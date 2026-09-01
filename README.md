# Very Special Games — Retail Sales Dashboard

Render Web Service with a persistent disk. PSi's weekly report lands on the
dashboard by itself; the manual drop-and-publish stays as a fallback.

```
server.js            serves the page, handles publishing and email ingest
lib/parse.js         reads the PSi workbook (server side)
public/index.html    the whole dashboard — markup, styles, charts, xlsx parsing
data.json            starting data, copied onto the disk on first boot
apps-script/Code.gs  the Gmail watcher — paste into script.google.com
```

## 1. Deploy

Push to GitHub, then Render → **New → Web Service** → pick the repo.

| Setting | Value |
| --- | --- |
| Language | Node |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Instance Type | Starter or above — a disk needs a paid instance |
| Health Check Path | `/healthz` |

Then **Settings → Disks → Add Disk**:

| Field | Value |
| --- | --- |
| Name | `data` |
| Mount Path | `/opt/render/project/src/storage` |
| Size | 1 GB |

## 2. Turn on email ingest

**Settings → Environment** → add one variable:

| Key | Value |
| --- | --- |
| `INGEST_SECRET` | any long random string — invent one, it just has to match the script |

Check `/healthz`. You want `"canPublish": true` and `"canIngest": true`.

## 3. Point the Gmail watcher at it

Open `apps-script/Code.gs`, then:

1. script.google.com → **New project**, paste the file in.
2. Set `DASHBOARD_URL` to your Render URL, and `INGEST_SECRET` to the same string.
3. Run **checkForReport** once and accept the Google authorisation prompt.
4. Triggers (clock icon) → **Add Trigger** → `checkForReport`, Time-driven,
   Day timer, 6am–7am.

That's it. PSi sends Wednesday mornings; the script picks it up on the next run.

## What happens each week

The script finds the newest "Weekly Dashboard" email, posts the workbook and the
email body to `/api/ingest`, and the dashboard updates. The email body matters:
PSi puts data-quality notes in it ("no Indigo sales from week ending 5/23") and
those show as a caveat on the dashboard instead of being lost.

**Nothing is overwritten carelessly.** The server refuses a file that is older
than what's live, or that has lost more than 10% of its rows. If the week is
already published it skips quietly, so a daily trigger is harmless. Any failure
emails you and leaves the previous week untouched — and retries next run.

The page also flags any retailer that has stopped reporting for 4+ weeks,
whether or not PSi mentions it.

## Manual fallback

Drop a workbook on section 05 and hit **Publish to the team** — same as before.
Dropping a `VSG COGS` workbook refreshes gross profit per SKU. Ideal thresholds
(section 02) publish through the same button.

`forceResend()` in the Apps Script re-pushes the newest report if you need it.

## Notes

- **No password on the browser publish** by design. Set `PUBLISH_PASSWORD` in
  Render and the page starts asking for one, no code change.
- **The disk survives deploys and restarts**, and Render snapshots it daily.
- `lib/parse.js` and the parser inside `public/index.html` must agree — if you
  change the row shape in one, change it in the other.
- A disk-backed service runs one instance and has a few seconds of downtime on
  deploy.
- Two external requests: Google Fonts and SheetJS from cdnjs. The page renders
  without them; the manual file drop needs SheetJS.
