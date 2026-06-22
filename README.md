# Alpha Terminal — Headless Alert Runner

A trading dashboard with a GitHub Actions-powered headless position monitor.  
The browser GUI shows live leaderboard data and manages positions. The headless runner watches your open positions 24/7 via GitHub Actions and sends Telegram alerts for stops, T1/T2 targets, and exit signals — even while the browser is closed.

---

## How It Works

```
Browser (GUI)                    GitHub repo                  GitHub Actions (headless)
─────────────────                ──────────────               ─────────────────────────
Leaderboard buy fires        →   writes positions.json    →   reads it every :15
You click "Close position"   →   updates status: stopped  →   skips that symbol
Browser closed / offline         file stays as-is             keeps monitoring 24/7
```

The workflow runs at **:15 past every hour** and checks:
- **Stop hit** → immediate Telegram alert
- **T1 / T2 price reached** → Telegram alert
- **Tier 2 exit signal** — CVD declining + exit score ≥ 3 → sell alert
- **Tier 1 overheating** — Funding hot + RSI extended → tighten stop warning
- **Stale position** — open > 48h with no close → one-time warning then silent

---

## Setup

### 1. GitHub Secrets
Go to **Settings → Secrets and variables → Actions → Secrets (New repository secret)**

| Secret | Required | Description |
|--------|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | ✅ Yes | Your Telegram bot token from [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_CHAT_ID` | ✅ Yes | Your Telegram chat ID (message your bot, then visit `api.telegram.org/bot<TOKEN>/getUpdates`) |
| `GH_PAT` | ✅ Yes (Option B) | Fine-grained PAT with **Contents: Read and write** on this repo. Used by the browser to push `positions.json` without storing a token in localStorage. Create at github.com → Settings → Developer settings → Personal access tokens → Fine-grained tokens |

### 2. GitHub Variables
Go to **Settings → Secrets and variables → Actions → Variables (New repository variable)**

#### Position Sync (Option B — headless, no browser PAT needed)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GH_REPO` | ✅ Yes (Option B) | — | Your repo in `owner/repo` format, e.g. `ahsan520/alpha` |
| `GH_BRANCH` | Optional | `main` | Branch where `positions.json` lives |
| `GH_POSITIONS_PATH` | Optional | `scripts/positions.json` | Path to positions file in repo |

#### Telegram Controls

| Variable | Default | Description |
|----------|---------|-------------|
| `TELEGRAM_ENABLED` | `true` | Set `false` to silence all Telegram without removing secrets |
| `DIGEST_MODE` | `true` | Batch multiple alerts into one message per run |
| `ALERT_COOLDOWN_HOURS` | `1` | Min hours between repeated rule alerts for the same symbol |

#### Leaderboard / Position Tracker Tuning

| Variable | Default | Recommended | Description |
|----------|---------|-------------|-------------|
| `LB_MIN_SCORE` | `9` | `9` | Min conviction score (0–14) to fire a buy alert. CAP BUY ignores this gate. |
| `LB_COOLDOWN_MIN` | `60` | `60` | Min minutes between buy alerts for the same symbol (60 = 1hr) |
| `LB_HOLD_LOCK` | `20` | `20` | Min minutes after entry before exit scoring begins |
| `LB_CVD_CYCLES` | `3` | `3` | Consecutive CVD decline cycles required to confirm distribution exit |

#### Testing

| Variable | Default | Description |
|----------|---------|-------------|
| `DRY_RUN` | `false` | Set `true` to run without sending any Telegram messages — logs output only |

---

## GitHub Sync — Option A vs Option B

### Option A — Browser PAT
The GUI pushes `positions.json` to the repo via a Personal Access Token stored in your browser's `localStorage`. The runner reads the checked-out local file on each run.

**Setup in GUI:** Alert Configuration → GitHub Position Sync → **Option A** tab  
Enter your `owner/repo`, `branch`, and a fine-grained PAT with **Contents: Read and write** scope on this repo only.

### Option B — GitHub Secrets (recommended for headless-first)
No token stored in the browser. The runner fetches `positions.json` directly from the GitHub API using its built-in `GITHUB_TOKEN`. Set `GH_REPO` as a repo Variable and you're done.

**Setup in GUI:** Alert Configuration → GitHub Position Sync → **Option B** tab  
No fields to fill — the checklist shows what Variables to set in the repo.

Both options can run simultaneously — Option A keeps `positions.json` updated in near-real-time, Option B is the fallback if the local checkout is stale.

---

## Workflow Schedule

The runner fires at **`:15` past every hour** (`15 * * * *` cron).

To change frequency, edit `.github/workflows/alert-runner.yml`:
```yaml
# Every 15 minutes (more responsive, uses more Actions minutes)
- cron: '*/15 * * * *'

# Once per hour at :15 (default — recommended)
- cron: '15 * * * *'

# Specific hours only (e.g. 09:15 and 21:15 UTC)
- cron: '15 9,21 * * *'
```

You can also trigger it manually: **Actions → Alpha Terminal Alert Runner → Run workflow**  
Check the **Dry run** box to test without sending Telegram messages.

---

## Alert State

The file `scripts/.alert-state.json` tracks cooldowns between runs so duplicate alerts are suppressed. It is automatically committed back after each run with `[skip ci]` to avoid triggering the Pages deployment.

**To reset all cooldowns** (force all alerts to re-evaluate): delete `scripts/.alert-state.json` from the repo or clear its contents to `{}`.

---

## Stale Position Guard

If a position has been open for more than **48 hours** with no status update, the runner sends a **one-time** Telegram warning:

> ⚠ Stale Position — BTCUSDT  
> Open for 52h with no close recorded.  
> If you already exited this trade, open the GUI and click Close to remove it from positions.json

After the warning fires, that position is silenced permanently until you close it in the GUI or manually clear `.alert-state.json`.

---

## Files

| File | Description |
|------|-------------|
| `scripts/alert-runner.js` | Headless Node.js runner — all position monitoring and alert logic |
| `scripts/package.json` | Node dependencies (`node-fetch`) |
| `scripts/positions.json` | Open positions synced from GUI (read by runner, written by GUI or Option B) |
| `scripts/.alert-state.json` | Cooldown state between runs (auto-managed by workflow) |
| `.github/workflows/alert-runner.yml` | GitHub Actions workflow definition |
| `js/position-tracker.js` | Browser-side position tracker and exit scoring |
| `js/github-sync.js` | Browser-side GitHub sync (Option A PAT push) |
| `js/alerts.js` | Browser-side alert rules and config |
