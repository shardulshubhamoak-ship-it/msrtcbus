#!/usr/bin/env node
/**
 * MSRTC ST Bus Depot QR app - local server
 * ---------------------------------------------------------------
 * Zero dependencies. Needs Node.js 16+.
 *
 *   node server.js
 *
 * TWO FILES in the same folder: server.js + index.html (the app). Edit index.html, refresh the browser.
 * (Optional) set APP_FILE=... to serve a different HTML file.
 *
 * What it does
 *   GET  /              serves the app (gzip-compressed, cached)
 *   POST /sync/push     { store, records[] }  -> upsert records
 *   POST /sync/delete   { store, keys[] }     -> remove records
 *   GET  /sync/pull     -> { users, qrCodes, depotRegister, notices }
 *   POST /otp/send      { username, mobile, email }
 *   POST /otp/verify    { username, code } -> { ok }
 *   GET  /health
 *
 * Settings (environment variables, all optional)
 *   PORT=8080            HOST=0.0.0.0     (plain http - fine on this computer via localhost)
 *   HTTPS_PORT=8443      HTTPS=0 turns HTTPS off. HTTPS is ON by default (needed for the phone camera QR scan and for fingerprint sign-in)
 *   APP_FILE=...         the app HTML file (default ./index.html)
 *   DATA_FILE=...        where ALL data is saved (default ./db.json, next to server.js)
 *   CERT_FILE / KEY_FILE your own TLS cert + key (default ./certs/cert.pem, ./certs/key.pem).
 *                        If none exist, a self-signed certificate is created automatically in ./certs
 *
 * Who gets / sends the OTP
 *   TO   : the email address entered for the staff account (saved on the server)
 *   FROM : the email address entered for that staff member's Depot account
 *          (shown as the sender + Reply-To; if the depot has no email, SMTP_FROM is used)
 *
 * Depot Gmail accounts (so the mail REALLY comes from the depot's @gmail.com address):
 *   Open this file in Notepad and edit the DEPOT_GMAIL block near the top.
 *   Each line:  'depot@gmail.com': 'Gmail App Password',
 *   (Google Account -> Security -> 2-Step Verification ON -> App passwords)
 *   No separate .json file is needed.
 *
 * Email OTP (SMTP) - set these to send real emails:
 *   SMTP_HOST=smtp.gmail.com      SMTP_PORT=465 (default; 587 also works via STARTTLS)
 *   SMTP_USER=you@gmail.com       SMTP_PASS=app-password
 *   SMTP_FROM="MSRTC Depot <you@gmail.com>"   (default: SMTP_USER)
 *   SMTP_SECURE=true|false   only needed on unusual ports (465 = true, others = STARTTLS)
 * Render FREE plan: SMTP is blocked there. Use the HTTPS mail API instead:  BREVO_API_KEY=xkeysib-...  MAIL_SENDER=you@gmail.com
 *   (sender verified once in Brevo). See README "Email verification code".
 * If neither SMTP nor Brevo is set, the OTP is only printed in this console (test mode).
 * The SMTP account still does the actual sending. Mail providers (e.g. Gmail) may replace
 * the From address with the SMTP account unless the depot address is an allowed alias, or the
 * SMTP server belongs to the depot's own mail domain.
 * The recipient is always read from the account saved on the server, never from the request.
 */
'use strict';

/* ================================================================== */
/*  ALWAYS-ON SUPERVISOR (added)                                       */
/*  `node server.js` now keeps itself running: if the server crashes   */
/*  or stops, it restarts automatically. Press Ctrl+C to really stop.  */
/*  Set NO_SUPERVISOR=1 to turn this off.                              */
/* ================================================================== */
if (!process.env.MSRTC_CHILD && process.env.NO_SUPERVISOR !== '1') {
  const { spawn } = require('child_process');
  let stopping = false, quick = 0, child = null, first = true;
  const stop = () => { stopping = true; if (child) child.kill(); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const launch = () => {
    const t = Date.now();
    child = spawn(process.execPath, [__filename].concat(process.argv.slice(2)), {
      stdio: 'inherit',
      env: Object.assign({}, process.env, { MSRTC_CHILD: '1', MSRTC_FIRST: first ? '1' : '' })
    });
    first = false;
    child.on('exit', code => {
      if (stopping) return process.exit(0);
      quick = Date.now() - t < 5000 ? quick + 1 : 0;
      const wait = Math.min(1000 * (quick + 1), 10000);
      console.error('[supervisor] server stopped (code ' + code + '). Restarting in ' + wait / 1000 + 's ...');
      setTimeout(launch, wait);
    });
  };
  launch();
  return; // the supervisor does nothing else; the child process runs the real server below
}

// Never let one bad request kill the server
process.on('uncaughtException', e => console.error('[uncaughtException]', e && e.stack || e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e && e.stack || e));

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const os = require('os');

/* ================================================================== */
/*  EDIT HERE - DEPOT GMAIL ACCOUNTS (OTP is sent FROM these)          */
/*  Format:  'depot gmail address': 'Gmail App Password',              */
/*  Add one line per depot. Keep the quotes and the comma.            */
/*  Get an App Password: Google Account > Security > 2-Step            */
/*  Verification (ON) > App passwords.                                 */
/* ================================================================== */
const DEPOT_GMAIL = {
  'guhagar.depot@gmail.com': 'abcd efgh ijkl mnop',
  // 'chiplun.depot@gmail.com': 'xxxx xxxx xxxx xxxx',
};
/* ================================================================== */

const PORT = parseInt(process.env.PORT, 10) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const APP_FILE = process.env.APP_FILE || path.join(__dirname, 'index.html'); // the app (HTML) lives in its own file next to server.js
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'db.json'); // ALL app data (users, QR codes, register, notices, audit logs) is saved here
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DATA_FILE), 'backups'); // rotating copies of the database
const BACKUP_KEEP = parseInt(process.env.BACKUP_KEEP, 10) || 20;
const BACKUP_EVERY_MS = (parseInt(process.env.BACKUP_EVERY_MIN, 10) || 10) * 60 * 1000;
const SYNC_KEY = process.env.SYNC_KEY || ''; // optional: when set, /sync/*, /backup/* need the header x-sync-key
const STARTED_AT = Date.now();
/* Google Cloud Text-to-Speech (optional): natural Google voices for the bus announcement, fetched in advance so there is no gap between languages.
   Set GOOGLE_TTS_KEY on the server (Render -> Environment). Without it the app falls back to the phone's own voices. */
const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_KEY || '';
const GOOGLE_TTS_URL = process.env.GOOGLE_TTS_URL || 'https://texttospeech.googleapis.com/v1/text:synthesize';
const TTS_VOICES = { mr: process.env.TTS_VOICE_MR || 'mr-IN-Wavenet-A', hi: process.env.TTS_VOICE_HI || 'hi-IN-Neural2-A', en: process.env.TTS_VOICE_EN || 'en-IN-Neural2-A' };
const TTS_LANG = { mr: 'mr-IN', hi: 'hi-IN', en: 'en-IN' };
const ttsCache = new Map(); // text+voice+speed -> base64 mp3 (saves quota; replays are instant)
function googlePost(body) {
  return new Promise((resolve, reject) => {
    const u = new URL(GOOGLE_TTS_URL + (GOOGLE_TTS_URL.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(GOOGLE_TTS_KEY));
    const data = JSON.stringify(body);
    const lib = u.protocol === 'http:' ? require('http') : https;
    const rq = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, timeout: 8000 }, r => {
      let b = ''; r.on('data', c => b += c); r.on('end', () => { try { resolve({ status: r.statusCode, json: JSON.parse(b || '{}') }); } catch (e) { reject(e); } });
    });
    rq.on('timeout', () => rq.destroy(new Error('Google TTS timeout'))); rq.on('error', reject); rq.end(data);
  });
}
const serverErrors = []; // recent server errors, shown by /health
function trackError(where, e) { serverErrors.push({ t: new Date().toISOString(), where, msg: String((e && e.message) || e).slice(0, 200) }); if (serverErrors.length > 20) serverErrors.shift(); }
let errorTotal = 0, lastSaveAt = 0, lastSaveError = '', lastBackupAt = 0, conflictTotal = 0;
const CERT_FILE = process.env.CERT_FILE || path.join(__dirname, 'certs', 'cert.pem');
const KEY_FILE = process.env.KEY_FILE || path.join(__dirname, 'certs', 'key.pem');
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT, 10) || 8443;
const ON_RENDER = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL); // running on Render.com
// On Render the public https address already has a real certificate (Render handles it), so the built-in self-signed HTTPS is not used there.
const HTTPS_ON = process.env.HTTPS === '1' || (process.env.HTTPS !== '0' && !ON_RENDER);
const CERT_META = path.join(path.dirname(CERT_FILE), 'cert-meta.json');
/* mail-settings.json (next to server.js): { "user": "you@gmail.com", "appPassword": "16-letter Gmail App Password", "host": "smtp.gmail.com", "port": 465 }
   Environment variables SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS / SMTP_FROM override the file (use them on Render so the password is not in the code). */
const MAIL_FILE = process.env.MAIL_FILE || path.join(__dirname, 'mail-settings.json');
let mailFile = {};
try { mailFile = JSON.parse(fs.readFileSync(MAIL_FILE, 'utf8')) || {}; } catch (e) { if (e.code !== 'ENOENT') console.error('Could not read ' + MAIL_FILE + ': ' + e.message); }
const filePass = String(mailFile.appPassword || mailFile.pass || '').replace(/\s+/g, '');
const fileOk = !!(mailFile.user && filePass && !/^(PUT|ENTER|XXXX)/i.test(filePass));
const SMTP = {
  host: process.env.SMTP_HOST || (fileOk ? (mailFile.host || 'smtp.gmail.com') : ''),
  port: parseInt(process.env.SMTP_PORT, 10) || (fileOk ? parseInt(mailFile.port, 10) || 465 : 465),
  user: process.env.SMTP_USER || (fileOk ? mailFile.user : ''),
  pass: process.env.SMTP_PASS || (fileOk ? filePass : ''),
  from: process.env.SMTP_FROM || process.env.SMTP_USER || (fileOk ? mailFile.user : '')
};
SMTP.secure = process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : SMTP.port === 465;
/* HTTPS e-mail (Brevo API, port 443). Render FREE web services block every SMTP port (25/465/587) since 26 Sep 2025, so Gmail SMTP cannot
   work there; an HTTPS mail API does. BREVO_API_KEY (Render environment) or "brevoApiKey" in mail-settings.json turns it on.
   The sender is MAIL_SENDER / mail-settings.json "user" and must be verified once inside Brevo (Senders & IP). */
const BREVO_KEY = String(process.env.BREVO_API_KEY || mailFile.brevoApiKey || '').trim();
const BREVO_OK = !!BREVO_KEY && !/^(PUT|ENTER|XXXX)/i.test(BREVO_KEY);
const BREVO_SENDER = String(process.env.MAIL_SENDER || process.env.SMTP_FROM || mailFile.sender || mailFile.user || '').replace(/^.*<([^>]+)>.*$/, '$1').trim();
const BREVO_URL = process.env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
const MAIL_ENABLED = !!(SMTP.host && SMTP.from) || !!(BREVO_OK && BREVO_SENDER.includes('@'));
// Per-depot Gmail logins: { "guhagar.depot@gmail.com": "abcd efgh ijkl mnop", ... }  (Gmail App Passwords)
const DEPOT_SMTP_FILE = process.env.DEPOT_SMTP_FILE || path.join(__dirname, 'smtp-depots.json');
function loadDepotSmtp() {
  const out = {};
  const add = (k, v) => { // skip the example placeholder
    if (!k || !v || /abcd efgh ijkl mnop/i.test(typeof v === 'string' ? v : String(v.pass || ''))) return;
    out[String(k).trim().toLowerCase()] = v;
  };
  for (const k of Object.keys(DEPOT_GMAIL)) add(k, DEPOT_GMAIL[k]);
  try { // optional extra file (not needed)
    const raw = JSON.parse(fs.readFileSync(DEPOT_SMTP_FILE, 'utf8'));
    for (const k of Object.keys(raw)) add(k, raw[k]);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read ' + DEPOT_SMTP_FILE + ': ' + e.message);
  }
  return out;
}
const EMAIL_RE = /^[^\s@<>",;:]+@[^\s@<>",;:]+\.[^\s@<>",;:]+$/;

const MAX_BODY = 25 * 1024 * 1024; // 25 MB per request
const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_TRIES = 5;

/* ------------------------------------------------------------------ */
/* Storage: in-memory Maps, saved to one JSON file (atomic writes)     */
/* ------------------------------------------------------------------ */
const STORES = ['users', 'qrCodes', 'depotRegister', 'notices', 'auditLogs', 'bio'];
const CLIENT_STORES = STORES.filter(s => s !== 'bio'); // the app may push / delete these; 'bio' (fingerprint keys) only through /bio/*
const keyField = store => (store === 'users' ? 'username' : store === 'bio' ? 'emp' : 'uid');
const PULL_STORES = ['users', 'qrCodes', 'depotRegister', 'notices']; // what the app pulls

const db = {};
for (const s of STORES) db[s] = new Map();

function listBackups() {
  try { return fs.readdirSync(BACKUP_DIR).filter(f => /^db-.*\.json$/.test(f)).sort(); } catch (e) { return []; }
}
function readDbFile() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch (e) {
    if (e.code !== 'ENOENT') { trackError('load', e); console.error('Could not read ' + DATA_FILE + ': ' + e.message); }
    const b = listBackups().pop();
    if (!b) throw e;
    const raw = JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, b), 'utf8'));
    console.log('RECOVERED the database from backup ' + b);
    trackError('recovery', 'Database restored from backup ' + b);
    return raw;
  }
}
function loadDb() {
  try {
    const raw = readDbFile();
    for (const s of STORES) {
      for (const rec of Array.isArray(raw[s]) ? raw[s] : []) {
        const k = rec && rec[keyField(s)];
        if (typeof k === 'string' && k) db[s].set(k, rec);
      }
    }
    console.log('Loaded data from ' + DATA_FILE);
  } catch (e) {
    if (e.code !== 'ENOENT') console.error('Could not read ' + DATA_FILE + ': ' + e.message);
  }
}


let saveTimer = null;
function saveDb() {
  const out = {};
  for (const s of STORES) out[s] = [...db[s].values()];
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(out));
  fs.renameSync(tmp, DATA_FILE);
  lastSaveAt = Date.now(); lastSaveError = '';
  if (Date.now() - lastBackupAt >= BACKUP_EVERY_MS) makeBackup();
}
function makeBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const name = 'db-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-') + '.json';
    fs.copyFileSync(DATA_FILE, path.join(BACKUP_DIR, name));
    lastBackupAt = Date.now();
    for (const old of listBackups().slice(0, -BACKUP_KEEP)) fs.unlinkSync(path.join(BACKUP_DIR, old));
  } catch (e) { trackError('backup', e); }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { saveDb(); } catch (e) { lastSaveError = e.message; trackError('save', e); console.error('Save failed: ' + e.message); }
  }, 300);
}
function flushAndExit() {
  try { saveDb(); } catch (e) { console.error('Save failed: ' + e.message); }
  process.exit(0);
}
process.on('SIGINT', flushAndExit);
process.on('SIGTERM', flushAndExit);

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
function send(res, status, body, headers) {
  const isStr = typeof body === 'string' || Buffer.isBuffer(body);
  const data = isStr ? body : JSON.stringify(body);
  res.writeHead(status, Object.assign(
    { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(data) },
    headers || {}
  ));
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (e) { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

const isObj = v => v && typeof v === 'object' && !Array.isArray(v);

/* ------------------------------------------------------------------ */
/* App file (gzip once, re-compress if the file changes)               */
/* ------------------------------------------------------------------ */
let appCache = null; // { mtimeMs, size, raw, gz, etag }
function getApp() {
  if (APP_FILE) { // optional external override (re-read when the file changes)
    const st = fs.statSync(APP_FILE);
    if (!appCache || appCache.mtimeMs !== st.mtimeMs || appCache.size !== st.size) {
      const raw = fs.readFileSync(APP_FILE);
      appCache = {
        mtimeMs: st.mtimeMs, size: st.size, raw,
        gz: zlib.gzipSync(raw, { level: 9 }),
        etag: '"' + crypto.createHash('sha1').update(raw).digest('hex').slice(0, 20) + '"'
      };
    }
    return appCache;
  }
  return appCache;
}

const PWA_FILES = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'application/javascript; charset=utf-8', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/icon-maskable-512.png': 'image/png' };
function serveApp(req, res) {
  let app;
  try { app = getApp(); }
  catch (e) { return send(res, 404, 'App file not found: ' + APP_FILE + ' - put index.html in the same folder as server.js'); }
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: app.etag, Vary: 'Accept-Encoding' };
  if (req.headers['if-none-match'] === app.etag) { res.writeHead(304, headers); return res.end(); }
  const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? app.gz : app.raw;
  if (gz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  res.end(body);
}

/* ------------------------------------------------------------------ */
/* Sync                                                                */
/* ------------------------------------------------------------------ */
function keyOk(req) { return !SYNC_KEY || req.headers['x-sync-key'] === SYNC_KEY; }
function health() {
  const counts = {}; for (const st of STORES) counts[st] = db[st].size;
  let dbStatus = 'connected';
  try { fs.accessSync(path.dirname(DATA_FILE), fs.constants.W_OK); } catch (e) { dbStatus = 'error'; }
  if (lastSaveError) dbStatus = 'error';
  return { ok: true, time: new Date().toISOString(), uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    db: { status: dbStatus, file: path.basename(DATA_FILE), records: counts, lastSave: lastSaveAt ? new Date(lastSaveAt).toISOString() : null, lastSaveError },
    backups: { count: listBackups().length, last: lastBackupAt ? new Date(lastBackupAt).toISOString() : null },
    conflictsResolved: conflictTotal, keyRequired: !!SYNC_KEY, tts: { configured: !!GOOGLE_TTS_KEY }, errors: { count: errorTotal, recent: serverErrors.slice(-5) } };
}
async function handleTts(req, res) {
  if (!GOOGLE_TTS_KEY) return send(res, 503, { ok: false, error: 'Google voice is not set up on the server' });
  const b = await readJson(req);
  const lang = isObj(b) && TTS_LANG[b.lang] ? b.lang : null, text = isObj(b) && typeof b.text === 'string' ? b.text.trim() : '';
  if (!lang || !text || text.length > 500) return send(res, 400, { ok: false, error: 'Bad text or language' });
  const rate = Math.min(1.5, Math.max(0.5, Number(b.rate) || 0.9));
  const key = lang + '|' + rate + '|' + text;
  if (ttsCache.has(key)) return send(res, 200, { ok: true, mime: 'audio/mpeg', audio: ttsCache.get(key), cached: true });
  const mk = name => ({ input: { text }, voice: Object.assign({ languageCode: TTS_LANG[lang] }, name ? { name } : { ssmlGender: 'FEMALE' }), audioConfig: { audioEncoding: 'MP3', speakingRate: rate, sampleRateHertz: 24000 } });
  let r = await googlePost(mk(TTS_VOICES[lang]));
  if (r.status === 400) r = await googlePost(mk(null)); // that named voice may not exist for this language: use Google's default voice
  if (r.status !== 200 || !r.json.audioContent) { trackError('tts', (r.json && r.json.error && r.json.error.message) || 'HTTP ' + r.status); return send(res, 502, { ok: false, error: 'Google voice request failed' }); }
  if (ttsCache.size > 300) ttsCache.delete(ttsCache.keys().next().value);
  ttsCache.set(key, r.json.audioContent);
  send(res, 200, { ok: true, mime: 'audio/mpeg', audio: r.json.audioContent });
}
function handleBackupDownload(req, res) {
  if (!SYNC_KEY || !keyOk(req)) return send(res, 403, { ok: false, error: 'Set SYNC_KEY on the server and send it as x-sync-key' });
  const out = {}; for (const st of STORES) out[st] = [...db[st].values()];
  send(res, 200, JSON.stringify(out), { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="msrtc-backup-' + new Date().toISOString().slice(0, 10) + '.json"' });
}
async function handleBackupRestore(req, res) {
  if (!SYNC_KEY || !keyOk(req)) return send(res, 403, { ok: false, error: 'Set SYNC_KEY on the server and send it as x-sync-key' });
  const raw = await readJson(req); let n = 0;
  if (!isObj(raw)) return send(res, 400, { ok: false, error: 'Bad backup file' });
  makeBackup(); // keep a copy of what is there now
  for (const st of STORES) for (const rec of Array.isArray(raw[st]) ? raw[st] : []) { const k = isObj(rec) && rec[keyField(st)]; if (typeof k === 'string' && k) { db[st].set(k, rec); n++; } }
  saveDb(); send(res, 200, { ok: true, restored: n });
}

async function handlePush(req, res) {
  const body = await readJson(req);
  const store = body && body.store;
  if (!CLIENT_STORES.includes(store) || !Array.isArray(body.records)) return send(res, 400, { ok: false, error: 'Bad store or records' });
  const kf = keyField(store);
  let saved = 0; const conflictKeys = [];
  for (const rec of body.records) {
    if (!isObj(rec)) continue;
    const k = rec[kf];
    if (typeof k !== 'string' || !k || k.length > 200) continue;
    const old = db[store].get(k);
    if (old && typeof old.updatedAt === 'number' && typeof rec.updatedAt === 'number' && old.updatedAt > rec.updatedAt) { conflictKeys.push(k); conflictTotal++; continue; } // server already has a NEWER edit
    const clean = Object.assign({}, rec);
    delete clean.id;      // local auto-increment id of the sender's IndexedDB
    delete clean.synced;  // each device tracks this itself
    db[store].set(k, clean);
    saved++;
  }
  if (saved) scheduleSave();
  send(res, 200, { ok: true, saved, conflicts: conflictKeys.length, conflictKeys });
}

async function handleDelete(req, res) {
  const body = await readJson(req);
  const store = body && body.store;
  if (!CLIENT_STORES.includes(store) || !Array.isArray(body.keys)) return send(res, 400, { ok: false, error: 'Bad store or keys' });
  let removed = 0;
  for (const k of body.keys) if (typeof k === 'string' && db[store].delete(k)) removed++;
  if (removed) scheduleSave();
  send(res, 200, { ok: true, removed });
}

/* PUBLIC, READ-ONLY, NO LOGIN: the passenger "See My Bus" screen. It returns ONLY the bus number, the depot where the bus was
   last registered and the registration time - never drivers, conductors, mobile numbers, accounts or any other data.
   Needs at least 3 characters, returns at most 5 buses, and is rate-limited per address. It does not need the sync key. */
const pubHits = new Map();
function handlePublicBus(req, res) {
  const ip = String(req.socket && req.socket.remoteAddress || '?'), now = Date.now();
  const h = (pubHits.get(ip) || []).filter(t => now - t < 60000);
  if (h.length >= 40) return send(res, 429, { ok: false, error: 'Too many searches. Please wait a minute.' });
  h.push(now); pubHits.set(ip, h);
  if (pubHits.size > 5000) for (const [k, arr] of pubHits) if (!arr.some(t => now - t < 60000)) pubHits.delete(k);
  const norm = x => String(x == null ? '' : x).toLowerCase().replace(/[\s-]/g, '');
  const rawQ = String(new URL(req.url, 'http://x').searchParams.get('q') || '');
  const q = norm(rawQ), words = rawQ.toLowerCase().split(/\s+/).filter(Boolean);
  if (q.length < 3) return send(res, 200, { ok: true, buses: [] });
  const ts = r => Number(r.scanEpoch) || Date.parse(r.scanTimestamp) || 0;
  const best = new Map();
  for (const r of db.depotRegister.values()) {
    /* match by bus number, service number OR route (every typed word must be in the route) */
    if (!r || !r.busNo || !(norm(r.busNo).includes(q) || norm(r.serviceNo).includes(q) || words.every(w => String(r.route || '').toLowerCase().includes(w)))) continue;
    const cur = best.get(r.busNo);
    if (!cur || ts(r) > ts(cur)) best.set(r.busNo, r);
  }
  const buses = [...best.values()].sort((a, b) => ts(b) - ts(a)).slice(0, 10)
    .map(r => ({ busNo: r.busNo, depotName: r.depotName || '', scanEpoch: ts(r) || null, scanTimestamp: r.scanTimestamp || '' }));
  send(res, 200, { ok: true, buses }, { 'Cache-Control': 'no-store' });
}

function handlePull(req, res) {
  const out = {};
  for (const s of PULL_STORES) out[s] = [...db[s].values()];
  send(res, 200, out);
}

/* ------------------------------------------------------------------ */
/* OTP                                                                 */
/* ------------------------------------------------------------------ */
const otps = new Map(); // username -> { hash, exp, tries, sentAt }
const hashCode = code => crypto.createHash('sha256').update(String(code)).digest();

/* ---- Minimal SMTP client (implicit TLS on 465, STARTTLS on 587) ---- */
async function smtpSend(o) {
  const net = require('net'), tls = require('tls');
  let sock = o.secure ? tls.connect({ host: o.host, port: o.port, servername: o.host })
                      : net.connect({ host: o.host, port: o.port });
  let buf = '', pending = null, err = null, encrypted = !!o.secure;

  const flush = () => {
    if (!pending) return;
    const m = buf.match(/^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/);
    if (!m) return;
    buf = buf.slice(m[0].length);
    const p = pending; pending = null;
    p.res(m[0].trim().split('\r\n'));
  };
  const wire = s => {
    s.on('data', d => { buf += d.toString('utf8'); flush(); });
    s.on('error', e => { err = e; if (pending) { pending.rej(e); pending = null; } });
    s.on('close', () => { if (!err) err = new Error('SMTP connection closed'); if (pending) { pending.rej(err); pending = null; } });
  };
  const read = () => new Promise((res, rej) => { if (err) return rej(err); pending = { res, rej }; flush(); });
  const expect = async codes => {
    const r = await read();
    if (!codes.includes(r[r.length - 1].slice(0, 3))) throw new Error('SMTP: ' + r.join(' | '));
    return r;
  };
  const cmd = (line, codes) => { sock.write(line + '\r\n'); return expect(codes); };
  const b64 = v => Buffer.from(v, 'utf8').toString('base64');
  wire(sock);

  const run = async () => {
    await expect(['220']);
    const me = 'msrtc-server';
    let caps = (await cmd('EHLO ' + me, ['250'])).join('\n').toUpperCase();
    if (!encrypted) {
      if (caps.includes('STARTTLS')) {
        await cmd('STARTTLS', ['220']);
        sock.removeAllListeners('data'); buf = '';
        sock = tls.connect({ socket: sock, servername: o.host });
        wire(sock); encrypted = true;
        caps = (await cmd('EHLO ' + me, ['250'])).join('\n').toUpperCase();
      } else if (o.user) {
        throw new Error('Server does not offer encryption; refusing to send the password');
      }
    }
    if (o.user) {
      if (/AUTH[^\n]*\bPLAIN\b/.test(caps)) {
        await cmd('AUTH PLAIN ' + b64('\0' + o.user + '\0' + o.pass), ['235']);
      } else {
        await cmd('AUTH LOGIN', ['334']);
        await cmd(b64(o.user), ['334']);
        await cmd(b64(o.pass), ['235']);
      }
    }
    const envFrom = (o.from.match(/<([^>]+)>/) || [null, o.from])[1].trim();
    await cmd('MAIL FROM:<' + envFrom + '>', ['250']);
    await cmd('RCPT TO:<' + o.to + '>', ['250', '251']);
    await cmd('DATA', ['354']);
    const body = Buffer.from(o.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
    const msg = [
      'From: ' + (o.headerFrom || o.from),
      ...(o.headerFrom ? ['Reply-To: ' + o.headerFrom, 'Sender: ' + o.from] : []),
      'To: <' + o.to + '>',
      'Subject: =?UTF-8?B?' + b64(o.subject) + '?=',
      'Date: ' + new Date().toUTCString(),
      'Message-ID: <' + crypto.randomUUID() + '@msrtc-server>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '', body, ''
    ].join('\r\n');
    sock.write(msg + '\r\n.\r\n');
    await expect(['250']);
    try { sock.write('QUIT\r\n'); } catch (e) { /* ignore */ }
  };

  let timer;
  try {
    await Promise.race([
      run(),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('SMTP timeout')), 20000); })
    ]);
  } finally {
    clearTimeout(timer);
    try { sock.end(); sock.destroy(); } catch (e) { /* ignore */ }
  }
}

const normName = s => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Email of the Depot account that belongs to this depot name (the sender)
function findDepotSender(depotName) {
  const want = normName(depotName);
  if (!want) return null;
  for (const u of db.users.values()) {
    if (u && u.role === 'Depot' && normName(u.depotName) === want) {
      const email = typeof u.email === 'string' ? u.email.trim() : '';
      if (EMAIL_RE.test(email)) return { email, name: String(u.depotName || u.name || '').replace(/[\r\n<>"]/g, ' ').trim() };
    }
  }
  return null;
}

const maskEmail = e => e.replace(/^(.).*?(@.*)$/, '$1***$2');

/* send one e-mail through the Brevo HTTPS API */
function brevoSend(o) {
  return new Promise((resolve, reject) => {
    const u = new URL(BREVO_URL), lib = u.protocol === 'http:' ? require('http') : require('https');
    const body = JSON.stringify({ sender: { name: 'MSRTC Depot', email: BREVO_SENDER }, to: [{ email: o.to }], subject: o.subject, textContent: o.text });
    const rq = lib.request({ method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'http:' ? 80 : 443), path: u.pathname + u.search,
      headers: { 'api-key': BREVO_KEY, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 20000 }, r => {
      let d = ''; r.on('data', c => { d += c; if (d.length > 5000) d = d.slice(0, 5000); });
      r.on('end', () => (r.statusCode >= 200 && r.statusCode < 300) ? resolve() : reject(new Error('Brevo HTTP ' + r.statusCode + ' ' + d.replace(/\s+/g, ' ').slice(0, 200))));
    });
    rq.on('timeout', () => rq.destroy(new Error('Brevo request timed out'))); rq.on('error', reject); rq.end(body);
  });
}

async function deliverOtp(username, email, code, depot) {
  if (BREVO_OK && BREVO_SENDER.includes('@')) {
    await brevoSend({ to: email, subject: 'MSRTC पडताळणी कोड / Verification code',
      text: 'तुमचा MSRTC पडताळणी कोड: ' + code + '\nहा कोड ५ मिनिटांसाठी वैध आहे. तो कोणालाही सांगू नका.\n\n' +
            'Your MSRTC verification code is ' + code + '.\nIt is valid for 5 minutes. Do not share it with anyone.\n' });
    return;
  }
  const headerFrom = depot
    ? (/^[\x20-\x7e]*$/.test(depot.name) && depot.name ? '"' + depot.name + '" <' + depot.email + '>'
       : '=?UTF-8?B?' + Buffer.from(depot.name || 'MSRTC Depot', 'utf8').toString('base64') + '?= <' + depot.email + '>')
    : '';
  const entry = depot ? loadDepotSmtp()[depot.email.toLowerCase()] : null;
  if (entry) { // send through the depot's own mailbox: true From = depot address
    const cfg = typeof entry === 'string' ? { pass: entry } : entry;
    const port = parseInt(cfg.port, 10) || 465;
    await smtpSend({
      host: cfg.host || 'smtp.gmail.com', port, secure: port === 465,
      user: depot.email, pass: String(cfg.pass || '').replace(/\s+/g, ''),
      from: headerFrom, to: email,
      subject: 'MSRTC पडताळणी कोड / Verification code',
      text: 'तुमचा MSRTC पडताळणी कोड: ' + code + '\nहा कोड ५ मिनिटांसाठी वैध आहे. तो कोणालाही सांगू नका.\n\n' +
            'Your MSRTC verification code is ' + code + '.\nIt is valid for 5 minutes. Do not share it with anyone.\n'
    });
    return;
  }
  if (depot && /@(gmail|googlemail)\.com$/i.test(depot.email)) {
    console.warn('[OTP] No App Password for ' + depot.email + ' in DEPOT_GMAIL (top of server.js) - Gmail will show the SMTP account as sender instead.');
  }
  if (!MAIL_ENABLED) {
    console.log('[OTP - test mode, no SMTP set] from ' + (depot ? depot.email : '(SMTP_FROM)') + ' to ' + username + ' <' + email + '>: ' + code);
    return;
  }
  await smtpSend({
    host: SMTP.host, port: SMTP.port, secure: SMTP.secure, user: SMTP.user, pass: SMTP.pass,
    from: SMTP.from, headerFrom, to: email,
    subject: 'MSRTC पडताळणी कोड / Verification code',
    text: 'तुमचा MSRTC पडताळणी कोड: ' + code + '\nहा कोड ५ मिनिटांसाठी वैध आहे. तो कोणालाही सांगू नका.\n\n' +
          'Your MSRTC verification code is ' + code + '.\nIt is valid for 5 minutes. Do not share it with anyone.\n'
  });
}

async function handleOtpSend(req, res) {
  const b = await readJson(req);
  if (typeof b.username !== 'string' || !b.username) return send(res, 400, { ok: false });
  // TO: the email entered for this staff account (saved on the server) - never one supplied in the request
  const user = db.users.get(b.username);
  const email = user && typeof user.email === 'string' ? user.email.trim() : '';
  if (!EMAIL_RE.test(email)) return send(res, 400, { ok: false, error: 'No valid email on record for this account (sync the account to the server first)' });
  // FROM: the email entered for this staff member's depot account
  const depot = findDepotSender(user.depotName);
  const prev = otps.get(b.username);
  if (prev && Date.now() - prev.sentAt < OTP_COOLDOWN_MS) return send(res, 429, { ok: false, error: 'Wait before requesting another OTP' });
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  otps.set(b.username, { hash: hashCode(code), exp: Date.now() + OTP_TTL_MS, tries: 0, sentAt: Date.now() });
  try {
    await deliverOtp(b.username, email, code, depot);
  } catch (e) {
    otps.delete(b.username);
    console.error('OTP email failed for ' + b.username + ': ' + e.message);
    return send(res, 502, { ok: false, error: 'Could not send email' });
  }
  const mailed = MAIL_ENABLED || !!(depot && loadDepotSmtp()[depot.email.toLowerCase()]);
  send(res, 200, { ok: true, sentTo: maskEmail(email), from: depot ? depot.email : null, mailed, testMode: !mailed });
}

async function handleOtpVerify(req, res) {
  const b = await readJson(req);
  const rec = typeof b.username === 'string' ? otps.get(b.username) : null;
  if (!rec || Date.now() > rec.exp) { if (rec) otps.delete(b.username); return send(res, 200, { ok: false }); }
  rec.tries++;
  const ok = crypto.timingSafeEqual(hashCode(String(b.code || '').trim()), rec.hash);
  if (ok || rec.tries >= OTP_MAX_TRIES) otps.delete(b.username);
  if (ok) otpPass.set(String(b.username).trim().toUpperCase(), Date.now() + 10 * 60000); // lets this person re-register a fingerprint (see /bio/register)
  send(res, 200, { ok });
}
setInterval(() => { const n = Date.now(); for (const [k, v] of otps) if (n > v.exp) otps.delete(k); }, 60000).unref();

/* ------------------------------------------------------------------ */
/* BIOMETRIC / PIN VERIFICATION (fingerprint, Android native, PIN)     */
/*  - registration and verification are separate endpoints             */
/*  - every proof is bound to the Employee ID (Personnel ID)           */
/*  - the server keeps the verification status of every employee       */
/*  - offline proofs made on a phone are re-checked here later         */
/*  Stored in the "bio" store (never writable through /sync/push).     */
/* ------------------------------------------------------------------ */
const bioB64 = b => Buffer.from(b).toString('base64url');
const bioUn = s => Buffer.from(String(s || ''), 'base64url');
const bioSha = d => crypto.createHash('sha256').update(d).digest();
const BIO_PURPOSES = ['REGISTER', 'LOGIN', 'BUS_REGISTER', 'ACCOUNT_EDIT', 'DATA_DELETE', 'PIN_SET', 'STATUS'];
const BIO_PIN_ITER = 150000;
const bioChallenges = new Map();   // cid -> { emp, purpose, ch, exp }
const bioGrants = new Map();       // token -> { emp, exp }   (proof that this person just verified)
const bioNonces = new Map();       // offline proof nonce -> exp
const bioAuthFails = new Map();    // emp -> { n, until }
const otpPass = new Map();         // emp -> exp (set after a correct email OTP)
const bioErr = (status, msg) => Object.assign(new Error(msg), { status });
const bioEmp = v => { const e = String(v || '').trim().toUpperCase(); if (!e || e.length > 64) throw bioErr(400, 'Bad Employee ID'); return e; };
const bioDevice = d => (isObj(d) ? { id: String(d.id || '').slice(0, 64), name: String(d.name || '').slice(0, 80) } : { id: '', name: '' });

function cborDecode(buf, o) {
  const ib = buf[o.p++], mt = ib >> 5, ai = ib & 31; let n;
  if (ai < 24) n = ai; else if (ai === 24) n = buf[o.p++]; else if (ai === 25) { n = buf.readUInt16BE(o.p); o.p += 2; } else if (ai === 26) { n = buf.readUInt32BE(o.p); o.p += 4; } else throw new Error('Unsupported CBOR');
  if (mt === 0) return n; if (mt === 1) return -1 - n;
  if (mt === 2) { const v = Buffer.from(buf.subarray(o.p, o.p + n)); o.p += n; return v; }
  if (mt === 3) { const v = buf.toString('utf8', o.p, o.p + n); o.p += n; return v; }
  if (mt === 4) { const a = []; for (let i = 0; i < n; i++) a.push(cborDecode(buf, o)); return a; }
  if (mt === 5) { const m = new Map(); for (let i = 0; i < n; i++) { const k = cborDecode(buf, o); m.set(k, cborDecode(buf, o)); } return m; }
  if (mt === 7) return n === 20 ? false : n === 21 ? true : null;
  throw new Error('Unsupported CBOR');
}
function parseAuthData(ad) {
  if (ad.length < 37) throw bioErr(400, 'Bad authenticator data');
  const r = { rpIdHash: ad.subarray(0, 32), flags: ad[32] };
  if (r.flags & 0x40) {
    let p = 53; const len = ad.readUInt16BE(p); p += 2;
    r.credId = ad.subarray(p, p + len); p += len; r.cose = cborDecode(ad, { p });
  }
  return r;
}
function coseToSpki(c) {
  if (!(c instanceof Map)) throw bioErr(400, 'Bad public key');
  const kty = c.get(1), alg = c.get(3); let jwk;
  if (kty === 2 && alg === -7 && c.get(-1) === 1) jwk = { kty: 'EC', crv: 'P-256', x: bioB64(c.get(-2)), y: bioB64(c.get(-3)) };
  else if (kty === 3 && alg === -257) jwk = { kty: 'RSA', n: bioB64(c.get(-1)), e: bioB64(c.get(-2)) };
  else throw bioErr(400, 'Unsupported key type');
  return { alg, pk: bioB64(crypto.createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'der' })) };
}
function bioSigOk(pk, data, sig) {
  try { return crypto.verify('sha256', data, crypto.createPublicKey({ key: bioUn(pk), format: 'der', type: 'spki' }), sig); } catch (e) { return false; }
}
const originHost = o => { try { const u = new URL(String(o)); return u.hostname; } catch (e) { return ''; } };

function bioRec(emp, create) {
  let r = db.bio.get(emp);
  if (!r && create) { r = { emp, creds: [], pin: null, ver: 0, last: null, history: [], failCount: 0, createdAt: Date.now() }; db.bio.set(emp, r); }
  return r;
}
function bioLog(r, ok, method, purpose, mode, dev, extra) {
  const ev = Object.assign({ t: Date.now(), ok, method, purpose, mode, device: dev && dev.name || '' }, extra || {});
  r.history.push(ev); if (r.history.length > 40) r.history.shift();
  if (method !== 'REGISTER' && method !== 'PIN_SET') {   // setting things up is not a verification
    if (!r.last || ev.t >= r.last.t) r.last = ev;
    r.failCount = ok ? 0 : (r.failCount || 0) + 1;
  }
  r.updatedAt = Date.now(); scheduleSave();
}
function bioSummary(r, emp) {
  if (!r) return { emp, state: 'NOT_REGISTERED', credCount: 0, hasPin: false };
  const locked = !!(r.pin && r.pin.lockUntil > Date.now());
  const state = locked ? 'LOCKED' : (!r.creds.length && !r.pin) ? 'NOT_REGISTERED' : !r.last ? 'REGISTERED' : r.last.ok ? 'VERIFIED' : 'FAILED';
  return { emp: r.emp, state, credCount: r.creds.length, hasPin: !!r.pin, locked, lockUntil: locked ? r.pin.lockUntil : 0,
    lastVerifiedAt: r.last && r.last.ok ? r.last.t : 0, lastAttemptAt: r.last ? r.last.t : 0, lastMethod: r.last ? r.last.method : '', lastPurpose: r.last ? r.last.purpose : '',
    lastMode: r.last ? r.last.mode : '', lastDevice: r.last ? r.last.device : '', failCount: r.failCount || 0, registeredAt: r.createdAt || 0 };
}
function serverBioKey() {
  let k = db.bio.get('__server__');
  if (!k) {
    const kp = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    k = { emp: '__server__', priv: kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), pub: bioB64(kp.publicKey.export({ type: 'spki', format: 'der' })), createdAt: Date.now() };
    db.bio.set('__server__', k); scheduleSave();
  }
  return k;
}
/* signed list of an employee's public keys: lets a phone check fingerprints offline without trusting its own (editable) database */
function bioManifest(emp) {
  const r = bioRec(emp), m = JSON.stringify({ emp, ver: r ? r.ver : 0, ts: Date.now(), pin: !!(r && r.pin), creds: (r ? r.creds : []).map(c => ({ id: c.id, pk: c.pk, alg: c.alg, kind: c.kind, rp: c.rp || '', transports: c.transports || [] })) });
  return { m, sig: bioB64(crypto.sign('sha256', Buffer.from(m), { key: serverBioKey().priv, dsaEncoding: 'ieee-p1363' })) };
}
function bioNewChallenge(emp, purpose) {
  const cid = bioB64(crypto.randomBytes(16)), ch = bioB64(crypto.randomBytes(32));
  bioChallenges.set(cid, { emp, purpose, ch, exp: Date.now() + 120000 }); return { cid, challenge: ch };
}
function bioTakeChallenge(cid, emp, purpose) {
  const c = bioChallenges.get(String(cid)); bioChallenges.delete(String(cid));   // one use only
  if (!c || c.exp < Date.now() || c.emp !== emp || (purpose && c.purpose !== purpose)) throw bioErr(400, 'Challenge expired or invalid. Try again.');
  return c;
}
function bioAuthorize(emp, auth, r) {
  const t = bioAuthFails.get(emp);
  if (t && t.until > Date.now()) throw bioErr(429, 'Too many failed attempts. Try again later.');
  const enrolled = !!(r && (r.creds.length || r.pin));
  let ok = false; auth = isObj(auth) ? auth : {};
  if (auth.type === 'grant') { const g = bioGrants.get(String(auth.token)); ok = !!(g && g.emp === emp && g.exp > Date.now()); }
  else if (auth.type === 'otp') ok = (otpPass.get(emp) || 0) > Date.now();
  else if (auth.type === 'password' && !enrolled) {
    const u = db.users.get(emp), a = Buffer.from(String(u && u.password || '')), b = Buffer.from(String(auth.hash || ''));
    ok = !!(u && a.length && a.length === b.length && crypto.timingSafeEqual(a, b));
  }
  if (!ok) { const n = ((t && t.n) || 0) + 1; bioAuthFails.set(emp, { n, until: n >= 8 ? Date.now() + 10 * 60000 : 0 }); throw bioErr(403, enrolled ? 'Verify with your fingerprint / PIN or an email code first.' : 'Account password check failed.'); }
  bioAuthFails.delete(emp);
}
const bioGrant = emp => { const token = bioB64(crypto.randomBytes(24)); bioGrants.set(token, { emp, exp: Date.now() + 5 * 60000 }); return token; };
const pinHash = (pin, salt, iter) => new Promise((res, rej) => crypto.pbkdf2(String(pin), salt, iter, 32, 'sha256', (e, k) => e ? rej(e) : res(k)));
const PIN_RE = /^[0-9]{6}$/;

/* check one fingerprint proof (WebAuthn or Android Keystore) against the stored public keys.  Returns the credential or throws. */
function bioCheckProof(r, p, expectChallenge, androidData) {
  const cred = r.creds.find(c => c.id === p.credId);
  if (!cred) throw bioErr(403, 'This sensor / key is not registered for this Employee ID.');
  if (cred.kind === 'android-native') {
    if (!bioSigOk(cred.pk, Buffer.from(androidData), bioUn(p.signature))) throw bioErr(403, 'Fingerprint proof is not valid.');
    return cred;
  }
  const cdRaw = bioUn(p.clientDataJSON); let cd; try { cd = JSON.parse(cdRaw.toString('utf8')); } catch (e) { throw bioErr(400, 'Bad client data'); }
  const host = originHost(cd.origin);
  if (cd.type !== 'webauthn.get' || cd.challenge !== expectChallenge || !host || host !== cred.rp) throw bioErr(403, 'Fingerprint reply could not be trusted.');
  const ad = bioUn(p.authenticatorData);
  if (ad.length < 37 || !bioSha(host).equals(ad.subarray(0, 32))) throw bioErr(403, 'Fingerprint reply was for a different address.');
  if (!(ad[32] & 1) || !(ad[32] & 4)) throw bioErr(403, 'The sensor did not confirm the user.');
  if (!bioSigOk(cred.pk, Buffer.concat([ad, bioSha(cdRaw)]), bioUn(p.signature))) throw bioErr(403, 'Fingerprint proof is not valid.');
  return cred;
}

async function handleBioChallenge(req, res) {
  const b = await readJson(req), emp = bioEmp(b.emp), purpose = String(b.purpose || '');
  if (!BIO_PURPOSES.includes(purpose)) throw bioErr(400, 'Bad purpose');
  const r = bioRec(emp), c = bioNewChallenge(emp, purpose);
  send(res, 200, { ok: true, cid: c.cid, challenge: c.challenge, creds: (r ? r.creds : []).map(x => ({ id: x.id, kind: x.kind, transports: x.transports || [], rp: x.rp || '' })), hasPin: !!(r && r.pin), status: bioSummary(r, emp) });
}
async function handleBioRegister(req, res) {
  const b = await readJson(req), emp = bioEmp(b.emp), dev = bioDevice(b.device), r = bioRec(emp);
  if (!db.users.get(emp)) throw bioErr(404, 'No account with this Employee ID on the server yet. Sync first.');
  bioAuthorize(emp, b.auth, r);
  const c = bioTakeChallenge(b.cid, emp, 'REGISTER'); let cred;
  if (b.kind === 'android-native') {
    const pk = String(b.publicKey || ''), id = bioB64(bioSha(bioUn(pk)));
    if (!bioSigOk(pk, Buffer.from('REG|' + emp + '|' + c.ch), bioUn(b.signature))) throw bioErr(403, 'Android fingerprint proof is not valid.');
    cred = { id, pk, alg: -7, kind: 'android-native', rp: '', transports: ['internal'] };
  } else {
    const cdRaw = bioUn(b.clientDataJSON); let cd; try { cd = JSON.parse(cdRaw.toString('utf8')); } catch (e) { throw bioErr(400, 'Bad client data'); }
    const host = originHost(cd.origin);
    if (cd.type !== 'webauthn.create' || cd.challenge !== c.ch || !host) throw bioErr(403, 'Registration could not be trusted.');
    let att; try { att = cborDecode(bioUn(b.attestationObject), { p: 0 }); } catch (e) { throw bioErr(400, 'Bad attestation'); }
    const ad = att instanceof Map ? att.get('authData') : null; if (!Buffer.isBuffer(ad)) throw bioErr(400, 'Bad attestation');
    const p = parseAuthData(ad);
    if (!bioSha(host).equals(p.rpIdHash) || !(p.flags & 4) || !p.credId || !p.cose) throw bioErr(403, 'The sensor did not confirm a fingerprint.');
    const k = coseToSpki(p.cose);
    cred = { id: bioB64(p.credId), pk: k.pk, alg: k.alg, kind: b.kind === 'cross-platform' ? 'cross-platform' : 'platform', rp: host, transports: Array.isArray(b.transports) ? b.transports.filter(x => typeof x === 'string').slice(0, 6) : [] };
  }
  for (const [e2, r2] of db.bio) if (e2 !== '__server__' && r2.creds && r2.creds.some(x => x.id === cred.id)) throw bioErr(409, 'This fingerprint key is already registered.');
  const rr = bioRec(emp, true);
  cred.label = String(b.label || '').slice(0, 80) || cred.kind; cred.addedAt = Date.now(); cred.device = dev.name;
  rr.creds.push(cred); rr.ver++; bioLog(rr, true, 'REGISTER', 'REGISTER', 'ONLINE', dev, { kind: cred.kind });
  send(res, 200, { ok: true, cred: { id: cred.id, pk: cred.pk, alg: cred.alg, kind: cred.kind, rp: cred.rp, transports: cred.transports, label: cred.label, added: new Date(cred.addedAt).toISOString() }, status: bioSummary(rr, emp), grant: bioGrant(emp), manifest: bioManifest(emp), serverKey: serverBioKey().pub });
}
async function handleBioVerify(req, res) {
  const b = await readJson(req), emp = bioEmp(b.emp), dev = bioDevice(b.device), purpose = String(b.purpose || ''), r = bioRec(emp);
  if (!BIO_PURPOSES.includes(purpose)) throw bioErr(400, 'Bad purpose');
  const c = bioTakeChallenge(b.cid, emp, purpose);
  if (!r || !r.creds.length) throw bioErr(404, 'No fingerprint is registered for this Employee ID.');
  let cred;
  try { cred = bioCheckProof(r, b, c.ch, 'VER|' + emp + '|' + purpose + '|' + c.ch); }
  catch (e) { bioLog(r, false, 'FINGERPRINT', purpose, 'ONLINE', dev); return send(res, 200, { ok: false, error: e.message, status: bioSummary(r, emp) }); }
  bioLog(r, true, 'FINGERPRINT', purpose, 'ONLINE', dev, { kind: cred.kind });
  send(res, 200, { ok: true, grant: bioGrant(emp), status: bioSummary(r, emp), manifest: bioManifest(emp), serverKey: serverBioKey().pub });
}
async function handleBioPinVerify(req, res) {
  const b = await readJson(req), emp = bioEmp(b.emp), dev = bioDevice(b.device), purpose = String(b.purpose || ''), r = bioRec(emp);
  if (!BIO_PURPOSES.includes(purpose)) throw bioErr(400, 'Bad purpose');
  if (!r || !r.pin) return send(res, 200, { ok: false, error: 'No PIN is set for this Employee ID.', status: bioSummary(r, emp) });
  if (r.pin.lockUntil > Date.now()) return send(res, 200, { ok: false, locked: true, lockUntil: r.pin.lockUntil, error: 'PIN is locked after wrong attempts. Try again later or use your fingerprint.', status: bioSummary(r, emp) });
  const salt = bioUn(r.pin.salt), h = await pinHash(String(b.pin || ''), salt, r.pin.iter), good = h.length === bioUn(r.pin.hash).length && crypto.timingSafeEqual(h, bioUn(r.pin.hash));
  if (!good) {
    r.pin.failed = (r.pin.failed || 0) + 1;
    if (r.pin.failed >= 5) r.pin.lockUntil = Date.now() + Math.min(24 * 3600e3, 15 * 60e3 * Math.pow(2, Math.floor(r.pin.failed / 5) - 1));
    bioLog(r, false, 'PIN', purpose, 'ONLINE', dev);
    return send(res, 200, { ok: false, locked: r.pin.lockUntil > Date.now(), lockUntil: r.pin.lockUntil || 0, triesLeft: Math.max(0, 5 - (r.pin.failed % 5)), error: 'Wrong PIN.', status: bioSummary(r, emp) });
  }
  r.pin.failed = 0; r.pin.lockUntil = 0; bioLog(r, true, 'PIN', purpose, 'ONLINE', dev);
  const out = { ok: true, grant: bioGrant(emp), status: bioSummary(r, emp) };
  if (b.wantLocal) out.verifier = { salt: r.pin.salt, hash: r.pin.hash, iter: r.pin.iter };   // lets THIS phone check the PIN offline
  send(res, 200, out);
}
async function handleBioPinSet(req, res) {
  const b = await readJson(req), emp = bioEmp(b.emp), dev = bioDevice(b.device);
  if (!PIN_RE.test(String(b.pin || ''))) throw bioErr(400, 'PIN must be exactly 6 digits.');
  if (!db.users.get(emp)) throw bioErr(404, 'No account with this Employee ID on the server yet. Sync first.');
  const r0 = bioRec(emp); bioAuthorize(emp, b.auth, r0);
  const salt = crypto.randomBytes(16), h = await pinHash(b.pin, salt, BIO_PIN_ITER), r = bioRec(emp, true);
  r.pin = { salt: bioB64(salt), hash: bioB64(h), iter: BIO_PIN_ITER, failed: 0, lockUntil: 0, setAt: Date.now() }; r.ver++;
  bioLog(r, true, 'PIN_SET', 'PIN_SET', 'ONLINE', dev);
  send(res, 200, { ok: true, verifier: { salt: r.pin.salt, hash: r.pin.hash, iter: r.pin.iter }, status: bioSummary(r, emp), manifest: bioManifest(emp), serverKey: serverBioKey().pub });
}
async function handleBioRemoveCred(req, res) {
  const b = await readJson(req), emp = bioEmp(b.emp), r = bioRec(emp);
  if (!r) throw bioErr(404, 'Nothing registered.');
  bioAuthorize(emp, b.auth, r);
  const i = r.creds.findIndex(c => c.id === b.credId); if (i < 0) throw bioErr(404, 'Fingerprint not found.');
  if (r.creds.length <= 1 && !r.pin) throw bioErr(409, 'Keep at least one fingerprint or a PIN.');
  r.creds.splice(i, 1); r.ver++; r.updatedAt = Date.now(); scheduleSave();
  send(res, 200, { ok: true, status: bioSummary(r, emp), manifest: bioManifest(emp) });
}
async function handleBioDelete(req, res) {   // account deletion: remove all biometric data of the employee
  const b = await readJson(req), emp = bioEmp(b.emp), r = bioRec(emp);
  if (r) { bioAuthorize(emp, b.auth, r); db.bio.delete(emp); scheduleSave(); }
  send(res, 200, { ok: true });
}
function handleBioStatus(req, res, u) {
  const emp = bioEmp(u.searchParams.get('emp')), r = bioRec(emp);
  send(res, 200, { ok: true, status: bioSummary(r, emp), manifest: bioManifest(emp), serverKey: serverBioKey().pub, history: r ? r.history.slice(-10) : [] });
}
function handleBioStatusList(req, res) {
  send(res, 200, { ok: true, list: [...db.bio.values()].filter(r => r.emp !== '__server__').map(r => bioSummary(r, r.emp)) });
}
function handleBioManifests(req, res) {
  const items = {}; for (const r of db.bio.values()) if (r.emp !== '__server__') items[r.emp] = bioManifest(r.emp);
  send(res, 200, { ok: true, serverKey: serverBioKey().pub, items });
}
/* proofs made while the phone had no internet: re-checked here, so an offline "verified" can be audited later */
async function handleBioOffline(req, res) {
  const b = await readJson(req), out = [];
  for (const p of (Array.isArray(b.proofs) ? b.proofs : []).slice(0, 200)) {
    const nonce = String(p && p.nonce || '');
    try {
      const emp = bioEmp(p.emp), purpose = String(p.purpose), ts = Number(p.ts), r = bioRec(emp), dev = bioDevice(p.device);
      if (!BIO_PURPOSES.includes(purpose) || !nonce || nonce.length > 64) throw bioErr(400, 'Bad proof');
      if (!(ts > Date.now() - 30 * 864e5 && ts < Date.now() + 10 * 60e3)) throw bioErr(400, 'Proof is too old or from the future.');
      if (bioNonces.has(nonce)) { out.push({ nonce, ok: true, duplicate: true }); continue; }
      if (!r) throw bioErr(404, 'No registration for this Employee ID.');
      const P = ['OFFLINE', emp, purpose, ts, nonce, dev.id].join('|');
      if (p.method === 'PIN') {
        if (!r.pin) throw bioErr(404, 'No PIN set.');
        const want = crypto.createHmac('sha256', bioUn(r.pin.hash)).update(P).digest(), got = bioUn(p.proof);
        if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) throw bioErr(403, 'PIN proof not valid.');
      } else bioCheckProof(r, p, bioB64(bioSha(P)), 'OFF|' + P);
      bioNonces.set(nonce, Date.now() + 40 * 864e5);
      const ev = { t: ts, ok: true, method: p.method === 'PIN' ? 'PIN' : 'FINGERPRINT', purpose, mode: 'OFFLINE', device: dev.name };
      r.history.push(ev); if (r.history.length > 40) r.history.shift(); if (!r.last || ts >= r.last.t) r.last = ev; r.updatedAt = Date.now(); scheduleSave();
      out.push({ nonce, ok: true });
    } catch (e) {
      try { const r = bioRec(bioEmp(p && p.emp)); if (r) { r.history.push({ t: Date.now(), ok: false, method: 'OFFLINE_PROOF', purpose: String(p.purpose || ''), mode: 'OFFLINE', device: '' }); if (r.history.length > 40) r.history.shift(); scheduleSave(); } } catch (e2) { }
      out.push({ nonce, ok: false, error: e.message });
    }
  }
  send(res, 200, { ok: true, results: out });
}
setInterval(() => { const n = Date.now(); for (const [k, v] of bioChallenges) if (v.exp < n) bioChallenges.delete(k); for (const [k, v] of bioGrants) if (v.exp < n) bioGrants.delete(k); for (const [k, v] of bioNonces) if (v < n) bioNonces.delete(k); for (const [k, v] of otpPass) if (v < n) otpPass.delete(k); }, 60000).unref();

/* ------------------------------------------------------------------ */
/* Router                                                              */
/* ------------------------------------------------------------------ */
async function handler(req, res) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-sync-key'
  };
  if (req.headers['access-control-request-private-network']) cors['Access-Control-Allow-Private-Network'] = 'true';
  for (const k in cors) res.setHeader(k, cors[k]);

  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  const p = new URL(req.url, 'http://x').pathname;
  try {
    if ((req.method === 'GET' || req.method === 'HEAD') && PWA_FILES[p]) { // installable-app files (manifest, service worker, icons)
      try {
        const buf = fs.readFileSync(path.join(__dirname, p.slice(1)));
        res.writeHead(200, { 'Content-Type': PWA_FILES[p], 'Cache-Control': p === '/sw.js' ? 'no-cache' : 'public, max-age=86400', 'Content-Length': buf.length });
        return res.end(req.method === 'HEAD' ? undefined : buf);
      } catch (e) { return send(res, 404, 'Not found'); }
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && (p === '/' || p === '/index.html' || (APP_FILE && p === '/' + path.basename(APP_FILE)))) return serveApp(req, res);
    if (req.method === 'GET' && p === '/health') return send(res, 200, health());
    if (req.method === 'GET' && p === '/public/bus') return handlePublicBus(req, res);
    if (p.startsWith('/sync/') && !keyOk(req)) return send(res, 401, { ok: false, error: 'Wrong or missing sync key' });
    if (req.method === 'POST' && p === '/tts') { if (!keyOk(req)) return send(res, 401, { ok: false, error: 'Wrong or missing sync key' }); return await handleTts(req, res); }
    if (req.method === 'GET' && p === '/backup/download') return handleBackupDownload(req, res);
    if (req.method === 'POST' && p === '/backup/restore') return await handleBackupRestore(req, res);
    if (req.method === 'GET' && p === '/sync/pull') return handlePull(req, res);
    if (req.method === 'POST' && p === '/sync/push') return await handlePush(req, res);
    if (req.method === 'POST' && p === '/sync/delete') return await handleDelete(req, res);
    if (p.startsWith('/bio/')) {
      if (!keyOk(req)) return send(res, 401, { ok: false, error: 'Wrong or missing sync key' });
      const u = new URL(req.url, 'http://x');
      if (req.method === 'POST' && p === '/bio/challenge') return await handleBioChallenge(req, res);
      if (req.method === 'POST' && p === '/bio/register') return await handleBioRegister(req, res);
      if (req.method === 'POST' && p === '/bio/verify') return await handleBioVerify(req, res);
      if (req.method === 'POST' && p === '/bio/pin/verify') return await handleBioPinVerify(req, res);
      if (req.method === 'POST' && p === '/bio/pin/set') return await handleBioPinSet(req, res);
      if (req.method === 'POST' && p === '/bio/remove') return await handleBioRemoveCred(req, res);
      if (req.method === 'POST' && p === '/bio/delete') return await handleBioDelete(req, res);
      if (req.method === 'POST' && p === '/bio/offline-proofs') return await handleBioOffline(req, res);
      if (req.method === 'GET' && p === '/bio/status') return handleBioStatus(req, res, u);
      if (req.method === 'GET' && p === '/bio/status-list') return handleBioStatusList(req, res);
      if (req.method === 'GET' && p === '/bio/manifests') return handleBioManifests(req, res);
      return send(res, 404, { ok: false, error: 'Not found' });
    }
    if (req.method === 'POST' && p === '/otp/send') return await handleOtpSend(req, res);
    if (req.method === 'POST' && p === '/otp/verify') return await handleOtpVerify(req, res);
    send(res, 404, { ok: false, error: 'Not found' });
  } catch (e) {
    errorTotal++; trackError(req.method + ' ' + req.url.split('?')[0], e);
    if (!res.headersSent) send(res, e.status || 500, { ok: false, error: e.message });
  }
}

/* ------------------------------------------------------------------ */
/* HTTPS: self-signed certificate made with plain Node (no openssl)    */
/* ------------------------------------------------------------------ */
function lanIps() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}
function makeSelfSigned(ips) {
  const derLen = n => { if (n < 128) return Buffer.from([n]); const b = []; while (n > 0) { b.unshift(n & 255); n >>= 8; } return Buffer.from([0x80 | b.length, ...b]); };
  const der = (tag, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]); };
  const SEQ = (...p) => der(0x30, ...p), SET = (...p) => der(0x31, ...p);
  const oid = str => {
    const a = str.split('.').map(Number), bytes = [a[0] * 40 + a[1]];
    for (let i = 2; i < a.length; i++) { let v = a[i]; const t = [v & 127]; v >>= 7; while (v > 0) { t.unshift((v & 127) | 128); v >>= 7; } bytes.push(...t); }
    return der(0x06, Buffer.from(bytes));
  };
  const posInt = buf => { let b = Buffer.from(buf); while (b.length > 1 && b[0] === 0 && b[1] < 128) b = b.slice(1); if (b[0] & 128) b = Buffer.concat([Buffer.from([0]), b]); return der(0x02, b); };
  const utc = d => { const p = n => String(n).padStart(2, '0'); return der(0x17, Buffer.from(p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) + p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z')); };
  const NULL = der(0x05, Buffer.alloc(0));
  const sigAlg = SEQ(oid('1.2.840.113549.1.1.11'), NULL); // sha256WithRSAEncryption
  const name = SEQ(SET(SEQ(oid('2.5.4.10'), der(0x0c, Buffer.from('MSRTC Local')))), SET(SEQ(oid('2.5.4.3'), der(0x0c, Buffer.from('MSRTC Local Server')))));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const notBefore = new Date(Date.now() - 24 * 3600e3), notAfter = new Date(Date.now() + 800 * 24 * 3600e3);
  const names = [der(0x82, Buffer.from('localhost'))];
  const host = os.hostname(); if (host) names.push(der(0x82, Buffer.from(host)));
  for (const ip of ['127.0.0.1', ...ips]) names.push(der(0x87, Buffer.from(ip.split('.').map(Number))));
  const ext = (id, crit, value) => SEQ(oid(id), ...(crit ? [der(0x01, Buffer.from([0xff]))] : []), der(0x04, value));
  const tbs = SEQ(
    der(0xa0, posInt(Buffer.from([2]))),
    posInt(crypto.randomBytes(16).map((b, i) => i === 0 ? b & 0x7f : b)),
    sigAlg, name, SEQ(utc(notBefore), utc(notAfter)), name,
    publicKey.export({ type: 'spki', format: 'der' }),
    der(0xa3, SEQ(
      ext('2.5.29.17', false, SEQ(...names)),                         // subjectAltName
      ext('2.5.29.19', true, SEQ()),                                  // basicConstraints: not a CA
      ext('2.5.29.15', true, der(0x03, Buffer.from([5, 0xa0]))),      // keyUsage: digitalSignature + keyEncipherment
      ext('2.5.29.37', false, SEQ(oid('1.3.6.1.5.5.7.3.1')))          // extKeyUsage: serverAuth
    ))
  );
  const sig = crypto.sign('sha256', tbs, privateKey);
  const cert = SEQ(tbs, sigAlg, der(0x03, Buffer.concat([Buffer.from([0]), sig])));
  const pem = (label, buf) => '-----BEGIN ' + label + '-----\n' + buf.toString('base64').replace(/(.{64})/g, '$1\n').trim() + '\n-----END ' + label + '-----\n';
  return { cert: pem('CERTIFICATE', cert), key: privateKey.export({ type: 'pkcs8', format: 'pem' }), expires: notAfter.getTime() };
}
/* returns { cert, key } or null. Your own cert/key are used as-is; the automatic one is renewed when the IPs change or it nears expiry. */
function getTls() {
  if (!HTTPS_ON) return null;
  try {
    const have = fs.existsSync(CERT_FILE) && fs.existsSync(KEY_FILE);
    let meta = null; try { meta = JSON.parse(fs.readFileSync(CERT_META, 'utf8')); } catch (e) { /* none */ }
    const ips = lanIps();
    if (have && !meta) return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) }; // user-supplied
    const stale = !have || !meta || meta.expires < Date.now() + 30 * 24 * 3600e3 || ips.some(ip => !(meta.ips || []).includes(ip));
    if (stale) {
      const g = makeSelfSigned(ips);
      fs.mkdirSync(path.dirname(CERT_FILE), { recursive: true });
      fs.writeFileSync(CERT_FILE, g.cert); fs.writeFileSync(KEY_FILE, g.key, { mode: 0o600 });
      fs.writeFileSync(CERT_META, JSON.stringify({ ips, expires: g.expires, created: new Date().toISOString() }));
      console.log('Created a self-signed HTTPS certificate in ' + path.dirname(CERT_FILE));
    }
    return { cert: fs.readFileSync(CERT_FILE), key: fs.readFileSync(KEY_FILE) };
  } catch (e) { console.error('HTTPS disabled - could not prepare the certificate: ' + e.message); return null; }
}

/* ------------------------------------------------------------------ */
/* Start                                                               */
/* ------------------------------------------------------------------ */
loadDb();

const tls = getTls();
const isLocalHost = h => /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(h);
let httpsServer = null;
if (tls) httpsServer = https.createServer(tls, handler);

/* plain http: this computer uses it via localhost; any other address is sent to https (the camera needs https) */
const httpServer = http.createServer((req, res) => {
  const host = (req.headers.host || '').replace(/:\d+$/, '');
  if (httpsServer && req.method === 'GET' && !isLocalHost(host) && req.url !== '/health') {
    res.writeHead(302, { Location: 'https://' + host + ':' + HTTPS_PORT + req.url });
    return res.end();
  }
  return handler(req, res);
});

const fail = (port) => e => {
  console.error(e.code === 'EADDRINUSE' ? 'Port ' + port + ' is already in use - close the other copy of this server (or set PORT / HTTPS_PORT to a free port).' : 'Server error: ' + e.message);
  process.exit(1);
};
httpServer.on('error', fail(PORT));
if (httpsServer) httpsServer.on('error', fail(HTTPS_PORT));

function banner() {
  console.log('\nMSRTC server running');
  if (ON_RENDER) {
    console.log('  Public URL    :  ' + (process.env.RENDER_EXTERNAL_URL || '(your onrender.com address)') + '   (secure https by Render - camera + fingerprint work)');
  } else {
    console.log('  This computer :  http://localhost:' + PORT);
    for (const ip of lanIps()) console.log('  Other devices :  ' + (httpsServer ? 'https://' + ip + ':' + HTTPS_PORT : 'http://' + ip + ':' + PORT));
  }
  console.log('Database file  :  ' + DATA_FILE);
  const dn = Object.keys(loadDepotSmtp()).length;
  console.log('\nDepot Gmail logins: ' + (dn ? dn + ' loaded' : 'none (edit DEPOT_GMAIL at the top of server.js)'));
  console.log('Email OTP: ' + (BREVO_OK && BREVO_SENDER.includes('@') ? 'Brevo HTTPS API as ' + BREVO_SENDER : MAIL_ENABLED ? 'SMTP ' + SMTP.host + ':' + SMTP.port + ' as ' + (SMTP.user || SMTP.from) : 'NOT SET UP - no email is sent, codes are only printed here. Put your Gmail App Password in mail-settings.json (or set SMTP_PASS on Render)'));
  console.log('\nOpen the app from the URL above - it saves everything to the database file automatically.');
  if (ON_RENDER) {
    console.log('\nRunning on Render: HTTPS is provided by Render, so no browser warning appears.');
  } else if (httpsServer) {
    console.log('\nHTTPS is ON (the phone camera works). The certificate is self-signed, so the FIRST time a phone');
    console.log('opens the https address it shows a warning: tap  Advanced  ->  Proceed to <address> (unsafe).  Only needed once.');
    console.log('(Typing http://<address>:' + PORT + ' on a phone is redirected to https automatically.)');
    console.log('\nFINGERPRINT (phone sensor / USB fingerprint key) uses WebAuthn, which browsers allow only on a DOMAIN NAME with a');
    console.log('trusted https certificate, or on http://localhost. It will NOT work on https://<IP address> with a self-signed');
    console.log('certificate. For phones use a real domain (e.g. your Render address, or your own domain + cert.pem/key.pem in certs).');
  } else {
    console.log('Note: HTTPS is off. Phones opening the app over plain http://<ip> cannot use the camera.');
  }
  console.log('');
  if (process.env.MSRTC_FIRST === '1' && process.env.NO_BROWSER !== '1') { // open the app once, on first start
    try {
      const url = 'http://localhost:' + PORT;
      const cp = require('child_process');
      const c = process.platform === 'win32' ? cp.spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true })
              : cp.spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true });
      c.on('error', () => {}); c.unref();
    } catch (e) { /* ignore */ }
  }
}
httpServer.listen(PORT, HOST, () => {
  if (httpsServer) httpsServer.listen(HTTPS_PORT, HOST, banner); else banner();
});
