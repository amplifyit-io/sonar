# Sonar — Amplify GTM Chrome Extension

> "Capture intelligence in the wild. Instantly."

Reduce: **time to capture high-signal intelligence → from 15s → 1 click.**

---

## What it does

A Manifest v3 Chrome Extension that injects a **"📡 Radar"** floating button on any page. One click → sends the URL + extracted context to the Amplify Radar ingestion pipeline → entities are resolved → events are created → Radar UI updates.

---

## Architecture

```
[Browser tab]
     ↓  click  (content.ts)
chrome.runtime.sendMessage INGEST
     ↓
[Service Worker]  (background.ts)
     ↓  POST /api/admin/gtm/radar/ingest
[Amplify API]
     ↓
[Ingestion pipeline] → entity resolution → event store → Radar UI
```

---

## Features

| Feature | Detail |
|---------|--------|
| **Floating button** | Injected on every page; platform-aware icon |
| **Platform extraction** | LinkedIn (profile/post/company), X (post/profile), Reddit, generic |
| **Context extraction** | Author, post text, title, meta description per platform |
| **Keyboard shortcut** | `Alt+Shift+R` — capture current page without clicking |
| **Right-click menu** | "📡 Send to Radar" on any link or selection |
| **Offline queue** | Captures stored in `chrome.storage.local`, retried up to 3× |
| **Popup UI** | Feed of last 50 captures with status, quick-paste input, settings |
| **Job polling** | Popup auto-refreshes every 2s while open |
| **Badge** | Shows active/failed job count on the extension icon |
| **SPA navigation** | Re-injects button after pushState route changes (LinkedIn/X) |

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Build
npm run build

# 3. Load in Chrome
#    chrome://extensions → Enable Developer mode → Load unpacked → select dist/
```

---

## Configuration

Open the extension popup → **Config** tab:

| Field | Default | Description |
|-------|---------|-------------|
| **Radar host** | `https://admin.amplifyit.io` | Base URL of your Amplify deployment |
| **Auth token** | _(empty)_ | Optional Bearer token if your API requires auth |

---

## Development

```bash
# Watch mode — auto-rebuilds on file change
npm run watch

# Then reload the extension in chrome://extensions after each rebuild
```

---

## Production icons

The build generates functional PNG icons using a pure-Node rasterizer. For pixel-perfect
icons rendered from `icons/icon.svg`, install `sharp` and it will be used automatically:

```bash
npm install sharp   # already in devDependencies
npm run build       # sharp is now used if available
```

---

## API contract

The extension posts to `POST {host}/api/admin/gtm/radar/ingest`:

```json
{
  "url":          "https://...",
  "purpose":      "manual_radar | trigger_tracking | operator_tracking | org_tracking",
  "priority":     "low | medium | high",
  "requested_by": "sonar"
}
```

Response: `{ "job_id": "...", "status": "queued" }` — 202 Accepted.

The Radar UI already handles job polling at `/api/admin/gtm/radar/jobs/{job_id}`.

---

## Source

```
sonar/
├── src/
│   ├── background.ts   Service worker — API calls, queue, context menu, badge
│   ├── content.ts      Injected into all pages — button, extraction, toast
│   └── popup.ts        Popup logic — feed, settings, quick capture
├── popup.html          Popup markup + inline styles (CSP-safe, no external deps)
├── manifest.json       MV3 manifest
├── icons/icon.svg      Source icon (black circle with white radar arcs)
├── build.mjs           esbuild + pure-Node icon generator
├── tsconfig.json
└── package.json
```
