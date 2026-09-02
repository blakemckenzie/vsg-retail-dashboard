# Very Special Games — Retail Sales Dashboard

Render Web Service with a persistent disk. PSi's weekly report lands on the
dashboard by itself; the manual drop-and-publish stays as a fallback.

```
server.js            serves the page, handles publishing, ingest and Asana
lib/parse.js         reads the PSi workbook (server side)
lib/brief.js         writes the weekly summary — this is the text Asana gets
lib/asana.js         posts the weekly task
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

## The brief at the top

One line on the week, then three fixed bullets:

1. **The flagship** — Ransom Notes House Party at Target and Walmart, dollars,
   year-on-year comp and dollars per store against each retailer's ideal.
2. **New titles** — anything listed in the last 12 weeks and how it is running.
   Brand-new lines are called out as too early to read; ones a few weeks in get
   their per-store number against the ideal.
3. **Red flags** — established lines under half their ideal on the 4-week
   average, retailers that have stopped reporting, and SKUs with no gross profit
   mapped.

Retailers that have gone quiet are kept out of the sales maths, so a reporting
gap never shows up as a -100% collapse.

Three settings live in the data file, so none of this needs a code change:

| Field | Does |
| --- | --- |
| `briefFlagship` | `{ "title": "...", "retailers": ["Target","Walmart"] }` — what bullet 1 tracks |
| `briefExclude` | titles to keep out of the brief entirely (currently Ransom Notes Couples Edition, being discontinued) |
| `newTitleWeeks` | how long a title counts as new — default 12 |

The brief is written by `lib/brief.js` and stored with the data, so the page and
the Asana task always say the same thing. Dropping a file by hand asks the server
to summarise the preview, so even that path uses the one implementation.

## 4. Optional: post to Asana each week

Add three more environment variables in Render:

| Key | Value |
| --- | --- |
| `ASANA_TOKEN` | a personal access token — Asana → Settings → Apps → Manage Developer Apps → Personal Access Tokens |
| `ASANA_PROJECT` | the project's gid — the **middle** number in the project URL |
| `ASANA_NOTIFY` | who to tag, as emails: `evan@…,josh@…,dave@…` |
| `ASANA_SECTION` | optional — the section to file it under, by name: `Retail Sales Weekly Reports` |

Reading the gid out of an Asana URL:

```
app.asana.com/1/1213156361562237/project/1215168650113487/task/…
                └ workspace ────┘         └ ASANA_PROJECT ┘
```

Emails and the section name are resolved to gids automatically, so there are no
gids to hunt down beyond the project. Sections never appear in the URL, which is
why the name is what you give it. If the name doesn't match, the task is still
created — it just lands in the project's default section, and the log lists the
section names it did find. `/healthz` reports `"asana"` once token and project
are both set.

Check it without waiting for Wednesday:

```bash
curl -X POST https://YOUR-SERVICE.onrender.com/api/asana-test \
  -H 'Content-Type: application/json' -d '{"secret":"YOUR_INGEST_SECRET"}'
```

That posts the current week as a task. `GET /api/brief` shows the text first,
without posting anything.

If the Asana post fails the ingest still succeeds — the numbers are saved and
the failure is logged. A missing task is a nuisance, not data loss.

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
