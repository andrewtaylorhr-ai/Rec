/**
 * Driver Submission Tracker - Google Apps Script backend.
 * GMAIL API VERSION - HIGH VOLUME, THREAD-BASED.
 *
 * Each driver row carries the WHOLE thread (submission + every reply) so the
 * dashboard can show the latest message. The list is fetched in parallel with
 * UrlFetchApp.fetchAll and cached for 5 hours.
 *
 * SETUP - the Gmail API service must be on:
 *   Services (+ in the left sidebar) -> Gmail API -> Add.
 *
 * Deploy as a Web app (Execute as: Me, Access: Only myself).
 */

// ---- Config ----
var SUBMISSION_SENDER = 'no-reply@classarecruitinginc.com';
var DEFAULT_WINDOW_DAYS = 30;
var DATA_START = '2026/4/1';          // ignore anything before this date
var MAX_THREADS = 3500;               // main list cap
var SUMMARY_MAX = 6000;               // 12-month summary cap
var SUMMARY_TIME_BUDGET_MS = 240000;  // summary stops before timing out
var FETCH_CHUNK = 100;                // parallel requests per batch

var LIST_CACHE_SECONDS = 21600;       // 6 hours (longer cache = far fewer Gmail fetches/day, avoids urlfetch quota)
var THREAD_CACHE_SECONDS = 3600;      // 1 hour
var SUMMARY_CACHE_SECONDS = 43200;    // 12 hours (the 12-month summary changes slowly)
var CHUNK_SIZE = 90000;
// Read the Gemini key from Script Properties so it is never committed in source.
// Set it once: run setGeminiKey('your-key') below, OR Project Settings -> Script Properties -> add GEMINI_API_KEY.
var GEMINI_API_KEY = (function () {
  try { return PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY') || ''; }
  catch (e) { return ''; }
})();
var GEMINI_MODEL = 'gemini-2.5-flash';

// One-time setup helper. Paste your rotated key, run this once from the editor, then clear the key out.
function setGeminiKey(key) {
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', String(key || '').trim());
  console.log('GEMINI_API_KEY stored in Script Properties.');
}

// ---- doGet ----
function doGet(e) {
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('Driver Submission Tracker')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ---- Reverse geocode a map click to a city + state (OpenStreetMap Nominatim, server-side) ----
function reverseGeocode(lat, lng) {
  try {
    var url = 'https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&addressdetails=1' +
              '&lat=' + encodeURIComponent(lat) + '&lon=' + encodeURIComponent(lng);
    var resp = UrlFetchApp.fetch(url, {
      headers: { 'User-Agent': 'DriverSubmissionTracker/1.0 (recruiting dashboard)' },
      muteHttpExceptions: true
    });
    if (resp.getResponseCode() !== 200) return { error: 'Geocoder ' + resp.getResponseCode() };
    var data = JSON.parse(resp.getContentText());
    var a = (data && data.address) || {};
    var city = a.city || a.town || a.village || a.hamlet || a.municipality || a.county || '';
    return { city: city, state: a.state || '', country: a.country_code || '' };
  } catch (e) {
    return { error: String(e) };
  }
}

// ---- Team assignments stored server-side (synced across all devices) ----
// Saved in Script Properties as JSON, chunked under the 9KB-per-value limit.
// Payload shape: { states: {recruiter:[STATE,...]}, cities: {recruiter:{STATE:[{n,lat,lng},...]}} }
function getTeamAssignments() {
  try {
    var props = PropertiesService.getScriptProperties();
    var n = parseInt(props.getProperty('ASSIGN_N') || '0', 10);
    if (!n) return { states: {}, cities: {} };
    var s = '';
    for (var i = 0; i < n; i++) s += (props.getProperty('ASSIGN_' + i) || '');
    var obj = JSON.parse(s);
    return { states: obj.states || {}, cities: obj.cities || {} };
  } catch (e) {
    return { states: {}, cities: {}, error: String(e) };
  }
}
function saveTeamAssignments(payload) {
  try {
    var data = (typeof payload === 'string') ? payload : JSON.stringify(payload || {});
    var props = PropertiesService.getScriptProperties();
    var oldN = parseInt(props.getProperty('ASSIGN_N') || '0', 10);
    for (var i = 0; i < oldN; i++) props.deleteProperty('ASSIGN_' + i);
    var CH = 8000, n = 0;
    for (var p = 0; p < data.length; p += CH) { props.setProperty('ASSIGN_' + n, data.substring(p, p + CH)); n++; }
    if (n === 0) { props.setProperty('ASSIGN_0', ''); n = 1; }
    props.setProperty('ASSIGN_N', String(n));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

// ---- Chunked cache ----
function cacheGet(key) {
  try {
    var cache = CacheService.getScriptCache();
    var head = cache.get(key + '__n');
    if (!head) return null;
    var n = parseInt(head, 10);
    if (!n) return null;
    var keys = [];
    for (var i = 0; i < n; i++) keys.push(key + '__' + i);
    var parts = cache.getAll(keys);
    var out = '';
    for (var j = 0; j < n; j++) {
      var piece = parts[key + '__' + j];
      if (piece == null) return null;
      out += piece;
    }
    return out;
  } catch (err) {
    console.log('Cache read skipped: ' + err);
    return null;
  }
}

function cachePut(key, value, seconds) {
  try {
    var cache = CacheService.getScriptCache();
    var chunks = {};
    var n = 0;
    for (var i = 0; i < value.length; i += CHUNK_SIZE) {
      chunks[key + '__' + n] = value.substring(i, i + CHUNK_SIZE);
      n++;
    }
    chunks[key + '__n'] = String(n);
    cache.putAll(chunks, seconds);
  } catch (err) {
    console.log('Cache write skipped: ' + err);
  }
}

// ---- List IDs matching a query (Gmail Advanced Service, paged) ----
function listThreadIds(query, max) {
  var ids = [];
  var pageToken = null;
  do {
    var args = { q: query, maxResults: 500 };
    if (pageToken) args.pageToken = pageToken;
    var resp = Gmail.Users.Threads.list('me', args);
    if (resp && resp.threads) {
      for (var i = 0; i < resp.threads.length; i++) ids.push(resp.threads[i].id);
    }
    pageToken = resp ? resp.nextPageToken : null;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

function listMessageIds(query, max) {
  var ids = [];
  var pageToken = null;
  do {
    var args = { q: query, maxResults: 500 };
    if (pageToken) args.pageToken = pageToken;
    var resp = Gmail.Users.Messages.list('me', args);
    if (resp && resp.messages) {
      for (var i = 0; i < resp.messages.length; i++) ids.push(resp.messages[i].id);
    }
    pageToken = resp ? resp.nextPageToken : null;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

// ---- Parallel batch fetch via the Gmail REST API ----
// kind = 'threads' or 'messages'. Returns parsed JSON objects (or null).
function fetchChunk(ids, token, kind) {
  if (!ids.length) return [];
  var requests = ids.map(function(id) {
    return {
      url: 'https://gmail.googleapis.com/gmail/v1/users/me/' + kind + '/' + encodeURIComponent(id) +
           '?format=metadata&metadataHeaders=Subject&metadataHeaders=From',
      headers: { Authorization: 'Bearer ' + token },
      muteHttpExceptions: true
    };
  });
  var responses = UrlFetchApp.fetchAll(requests);
  var out = [];
  for (var i = 0; i < responses.length; i++) {
    try {
      if (responses[i].getResponseCode() === 200) {
        out.push(JSON.parse(responses[i].getContentText()));
      } else {
        out.push(null);
      }
    } catch (e) {
      out.push(null);
    }
  }
  return out;
}

function batchGet(ids, kind) {
  // Gmail ADVANCED SERVICE fetch. UrlFetchApp.fetchAll to the Gmail REST API HANGS inside the
  // published web app (works only in the editor), so we use the Advanced Service here — it's the
  // method that actually loads data in the deployed app (proven by the working v50). Sequential,
  // light retry. Uses the Gmail read quota (separate from the urlfetch quota).
  var result = [];
  var mh = ['Subject', 'From'];
  for (var i = 0; i < ids.length; i++) {
    var obj = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      try {
        obj = (kind === 'threads')
          ? Gmail.Users.Threads.get('me', ids[i], { format: 'metadata', metadataHeaders: mh })
          : Gmail.Users.Messages.get('me', ids[i], { format: 'metadata', metadataHeaders: mh });
        break;
      } catch (e) {
        if (attempt === 0) Utilities.sleep(150); else obj = null;
      }
    }
    result.push(obj);
  }
  return result;
}

// ===================================================================
// SHEET-BACKED DATA STORE  (instant loads, no Gmail quota on page load)
// -------------------------------------------------------------------
// A 15-minute time trigger (syncToSheet) keeps a Google Sheet up to
// date in the background. The web app reads from that Sheet instead of
// hitting Gmail on every load, so page loads drop from ~60-90s to ~1-3s
// and can never exhaust the daily Gmail quota no matter how often the
// page is reloaded. The Gmail fetching happens quietly in the trigger.
// ===================================================================
var DB_TAB = 'Drivers';

// Open (or create on first use) the backing spreadsheet. Its id lives in Script Properties.
function getDbSheet_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DB_SHEET_ID');
  var ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {
    ss = SpreadsheetApp.create('Driver Tracker DB');
    props.setProperty('DB_SHEET_ID', ss.getId());
  }
  var sh = ss.getSheetByName(DB_TAB);
  if (!sh) {
    sh = ss.insertSheet(DB_TAB);
    sh.getRange(1, 1, 1, 3).setValues([['threadId', 'date', 'json']]);
  }
  return sh;
}

// Read every stored driver row back into the same shape fetchSubmissions used to return.
function getDriversFromSheet() {
  var sh = getDbSheet_();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 3, last - 1, 1).getValues(); // the json column
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var s = vals[i][0];
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch (e) {}
  }
  return out;
}

// Overwrite the Drivers tab with the given rows (array of driver objects).
function writeDriversToSheet_(rows) {
  var sh = getDbSheet_();
  rows = rows || [];
  rows.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  var out = [];
  for (var i = 0; i < rows.length; i++) {
    out.push([rows[i].threadId || '', rows[i].date || '', JSON.stringify(rows[i])]);
  }
  var last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, 3).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, 3).setValues(out);
  PropertiesService.getScriptProperties().setProperty('DB_SYNCED_AT', new Date().toISOString());
}

// Background sync: pull recent (or all) submission threads from Gmail and upsert
// them into the Sheet by threadId. Runs on the 15-min trigger and on "Refresh now".
// opts.full = rebuild everything since DATA_START (used for the first seed).
function syncToSheet(opts) {
  opts = opts || {};
  var lock = LockService.getScriptLock();
  try { lock.waitLock(30000); } catch (e) { return { ok: false, error: 'busy' }; }
  try {
    var existing = getDriversFromSheet();
    var byId = {};
    for (var i = 0; i < existing.length; i++) {
      if (existing[i] && existing[i].threadId) byId[existing[i].threadId] = existing[i];
    }
    var query;
    if (opts.full || existing.length === 0) {
      query = 'from:' + SUBMISSION_SENDER + ' subject:submission after:' + DATA_START;
    } else {
      // overlap window catches new submissions AND replies that bump old threads
      query = 'from:' + SUBMISSION_SENDER + ' subject:submission newer_than:3d after:' + DATA_START;
    }
    var ids = listThreadIds(query, MAX_THREADS);
    var threads = batchGet(ids, 'threads');
    var changed = 0;
    for (var t = 0; t < threads.length; t++) {
      if (!threads[t]) continue;
      try {
        var row = threadToDriverRow(threads[t]);
        byId[row.threadId] = row;
        changed++;
      } catch (err) {}
    }
    var merged = [];
    for (var k in byId) { if (byId.hasOwnProperty(k)) merged.push(byId[k]); }
    writeDriversToSheet_(merged);
    ensureSyncTrigger_();
    return { ok: true, total: merged.length, fetched: ids.length, changed: changed };
  } catch (e) {
    return { ok: false, error: String(e) };
  } finally {
    try { lock.releaseLock(); } catch (e2) {}
  }
}

// One-time helpers (safe to run from the editor):
function seedSheet() { return syncToSheet({ full: true }); }       // full rebuild
function installSyncTrigger() { return ensureSyncTrigger_(); }     // install the trigger

function resetHermesSeedCursor() {
  var props = PropertiesService.getScriptProperties();
  props.deleteProperty('HERMES_SEED_OFFSET');
  console.log(JSON.stringify({ ok: true, reset: true }, null, 2));
  return { ok: true, reset: true };
}

function seedSheetChunk() {
  return seedSheetChunk_(200);
}

function seedSheetChunk_(chunkSize) {
  chunkSize = chunkSize || 200;
  var props = PropertiesService.getScriptProperties();
  var offset = parseInt(props.getProperty('HERMES_SEED_OFFSET') || '0', 10) || 0;
  var query = 'from:' + SUBMISSION_SENDER + ' subject:submission after:' + DATA_START;
  var ids = listThreadIds(query, MAX_THREADS);
  var slice = ids.slice(offset, offset + chunkSize);
  var existing = getDriversFromSheet();
  var byId = {};
  for (var i = 0; i < existing.length; i++) {
    if (existing[i] && existing[i].threadId) byId[existing[i].threadId] = existing[i];
  }
  var threads = batchGet(slice, 'threads');
  var changed = 0;
  var rejected = 0;
  var rejectReasons = {};
  for (var t = 0; t < threads.length; t++) {
    if (!threads[t]) { rejected++; inc_(rejectReasons, 'thread_fetch_null'); continue; }
    try {
      var row = threadToDriverRow(threads[t]);
      byId[row.threadId] = row;
      changed++;
    } catch (err) {
      rejected++;
      inc_(rejectReasons, String(err).substring(0, 140));
    }
  }
  var merged = [];
  for (var k in byId) { if (byId.hasOwnProperty(k)) merged.push(byId[k]); }
  writeDriversToSheet_(merged);
  var nextOffset = offset + slice.length;
  var done = nextOffset >= ids.length || slice.length === 0;
  if (done) props.deleteProperty('HERMES_SEED_OFFSET');
  else props.setProperty('HERMES_SEED_OFFSET', String(nextOffset));
  var out = {
    ok: true,
    query: query,
    totalCandidateThreads: ids.length,
    offsetStarted: offset,
    chunkSize: chunkSize,
    processedThisRun: slice.length,
    changedThisRun: changed,
    rejectedThisRun: rejected,
    rejectReasons: rejectReasons,
    storedDriversTotal: merged.length,
    nextOffset: done ? null : nextOffset,
    done: done
  };
  console.log(JSON.stringify(out, null, 2));
  return out;
}

// Install the 15-minute background sync trigger exactly once (idempotent).
function ensureSyncTrigger_() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SYNC_TRIGGER_ON') === '1') return { ok: true, already: true };
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'syncToSheet') {
      props.setProperty('SYNC_TRIGGER_ON', '1');
      return { ok: true, already: true };
    }
  }
  ScriptApp.newTrigger('syncToSheet').timeBased().everyMinutes(15).create();
  props.setProperty('SYNC_TRIGGER_ON', '1');
  return { ok: true, installed: true };
}

// Status for the UI: when the Sheet was last refreshed + how many drivers it holds.
function getSyncInfo() {
  var props = PropertiesService.getScriptProperties();
  var sh = getDbSheet_();
  return { syncedAt: props.getProperty('DB_SYNCED_AT') || null, count: Math.max(0, sh.getLastRow() - 1) };
}

// ---- fetchSubmissions: now reads from the Sheet (instant), filtered by range ----
function fetchSubmissions(range, force) {
  if (force) { try { syncToSheet(); } catch (e) {} }
  var all = getDriversFromSheet();
  // First ever load: Sheet is empty -> do one full seed so the app is never blank.
  if (!all.length) {
    try { syncToSheet({ full: true }); all = getDriversFromSheet(); } catch (e) {}
  }
  // Resolve the [startMs, endMs) window from the requested range.
  var startMs, endMs = null;
  var mm = String(range == null ? '' : range).match(/^month:(\d{4})-(\d{1,2})$/);
  if (mm) {
    var y = parseInt(mm[1], 10), mo = parseInt(mm[2], 10);
    startMs = new Date(y, mo - 1, 1).getTime();
    endMs = new Date(mo === 12 ? y + 1 : y, mo === 12 ? 0 : mo, 1).getTime();
  } else {
    var daysBack = parseInt(range, 10) || DEFAULT_WINDOW_DAYS;
    startMs = Date.now() - daysBack * 86400000;
  }
  // Never go earlier than DATA_START.
  var ds = String(DATA_START).split('/');
  var dataStartMs = new Date(parseInt(ds[0], 10), parseInt(ds[1], 10) - 1, parseInt(ds[2], 10)).getTime();
  if (!isNaN(dataStartMs)) startMs = Math.max(startMs, dataStartMs);

  var out = [];
  for (var i = 0; i < all.length; i++) {
    var dms = new Date(all[i].date || 0).getTime();
    if (isNaN(dms) || dms < startMs) continue;
    if (endMs != null && dms >= endMs) continue;
    out.push(all[i]);
  }
  out.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
  return out;
}

// Return true if the email body looks like a system notification, not a real
// driver submission (e.g. "X pending app(s) need updated", "Click the link below
// to manage these apps in driver manager"). These come from the same sender but
// they are NOT submissions - they should not show up as Unknown drivers.
function isNotificationEmail(subject, body) {
  var t = ((subject || '') + ' ' + (body || '')).toLowerCase();
  var patterns = [
    'click the link below to manage',
    'manage pending applications',
    'pending app(s) need updated',
    'pending app(s) need',
    'pending applications need',
    'manage these apps in driver manager',
    'driver manager',
    'need updated'
  ];
  for (var i = 0; i < patterns.length; i++) {
    if (t.indexOf(patterns[i]) >= 0) return true;
  }
  // Real submissions always start with "Application Info" - if a body has none
  // of the expected submission fields, treat it as noise.
  if (t.indexOf('application info') < 0 && t.indexOf('name:') < 0 && t.indexOf('phone') < 0) {
    return true;
  }
  return false;
}

// Convert a Gmail thread (metadata) into a driver row with all its messages.
function threadToDriverRow(thread) {
  var raw = (thread.messages || []).slice();
  raw.sort(function(a, b) {
    return (parseInt(a.internalDate, 10) || 0) - (parseInt(b.internalDate, 10) || 0);
  });
  var msgObjs = [];
  for (var i = 0; i < raw.length; i++) {
    var m = raw[i];
    var p = m.payload || {};
    var from = getHeader(p, 'From');
    var dms = parseInt(m.internalDate, 10);
    var snip = decodeEntities(m.snippet || '');
    msgObjs.push({
      from: from,
      sender: from,
      date: isNaN(dms) ? '' : new Date(dms).toISOString(),
      subject: getHeader(p, 'Subject'),
      body: snip,
      snippet: snip.substring(0, 320),
      isSubmission: String(from).toLowerCase().indexOf(SUBMISSION_SENDER) >= 0
    });
  }
  var first = msgObjs[0] || { from: '', date: '', subject: '', body: '' };
  var last = msgObjs[msgObjs.length - 1] || first;
  if (isNotificationEmail(first.subject, first.body)) {
    throw 'notification email, not a submission';
  }
  var parsed = parseSubmissionBody('', first.subject, first.body);
  return {
    threadId: thread.id,
    date: first.date,
    subject: first.subject,
    snippet: (first.body || '').substring(0, 320),
    name: parsed.name,
    email: parsed.email,
    phone: parsed.phone,
    carrier: parsed.carrier,
    recruiter: parsed.recruiter,
    message: parsed.message,
    messages: msgObjs,
    replyCount: Math.max(0, msgObjs.length - 1),
    lastReplyAt: msgObjs.length > 1 ? last.date : null,
    permalink: permalinkFor(thread.id)
  };
}

// ---- fetchThread: full bodies for ONE thread (detail drawer), cached ----
function fetchThread(threadId) {
  var cacheKey = 'gthr5_' + threadId;
  var cached = cacheGet(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  var thread = Gmail.Users.Threads.get('me', threadId, { format: 'full' });
  if (!thread) return { error: 'thread not found' };
  var result = {
    messages: messagesToObjects(thread.messages || [], true),
    permalink: permalinkFor(threadId)
  };
  cachePut(cacheKey, JSON.stringify(result), THREAD_CACHE_SECONDS);
  return result;
}

// ---- fetchSummary: lightweight data for the Performance page (reads the Sheet) ----
// The Sheet already holds every submission since DATA_START, so derive the summary
// straight from it instead of hitting Gmail (avoids the old fetchAll hang + quota).
function fetchSummary(daysBack) {
  var all = getDriversFromSheet();
  if (!all.length) {
    try { syncToSheet({ full: true }); all = getDriversFromSheet(); } catch (e) {}
  }
  var out = [];
  for (var i = 0; i < all.length; i++) {
    out.push({
      threadId: all[i].threadId,
      date: all[i].date,
      name: all[i].name,
      recruiter: all[i].recruiter,
      carrier: all[i].carrier
    });
  }
  return out;
}

// ---- Helpers ----

function messagesToObjects(messages, allBodies) {
  messages = (messages || []).slice();
  messages.sort(function(a, b) {
    return (parseInt(a.internalDate, 10) || 0) - (parseInt(b.internalDate, 10) || 0);
  });
  var n = messages.length;
  var out = [];
  for (var j = 0; j < n; j++) {
    var isFirst = (j === 0);
    var isLast = (j === n - 1);
    var needBody = allBodies || isFirst || isLast;
    var obj = gmailMessageToObject(messages[j], needBody);
    var cap = (allBodies || isFirst) ? 200000 : 2000;
    obj.body = (obj.body || '').substring(0, cap);
    out.push(obj);
  }
  return out;
}

function gmailMessageToObject(msg, needBody) {
  var payload = (msg && msg.payload) || {};
  var from = getHeader(payload, 'From');
  var subject = getHeader(payload, 'Subject');
  var dateMs = parseInt(msg && msg.internalDate, 10);
  var dateIso = isNaN(dateMs) ? '' : new Date(dateMs).toISOString();
  var gmailSnippet = decodeEntities((msg && msg.snippet) || '');
  var body = needBody ? extractBody(payload, msg && msg.id) : '';
  if (needBody && !body) body = gmailSnippet;
  return {
    from: from,
    sender: from,
    date: dateIso,
    subject: subject,
    body: body,
    snippet: (body || gmailSnippet || '').substring(0, 600),
    isSubmission: String(from).toLowerCase().indexOf(SUBMISSION_SENDER) >= 0
  };
}

function getHeader(payload, name) {
  if (!payload || !payload.headers) return '';
  var want = String(name).toLowerCase();
  for (var i = 0; i < payload.headers.length; i++) {
    var h = payload.headers[i];
    if (h && String(h.name || '').toLowerCase() === want) return h.value || '';
  }
  return '';
}

function decodeData(data) {
  if (!data) return '';
  var s = String(data);
  try {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(s)).getDataAsString('UTF-8');
  } catch (e) {}
  try {
    var std = s.replace(/-/g, '+').replace(/_/g, '/');
    while (std.length % 4) std += '=';
    return Utilities.newBlob(Utilities.base64Decode(std)).getDataAsString('UTF-8');
  } catch (e2) {}
  return '';
}

function extractBody(payload, messageId) {
  if (!payload) return '';
  var plain = [];
  var html = [];
  function readPartData(part) {
    if (!part || !part.body) return '';
    if (part.body.data) return decodeData(part.body.data);
    if (part.body.attachmentId && messageId) {
      try {
        var att = Gmail.Users.Messages.Attachments.get('me', messageId, part.body.attachmentId);
        if (att && att.data) return decodeData(att.data);
      } catch (e) {
        console.log('Attachment read skipped: ' + e);
      }
    }
    return '';
  }
  function walk(part) {
    if (!part) return;
    var mime = String(part.mimeType || '').toLowerCase();
    if (mime === 'text/plain') {
      plain.push(readPartData(part));
    } else if (mime === 'text/html') {
      html.push(readPartData(part));
    } else if (mime.indexOf('multipart/') !== 0 && part.body && (part.body.data || part.body.attachmentId)) {
      plain.push(readPartData(part));
    }
    if (part.parts) {
      for (var i = 0; i < part.parts.length; i++) walk(part.parts[i]);
    }
  }
  walk(payload);
  var plainText = plain.join('\n').trim();
  if (plainText) return plainText;
  var htmlText = html.join('\n');
  if (htmlText) return htmlToText(htmlText);
  return '';
}

function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|td|th)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/&#39;/g, "'").replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .trim();
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#39;/g, "'").replace(/&apos;/gi, "'")
    .replace(/&quot;/gi, '"').replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&');
}

function permalinkFor(threadId) {
  return 'https://mail.google.com/mail/u/0/#all/' + threadId;
}

function parseSubmissionBody(body, subject, snippet) {
  var out = { name: '', email: '', phone: '', carrier: '', recruiter: '', message: '' };
  var text = decodeEntities(((body || '') + '\n' + (snippet || '')).replace(/\r/g, ''));
  function grab(re) {
    var m = text.match(re);
    return m ? (m[1] || '').trim() : '';
  }
  out.name      = grab(/Name:\s*([\s\S]*?)\s*(?:\n|Email:|Phone\b|Carrier:|Recruiter:|$)/i);
  out.email     = grab(/Email:\s*([^\s\n]*)/i);
  out.phone     = grab(/Phone\s*1?:\s*([0-9()+\-.\s]*?)\s*(?:\n|Carrier:|Recruiter:|Email:|Name:|$)/i);
  out.carrier   = grab(/Carrier:\s*([\s\S]*?)\s*(?:\n|Recruiter:|Phone\b|Email:|Name:|$)/i);
  out.recruiter = grab(/Recruiter:\s*([\s\S]*?)\s*(?:\n|Recruiter Message:|$)/i);
  out.message   = grab(/Recruiter Message:\s*([\s\S]*?)(?:\n\s*(?:--|__|This message|Sent from|Application Info)|$)/i);
  if (!out.name || !out.carrier) {
    var sm = (subject || '').match(/New\s+(.+?)\s+submission for\s+(.+?)\s*-\s*Class A Recruiting/i);
    if (sm) {
      if (!out.carrier) out.carrier = sm[1].trim();
      if (!out.name) out.name = sm[2].trim();
    }
  }
  out.name = out.name.replace(/\s+/g, ' ').trim();
  out.carrier = out.carrier.replace(/\s+/g, ' ').trim();
  out.recruiter = out.recruiter.replace(/\s+/g, ' ').trim();
  return out;
}

// ---- fetchRecent: submission threads with activity in the last 2 days ----
// Catches new submissions AND new replies (replies keep the subject line).
function fetchRecent() {
  var cacheKey = 'grecent5';
  var cached = cacheGet(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  var query = 'subject:(Class A Recruiting) newer_than:2d';
  var ids = listThreadIds(query, 800);
  if (!ids.length) return [];
  var threads = batchGet(ids, 'threads');
  var out = [];
  for (var i = 0; i < threads.length; i++) {
    if (!threads[i]) continue;
    try {
      var row = threadToDriverRow(threads[i]);
      var isSub = false;
      for (var j = 0; j < row.messages.length; j++) {
        if (row.messages[j].isSubmission) { isSub = true; break; }
      }
      if (isSub) out.push(row);
    } catch (err) {}
  }
  cachePut(cacheKey, JSON.stringify(out), 1500);
  return out;
}

// ---- AI: summarize a driver + suggest next action (Gemini) ----
function aiSummarize(threadId, driverName, stage, recruiter) {
  if (!GEMINI_API_KEY) {
    return { error: 'No Gemini API key set. Get a free key at https://aistudio.google.com/apikey and paste it into Code.gs (GEMINI_API_KEY).' };
  }
  try {
    var thread = fetchThread(threadId);
    if (!thread || thread.error) return { error: 'Could not fetch the email thread.' };
    var msgs = thread.messages || [];
    var msgText = msgs.map(function(m, i) {
      var tag = m.isSubmission ? 'SUBMISSION' : 'REPLY';
      var body = (m.body || m.snippet || '').substring(0, 2000);
      return '[' + (i + 1) + '] ' + tag + ' from ' + (m.from || '') + ' on ' + (m.date || '') + ':\n' + body;
    }).join('\n\n---\n\n');
    var prompt = 'You are helping a trucking driver recruiter coordinator manage their pipeline. ' +
      'Below is a driver\'s submission email and the reply thread.\n\n' +
      'Driver: ' + (driverName || '(unknown)') + '\n' +
      'Current pipeline stage: ' + (stage || '(unset)') + '\n' +
      'Recruiter who submitted them: ' + (recruiter || '(unknown)') + '\n\n' +
      'Emails (oldest first):\n\n' + msgText + '\n\n' +
      'Reply in this exact format (two short lines only, no preamble):\n' +
      'STATUS: <one sentence summary of where this driver stands right now>\n' +
      'NEXT: <one concrete action the coordinator should take, or "No action needed" if appropriate>';
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
              ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY);
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code !== 200) {
      return { error: 'Gemini API ' + code + ': ' + resp.getContentText().substring(0, 300) };
    }
    var data = JSON.parse(resp.getContentText());
    var text = '';
    try { text = data.candidates[0].content.parts[0].text || ''; } catch (e) {}
    return { text: text || '(no response from Gemini)' };
  } catch (e) {
    return { error: String(e) };
  }
}

// ---- AI: answer a free-form question about the live pipeline (Gemini) ----
function aiAsk(question, contextJson, historyJson) {
  if (!GEMINI_API_KEY) {
    return { error: 'No Gemini API key set. Get a free key at https://aistudio.google.com/apikey and paste it into Code.gs (GEMINI_API_KEY).' };
  }
  question = String(question || '').trim();
  if (!question) return { error: 'Please type a question.' };
  try {
    var ctx = '';
    try { ctx = typeof contextJson === 'string' ? contextJson : JSON.stringify(contextJson || {}); } catch (e) { ctx = ''; }
    if (ctx.length > 800000) ctx = ctx.substring(0, 800000); // hard cap so we never blow past Gemini limits (1M-token model fits ~3MB of JSON)
    var hist = [];
    try { hist = typeof historyJson === 'string' ? JSON.parse(historyJson) : (historyJson || []); } catch (e) { hist = []; }
    var histText = '';
    if (hist && hist.length) {
      histText = '\n\nEarlier in this chat:\n' + hist.slice(-6).map(function(t) {
        return (t.role === 'user' ? 'USER' : 'AI') + ': ' + String(t.text || '').substring(0, 1200);
      }).join('\n') + '\n';
    }
    var prompt =
      'You are a helpful assistant embedded in a trucking driver recruiting dashboard. ' +
      'You answer questions about the LIVE driver pipeline. Use ONLY facts from the JSON ' +
      'context below. If the answer is not in the context, say so plainly. Be concise: ' +
      'short sentences, tight bullet lists when listing drivers (Name - Recruiter - Stage). ' +
      'Never invent drivers or numbers. When counting or filtering, iterate over the ENTIRE ' +
      '`drivers` array - it contains every driver in the pipeline. The `byStage` and ' +
      '`byRecruiter` objects are pre-computed totals you can use directly. The shorter field ' +
      'keys in `drivers` are explained in `fieldKey`. `recentDetail` only holds the 80 most ' +
      'recent drivers with their last-reply text - use it when the user asks about specific ' +
      'message content, not for counts.\n\n' +
      'TODAY: ' + (new Date()).toISOString().slice(0, 10) + '\n\n' +
      'Stage values used in this pipeline: No Contact, Hiring on Hold, Show, Confirmed, ' +
      'Scheduled, Pending Approval, At MVR, Conditional Approved, Hired, DQed, Ditched us, ' +
      'Left Voicemail, Cancelled, Reschedule, Other.\n\n' +
      'PIPELINE CONTEXT (JSON):\n' + ctx + histText + '\n\n' +
      'USER QUESTION: ' + question + '\n\n' +
      'Answer:';
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
              ':generateContent?key=' + encodeURIComponent(GEMINI_API_KEY);
    var payload = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
    var resp = null, code = 0, body = '';
    var attempts = [0, 2500, 6000]; // initial try + 2 retries with backoff
    for (var a = 0; a < attempts.length; a++) {
      if (attempts[a] > 0) Utilities.sleep(attempts[a]);
      resp = UrlFetchApp.fetch(url, {
        method: 'post', contentType: 'application/json',
        payload: payload, muteHttpExceptions: true
      });
      code = resp.getResponseCode();
      body = resp.getContentText();
      // Retry only on transient errors. Everything else (incl 200) breaks the loop.
      if (code !== 503 && code !== 429 && code !== 500) break;
    }
    if (code !== 200) {
      var nice = 'Gemini API ' + code + ': ' + body.substring(0, 300);
      if (code === 503) nice = 'Gemini is busy right now (server overloaded). Please try again in a few seconds.';
      else if (code === 429) nice = 'Hit Gemini rate limit. Wait a minute and try again.';
      return { error: nice };
    }
    var data = JSON.parse(body);
    var text = '';
    try { text = data.candidates[0].content.parts[0].text || ''; } catch (e) {}
    return { text: text || '(no response from Gemini)' };
  } catch (e) {
    return { error: String(e) };
  }
}

// ---- Quick sanity test ----
function _selftest() {
  if (typeof Gmail === 'undefined') {
    console.log('Gmail API service is NOT enabled. Add it: Services (+) -> Gmail API -> Add.');
    return;
  }
  var t0 = Date.now();
  var rows = fetchSubmissions(7, true);
  console.log('Found ' + rows.length + ' submissions in the last 7 days (' +
              Math.round((Date.now() - t0) / 1000) + 's).');
  for (var i = 0; i < Math.min(3, rows.length); i++) {
    var r = rows[i];
    var lastMsg = r.messages[r.messages.length - 1];
    console.log((i + 1) + '. ' + r.name + ' | recruiter=' + r.recruiter +
                ' | ' + r.messages.length + ' msg(s) | last: ' +
                (lastMsg ? lastMsg.body.substring(0, 80) : ''));
  }
}

// ---- Force a fresh pull (clears the cache) ----
function _refreshNow() {
  try {
    var cache = CacheService.getScriptCache();
    var keys = ['gsum5__n'];
    for (var x = 0; x < 40; x++) keys.push('gsum5__' + x);
    [7, 30, 90, 180, 365].forEach(function(d) {
      keys.push('gsubs5_' + d + '__n');
      for (var i = 0; i < 80; i++) keys.push('gsubs5_' + d + '__' + i);
    });
    cache.removeAll(keys);
    console.log('Cache cleared. Next page load pulls fresh from Gmail.');
  } catch (err) {
    console.log('Could not clear cache: ' + err);
  }
}

// ===================================================================
// HERMES READ-ONLY EVENT EXPORT
// -------------------------------------------------------------------
// Local-only addition for Recruiter Hermes integration. These functions do
// not write to Gmail, Sheets, triggers, or Script Properties. They convert the
// existing parsed email-thread rows into normalized event objects that Hermes
// can consume, then test against demo Driver Management tabs.
// ===================================================================

var HERMES_EVENT_VERSION = 'rec-email-events-v1';

function exportHermesEvents(range, force) {
  var drivers = fetchSubmissions(range || 30, !!force) || [];
  var events = [];
  var warnings = [];
  for (var i = 0; i < drivers.length; i++) {
    try {
      var rowEvents = hermesEventsForDriver_(drivers[i]);
      for (var j = 0; j < rowEvents.length; j++) events.push(rowEvents[j]);
    } catch (e) {
      warnings.push({ index: i, error: String(e) });
    }
  }
  return {
    ok: true,
    version: HERMES_EVENT_VERSION,
    source: 'rec_apps_script_email_threads',
    generatedAt: new Date().toISOString(),
    range: range || 30,
    force: !!force,
    driverCount: drivers.length,
    eventCount: events.length,
    events: events,
    warnings: warnings
  };
}

function hermesEventsForDriver_(driver) {
  driver = driver || {};
  var messages = driver.messages || [];
  var text = hermesDriverText_(driver);
  var stage = hermesClassifyStage_(driver, text);
  var base = hermesBaseEvent_(driver, stage);
  var events = [];

  // Every valid parsed driver thread starts as one submission event. The
  // threadId is the idempotency key so replies do not double-count submissions.
  events.push(hermesBuildEvent_(base, 'submission', driver.date, [
    'parsed_submission_thread',
    driver.subject ? 'subject:' + String(driver.subject).substring(0, 80) : 'subject:missing'
  ]));

  if (stage.eventType && stage.eventType !== 'submission') {
    events.push(hermesBuildEvent_(base, stage.eventType, stage.eventAt || driver.lastReplyAt || driver.date, stage.signals));
  }

  if (messages.length > 1 && !stage.eventType) {
    events.push(hermesBuildEvent_(base, 'thread_update', driver.lastReplyAt || driver.date, [
      'reply_count:' + String(Math.max(0, messages.length - 1))
    ]));
  }

  return events;
}

function hermesBaseEvent_(driver, stage) {
  return {
    threadId: driver.threadId || '',
    driverKey: hermesDriverKey_(driver),
    driverName: driver.name || '',
    email: driver.email || '',
    phone: hermesNormalizePhone_(driver.phone || ''),
    carrier: driver.carrier || '',
    recruiter: driver.recruiter || '',
    subject: driver.subject || '',
    permalink: driver.permalink || '',
    sourceStage: stage.stage || '',
    confidence: stage.confidence || 'medium',
    replyCount: Math.max(0, (driver.messages || []).length - 1),
    lastReplyAt: driver.lastReplyAt || null
  };
}

function hermesBuildEvent_(base, eventType, eventAt, signals) {
  var out = {};
  for (var k in base) if (base.hasOwnProperty(k)) out[k] = base[k];
  out.eventType = eventType;
  out.eventAt = eventAt || base.lastReplyAt || '';
  out.signals = signals || [];
  out.idempotencyKey = [eventType, base.threadId || base.driverKey || '', out.eventAt || ''].join(':');
  return out;
}

function hermesClassifyStage_(driver, text) {
  text = String(text || '').toLowerCase();
  var stage = { stage: '', eventType: '', confidence: 'low', signals: [] };
  function hit(type, label, patterns, confidence) {
    for (var i = 0; i < patterns.length; i++) {
      if (patterns[i].test(text)) {
        stage.eventType = type;
        stage.stage = label;
        stage.confidence = confidence || 'medium';
        stage.signals.push('pattern:' + patterns[i].source.substring(0, 80));
        stage.eventAt = driver.lastReplyAt || driver.date || '';
        return true;
      }
    }
    return false;
  }

  // Highest priority terminal states first.
  if (hit('hire', 'Hired', [
    /\bhired\b/i,
    /\bdriver\s+is\s+hired\b/i,
    /\bcompleted\s+orientation\b/i,
    /\breleased\s+to\s+dispatch\b/i,
    /\bdispatched\b/i
  ], 'medium')) return stage;

  if (hit('dq_from_dqp', 'DQed', [
    /\bdq(?:ed)?\b/i,
    /\bnot\s+qualified\b/i,
    /\bno\s*show\b/i,
    /\bcarrier\s+(?:has\s+)?(?:chosen\s+to\s+)?pass(?:ed)?\b/i,
    /\bpass\s+on\s+(?:the\s+)?driver\b/i,
    /\bditched\s+us\b/i
  ], 'medium')) return stage;

  if (hit('needs_attention', 'Need Attention', [
    /\bneed(?:s)?\s+attention\b/i,
    /\bmissing\s+(?:doc|docs|document|documents)\b/i,
    /\bneed(?:s)?\s+(?:doc|docs|document|documents)\b/i,
    /\bwaiting\s+for\s+(?:rc|recruiter|documents|docs)\b/i,
    /\bneed\s+to\s+reschedule\b/i,
    /\breschedule\b/i
  ], 'medium')) return stage;

  if (hit('confirmed_dqp', 'Confirmed DQP', [
    /\bdqp\s+confirmed\b/i,
    /\bconfirmed\s+(?:for\s+)?(?:dqp|orientation)\b/i,
    /\bscheduled\s+(?:for\s+)?(?:dqp|orientation)\b/i,
    /\bat\s+(?:the\s+)?orientation\b/i,
    /\bshow\b/i,
    /\bapproved\b/i
  ], 'medium')) return stage;

  stage.stage = 'Submitted';
  stage.confidence = 'medium';
  stage.signals.push('default:submission_thread');
  return stage;
}

function hermesDriverText_(driver) {
  var parts = [driver.subject || '', driver.snippet || '', driver.message || ''];
  var messages = driver.messages || [];
  for (var i = 0; i < messages.length; i++) {
    parts.push(messages[i].subject || '');
    parts.push(messages[i].snippet || '');
    parts.push(messages[i].body || '');
  }
  return parts.join('\n');
}

function hermesNormalizePhone_(phone) {
  var digits = String(phone || '').replace(/[^0-9]/g, '');
  if (digits.length === 11 && digits.charAt(0) === '1') digits = digits.slice(1);
  return digits;
}

function hermesDriverKey_(driver) {
  var phone = hermesNormalizePhone_(driver && driver.phone);
  if (phone) return 'phone:' + phone;
  var email = String((driver && driver.email) || '').toLowerCase().trim();
  if (email) return 'email:' + email;
  var name = String((driver && driver.name) || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return name ? 'name:' + name : 'thread:' + String((driver && driver.threadId) || 'unknown');
}

function _hermesExportSelftest() {
  var sample = {
    threadId: 'sample-thread',
    date: '2026-06-29T12:00:00.000Z',
    subject: 'New Swift submission for Test Driver - Class A Recruiting',
    name: 'Test Driver',
    phone: '(555) 123-4567',
    carrier: 'Swift',
    recruiter: 'Robert',
    messages: [
      { subject: 'New Swift submission', body: 'Application Info\nName: Test Driver\nPhone 1: 5551234567', date: '2026-06-29T12:00:00.000Z' },
      { subject: 'Re: New Swift submission', body: 'Driver is confirmed for DQP orientation Monday.', date: '2026-06-29T13:00:00.000Z' }
    ],
    lastReplyAt: '2026-06-29T13:00:00.000Z'
  };
  var events = hermesEventsForDriver_(sample);
  console.log(JSON.stringify(events));
  return events;
}

function logHermesExportCounts() {
  var out = exportHermesEvents(30, false);
  var summary = {
    ok: !!out.ok,
    version: out.version,
    source: out.source,
    driverCount: out.driverCount,
    eventCount: out.eventCount,
    warningCount: (out.warnings || []).length,
    eventTypeCounts: hermesCountEventTypes_(out.events || [])
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function logHermesExportDiagnostics() {
  var props = PropertiesService.getScriptProperties();
  var diagnostics = {
    ok: true,
    version: HERMES_EVENT_VERSION,
    dbSheetIdPresent: !!props.getProperty('DB_SHEET_ID'),
    dbSyncedAt: props.getProperty('DB_SYNCED_AT') || null,
    syncTriggerOn: props.getProperty('SYNC_TRIGGER_ON') || null,
    syncInfo: null,
    sheetRowsTotal: null,
    ranges: {},
    gmailQueryCounts: {},
    seedPreview: null
  };

  try { diagnostics.syncInfo = getSyncInfo(); } catch (e) { diagnostics.syncInfo = { error: String(e) }; }
  try { diagnostics.sheetRowsTotal = getDriversFromSheet().length; } catch (e2) { diagnostics.sheetRowsTotal = { error: String(e2) }; }

  [30, 90, 180, 365, 9999].forEach(function(days) {
    try {
      var out = exportHermesEvents(days, false);
      diagnostics.ranges[String(days)] = {
        driverCount: out.driverCount,
        eventCount: out.eventCount,
        warningCount: (out.warnings || []).length,
        eventTypeCounts: hermesCountEventTypes_(out.events || [])
      };
    } catch (e3) {
      diagnostics.ranges[String(days)] = { error: String(e3) };
    }
  });

  var queries = {
    fullSubmissionThreads: 'from:' + SUBMISSION_SENDER + ' subject:submission after:' + DATA_START,
    recentSubmissionThreads: 'from:' + SUBMISSION_SENDER + ' subject:submission newer_than:30d after:' + DATA_START,
    senderOnlyRecent: 'from:' + SUBMISSION_SENDER + ' newer_than:30d',
    submissionSubjectRecent: 'subject:submission newer_than:30d'
  };
  for (var name in queries) {
    if (!queries.hasOwnProperty(name)) continue;
    try { diagnostics.gmailQueryCounts[name] = listThreadIds(queries[name], 20).length; }
    catch (e4) { diagnostics.gmailQueryCounts[name] = { error: String(e4) }; }
  }

  console.log(JSON.stringify(diagnostics, null, 2));
  return diagnostics;
}

function logHermesEmailFormatDiscovery() {
  var discovery = discoverHermesEmailFormats_(20000);
  console.log(JSON.stringify(discovery, null, 2));
  return discovery;
}

function saveHermesEmailFormatDiscovery() {
  var discovery = discoverHermesEmailFormats_(20000);
  var name = 'hermes-email-format-discovery-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd-HHmmss') + '.json';
  var file = DriveApp.createFile(name, JSON.stringify(discovery, null, 2), MimeType.PLAIN_TEXT);
  var summary = {
    ok: true,
    fileName: name,
    fileId: file.getId(),
    fileUrl: file.getUrl(),
    knownSenderTotal: ((discovery.querySummaries || {}).known_sender_all || {}).totalMessages || 0,
    subjectSubmissionTotal: ((discovery.querySummaries || {}).subject_submission_all || {}).totalMessages || 0,
    likelyFormatIssues: discovery.likelyFormatIssues || []
  };
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

function logHermesSubmissionParseDiagnostics() {
  var out = diagnoseHermesSubmissionParsing_(250);
  console.log(JSON.stringify(out, null, 2));
  return out;
}

function diagnoseHermesSubmissionParsing_(limit) {
  limit = limit || 250;
  var query = 'from:' + SUBMISSION_SENDER + ' subject:submission after:' + DATA_START;
  var ids = listThreadIds(query, limit);
  var threads = batchGet(ids, 'threads');
  var out = {
    ok: true,
    version: HERMES_EVENT_VERSION,
    query: query,
    candidateThreads: ids.length,
    fetchedThreads: threads.length,
    parsed: 0,
    rejected: 0,
    rejectReasons: {},
    firstMessageSignals: {
      hasApplicationInfo: 0,
      hasPhone: 0,
      hasRecruiter: 0,
      hasCarrier: 0,
      notificationLike: 0,
      emptySnippet: 0
    }
  };
  for (var i = 0; i < threads.length; i++) {
    var th = threads[i];
    if (!th) {
      out.rejected++;
      inc_(out.rejectReasons, 'thread_fetch_null');
      continue;
    }
    try {
      var raw = (th.messages || []).slice();
      raw.sort(function(a, b) { return (parseInt(a.internalDate, 10) || 0) - (parseInt(b.internalDate, 10) || 0); });
      var first = raw[0] || {};
      var p = first.payload || {};
      var subj = getHeader(p, 'Subject') || '';
      var snip = decodeEntities(first.snippet || '');
      var text = (subj + ' ' + snip).toLowerCase();
      if (!snip) out.firstMessageSignals.emptySnippet++;
      if (text.indexOf('application info') >= 0) out.firstMessageSignals.hasApplicationInfo++;
      if (/\bphone\b|phone\s*1/.test(text)) out.firstMessageSignals.hasPhone++;
      if (/\brecruiter\b/.test(text)) out.firstMessageSignals.hasRecruiter++;
      if (/\bcarrier\b|swift|pam|usx|u\.s\.\s*xpress|us xpress/.test(text)) out.firstMessageSignals.hasCarrier++;
      if (isNotificationEmail(subj, snip)) out.firstMessageSignals.notificationLike++;
      threadToDriverRow(th);
      out.parsed++;
    } catch (e) {
      out.rejected++;
      inc_(out.rejectReasons, String(e).substring(0, 140));
    }
  }
  return out;
}

function discoverHermesEmailFormats_(maxMessages) {
  var queries = {
    known_sender_all: 'from:' + SUBMISSION_SENDER + ' after:' + DATA_START,
    subject_submission_all: 'subject:submission after:' + DATA_START,
    application_terms_all: '(submission OR application OR driver OR orientation OR DQP OR hired OR DQed OR scheduled OR confirmed) after:' + DATA_START,
    recent_any_30d: '(submission OR application OR driver OR orientation OR DQP OR hired OR scheduled OR confirmed) newer_than:30d'
  };
  var out = {
    ok: true,
    version: HERMES_EVENT_VERSION,
    generatedAt: new Date().toISOString(),
    maxMessages: maxMessages || 20000,
    senderConfigured: SUBMISSION_SENDER,
    dataStart: DATA_START,
    querySummaries: {},
    likelyFormatIssues: []
  };
  for (var qname in queries) {
    if (!queries.hasOwnProperty(qname)) continue;
    try {
      out.querySummaries[qname] = summarizeGmailMessageFormats_(queries[qname], maxMessages || 20000);
    } catch (e) {
      out.querySummaries[qname] = { error: String(e) };
    }
  }
  var known = out.querySummaries.known_sender_all || {};
  var subj = out.querySummaries.subject_submission_all || {};
  if ((known.totalMessages || 0) === 0) out.likelyFormatIssues.push('configured sender returned zero messages');
  if ((subj.totalMessages || 0) > (known.totalMessages || 0) * 2) out.likelyFormatIssues.push('subject:submission matches many more messages than configured sender');
  if ((known.totalMessages || 0) > 0 && (known.bodySignalCounts && (known.bodySignalCounts.applicationInfo || 0) === 0)) out.likelyFormatIssues.push('configured sender messages do not show application-info signal in snippets');
  return out;
}

function summarizeGmailMessageFormats_(query, maxMessages) {
  var ids = listMessageIds(query, maxMessages || 20000);
  var sampleIds = ids.slice(0, Math.min(ids.length, 250));
  var messages = batchGet(sampleIds, 'messages');
  var senders = {};
  var subjectPrefixes = {};
  var subjectTokens = {};
  var bodySignals = {
    applicationInfo: 0,
    phone: 0,
    recruiter: 0,
    carrier: 0,
    orientation: 0,
    dqp: 0,
    scheduled: 0,
    confirmed: 0,
    hired: 0,
    dq: 0,
    noShow: 0,
    documents: 0
  };
  var parseSignals = { parseableSubmission: 0, notificationLike: 0, unknownLike: 0 };
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    if (!m) continue;
    var p = m.payload || {};
    var from = sanitizeEmailForDiscovery_(getHeader(p, 'From'));
    var subj = getHeader(p, 'Subject') || '';
    var snip = decodeEntities(m.snippet || '');
    inc_(senders, from || '(unknown)');
    inc_(subjectPrefixes, subjectPrefixForDiscovery_(subj));
    var toks = subjectTokensForDiscovery_(subj);
    for (var t = 0; t < toks.length; t++) inc_(subjectTokens, toks[t]);
    var text = (subj + ' ' + snip).toLowerCase();
    if (text.indexOf('application info') >= 0) bodySignals.applicationInfo++;
    if (/\bphone\b|phone\s*1|mobile|cell/.test(text)) bodySignals.phone++;
    if (/\brecruiter\b/.test(text)) bodySignals.recruiter++;
    if (/\bcarrier\b|swift|pam|usx|u\.s\.\s*xpress|us xpress/.test(text)) bodySignals.carrier++;
    if (/\borientation\b/.test(text)) bodySignals.orientation++;
    if (/\bdqp\b/.test(text)) bodySignals.dqp++;
    if (/\bscheduled\b/.test(text)) bodySignals.scheduled++;
    if (/\bconfirmed\b/.test(text)) bodySignals.confirmed++;
    if (/\bhired\b|dispatch/.test(text)) bodySignals.hired++;
    if (/\bdq\b|dqed|not qualified/.test(text)) bodySignals.dq++;
    if (/no\s*show/.test(text)) bodySignals.noShow++;
    if (/doc|document|missing/.test(text)) bodySignals.documents++;
    if (isNotificationEmail(subj, snip)) parseSignals.notificationLike++;
    else if (text.indexOf('application info') >= 0 || /\bname\b.*\bphone\b/.test(text)) parseSignals.parseableSubmission++;
    else parseSignals.unknownLike++;
  }
  return {
    query: query,
    totalMessages: ids.length,
    sampledMessages: messages.length,
    topSenders: topCounts_(senders, 20),
    topSubjectPrefixes: topCounts_(subjectPrefixes, 30),
    topSubjectTokens: topCounts_(subjectTokens, 30),
    bodySignalCounts: bodySignals,
    parseSignalCounts: parseSignals
  };
}

function sanitizeEmailForDiscovery_(from) {
  from = String(from || '').toLowerCase();
  var m = from.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  if (!m) return '(unknown)';
  var parts = m[0].split('@');
  var local = parts[0] || '';
  var safeLocal = local.length <= 3 ? local.charAt(0) + '***' : local.substring(0, 3) + '***';
  return safeLocal + '@' + parts[1];
}

function subjectPrefixForDiscovery_(subject) {
  subject = String(subject || '').replace(/\s+/g, ' ').trim();
  subject = subject.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
  subject = subject.replace(/\b\+?1?\s*\(?\d{3}\)?[-.\s]*\d{3}[-.\s]*\d{4}\b/g, '[phone]');
  subject = subject.replace(/\b[A-Z][a-z]+\s+[A-Z][a-z]+\b/g, '[Name]');
  return subject.substring(0, 90) || '(empty)';
}

function subjectTokensForDiscovery_(subject) {
  var stop = { the:1, and:1, for:1, with:1, from:1, re:1, fw:1, fwd:1, new:1, your:1, you:1, are:1, has:1, have:1, this:1, that:1 };
  var words = String(subject || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/);
  var out = [];
  for (var i = 0; i < words.length; i++) {
    var w = words[i];
    if (w.length < 3 || stop[w]) continue;
    out.push(w);
  }
  return out.slice(0, 12);
}

function inc_(obj, key) {
  obj[key] = (obj[key] || 0) + 1;
}

function topCounts_(obj, n) {
  var arr = [];
  for (var k in obj) if (obj.hasOwnProperty(k)) arr.push({ value: k, count: obj[k] });
  arr.sort(function(a, b) { return b.count - a.count || String(a.value).localeCompare(String(b.value)); });
  return arr.slice(0, n || 20);
}

function hermesCountEventTypes_(events) {
  var counts = {};
  for (var i = 0; i < events.length; i++) {
    var t = events[i] && events[i].eventType ? events[i].eventType : 'unknown';
    counts[t] = (counts[t] || 0) + 1;
  }
  return counts;
}