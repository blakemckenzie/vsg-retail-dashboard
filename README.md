# Very Special Games — Retail Sales Dashboard

Render Web Service with a persistent disk. Drop the weekly workbook on the page,
hit Publish, and everyone on the URL sees it. No git, no redeploy.

```
server.js          serves the page, handles the weekly publish
public/index.html  the whole dashboard — markup, styles, charts, xlsx parsing
data.json          starting data, copied onto the disk on first boot
```

## Deploy (once)

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

No environment variables. The mount path above is the default the server looks
for; if you mount somewhere else, set `DATA_DIR` to match.

Confirm it worked at `/healthz` — you want `"canPublish": true`.

## Every week

Open the URL, drop `Very Special Games<date>.xlsx` on section 05, check the
numbers, hit **Publish to the team**. Done.

Dropping a `VSG COGS` workbook refreshes gross profit per SKU the same way.
Ideal thresholds (section 02) publish through the same button.

## Notes

- **No password by design.** Anyone with the URL can publish. Set
  `PUBLISH_PASSWORD` in Render and the page starts asking for one — no code change.
- **The disk survives deploys and restarts.** It's snapshotted daily by Render.
- **If the disk is missing**, the page still serves the last data it has and the
  Publish button refuses with an explanation rather than silently losing the file.
- A disk-backed service runs one instance and has a few seconds of downtime on
  deploy. Irrelevant here, but that's why.
- Two external requests: Google Fonts and SheetJS from cdnjs. The page renders
  without them; the file drop needs SheetJS.
