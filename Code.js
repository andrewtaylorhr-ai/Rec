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

// ---- fetchSummary: 12-month data for the Performance page (cached 6h) ----
function fetchSummary(daysBack) {
  var cacheKey = 'gsum5';
  var cached = cacheGet(cacheKey);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) {}
  }
  var query = 'from:' + SUBMISSION_SENDER + ' subject:submission after:' + DATA_START;
  var ids = listMessageIds(query, SUMMARY_MAX);
  if (!ids.length) return [];

  var token = ScriptApp.getOAuthToken();
  var out = [];
  var startTime = Date.now();
  for (var c = 0; c < ids.length; c += FETCH_CHUNK) {
    if (Date.now() - startTime > SUMMARY_TIME_BUDGET_MS) break;
    var got = fetchChunk(ids.slice(c, c + FETCH_CHUNK), token, 'messages');
    for (var i = 0; i < got.length; i++) {
      var m = got[i];
      if (!m) continue;
      try {
        var p = m.payload || {};
        var _subj = getHeader(p, 'Subject');
        var _body = decodeEntities(m.snippet || '');
        if (isNotificationEmail(_subj, _body)) continue;
        var parsed = parseSubmissionBody('', _subj, _body);
        var dms = parseInt(m.internalDate, 10);
        out.push({
          threadId: m.threadId,
          date: isNaN(dms) ? '' : new Date(dms).toISOString(),
          name: parsed.name,
          recruiter: parsed.recruiter,
          carrier: parsed.carrier
        });
      } catch (err) {}
    }
  }
  cachePut(cacheKey, JSON.stringify(out), SUMMARY_CACHE_SECONDS);
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