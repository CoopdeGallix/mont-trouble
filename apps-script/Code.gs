// Apps Script backend for the race timing app.
// Deploy: Extensions > Apps Script in the race Google Sheet, paste this file,
// run setup() once, then Deploy > New deployment > Web app
// (Execute as: Me, Who has access: Anyone).

const PIN = 'CHANGE_ME'; // shared with the timers, checked on every POST
const RACE_DATE = '2026-10-24';
const TZ = 'America/Toronto';
const CACHE_SECONDS = 15;
const CHUNK = 90000; // CacheService values are limited to 100 KB

const EVENT_HEADERS = ['id', 'bib', 'type', 'ts', 'ref', 'device', 'source', 'received_at', 'void', 'note'];
const PARTICIPANT_HEADERS = ['bib', 'name', 'sex', 'status']; // status: DNS for non-starters
const TYPES = ['D', 'M', 'A', 'DNF', 'VOID']; // M = summit (optional split)

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(TZ);
  const events = ss.getSheetByName('events') || ss.insertSheet('events');
  if (events.getLastRow() === 0) events.appendRow(EVENT_HEADERS);
  events.setFrozenRows(1);
  events.getRange('D:D').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  events.getRange('H:H').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  const participants = ss.getSheetByName('participants') || ss.insertSheet('participants');
  if (participants.getLastRow() === 0) participants.appendRow(PARTICIPANT_HEADERS);
  participants.setFrozenRows(1);
}

function doGet(e) {
  const action = (e && e.parameter && e.parameter.action) || 'data';
  if (action !== 'data') return json({ error: 'unknown action' });
  return json(cachedData());
}

function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return json({ error: 'invalid JSON' });
  }
  if (body.pin !== PIN) return json({ error: 'NIP invalide' });
  if (body.action === 'participant') return json(addParticipant(body.participant));
  if (body.action !== 'events' || !Array.isArray(body.events)) return json({ error: 'unknown action' });

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json({ error: 'busy, retry' });
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('events');
    const last = lastIdRow(sheet);
    const existing = new Set(
      last > 1 ? sheet.getRange(2, 1, last - 1, 1).getValues().map((r) => String(r[0])) : []
    );
    const now = new Date();
    const accepted = [];
    const duplicates = [];
    const rejected = [];
    const rows = [];
    for (const ev of body.events) {
      const problem = validate(ev);
      if (problem) {
        rejected.push({ id: ev && ev.id, error: problem });
        continue;
      }
      if (existing.has(ev.id)) {
        duplicates.push(ev.id);
        continue;
      }
      existing.add(ev.id);
      accepted.push(ev.id);
      rows.push([
        ev.id,
        ev.bib === '' || ev.bib == null ? '' : Number(ev.bib),
        ev.type,
        new Date(ev.ts),
        ev.ref || '',
        String(ev.device || '').slice(0, 40),
        ev.source || 'app',
        now,
        false,
        String(ev.note || '').slice(0, 200),
      ]);
    }
    if (rows.length) {
      sheet.getRange(last + 1, 1, rows.length, EVENT_HEADERS.length).setValues(rows);
      sheet.getRange(last + 1, 9, rows.length, 1).insertCheckboxes();
      CacheService.getScriptCache().remove('data:n');
    }
    return json({ ok: true, accepted, duplicates, rejected });
  } finally {
    lock.releaseLock();
  }
}

// Last row with an id. getLastRow() would count checkboxes or formatting
// someone adds further down, and new events would land far below the data.
function lastIdRow(sheet) {
  const ids = sheet.getRange('A:A').getValues();
  for (let i = ids.length - 1; i >= 0; i--) if (ids[i][0] !== '') return i + 1;
  return 1;
}

// Late registration: append to the participants tab, refusing a bib already taken.
function addParticipant(p) {
  if (!p || !/^\d{1,4}$/.test(String(p.bib))) return { error: 'Dossard invalide' };
  const name = String(p.name || '').trim().slice(0, 80);
  if (!name) return { error: 'Nom requis' };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return { error: 'busy, retry' };
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('participants');
    const rows = sheet.getDataRange().getValues().slice(1);
    const taken = rows.find((r) => r[0] !== '' && Number(r[0]) === Number(p.bib));
    if (taken) return { error: 'Dossard ' + p.bib + ' déjà pris : ' + taken[1] };
    sheet.appendRow([Number(p.bib), name, String(p.sex || '').trim().slice(0, 10)]);
    CacheService.getScriptCache().remove('data:n');
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function validate(ev) {
  if (!ev || typeof ev.id !== 'string' || !ev.id || ev.id.length > 40) return 'bad id';
  if (TYPES.indexOf(ev.type) < 0) return 'bad type';
  if (typeof ev.ts !== 'number' || !isFinite(ev.ts)) return 'bad ts';
  if (ev.type === 'VOID') return ev.ref ? null : 'VOID needs ref';
  if (!/^\d{1,4}$/.test(String(ev.bib))) return 'bad bib';
  return null;
}

function cachedData() {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get('data:n'));
  if (n) {
    const keys = [];
    for (let i = 0; i < n; i++) keys.push('data:' + i);
    const parts = cache.getAll(keys);
    if (Object.keys(parts).length === n) {
      return JSON.parse(keys.map((k) => parts[k]).join(''));
    }
  }
  const data = readData();
  const str = JSON.stringify(data);
  const chunks = {};
  let count = 0;
  for (let i = 0; i < str.length; i += CHUNK) chunks['data:' + count++] = str.slice(i, i + CHUNK);
  cache.putAll(chunks, CACHE_SECONDS);
  cache.put('data:n', String(count), CACHE_SECONDS);
  return data;
}

function readData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const pRows = ss.getSheetByName('participants').getDataRange().getValues().slice(1);
  const participants = pRows
    .filter((r) => r[0] !== '' && r[0] != null)
    .map((r) => ({
      bib: Number(r[0]),
      name: String(r[1] || '').trim(),
      sex: String(r[2] || '').trim(),
      status: String(r[3] || '').trim().toUpperCase(),
    }));

  const range = ss.getSheetByName('events').getDataRange();
  const eRows = range.getValues().slice(1);
  const shown = range.getDisplayValues().slice(1);
  const events = [];
  for (let i = 0; i < eRows.length; i++) {
    const r = eRows[i];
    if (!r[0]) continue;
    const ts = toMs(r[3], shown[i][3]);
    if (ts == null) continue;
    const ev = { id: String(r[0]), bib: r[1] === '' ? null : Number(r[1]), type: String(r[2]).trim(), ts };
    if (r[4]) ev.ref = String(r[4]);
    if (r[8] === true) ev.void = true;
    events.push(ev);
  }
  return { participants, events, serverTime: Date.now() };
}

// Cell value -> epoch ms. A time typed by hand in the Sheet (e.g. "10:23:15")
// comes back as a date in 1899 with odd historical offsets, so use the text
// shown in the cell and put it on race day.
function toMs(v, shown) {
  if (v instanceof Date) {
    if (v.getFullYear() < 2000) {
      const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(shown || '');
      if (!m) return null;
      const hms = ('0' + m[1]).slice(-2) + ':' + m[2] + ':' + (m[3] || '00');
      return Utilities.parseDate(RACE_DATE + ' ' + hms, TZ, 'yyyy-MM-dd HH:mm:ss').getTime();
    }
    return v.getTime();
  }
  if (typeof v === 'number') return v > 1e12 ? v : null;
  return null;
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
