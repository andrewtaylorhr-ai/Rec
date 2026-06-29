# Driver Submission Tracker

Google Apps Script web app for Class A Recruiting Inc. Reads driver-submission
emails from Gmail, parses each thread into a driver row, and shows a recruiting
pipeline dashboard: pipeline stages, recruiter performance, targets, an AI
assistant (Gemini), and a US state-assignment / coverage map.

## Files
- `Code.js` — Apps Script backend (Gmail fetch, Sheet-backed data store, AI, geocode, sync).
- `Index.html` — single-page dashboard frontend (served by `doGet`).
- `appsscript.json` — manifest (timezone, Gmail advanced service, web-app access).
- `.clasp.json` — clasp project link (scriptId).

## Data layer
A 15-minute time trigger (`syncToSheet`) keeps a backing Google Sheet up to date
in the background. The web app reads driver data from that Sheet instead of
hitting Gmail on every page load, so loads are fast and never exhaust the daily
Gmail quota. One-time setup from the editor: run `seedSheet` (full rebuild) and
`installSyncTrigger`.

## Deploy (clasp)
```
clasp push --force
clasp deploy -i <deploymentId> -d "message"
```
The live `/exec` URL is a pinned deployment, so `clasp push` alone does not change
what it serves — you must also `clasp deploy` to bump the pinned version.

## Config (Script Properties)
- `GEMINI_API_KEY` — Gemini API key (kept out of source).
- `DB_SHEET_ID` — id of the backing Sheet (created automatically on first sync).
