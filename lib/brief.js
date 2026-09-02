/* The weekly brief — one line on the week, then three fixed slots:
 *
 *   1. the flagship line, at the retailers that matter for it
 *   2. how recent launches are doing
 *   3. red flags worth chasing
 *
 * Computed here and stored with the data, so the page, the Asana task and
 * anything else read exactly the same words. There is no second copy.
 *
 * Tunable from the data file, no code change needed:
 *   briefFlagship   { title, retailers[] }
 *   briefExclude    titles to keep out of the brief entirely
 *   newTitleWeeks   how long a title counts as "new"
 */

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const GOOD_BAND = 0.95, WARN_BAND = 0.50;
const QUIET_WEEKS = 4, QUIET_MIN_YTD = 500;
const MIN_DOORS = 25;
const LAUNCH_MIN_DOORS = 100;   // below this a "launch" is a handful of test stores
const LAUNCH_MIN_SALES = 500;

const DEFAULT_FLAGSHIP = { title: "Ransom Notes House Party", retailers: ["Target", "Walmart"] };
const DEFAULT_EXCLUDE = ["Ransom Notes Couples Edition"];
const DEFAULT_NEW_WEEKS = 12;

const money = (v) => "$" + Math.round(v).toLocaleString("en-US");
const pct = (v, dp = 1) => (v * 100).toFixed(dp) + "%";
const signed = (v, dp = 1) => (v > 0 ? "+" : "") + pct(v, dp);
const listOf = (a) => a.length <= 1 ? (a[0] || "")
  : a.length === 2 ? a.join(" and ")
  : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];

function index(data) {
  const byWeek = {}, cell = {}, pairs = {}, firstWeek = {};
  for (const r of data.rows) {
    const [ret, yr, wk, sku, sales, units, stores = 0] = r;
    const wkey = yr + "|" + wk, pkey = ret + "|" + sku;
    (byWeek[wkey] || (byWeek[wkey] = [])).push(r);
    const c = cell[pkey + "|" + wkey] || (cell[pkey + "|" + wkey] = { s: 0, d: 0 });
    c.s += sales; c.d += stores;
    const p = pairs[pkey] || (pairs[pkey] = { retailer: ret, sku, years: {} });
    p.years[yr] = (p.years[yr] || 0) + sales;
    if (sales > 0) {
      const ord = yr * 100 + wk;
      if (firstWeek[pkey] == null || ord < firstWeek[pkey]) firstWeek[pkey] = ord;
    }
  }
  return { byWeek, cell, pairs, firstWeek };
}

function build(data) {
  const I = index(data);
  const yr = data.maxYear, wk = data.maxWeek, ly = yr - 1;
  const flagship = data.briefFlagship || DEFAULT_FLAGSHIP;
  const exclude = new Set((data.briefExclude || DEFAULT_EXCLUDE).map((t) => t.toLowerCase()));
  const newWeeks = data.newTitleWeeks || DEFAULT_NEW_WEEKS;

  const titleOf = (sku) => (data.skuTitle || {})[sku] || sku;
  const weekDate = (y, w) => (data.weekDates || {})[y + "-" + w] || "";
  const at = (ret, sku, y, w) => I.cell[ret + "|" + sku + "|" + y + "|" + w] || { s: 0, d: 0 };
  const weekRows = (y, w) => I.byWeek[y + "|" + w] || [];
  const thrFor = (ret) => (data.thresholds || {})[ret] || 5;
  const prettyDate = (iso) => {
    if (!iso) return "";
    const p = iso.split("-");
    return MONTHS[+p[1] - 1] + " " + +p[2] + ", " + p[0];
  };
  /* every retailer/sku pair whose display title matches */
  const pairsForTitle = (title) => Object.values(I.pairs).filter(
    (p) => titleOf(p.sku).toLowerCase() === String(title).toLowerCase());

  /* doors this week, falling back to the most recent week that had any */
  const doorsNow = (ret, sku) => {
    for (let i = 0; i <= 8; i++) {
      const d = at(ret, sku, yr, wk - i).d;
      if (d > 0) return d;
    }
    return 0;
  };

  /* retailers that have gone silent — a data gap, not a sales collapse */
  const last = {}, ytdBy = {};
  for (const r of data.rows) {
    if (r[1] !== yr || r[4] <= 0) continue;
    if (!last[r[0]] || r[2] > last[r[0]]) last[r[0]] = r[2];
    ytdBy[r[0]] = (ytdBy[r[0]] || 0) + r[4];
  }
  const quiet = Object.keys(last).filter(
    (ret) => wk - last[ret] >= QUIET_WEEKS && ytdBy[ret] >= QUIET_MIN_YTD);

  /* ------------------------------ headline ------------------------------ */
  let pos = 0, posLy = 0, ytd = 0, ytdLy = 0;
  for (const r of weekRows(yr, wk)) pos += r[4];
  for (const r of weekRows(ly, wk)) posLy += r[4];
  for (let w = 1; w <= wk; w++) {
    for (const r of weekRows(yr, w)) ytd += r[4];
    for (const r of weekRows(ly, w)) ytdLy += r[4];
  }
  const wkComp = posLy > 0 ? pos / posLy - 1 : null;
  const ytdComp = ytdLy > 0 ? ytd / ytdLy - 1 : null;

  let headline = `Week ${wk} ending ${prettyDate(weekDate(yr, wk))} brought in ${money(pos)}`;
  if (wkComp != null) headline += `, ${wkComp >= 0 ? "up" : "down"} ${pct(Math.abs(wkComp))} on the same week last year`;
  if (ytdComp != null) headline += `. Year to date the business is ${signed(ytdComp)}`;
  headline += ".";

  /* --------------------- 1. the flagship, by retailer --------------------- */
  function slotFlagship() {
    const parts = [], perStore = [];
    let anyDown = false;
    for (const ret of flagship.retailers) {
      const p = pairsForTitle(flagship.title).find((x) => x.retailer === ret);
      if (!p) continue;
      const now = at(ret, p.sku, yr, wk), then = at(ret, p.sku, ly, wk).s;
      if (now.s <= 0 && then <= 0) continue;
      const comp = then > 0 ? now.s / then - 1 : null;
      if (comp != null && comp < 0) anyDown = true;
      parts.push(`${money(now.s)} at ${ret}${comp != null ? ` (${signed(comp, 0)})` : ""}`);
      const doors = doorsNow(ret, p.sku);
      if (doors >= MIN_DOORS) {
        perStore.push(`$${(now.s / doors).toFixed(2)} against a $${thrFor(ret)} ideal at ${ret}`);
      }
    }
    if (!parts.length) return null;
    let text = `${flagship.title} did ${listOf(parts)}.`;
    if (perStore.length) text += ` Per store that's ${listOf(perStore)}.`;
    return { up: !anyDown, slot: "flagship", text };
  }

  /* ------------------------ 2. how the new lines run ---------------------- */
  function slotNewTitles() {
    const cutoff = yr * 100 + wk - newWeeks;
    const rows = [];
    for (const k of Object.keys(I.pairs)) {
      const p = I.pairs[k], first = I.firstWeek[k];
      if (first == null || first < cutoff) continue;
      if (exclude.has(titleOf(p.sku).toLowerCase())) continue;
      const weeksOn = (yr * 100 + wk) - first + 1;
      let sinceLaunch = 0;
      for (let w = first % 100; w <= wk; w++) sinceLaunch += at(p.retailer, p.sku, yr, w).s;
      const doors = doorsNow(p.retailer, p.sku);
      if (doors < LAUNCH_MIN_DOORS && sinceLaunch < LAUNCH_MIN_SALES) continue;
      rows.push({ retailer: p.retailer, sku: p.sku, title: titleOf(p.sku),
                  doors, weeksOn, thisWeek: at(p.retailer, p.sku, yr, wk).s, sinceLaunch });
    }
    if (!rows.length) {
      return { up: true, slot: "new",
        text: `No new listings in the last ${newWeeks} weeks — the range is unchanged.` };
    }
    rows.sort((a, b) => b.doors - a.doors);

    const fresh = rows.filter((r) => r.weeksOn <= 2);
    const bedding = rows.filter((r) => r.weeksOn > 2);
    const bits = [];

    if (fresh.length) {
      const where = [...new Set(fresh.map((r) => r.retailer))];
      const names = fresh.slice(0, 3).map(
        (r) => `${r.title}${r.doors ? ` (${r.doors.toLocaleString("en-US")} doors)` : ""}`);
      const total = fresh.reduce((t, r) => t + r.thisWeek, 0);
      bits.push(`${listOf(names)} just went live at ${listOf(where)} — ${money(total)} in a first part-week, too early to read`);
    }
    for (const r of bedding.slice(0, 2)) {
      const thr = thrFor(r.retailer);
      const ps = r.doors >= MIN_DOORS ? r.thisWeek / r.doors : null;
      bits.push(ps != null
        ? `${r.title} is ${r.weeksOn} weeks in at ${r.retailer}, running $${ps.toFixed(2)} per store against a $${thr} ideal (${pct(ps / thr, 0)})`
        : `${r.title} is ${r.weeksOn} weeks in at ${r.retailer}, ${money(r.sinceLaunch)} since launch`);
    }
    const anyBelow = bedding.some(
      (r) => r.doors >= MIN_DOORS && r.thisWeek / r.doors < thrFor(r.retailer) * WARN_BAND);
    return { up: !anyBelow, slot: "new", text: bits.join(". ") + "." };
  }

  /* --------------------------- 3. red flags ------------------------------ */
  function slotRedFlags() {
    const flags = [];

    /* established lines sitting under half their ideal, worst first */
    const weak = [];
    for (const k of Object.keys(I.pairs)) {
      const p = I.pairs[k], first = I.firstWeek[k];
      if (!["Target", "Walmart", "B&N"].includes(p.retailer)) continue;
      if (exclude.has(titleOf(p.sku).toLowerCase())) continue;
      if ((data.excludePspw || []).includes(p.sku)) continue;
      if (first == null || first > yr * 100 + wk - newWeeks) continue;   // give new lines time
      const doors = doorsNow(p.retailer, p.sku);
      if (doors < MIN_DOORS) continue;
      let sales = 0, doorWeeks = 0;
      for (let i = 0; i < 4; i++) {
        const c = at(p.retailer, p.sku, yr, wk - i);
        sales += c.s; doorWeeks += c.d;
      }
      if (doorWeeks <= 0) continue;
      const ps = sales / doorWeeks, thr = thrFor(p.retailer);
      if (ps / thr < WARN_BAND) {
        weak.push({ retailer: p.retailer, title: titleOf(p.sku), ps, thr, ratio: ps / thr });
      }
    }
    weak.sort((a, b) => a.ratio - b.ratio);

    if (weak.length) {
      const byRet = {};
      weak.forEach((w) => { (byRet[w.retailer] || (byRet[w.retailer] = [])).push(w); });
      const worstRet = Object.keys(byRet).sort((a, b) => byRet[b].length - byRet[a].length)[0];
      const group = byRet[worstRet];
      if (group.length >= 2) {
        const names = group.slice(0, 3).map((w) => `${w.title} ($${w.ps.toFixed(2)})`);
        flags.push(`${worstRet} is the soft spot — ${group.length} lines are under half the $${group[0].thr} ideal on the 4-week average, including ${listOf(names)}`);
      } else {
        const w = weak[0];
        flags.push(`${w.retailer} ${w.title} is at $${w.ps.toFixed(2)} per store on the 4-week average, ${pct(w.ratio, 0)} of its $${w.thr} ideal`);
      }
    }

    /* retailers that have stopped reporting */
    if (quiet.length) {
      flags.push(`${listOf(quiet)} ${quiet.length > 1 ? "have" : "has"} reported nothing for ` +
        listOf(quiet.map((q) => `${wk - last[q]} weeks`)) + ` — missing from the totals, not zero`);
    }

    /* profit we cannot calculate */
    const unmapped = (data.unmapped || []).filter(
      (sku) => Object.values(I.pairs).some((p) => p.sku === sku && p.years[yr] > 0));
    if (unmapped.length) {
      flags.push(`${unmapped.length} SKU${unmapped.length > 1 ? "s have" : " has"} no gross profit mapped (${unmapped.join(", ")}), so those units sit outside profit and margin`);
    }

    if (!flags.length) return { up: true, slot: "flags", text: "No red flags this week." };
    return { up: false, slot: "flags", text: flags.slice(0, 2).join(". ") + "." };
  }

  const bullets = [slotFlagship(), slotNewTitles(), slotRedFlags()].filter(Boolean);

  /* caveats carried through to Asana */
  const caveats = quiet.map((ret) => {
    const iso = weekDate(yr, last[ret]);
    return `${ret} has reported no sales since week ${last[ret]}${iso ? ` (${prettyDate(iso)})` : ""} — ${wk - last[ret]} weeks. Its figures are missing from the totals, not zero.`;
  });
  if (data.caveat && data.caveat.text) {
    const lines = String(data.caveat.text).split(/\n+/).map((l) => l.trim()).filter(
      (l) => l && !/^(hello|regards|thanks)\b/i.test(l) &&
             !/contact your Brand Manager/i.test(l) && !/^Attached is your weekly/i.test(l));
    if (lines.length) caveats.push("From PSi's report email: " + lines.join(" "));
  }

  return { year: yr, week: wk, weekEnding: prettyDate(weekDate(yr, wk)),
           headline, bullets: bullets.map((b) => ({ up: b.up, slot: b.slot, text: b.text })),
           caveats };
}

module.exports = { build };
