// ══════════════════════════════════════════════════════════════════
// github-sync.js — pushes open positions to scripts/positions.json
// v1.0
//
// WHY: localStorage (a49_positions) only lives in this browser tab.
// GitHub Actions can't read it, so alert-runner.js has no idea what's
// open when the laptop is asleep — which is exactly when a stop or T1
// is most likely to get hit. This module pushes the same position
// store the GUI already maintains straight into the repo via the
// GitHub Contents API, so the server-side runner can watch it too.
//
// FLOW:
//   position-tracker.js savePositions() → scheduleGithubSync()
//     → debounce ~4s → syncPositionsToGitHub()
//        → GET current file sha (if any) → PUT updated content
//   + a periodic safety-net tick (every ~60s) re-pushes if the
//     configured interval has elapsed and content actually changed.
//
// This is one-directional: browser → GitHub. The server only reads
// positions.json to decide when to alert; it never writes it back,
// so the browser's localStorage stays the single source of truth.
// ══════════════════════════════════════════════════════════════════

const GH_SYNC_KEY = `${_REPO_NS}_gh_sync_cfg`;

// Bump this version whenever defaults change — triggers a one-time migration
// that resets mode/enabled to new defaults while keeping PAT credentials intact.
const GH_SYNC_CFG_VERSION = 4; // v4: Option B default with pull from GitHub, repo field

const DEFAULT_GH_SYNC_CFG = {
  _version:     GH_SYNC_CFG_VERSION,
  enabled:      true,      // ON by default — sync starts immediately when repo is configured
  mode:         'secrets', // Option B by default — headless-first, no PAT needed
  token:        '',        // GitHub PAT — fine-grained, "Contents: Read and write" on this repo
  repo:         '',        // "yourname/your-repo"
  branch:       'main',
  path:         'scripts/positions.json',
  intervalMins: 3,         // periodic safety-net push interval (Option A only)
};

function loadGhSyncCfg() {
  try {
    const raw = JSON.parse(localStorage.getItem(GH_SYNC_KEY) || '{}');
    const savedVersion = raw._version || 0;
    // Version migration — reset mode and enabled to new defaults, keep credentials
    if (savedVersion < GH_SYNC_CFG_VERSION) {
      console.log(`[github-sync] Config v${savedVersion} → v${GH_SYNC_CFG_VERSION}: resetting mode/enabled to defaults`);
      const migrated = {
        ...DEFAULT_GH_SYNC_CFG,
        // Preserve any PAT/repo/branch the user already entered
        // Reset mode to 'pat' — fixes users stuck on broken Option B default
        mode:         raw.token ? 'pat' : (raw.mode || 'secrets'),
        token:        raw.token        || '',
        repo:         raw.repo         || '',
        branch:       raw.branch       || 'main',
        path:         raw.path         || 'scripts/positions.json',
        intervalMins: raw.intervalMins || 3,
      };
      localStorage.setItem(GH_SYNC_KEY, JSON.stringify(migrated));
      return migrated;
    }
    return { ...DEFAULT_GH_SYNC_CFG, ...raw };
  } catch { return { ...DEFAULT_GH_SYNC_CFG }; }
}

function saveGhSyncCfg(cfg) {
  localStorage.setItem(GH_SYNC_KEY, JSON.stringify(cfg));
}

// ── Runtime status (not persisted — resets each session) ──
window._ghSyncState = window._ghSyncState || {
  lastSyncAt:   0,
  lastError:    null,
  lastPushedJSON: null,
  syncing:      false,
};

let _ghSyncTimer   = null;
let _ghSyncInFlight = false;
let _ghSyncQueued   = false;

// ══════════════════════════════════════════════════════════════════
// DEBOUNCED TRIGGER — called from position-tracker.js after every
// savePositions(). Batches rapid-fire changes into one push.
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// OPTION B — Pull positions.json FROM GitHub into localStorage
// Runs on page load when mode='secrets' so the GUI shows headless
// positions written by leaderboard-decider.js without any browser sync.
// ══════════════════════════════════════════════════════════════════
async function pullPositionsFromGitHub() {
  const cfg   = loadGhSyncCfg();
  if (cfg.mode !== 'secrets') return; // Option A manages its own state

  // Use GH_PAT secret from env.js OR fall back to GITHUB_TOKEN isn't
  // available client-side, so we need GH_PAT set as a repo secret exposed
  // via env.js, OR the user can leave Option B and just view headless data
  // by refreshing — the runner commits positions.json every run.
  //
  // Simplest working approach: fetch the raw file from the public repo URL.
  // This works for public repos without any auth.
  const repo   = cfg.repo || window.__GH_REPO || '';
  const branch = cfg.branch || 'main';
  const fpath  = cfg.path  || 'scripts/positions.json';

  if (!repo) return; // no repo configured

  try {
    // Try raw.githubusercontent.com first (public repos, no auth needed)
    const rawUrl = `https://raw.githubusercontent.com/${repo}/${branch}/${fpath}?t=${Date.now()}`;
    const r = await fetch(rawUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const remote = await r.json();

    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return;

    const localPositions = (typeof loadPositions === 'function') ? loadPositions() : {};
    const localKeys  = Object.keys(localPositions);
    const remoteKeys = Object.keys(remote);

    if (remoteKeys.length === 0 && localKeys.length > 0) {
      // Remote is empty but local has data — don't overwrite local with empty
      return;
    }

    // Merge: remote wins for symbols it knows about, local wins for anything extra
    const merged = { ...localPositions, ...remote };

    if (typeof savePositions === 'function') savePositions(merged);
    logAlertItem('info', `☁ Option B — pulled ${remoteKeys.length} position(s) from GitHub`);

    // Refresh the position tracker display
    if (typeof renderAlertCfgPage === 'function') renderAlertCfgPage();

  } catch (e) {
    // Silently fail — this is a best-effort pull
    console.log(`[gh-sync pull] ${e.message}`);
  }
}

// Pull on page load (Option B) — deferred so the rest of the app inits first
setTimeout(() => {
  const cfg = loadGhSyncCfg();
  if (cfg.mode === 'secrets') pullPositionsFromGitHub();
}, 3000);

function scheduleGithubSync(delayMs = 4000) {
  const cfg = loadGhSyncCfg();
  if (!cfg.enabled) return;
  if (_ghSyncTimer) clearTimeout(_ghSyncTimer);
  _ghSyncTimer = setTimeout(() => {
    _ghSyncTimer = null;
    syncPositionsToGitHub();
  }, delayMs);
}

// ══════════════════════════════════════════════════════════════════
// CORE SYNC — GET sha (if file exists) → PUT updated content.
// manual=true bypasses the "enabled" gate so the Sync Now button
// always works even mid-setup, and surfaces config errors in the log.
// ══════════════════════════════════════════════════════════════════
async function syncPositionsToGitHub(manual = false) {
  const cfg = loadGhSyncCfg();

  if (!cfg.enabled && !manual) return { ok: false, reason: 'disabled' };

  // Token resolution: Option A (browser localStorage PAT) or Option B (GH_PAT secret
  // injected as window.__GH_PAT via a <meta> tag written by the GitHub Actions workflow).
  const resolvedToken = cfg.token || window.__GH_PAT || '';
  const resolvedRepo  = cfg.repo  || window.__GH_REPO || '';

  if (!resolvedToken || !resolvedRepo) {
    if (manual) logAlertItem('info', '⚠ GitHub Sync — no token found. Set GH_PAT secret (Option B) or enter a PAT (Option A).');
    return { ok: false, reason: 'not configured' };
  }

  // Avoid overlapping requests — if one's in flight, queue exactly one follow-up.
  if (_ghSyncInFlight) { _ghSyncQueued = true; return { ok: false, reason: 'in-flight' }; }
  _ghSyncInFlight = true;
  window._ghSyncState.syncing = true;

  try {
    const positions = (typeof loadPositions === 'function') ? loadPositions() : {};
    const json = JSON.stringify(positions, null, 2);

    // Skip the push entirely if nothing has actually changed since the
    // last successful sync — keeps commit history clean and avoids
    // burning API calls on no-op pushes from the periodic safety-net tick.
    if (!manual && json === window._ghSyncState.lastPushedJSON) {
      return { ok: true, reason: 'unchanged' };
    }

    const branch  = cfg.branch || 'main';
    const apiBase = `https://api.github.com/repos/${resolvedRepo}/contents/${cfg.path}`;
    const headers = {
      'Authorization':        `Bearer ${resolvedToken}`,
      'Accept':               'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };

    // ── 1. Look up the current file sha (needed to update vs. create) ──
    let sha = null;
    const getRes = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
    if (getRes.ok) {
      const j = await getRes.json();
      sha = j.sha || null;
    } else if (getRes.status !== 404) {
      throw new Error(`GET ${getRes.status} — check token scope / repo name`);
    }

    // UTF-8-safe base64 encode
    const content = btoa(unescape(encodeURIComponent(json)));

    const putBody = {
      message: `chore: sync positions (${Object.keys(positions).length} open) [skip ci]`,
      content,
      branch,
    };
    if (sha) putBody.sha = sha;

    let putRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(putBody) });

    // Lost a race with another writer (e.g. Actions touched the same file) — refetch sha, retry once.
    if (!putRes.ok && putRes.status === 409) {
      const getRes2 = await fetch(`${apiBase}?ref=${encodeURIComponent(branch)}`, { headers });
      if (getRes2.ok) {
        const j2 = await getRes2.json();
        putBody.sha = j2.sha || undefined;
        putRes = await fetch(apiBase, { method: 'PUT', headers, body: JSON.stringify(putBody) });
      }
    }

    if (!putRes.ok) {
      const errJson = await putRes.json().catch(() => ({}));
      throw new Error(`PUT ${putRes.status} ${errJson.message || ''}`.trim());
    }

    window._ghSyncState.lastSyncAt     = Date.now();
    window._ghSyncState.lastError      = null;
    window._ghSyncState.lastPushedJSON = json;

    // Sync succeeded — log and refresh status
    const posCount = Object.keys(positions).length;
    const posNames = Object.keys(positions).join(', ') || 'none';
    logAlertItem('info', `☁ GitHub sync OK — ${posCount} position(s) → ${resolvedRepo}`);
    if (posCount === 0) {
      logAlertItem('info', `ℹ No positions in local cache yet. A leaderboard buy alert must fire first to populate positions.`);
    } else {
      logAlertItem('info', `  Synced: ${posNames}`);
    }
    // Write to audit log (best-effort — needs Option A PAT)
    if (typeof logBrowserAudit === 'function') {
      logBrowserAudit('browser_sync_ok', { count: posCount, symbols: posNames, repo: resolvedRepo });
    }

    _refreshGhSyncStatusDOM();
    return { ok: true };

  } catch (e) {
    window._ghSyncState.lastError = e.message;
    // Surface actionable error messages
    let hint = '';
    if (e.message.includes('401')) hint = ' — PAT invalid or expired';
    else if (e.message.includes('403')) hint = ' — PAT lacks Contents:Write permission';
    else if (e.message.includes('404')) hint = ' — repo not found, check owner/repo field';
    else if (e.message.includes('not configured')) hint = ' — enter owner/repo and PAT then Save';
    logAlertItem('info', `☁ GitHub sync FAILED — ${e.message}${hint}`);
    // Write failure to audit (best-effort)
    if (typeof logBrowserAudit === 'function') {
      logBrowserAudit('browser_sync_failed', { error: e.message + hint, repo: resolvedRepo || '?' });
    }
    _refreshGhSyncStatusDOM();
    return { ok: false, reason: e.message };

  } finally {
    _ghSyncInFlight = false;
    window._ghSyncState.syncing = false;
    if (_ghSyncQueued) { _ghSyncQueued = false; scheduleGithubSync(2000); }
  }
}

// ══════════════════════════════════════════════════════════════════
// PERIODIC SAFETY NET — in case a debounced call gets lost (tab
// backgrounded mid-timer, etc.), re-check every minute and push if
// the configured interval has elapsed. The "unchanged" short-circuit
// above means this is a no-op unless something actually drifted.
// ══════════════════════════════════════════════════════════════════
setInterval(() => {
  const cfg = loadGhSyncCfg();
  if (!cfg.enabled) return;
  const minGapMs = Math.max(1, cfg.intervalMins || 3) * 60000;
  if (Date.now() - (window._ghSyncState.lastSyncAt || 0) >= minGapMs) {
    syncPositionsToGitHub();
  }
}, 60_000);

// ══════════════════════════════════════════════════════════════════
// UI — config card rendered inside renderAlertCfgPage()
// ══════════════════════════════════════════════════════════════════
function _ghSyncStatusLine() {
  const s = window._ghSyncState;
  if (s.syncing) return `<span style="color:var(--accent);">⏳ syncing…</span>`;
  if (s.lastError) return `<span style="color:var(--bear);">⚠ ${s.lastError}</span>`;
  if (!s.lastSyncAt) return `<span style="color:var(--text-dim);">Never synced yet</span>`;
  const mins = Math.floor((Date.now() - s.lastSyncAt) / 60000);
  const txt  = mins < 1 ? 'just now' : mins === 1 ? '1 min ago' : `${mins} min ago`;
  return `<span style="color:var(--bull);">✓ Last synced ${txt}</span>`;
}

function _refreshGhSyncStatusDOM() {
  const el = document.getElementById('gh-sync-status-line');
  if (el) el.innerHTML = _ghSyncStatusLine();
}

function renderGithubSyncCard() {
  const cfg  = loadGhSyncCfg();
  const mode = cfg.mode || 'secrets'; // 'pat' | 'secrets'

  const tabStyle = (m) => [
    'cursor:pointer;font-family:var(--mono);font-size:8px;font-weight:700;padding:4px 14px;',
    'border-radius:3px;',
    `border:1px solid ${mode===m ? '#8957e5' : 'var(--border2)'};`,
    `background:${mode===m ? 'rgba(137,87,229,.18)' : 'transparent'};`,
    `color:${mode===m ? '#8957e5' : 'var(--text-dim)'};`,
  ].join('');

  const patPanel = `
    <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:12px;line-height:1.7;">
      Browser pushes <code style="color:var(--accent);">${cfg.path}</code> via your PAT whenever a position changes.<br>
      ⚠ Token stored in <b>localStorage only</b>. Use a fine-grained PAT scoped to this repo,
      <b>Contents: Read and write</b> — never a token with broader access.
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">OWNER/REPO</label>
        <input type="text" id="gh-sync-repo" value="${cfg.repo}" placeholder="yourname/alpha-terminal"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">BRANCH</label>
        <input type="text" id="gh-sync-branch" value="${cfg.branch}" placeholder="main"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
    </div>
    <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">PERSONAL ACCESS TOKEN</label>
    <input type="password" id="gh-sync-token" value="${cfg.token}" placeholder="github_pat_…"
      style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
             padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;margin-bottom:8px;box-sizing:border-box;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">FILE PATH</label>
        <input type="text" id="gh-sync-path" value="${cfg.path}"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">SAFETY-NET INTERVAL (min)</label>
        <input type="number" id="gh-sync-interval" value="${cfg.intervalMins}" min="1" max="30" step="1"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
    </div>`;

  const secretsPanel = `
    <div style="font-family:var(--mono);font-size:8px;color:var(--text-dim);margin-bottom:12px;line-height:1.9;">
      <b style="color:var(--text);">Fully headless — no PAT in browser.</b>
      GitHub Actions writes <code style="color:var(--accent);">positions.json</code> every 15 min.
      The browser pulls it on load so you see live positions without syncing.<br><br>
      <b style="color:#8957e5;">Required — Settings → Secrets → Actions:</b><br>
      &nbsp;&nbsp;<code style="color:var(--accent);">TELEGRAM_BOT_TOKEN</code> + <code style="color:var(--accent);">TELEGRAM_CHAT_ID</code><br><br>
      <b style="color:#8957e5;">Required — Settings → Variables → Actions:</b><br>
      &nbsp;&nbsp;<code style="color:var(--accent);">GH_REPO</code> = <code>ahsan520/alpha</code><br><br>
      <b style="color:var(--text);">Enter your repo below so the browser can pull positions:</b>
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">OWNER/REPO</label>
        <input type="text" id="gh-sync-repo" value="\${cfg.repo}" placeholder="ahsan520/alpha"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
      <div>
        <label style="font-family:var(--mono);font-size:7px;color:var(--text-dim);display:block;margin-bottom:3px;">BRANCH</label>
        <input type="text" id="gh-sync-branch" value="\${cfg.branch}" placeholder="main"
          style="width:100%;background:var(--bg);border:1px solid var(--border2);color:var(--text-bright);
                 padding:7px 10px;border-radius:4px;font-size:9px;font-family:var(--mono);outline:none;box-sizing:border-box;">
      </div>
    </div>
    <button onclick="pullPositionsFromGitHub()"
      style="width:100%;background:none;border:1px solid #8957e5;color:#8957e5;padding:8px;
             border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;margin-bottom:10px;">
      🔄 PULL POSITIONS NOW
    </button>
    <div style="font-family:var(--mono);font-size:7.5px;color:var(--text-dim);line-height:1.7;padding:8px;background:rgba(137,87,229,.06);border-radius:4px;">
      ✓ Leaderboard buy alerts → GitHub Actions → <code>positions.json</code><br>
      ✓ Stop/T1/T2/exit alerts → GitHub Actions every 15 min<br>
      ✓ Browser pulls positions on load — close tab anytime
    </div>`;

  return `
  <div style="background:var(--card);border:1px solid var(--border);border-top:2px solid #8957e5;
              border-radius:8px;padding:16px;" id="github-sync-card">

    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <div style="font-family:var(--mono);font-size:10px;font-weight:700;color:#8957e5;letter-spacing:2px;">
        ☁ GITHUB POSITION SYNC
      </div>
      <span style="font-family:var(--mono);font-size:8px;padding:2px 8px;border-radius:4px;font-weight:700;
        background:${cfg.enabled ? 'rgba(137,87,229,.15)' : 'rgba(100,100,100,.12)'};
        color:${cfg.enabled ? '#8957e5' : '#555'};
        border:1px solid ${cfg.enabled ? 'rgba(137,87,229,.35)' : '#2a2a2a'};">
        ${cfg.enabled ? 'ACTIVE' : 'OFF'}
      </span>
    </div>

    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-family:var(--mono);font-size:9px;
                  color:var(--text);margin-bottom:12px;padding-bottom:12px;border-bottom:1px solid var(--border);">
      <input type="checkbox" id="gh-sync-enabled" ${cfg.enabled ? 'checked' : ''}
        style="width:auto;margin:0;accent-color:#8957e5;"> Enable GitHub Sync
    </label>

    <!-- Mode selector -->
    <div style="display:flex;gap:6px;margin-bottom:14px;">
      <button onclick="setGhSyncMode('pat')"     style="${tabStyle('pat')}">⬡ OPTION A — Browser PAT</button>
      <button onclick="setGhSyncMode('secrets')" style="${tabStyle('secrets')}">⬡ OPTION B — GitHub Secrets</button>
    </div>

    ${mode === 'pat' ? patPanel : secretsPanel}

    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
      <button onclick="saveGithubSyncCfgFromUI()"
        style="background:#8957e5;border:none;color:#fff;padding:8px 20px;
               border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;font-weight:700;">
        💾 SAVE
      </button>
      <button onclick="syncPositionsToGitHub(true)"
        style="background:none;border:1px solid #8957e5;color:#8957e5;padding:7px 16px;
               border-radius:4px;cursor:pointer;font-family:var(--mono);font-size:9px;">
        🔄 SYNC NOW
      </button>
      <span id="gh-sync-status-line" style="font-family:var(--mono);font-size:8px;">${_ghSyncStatusLine()}</span>
    </div>
  </div>`;
}

function setGhSyncMode(mode) {
  const cfg = loadGhSyncCfg();
  cfg.mode = mode;
  saveGhSyncCfg(cfg);
  renderAlertCfgPage();
}

function saveGithubSyncCfgFromUI() {
  const existing = loadGhSyncCfg();
  const mode = existing.mode || 'secrets';
  const cfg = {
    ...existing,
    mode,
    enabled: document.getElementById('gh-sync-enabled')?.checked ?? false,
  };
  if (mode === 'pat') {
    cfg.token        = document.getElementById('gh-sync-token')?.value.trim()    || '';
    cfg.repo         = document.getElementById('gh-sync-repo')?.value.trim()     || '';
    cfg.branch       = document.getElementById('gh-sync-branch')?.value.trim()   || 'main';
    cfg.path         = document.getElementById('gh-sync-path')?.value.trim()     || 'scripts/positions.json';
    cfg.intervalMins = parseInt(document.getElementById('gh-sync-interval')?.value) || 3;
  }
  // Option B: save repo/branch so pullPositionsFromGitHub knows where to fetch from
  if (mode === 'secrets') {
    cfg.repo   = document.getElementById('gh-sync-repo')?.value.trim()   || cfg.repo   || '';
    cfg.branch = document.getElementById('gh-sync-branch')?.value.trim() || cfg.branch || 'main';
  }
  cfg._version = GH_SYNC_CFG_VERSION;
  saveGhSyncCfg(cfg);
  logAlertItem('info', `💾 GitHub Sync config saved (${mode === 'secrets' ? 'Option B — Secrets' : 'Option A — Browser PAT'}).`);
  renderAlertCfgPage();
  if (mode === 'pat' && cfg.enabled && cfg.token && cfg.repo) syncPositionsToGitHub(true);
}
