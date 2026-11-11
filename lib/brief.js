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
const DEFAULT_LAUNCH_WEEKS = 35;   // ~8 months, the launch-status window

const money = (v) => "$" + Math.round(v).toLocaleString("en-US");
const pct = (v, dp = 1) => (v * 100).toFixed(dp) + "%";
const signed = (v, dp = 1) => (v > 0 ? "+" : "") + pct(v, dp);
const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th"
  : n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th");
const listOf = (a) => a.length <= 1 ? (a[0] || "")
  : a.length === 2 ? a.join(" and ")
  : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];

function index(data) {
  const byWeek = {}, cell = {}, pairs = {}, firstWeek = {};
  for (const r of data.rows) {
    const [ret, yr, wk, sku, sales, units, stores = 0] = r;
    const wkey = yr + "|" + wk, pkey = ret + "|" + sku;
    (byWeek[wkey] || (byWeek[wkey] = [])).push(r);
    const c = cell[pkey + "|" + wkey] || (cell[pkey + "|" + wkey] = { s: 0, d: 0, u: 0 });
    c.s += sales; c.d += stores; c.u += units;   // units: the discount slot needs an average price
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
  const gpOf = (sku) => {
    const a = data.gpAlias || {}, gp = data.gp || {};
    return gp[sku] || (a[sku] ? gp[a[sku]] : null);
  };
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

  /* ---- 1. the flagship, per store against its ideal, at each retailer ---- */
  function slotFlagship() {
    const parts = [];
    let anyDown = false;
    for (const ret of flagship.retailers) {
      const p = pairsForTitle(flagship.title).find((x) => x.retailer === ret);
      if (!p) continue;
      const now = at(ret, p.sku, yr, wk), then = at(ret, p.sku, ly, wk).s;
      if (now.s <= 0 && then <= 0) continue;
      const doors = doorsNow(ret, p.sku);
      const thr = thrFor(ret);
      const comp = then > 0 ? now.s / then - 1 : null;
      if (comp != null && comp < 0) anyDown = true;
      const ps = doors >= MIN_DOORS ? `$${(now.s / doors).toFixed(2)} PSPW` : money(now.s);
      parts.push(`${ret} ${ps} against $${thr} ideal` +
        (comp != null ? ` (${signed(comp, 0)} comped to this week last year)` : " (no matching week last year)"));
    }
    if (!parts.length) return null;
    return { up: !anyDown, slot: "flagship", text: `${flagship.title}: ${listOf(parts)}.` };
  }

  /* ---- the launch list: everything listed inside the last 8 months ------- */
  const RETAILER_ORDER = ["Target", "Walmart", "B&N"];

  function slotLaunchStatus() {
    const weeks = data.launchWeeks || DEFAULT_LAUNCH_WEEKS;
    const cutoff = yr * 100 + wk - weeks;
    const rows = [];
    for (const k of Object.keys(I.pairs)) {
      const p = I.pairs[k], first = I.firstWeek[k];
      if (first == null || first < cutoff) continue;
      if (exclude.has(titleOf(p.sku).toLowerCase())) continue;
      const doors = doorsNow(p.retailer, p.sku);
      let sinceLaunch = 0;
      for (let w = first % 100; w <= wk; w++) sinceLaunch += at(p.retailer, p.sku, yr, w).s;
      if (doors < LAUNCH_MIN_DOORS && sinceLaunch < LAUNCH_MIN_SALES) continue;
      const thisWeek = at(p.retailer, p.sku, yr, wk).s;
      rows.push({ retailer: p.retailer, title: titleOf(p.sku), doors,
                  weeksOn: (yr * 100 + wk) - first + 1, thisWeek, sinceLaunch,
                  ps: doors >= MIN_DOORS ? thisWeek / doors : null,
                  thr: thrFor(p.retailer) });
    }
    if (!rows.length) {
      return { up: true, slot: "launches",
        text: `No titles listed in the last ${Math.round(weeks / 4.345)} months.` };
    }
    rows.sort((a, b) => {
      const ai = RETAILER_ORDER.indexOf(a.retailer), bi = RETAILER_ORDER.indexOf(b.retailer);
      const ar = ai < 0 ? 99 : ai, br = bi < 0 ? 99 : bi;
      if (ar !== br) return ar - br;
      if (a.retailer !== b.retailer) return a.retailer < b.retailer ? -1 : 1;
      return b.doors - a.doors;
    });
    /* one line per listing, as a nested list under a heading */
    const lines = rows.map((r) => `\u2022 ${r.retailer}: ${r.title} ` +
      (r.ps != null ? `$${r.ps.toFixed(2)} PSPW vs. $${r.thr} ideal`
                    : `${money(r.thisWeek)} this week, too few doors to read per store`));
    const anyBelow = rows.some((r) => r.ps != null && r.ps < r.thr * WARN_BAND);
    return { up: !anyBelow, slot: "launches", text: "New Launch Status:\n" + lines.join("\n") };
  }

  /* --- 3. what sold below its MSRP this week, by SKU and retailer --------- */
  const DISCOUNT_MIN = 0.10;      // under this it's rounding, not a markdown
  const UNUSUAL_MIN = 0.08;       // cheaper than this SKU normally goes = a real move

  function aspFor(ret, sku, year, week) {
    const c = I.cell[ret + "|" + sku + "|" + year + "|" + week];
    return c && c.u > 0 ? c.s / c.u : null;
  }

  function slotDiscounts() {
    const found = [];
    for (const k of Object.keys(I.pairs)) {
      const p = I.pairs[k];
      const g = gpOf(p.sku);
      if (!g || !g.msrp) continue;
      const asp = aspFor(p.retailer, p.sku, yr, wk);
      if (asp == null) continue;
      const off = 1 - asp / g.msrp;
      if (off < DISCOUNT_MIN) continue;

      /* is this a markdown, or just where this line always sells? */
      const hist = [];
      for (let w = wk - 12; w < wk; w++) {
        const a = aspFor(p.retailer, p.sku, yr, w);
        if (a != null) hist.push(a);
      }
      hist.sort((a, b) => a - b);
      const median = hist.length >= 4 ? hist[Math.floor(hist.length / 2)] : null;
      const vsUsual = median ? 1 - asp / median : null;

      const cell = I.cell[p.retailer + "|" + p.sku + "|" + yr + "|" + wk];
      found.push({ retailer: p.retailer, title: titleOf(p.sku), units: cell.u,
                   asp, msrp: g.msrp, off, vsUsual });
    }
    if (!found.length) {
      return { up: true, slot: "discounts",
        text: "Nothing sold more than 10% below its MSRP this week." };
    }
    found.sort((a, b) => b.off - a.off);
    const bits = found.slice(0, 4).map((f) => {
      let t = `${f.retailer} ${f.title} ${f.units.toLocaleString("en-US")} unit` +
        (f.units === 1 ? "" : "s") + ` at $${f.asp.toFixed(2)} against a $${f.msrp.toFixed(2)} MSRP (${signed(-f.off, 0)})`;
      if (f.vsUsual != null && f.vsUsual >= UNUSUAL_MIN) t += `, ${pct(f.vsUsual, 0)} below where it normally sells`;
      else if (f.vsUsual != null && f.vsUsual < UNUSUAL_MIN) t += ", about where it normally sells";
      return t;
    });
    const fresh = found.some((f) => f.vsUsual != null && f.vsUsual >= UNUSUAL_MIN);
    let text = "Sold below MSRP this week: " + bits.join("; ") + ".";
    if (found.length > 4) text += ` ${found.length - 4} more line${found.length - 4 === 1 ? "" : "s"} also sold under MSRP.`;
    return { up: !fresh, slot: "discounts", text };
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

  const bullets = [slotFlagship(), slotDiscounts(), slotLaunchStatus()].filter(Boolean);

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
