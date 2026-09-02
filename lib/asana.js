/* Posting the weekly brief to Asana.
 *
 * Needs three things in the environment:
 *   ASANA_TOKEN     a personal access token (Asana → Settings → Apps →
 *                   Manage Developer Apps → Personal Access Tokens)
 *   ASANA_PROJECT   the project's gid — the long number in the project URL
 *   ASANA_NOTIFY    who to tag, as emails: evan@…,josh@…,dave@…
 *   ASANA_SECTION   optional — the section to file it under, by NAME
 *                   ("Retail Sales Weekly Reports") or by gid. Sections do not
 *                   appear in the Asana URL, so the name is the easy way in.
 *
 * Emails are resolved to Asana user gids at runtime and cached, so you never
 * have to go hunting for gids yourself.
 */

const API = process.env.ASANA_API || "https://app.asana.com/api/1.0";

function headers(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" };
}

async function call(token, path, init = {}) {
  const res = await fetch(API + path, { ...init, headers: headers(token) });
  const text = await res.text();
  let body = {};
  try { body = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = (body.errors && body.errors[0] && body.errors[0].message) || text.slice(0, 300);
    throw new Error(`Asana ${res.status} on ${path}: ${msg}`);
  }
  return body.data;
}

let cache = { at: 0, byEmail: null };
let sectionCache = { at: 0, byName: null, projectGid: null };

/** Look up the project's workspace, then map the notify emails to user gids. */
async function resolveUsers(token, projectGid, emails) {
  if (!emails.length) return [];
  if (cache.byEmail && Date.now() - cache.at < 12 * 3600 * 1000) {
    return emails.map((e) => cache.byEmail[e.toLowerCase()]).filter(Boolean);
  }
  const project = await call(token, `/projects/${projectGid}?opt_fields=workspace`);
  const workspace = project.workspace && project.workspace.gid;
  if (!workspace) throw new Error("Could not read the project's workspace.");

  const byEmail = {};
  let offset = "";
  for (let page = 0; page < 20; page++) {
    const q = `/users?workspace=${workspace}&opt_fields=name,email&limit=100` + (offset ? `&offset=${offset}` : "");
    const res = await fetch(API + q, { headers: headers(token) });
    const body = await res.json();
    if (!res.ok) throw new Error(`Asana ${res.status} listing users`);
    (body.data || []).forEach((u) => { if (u.email) byEmail[u.email.toLowerCase()] = u.gid; });
    offset = body.next_page && body.next_page.offset;
    if (!offset) break;
  }
  cache = { at: Date.now(), byEmail };

  const missing = emails.filter((e) => !byEmail[e.toLowerCase()]);
  if (missing.length) console.warn("Asana: no user found for " + missing.join(", "));
  return emails.map((e) => byEmail[e.toLowerCase()]).filter(Boolean);
}

/** Resolve a section name to its gid. Accepts a gid straight through. */
async function resolveSection(token, projectGid, section) {
  if (!section) return null;
  if (/^\d+$/.test(String(section).trim())) return String(section).trim();

  const fresh = sectionCache.byName && sectionCache.projectGid === projectGid &&
                Date.now() - sectionCache.at < 12 * 3600 * 1000;
  if (!fresh) {
    const rows = await call(token, `/projects/${projectGid}/sections?opt_fields=name&limit=100`);
    const byName = {};
    (rows || []).forEach((s) => { if (s.name) byName[s.name.trim().toLowerCase()] = s.gid; });
    sectionCache = { at: Date.now(), byName, projectGid };
  }
  const gid = sectionCache.byName[String(section).trim().toLowerCase()];
  if (!gid) {
    console.warn(`Asana: no section named "${section}" in project ${projectGid}. ` +
      `Sections found: ${Object.keys(sectionCache.byName).join(", ") || "none"}. ` +
      `The task will sit in the project's default section.`);
  }
  return gid || null;
}

/** Asana rich text: a <body> root and a short list of allowed tags. */
function toHtml(brief, url, mentionGids) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const parts = [];
  parts.push(`<strong>${esc(brief.headline)}</strong>`);
  if (brief.bullets.length) {
    parts.push("<ul>" + brief.bullets.map(
      (b) => `<li>${b.up ? "▲" : "▼"} ${esc(b.text)}</li>`).join("") + "</ul>");
  }
  if (brief.caveats.length) {
    parts.push("<strong>Read with this in mind</strong><ul>" +
      brief.caveats.map((c) => `<li>${esc(c)}</li>`).join("") + "</ul>");
  }
  if (url) parts.push(`<a href="${esc(url)}">Open the dashboard</a>`);
  if (mentionGids.length) {
    parts.push(mentionGids.map((g) => `<a data-asana-gid="${g}"/>`).join(" "));
  }
  return `<body>${parts.join("\n")}</body>`;
}

async function postWeeklyTask({ token, projectGid, notifyEmails, brief, dashboardUrl, section }) {
  const gids = await resolveUsers(token, projectGid, notifyEmails);

  const task = await call(token, "/tasks", {
    method: "POST",
    body: JSON.stringify({
      data: {
        name: `Weekly Retail Sales — ${brief.year} W${brief.week} (${brief.weekEnding})`,
        html_notes: toHtml(brief, dashboardUrl, gids),
        projects: [projectGid],
        followers: gids,
      },
    }),
  });

  /* Move it into the right section. If this fails the task still exists in the
     project, so warn rather than throw. */
  let sectionGid = null;
  try {
    sectionGid = await resolveSection(token, projectGid, section);
    if (sectionGid) {
      await call(token, `/sections/${sectionGid}/addTask`, {
        method: "POST",
        body: JSON.stringify({ data: { task: task.gid } }),
      });
    }
  } catch (e) {
    console.warn("Asana: could not file the task under its section — " + e.message);
    sectionGid = null;
  }

  return { gid: task.gid,
           url: task.permalink_url || `https://app.asana.com/0/${projectGid}/${task.gid}`,
           tagged: gids.length, section: sectionGid };
}

module.exports = { postWeeklyTask, toHtml, resolveUsers, resolveSection };
