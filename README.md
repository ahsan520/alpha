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

---

## Understanding Buy / Sell Alerts

### Leaderboard Alerts — Entry (BUY side)

Fires when a new card appears on the leaderboard with sufficient conviction. This is your **entry signal** — it means a setup just formed worth acting on.

```
New card appears on leaderboard
        ↓
Setup type check (CAP BUY / SQUEEZE NOW / BREAKOUT)
        ↓
Conviction score ≥ 9 (default min score)
        ↓
Not on cooldown (60 min per symbol)
        ↓
🟢 Telegram: LEADERBOARD BUY ALERT
   Includes: Entry price · Stop · T1 · T2
   Position auto-added to Position Tracker
```

**You decide whether to enter** — the alert gives you the levels, you execute at your broker.

---

### Position Tracker Alerts — Exit (SELL side)

Once you're in a trade, the headless runner monitors it every `:15` against `positions.json`. It never fires a fresh buy — it only tells you when and how to get out.

| Alert | Trigger | What to do |
|---|---|---|
| 🔴 **STOP HIT** | Price ≤ stop level | Exit immediately — loss is capped |
| ✅ **T1 HIT** | Price reaches T1 | Take 50% profit, move stop to entry (risk-free) |
| 🏆 **T2 HIT** | Price reaches T2 | Full target hit — close remaining position |
| ⚠️ **TIER 1 — Overheating** | Funding > 0.08% + RSI 15m > 75, CVD still up | Tighten stop — don't exit yet, but be ready |
| 🟡 **TIER 2 — EXIT SIGNAL** | CVD declining 3 cycles + exit score ≥ 3 | Distribution confirmed — consider partial or full exit *before* stop hits |

---

### Why Tier 2 is the most valuable alert

Most traders only react to T1/T2/Stop. But by then price has already moved.

**Tier 2 fires earlier** — it detects smart money exiting before price rolls over:

- **CVD declining** — cumulative volume delta falling = buyers exhausted, sellers taking over
- **OI distributing** — open interest dropping while price is flat/falling = longs unwinding
- **Funding elevated** — longs overleveraged, vulnerable to a flush

In a fast market the difference between a Tier 2 alert and a stop hit can be **2–5% of the position**. This is the alert you want to act on decisively.

---

### Full Trade Lifecycle

```
🟢 LEADERBOARD BUY ALERT fires
        ↓
You enter at broker · Position Tracker auto-created
        ↓
Position monitored headlessly every :15
        ↓
        ├─ ⚠️ TIER 1   → tighten stop, stay in
        ├─ 🟡 TIER 2   → exit near top (before stop hits)
        ├─ ✅ T1 HIT   → take 50% off, move stop to entry
        ├─ 🏆 T2 HIT   → close rest, trade complete
        └─ 🔴 STOP HIT → exit, loss taken (last resort)
        ↓
Click Close in GUI → removes from positions.json → monitoring stops
```

---

### What you do NOT need

| Feature | Status | Why |
|---|---|---|
| Signal Rules (vol shock, strong buy/sell) | ❌ Disabled | Lower quality than leaderboard, more noise |
| Overnight rules | ❌ Disabled | Superseded by leaderboard buy alerts |
| Email alerts | ❌ Disabled | Redundant if Telegram is working |
| Trending setup type | ❌ Off | Alerts come too late — trend already extended |
| Short Setup | ❌ Off | Enable only if actively trading shorts |
| Digest mode | ✅ On | Batches multiple alerts into one message per cycle |
