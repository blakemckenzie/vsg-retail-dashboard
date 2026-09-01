/**
 * Very Special Games — weekly retail report, hands-free.
 *
 * Runs on a timer inside your own Google account. Finds PSi's "Weekly Dashboard"
 * email, takes the .xlsx off it, and posts it to the dashboard. Nobody uploads
 * anything. The email body goes across too, so PSi's own caveats ("no Indigo
 * sales this week") show up on the dashboard instead of being lost.
 *
 * SETUP
 *  1. script.google.com → New project. Paste this in, replacing everything.
 *  2. Fill in DASHBOARD_URL and INGEST_SECRET below.
 *  3. Run ▶ checkForReport once. Google asks you to authorise — accept.
 *  4. Left sidebar → Triggers (clock icon) → Add Trigger:
 *       function: checkForReport
 *       source:   Time-driven → Day timer → 6am–7am
 *     One a day is plenty. PSi sends Wednesday mornings; a daily check picks it
 *     up within hours and covers late or resent reports without any fuss.
 */

// ────────────────────────────────────────────────────────────────────
const DASHBOARD_URL = 'https://YOUR-SERVICE.onrender.com';   // no trailing slash
const INGEST_SECRET = 'PASTE-THE-SAME-SECRET-YOU-SET-IN-RENDER';
const SENDER        = 'Reporting@pubservinc.com';
const SUBJECT       = 'Weekly Dashboard';
const ALERT_EMAIL   = Session.getActiveUser().getEmail();    // where problems go
const STALE_DAYS    = 8;   // no report in this long → tell me
// ────────────────────────────────────────────────────────────────────

function checkForReport() {
  var props = PropertiesService.getScriptProperties();

  var threads = GmailApp.search(
    'from:' + SENDER + ' subject:"' + SUBJECT + '" has:attachment newer_than:60d', 0, 10);

  var newest = null;
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (m.getFrom().toLowerCase().indexOf(SENDER.toLowerCase()) === -1) return;
      if (!newest || m.getDate() > newest.getDate()) newest = m;
    });
  });

  if (!newest) {
    notify('No PSi report found',
      'Searched the last 60 days for "' + SUBJECT + '" from ' + SENDER + ' and found nothing. ' +
      'Either the sender changed or the mail is being filtered somewhere I can\'t see.');
    return;
  }

  var ageDays = (new Date() - newest.getDate()) / 86400000;
  if (ageDays > STALE_DAYS) {
    notify('PSi report looks overdue',
      'The most recent "' + SUBJECT + '" is ' + Math.floor(ageDays) + ' days old (' +
      newest.getDate() + '). PSi may not have sent this week\'s report.');
  }

  if (props.getProperty('lastMessageId') === newest.getId()) {
    Logger.log('Already handled message ' + newest.getId() + ' — nothing to do.');
    return;
  }

  var file = null;
  newest.getAttachments().forEach(function (a) {
    var n = a.getName().toLowerCase();
    if (n.slice(-5) === '.xlsx' || n.slice(-5) === '.xlsm') file = a;
  });
  if (!file) {
    notify('PSi email had no workbook',
      'Found the email from ' + newest.getDate() + ' but there was no .xlsx attached.');
    return;
  }

  var payload = {
    secret: INGEST_SECRET,
    filename: file.getName(),
    emailBody: newest.getPlainBody(),
    receivedAt: newest.getDate().toISOString(),
    fileBase64: Utilities.base64Encode(file.getBytes())
  };

  var res = UrlFetchApp.fetch(DASHBOARD_URL + '/api/ingest', {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  var code = res.getResponseCode();
  var body = {};
  try { body = JSON.parse(res.getContentText()); } catch (e) {}

  if (code === 200 && body.ok) {
    props.setProperty('lastMessageId', newest.getId());
    if (body.skipped) {
      Logger.log('Dashboard already had that week: ' + body.reason);
    } else {
      Logger.log('Published ' + body.maxYear + ' W' + body.maxWeek + ' — ' + body.rows + ' rows.');
    }
    return;
  }

  // Don't record the message id, so the next run retries.
  notify('Dashboard update failed',
    'Posting ' + file.getName() + ' to the dashboard returned HTTP ' + code + '.\n\n' +
    (body.error || res.getContentText().slice(0, 500)) + '\n\n' +
    'Nothing on the dashboard changed — it is still showing the previous week. ' +
    'This will retry on the next run.');
}

function notify(subject, message) {
  Logger.log(subject + ' — ' + message);
  try {
    MailApp.sendEmail(ALERT_EMAIL, '[Retail dashboard] ' + subject, message);
  } catch (e) {
    Logger.log('Could not send the alert email: ' + e);
  }
}

/** Run this by hand to push the newest report again, even if it was already handled. */
function forceResend() {
  PropertiesService.getScriptProperties().deleteProperty('lastMessageId');
  checkForReport();
}
