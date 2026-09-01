/* Very Special Games — Retail Sales Dashboard
 *
 * A Render Web Service with a persistent disk. The dashboard is a single page in
 * public/. Dropping a workbook on the page and hitting Publish writes the week's
 * numbers to the disk, which survives deploys and restarts — so every visitor to
 * the URL sees the same thing, and nobody touches git.
 *
 * Environment:
 *   DATA_DIR   where the persistent disk is mounted.
 *              Defaults to /opt/render/project/src/storage, which is Render's
 *              own convention for Node services.
 *
 * On first boot the disk is empty, so the repo's data.json is copied onto it as
 * a starting point. After that the disk is the source of truth.
 *
 * There is no password on the browser publish by design — this is an internal
 * dashboard on an unguessable URL. If that changes, set PUBLISH_PASSWORD.
 *
 * POST /api/ingest is the automated path: a Google Apps Script watches Gmail for
 * PSi's "Weekly Dashboard" mail, and posts the workbook here every week without
 * anyone touching the page. It needs INGEST_SECRET set, and it carries the email
 * body across so the report's own caveats show on the dashboard.
 */

const express = require("express");
const path = require("path");
const fs = require("fs/promises");
const { parseWeekly, merge, guard } = require("./lib/parse");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = process.env.DATA_DIR || "/opt/render/project/src/storage";
const LIVE_FILE = path.join(DATA_DIR, "data.json");
const SEED_FILE = path.join(__dirname, "data.json");
const PASSWORD = process.env.PUBLISH_PASSWORD || "";
const INGEST_SECRET = process.env.INGEST_SECRET || "";

app.disable("x-powered-by");
app.use(express.json({ limit: "24mb" }));

/* compare without leaking length through timing */
function secretOk(given, expected) {
  const a = String(given || ""), b = String(expected || "");
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= a.charCodeAt(i % (a.length || 1)) ^ b.charCodeAt(i % (b.length || 1));
  }
  return diff === 0;
}

/* ------------------------------- storage -------------------------------- */

let writable = false;   // set at boot: is the disk actually there and writable?

async function readLive() {
  try {
    return JSON.parse(await fs.readFile(LIVE_FILE, "utf8"));
  } catch {
    return null;
  }
}
async function readSeed() {
  try {
    return JSON.parse(await fs.readFile(SEED_FILE, "utf8"));
  } catch {
    return null;
  }
}
async function writeLive(json) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // write beside, then rename — a crash mid-write can't leave a half file
  const tmp = LIVE_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(json));
  await fs.rename(tmp, LIVE_FILE);
}

/* Prove the disk is writable at boot rather than discovering it on a publish. */
async function checkDisk() {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const probe = path.join(DATA_DIR, ".write-probe");
    await fs.writeFile(probe, String(Date.now()));
    await fs.unlink(probe);
    writable = true;
  } catch (e) {
    writable = false;
    console.warn(`No writable disk at ${DATA_DIR} (${e.code || e.message}).`);
    console.warn("Publishing is disabled. Attach a persistent disk in Render, mounted at that path.");
  }
  if (writable && !(await readLive())) {
    const seed = await readSeed();
    if (seed) {
      await writeLive(seed);
      console.log("Disk was empty — seeded it with the data.json from the repo.");
    }
  }
}

/* -------------------------------- validation ----------------------------- */

function validate(data) {
  if (!data || typeof data !== "object") return "payload is not an object";
  if (!Array.isArray(data.rows) || data.rows.length === 0) return "no sales rows in the payload";
  if (data.rows.length > 500_000) return "far more rows than a weekly report should have";
  const bad = data.rows.find(
    (r) => !Array.isArray(r) || r.length < 6 || typeof r[1] !== "number" || typeof r[2] !== "number"
  );
  if (bad) return "sales rows are not in the expected shape";
  if (typeof data.maxYear !== "number" || typeof data.maxWeek !== "number") return "missing the latest year and week";
  if (!data.thresholds || typeof data.thresholds !== "object") return "missing retailer thresholds";
  return null;
}

/* --------------------------------- routes -------------------------------- */

app.get("/api/data", async (_req, res) => {
  const data = (await readLive()) || (await readSeed());
  if (!data) return res.status(404).json({ error: "No report available yet." });
  res.set("Cache-Control", "no-store");
  res.json({
    data,
    updatedAt: data.publishedAt || null,
    canPublish: writable,
    needsPassword: Boolean(PASSWORD),
  });
});

app.post("/api/publish", async (req, res) => {
  if (!writable) {
    return res.status(503).json({
      error:
        "There's no writable disk, so publishing would be lost on the next deploy. " +
        "Attach a persistent disk in Render → Settings → Disks, mounted at " + DATA_DIR + ".",
    });
  }

  if (PASSWORD && !secretOk(req.body && req.body.password, PASSWORD)) {
    return res.status(401).json({ error: "Wrong password." });
  }

  const data = req.body && req.body.data;
  const problem = validate(data);
  if (problem) return res.status(400).json({ error: problem });

  data.publishedAt = new Date().toISOString();
  try {
    await writeLive(data);
    res.json({ ok: true, updatedAt: data.publishedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* ---- automated weekly ingest, called by the Apps Script ---- */

app.post("/api/ingest", async (req, res) => {
  if (!INGEST_SECRET) {
    return res.status(503).json({ error: "INGEST_SECRET is not set on the server." });
  }
  if (!secretOk(req.body && req.body.secret, INGEST_SECRET)) {
    return res.status(401).json({ error: "Bad secret." });
  }
  if (!writable) {
    return res.status(503).json({ error: "No writable disk — nothing would persist." });
  }

  const b = req.body || {};
  if (!b.fileBase64) return res.status(400).json({ error: "No file in the request." });

  let parsed;
  try {
    parsed = parseWeekly(Buffer.from(b.fileBase64, "base64"));
  } catch (e) {
    return res.status(400).json({ error: "Could not read the workbook: " + e.message });
  }
  if (!parsed) {
    return res.status(400).json({ error: "No WeeklySales tab in that file." });
  }

  const current = (await readLive()) || (await readSeed()) || {};
  const next = merge(current, parsed);

  const check = guard(current, next);
  if (check.skip) {
    return res.json({ ok: true, skipped: true, reason: check.reason,
                      maxYear: next.maxYear, maxWeek: next.maxWeek });
  }
  if (check.block) {
    return res.status(409).json({ error: check.reason });
  }

  /* The email body carries PSi's own caveats — which retailer is missing this
     week, and so on. Keeping it with the data is the whole point of ingesting
     the mail rather than just the attachment. */
  if (b.emailBody) {
    next.caveat = {
      text: String(b.emailBody).slice(0, 4000),
      filename: b.filename ? String(b.filename).slice(0, 200) : null,
      receivedAt: b.receivedAt || null,
    };
  }
  next.publishedAt = new Date().toISOString();
  next.publishedBy = "email";

  try {
    await writeLive(next);
    console.log(`Ingested ${b.filename || "workbook"} — now at ${next.maxYear} W${next.maxWeek}`);
    res.json({ ok: true, maxYear: next.maxYear, maxWeek: next.maxWeek,
               rows: next.rows.length, updatedAt: next.publishedAt });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get("/healthz", (_req, res) =>
  res.json({ ok: true, canPublish: writable, canIngest: Boolean(INGEST_SECRET) && writable, dataDir: DATA_DIR })
);

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"], maxAge: "5m" }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

checkDisk().then(() => {
  app.listen(PORT, () => {
    console.log(
      `VSG retail dashboard on :${PORT} — ` +
        (writable ? `publishing to the disk at ${DATA_DIR}` : "READ ONLY, no writable disk") +
        (INGEST_SECRET ? " — email ingest enabled" : " — email ingest off (set INGEST_SECRET)")
    );
  });
});
