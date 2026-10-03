# StationBrain

Station-level reporting tool for Jamaica Fire Brigade crews: **incident reports**, **shift handovers** and **debriefings**, formatted consistently and ready to copy, share (e.g. to WhatsApp) or print.

It is a single-file Progressive Web App: no build step, no server and no external dependencies. Install it to the home screen and it works fully offline.

> Personal tool, not an official JFB system. See the in-app *Legal* page.

## Features

- **Three report types** with structured fields. Incident reports show house-fire or vehicle sections only when relevant, and work out time out of station (including returns after midnight).
- **Autosaved drafts**: entries save as you type and survive closing the app or the phone locking.
- **Reports log** with search, type filters, edit-in-place (no duplicates) and delete with undo.
- **Copy / Share / Print**: a plain-text report for messaging apps, or a print layout for PDF.
- **Backup**: export and import all reports as JSON from *Settings*.
- Light and dark themes (follows the system or set manually), large tap targets, works one-handed.

## Data & privacy

Everything is stored in the browser's `localStorage` on the device. Nothing is uploaded. Clearing site data, uninstalling the browser or switching phones erases reports, so **export a backup regularly**.

## Development

Open `index.html` through any static server (the service worker requires `http(s)://`):

```bash
npx http-server -c-1 .
```

Run the end-to-end tests (Chromium via Playwright):

```bash
npm install
npx playwright install chromium
npm test
```

Pushing to `main` deploys to GitHub Pages (`.github/workflows/deploy.yml`). When you change cached files, bump `CACHE_NAME` in `sw.js` and `APP_VERSION` in `index.html`.
