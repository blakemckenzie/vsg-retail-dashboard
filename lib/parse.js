/* Parsing the PSi weekly workbook, server side.
 *
 * This mirrors the parser inlined in public/index.html, which is what runs when
 * someone drops a file on the page by hand. The two must agree — if you change
 * the shape of a row here, change it there too.
 *
 * row = [retailer, year, week, sku, sales$, units, storeCount]
 */

const XLSX = require("xlsx");

const RET_MAP = {
  TARGET: "Target", WALMART: "Walmart", BN: "B&N", MEIJER: "Meijer", AWBC: "AWBC",
  INDIGO: "Indigo", "FRED MEYER": "Fred Meyer", KOHLS: "Kohl's", GGS: "GGS", BGR: "BGR",
};

function normSku(v) {
  const s = String(v == null ? "" : v).trim();
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

function headerIndex(aoa) {
  for (let i = 0; i < Math.min(6, aoa.length); i++) {
    const row = (aoa[i] || []).map((c) => String(c == null ? "" : c).trim());
    if (row.includes("RetailerName") && row.includes("Sales$")) return i;
  }
  return -1;
}

/** Parse the WeeklySales tab out of a workbook buffer. Returns null if it isn't one. */
function parseWeekly(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws = wb.Sheets["WeeklySales"];
  if (!ws) return null;

  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const hi = headerIndex(aoa);
  if (hi < 0) return null;

  const head = aoa[hi].map((c) => String(c == null ? "" : c).trim());
  const col = {};
  ["RetailerName", "ChannelType", "ReportingYear", "ReportingWeek", "ReportDate",
   "UPC", "Title", "Sales$", "SalesUnits", "StoreCount"].forEach((n) => { col[n] = head.indexOf(n); });
  if (col["RetailerName"] < 0 || col["Sales$"] < 0) return null;

  const rows = [], weekDates = {}, titles = {};
  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i];
    if (!r) continue;
    const rn = r[col["RetailerName"]];
    if (rn == null || String(rn).trim() === "") continue;

    const ret = RET_MAP[String(rn).trim().toUpperCase()] || String(rn).trim();
    const yr = parseInt(r[col["ReportingYear"]], 10);
    const wk = parseInt(r[col["ReportingWeek"]], 10);
    if (!Number.isFinite(yr) || !Number.isFinite(wk)) continue;

    const sku = normSku(r[col["UPC"]]);
    const sales = Number(r[col["Sales$"]]) || 0;
    const units = parseInt(r[col["SalesUnits"]], 10) || 0;

    let stores = 0;
    if (col["StoreCount"] >= 0 && String(r[col["ChannelType"]]).trim() === "B&M") {
      const sc = parseInt(r[col["StoreCount"]], 10);
      if (Number.isFinite(sc) && sc > 0) stores = sc;
    }
    rows.push([ret, yr, wk, sku, Math.round(sales * 100) / 100, units, stores]);

    const dt = r[col["ReportDate"]];
    if (dt != null) {
      let iso = "";
      if (dt instanceof Date) {
        iso = dt.getFullYear() + "-" + String(dt.getMonth() + 1).padStart(2, "0") +
              "-" + String(dt.getDate()).padStart(2, "0");
      } else if (typeof dt === "number") {
        const pd = XLSX.SSF.parse_date_code(dt);
        if (pd) iso = pd.y + "-" + String(pd.m).padStart(2, "0") + "-" + String(pd.d).padStart(2, "0");
      } else iso = String(dt).slice(0, 10);
      if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) weekDates[yr + "-" + wk] = iso;
    }
    if (col["Title"] >= 0 && r[col["Title"]]) titles[sku] = String(r[col["Title"]]).trim();
  }
  if (!rows.length) return null;

  let maxYear = 0, maxWeek = 0;
  for (const r of rows) {
    if (r[1] > maxYear) { maxYear = r[1]; maxWeek = r[2]; }
    else if (r[1] === maxYear && r[2] > maxWeek) maxWeek = r[2];
  }
  return { rows, weekDates, titles, maxYear, maxWeek };
}

/** Fold a freshly parsed workbook into the existing data, keeping all configuration. */
function merge(current, parsed) {
  const next = { ...current };
  next.rows = parsed.rows;
  next.weekDates = { ...(current.weekDates || {}), ...parsed.weekDates };
  next.maxYear = parsed.maxYear;
  next.maxWeek = parsed.maxWeek;
  next.retailers = [...new Set(parsed.rows.map((r) => r[0]))].sort();

  next.skuTitle = { ...(current.skuTitle || {}) };
  for (const sku of Object.keys(parsed.titles)) {
    if (!next.skuTitle[sku]) next.skuTitle[sku] = parsed.titles[sku];
  }

  next.thresholds = { ...(current.thresholds || {}) };
  for (const ret of next.retailers) {
    if (next.thresholds[ret] == null) next.thresholds[ret] = 5;
  }

  const skus = new Set(parsed.rows.map((r) => r[3]));
  next.unmapped = [...skus].filter((s) => !(current.gp || {})[s]).sort();
  return next;
}

/** Refuse anything that looks like it would make the dashboard worse. */
function guard(current, next) {
  const curOrd = (current.maxYear || 0) * 100 + (current.maxWeek || 0);
  const newOrd = next.maxYear * 100 + next.maxWeek;

  if (newOrd < curOrd) {
    return { block: true, reason:
      `the file is older than what's live (week ${next.maxYear} W${next.maxWeek} vs ${current.maxYear} W${current.maxWeek})` };
  }
  if (newOrd === curOrd) {
    return { skip: true, reason: `week ${next.maxYear} W${next.maxWeek} is already published` };
  }
  const cur = (current.rows || []).length;
  if (cur > 0 && next.rows.length < cur * 0.9) {
    return { block: true, reason:
      `only ${next.rows.length} rows, down from ${cur} — that looks like a truncated file` };
  }
  return { ok: true };
}

module.exports = { parseWeekly, merge, guard, RET_MAP };
