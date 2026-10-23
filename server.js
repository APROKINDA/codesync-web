// CodeSync — realtime multiplayer web editor (HTML, CSS, JavaScript). Plain Node.js (Express), no build step.
import express from 'express';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { httpServerHandler } from 'cloudflare:node';

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || 'data';
const INVITE_CODE = process.env.INVITE_CODE || '';
const SECRET = process.env.SECRET || 'dev-secret-change-me';

// Wrap fs operations in try/catch for Cloudflare Workers read-only environment
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {
  // Ignored on serverless edge
}

// ---------------- account store ----------------
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = [];
try {
  users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) : [];
} catch (e) {
  users = [];
}
const saveUsers = () => {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users));
  } catch (e) {
    // Read-only filesystem on Cloudflare Workers
  }
};
const NAME_RX = /^[A-Za-z0-9_. -]{2,20}$/;
const COLOR_RX = /^#[0-9a-fA-F]{6}$/;
const PALETTE = ['#ff7a90', '#ffb454', '#7fe0b0', '#6cc3ff', '#b48cff', '#f2e96b', '#ff9de2', '#5eead4'];

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const pub = u => ({ name: u.name, color: u.color });

function checkName(name, self) {
  if (!NAME_RX.test(name)) return 'Name must be 2-20 characters: letters, numbers, spaces, . _ -';
  if (users.some(u => u !== self && u.name.toLowerCase() === name.toLowerCase())) return 'That name is taken';
  return null;
}
function createUser(name, pw, invite) {
  name = (name || '').trim();
  if (INVITE_CODE && invite !== INVITE_CODE) return { error: 'Invalid invite code' };
  const err = checkName(name, null);
  if (err) return { error: err };
  if (!pw || pw.length < 6) return { error: 'Password must be at least 6 characters' };
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: crypto.randomUUID(), name, salt, hash: hash(pw, salt), color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };
  users.push(u); saveUsers();
  return { user: u };
}
function login(name, pw) {
  const u = users.find(x => x.name.toLowerCase() === (name || '').trim().toLowerCase());
  if (!u) return null;
  const a = Buffer.from(hash(pw || '', u.salt)), b = Buffer.from(u.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
}
function updateUser(u, name, color) {
  name = (name || '').trim();
  const err = checkName(name, u);
  if (err) return { error: err };
  if (!COLOR_RX.test(color || '')) return { error: 'Pick a valid color' };
  u.name = name; u.color = color; saveUsers();
  return { user: u };
}
function token(u) {
  const p = `${u.id}.${Date.now() + 30 * 86400000}`;
  return `${p}.${sign(p)}`;
}
function fromToken(t) {
  if (!t) return null;
  const [id, exp, sig] = t.split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
  const expect = sign(`${id}.${exp}`);
  if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  return users.find(u => u.id === id) || null;
}
const parseCookies = h => Object.fromEntries((h || '').split(';').filter(Boolean).map(p => {
  const i = p.indexOf('='); return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
}));

// ---------------- http app ----------------
const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), 'public')));

function setCookie(res, req, u) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie', `cs=${token(u)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
}
const me = req => fromToken(parseCookies(req.headers.cookie).cs);

app.post('/api/signup', (req, res) => {
  const r = createUser(req.body.name, req.body.password, req.body.invite);
  if (r.error) return res.status(400).json({ error: r.error });
  setCookie(res, req, r.user);
  res.json(pub(r.user));
});
app.post('/api/login', async (req, res) => {
  const u = login(req.body.name, req.body.password);
  if (!u) { await new Promise(r => setTimeout(r, 500)); return res.status(401).json({ error: 'Wrong name or password' }); }
  setCookie(res, req, u);
  res.json(pub(u));
});
app.post('/api/logout', (_req, res) => { res.setHeader('Set-Cookie', 'cs=; Path=/; Max-Age=0'); res.json({ ok: true }); });
app.get('/api/me', (req, res) => { const u = me(req); u ? res.json(pub(u)) : res.sendStatus(401); });
app.post('/api/profile', (req, res) => {
  const u = me(req); if (!u) return res.sendStatus(401);
  const r = updateUser(u, req.body.name, req.body.color);
  if (r.error) return res.status(400).json({ error: r.error });
  res.json(pub(r.user));
});

// ---------------- rooms setup ----------------
const STARTERS = {
  html: `<!DOCTYPE html>\n<html>\n<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n<body><button id="restart">Restart</button></body>\n</html>`,
  css: `body { margin: 0; background: #14111f; font-family: sans-serif; }`,
  js: `console.log("Hello from CodeSync!");`,
  assets: `{}`
};
const LANGS = Object.keys(STARTERS);
const MAX_DOC = 200000;

const rooms = new Map();
function room(name) {
  if (!rooms.has(name)) {
    const docs = {};
    for (const l of LANGS) docs[l] = { text: STARTERS[l], v: 0 };
    rooms.set(name, { docs, clients: new Set(), lastRun: 0 });
  }
  return rooms.get(name);
}
const send = (c, s) => { try { c.ws.send(s); } catch {} };
const broadcast = (r, s, except) => { for (const c of r.clients) if (c !== except) send(c, s); };
const initMsg = (r, lang) => JSON.stringify({ type: 'init', lang, v: r.docs[lang].v, doc: r.docs[lang].text });
const usersMsg = r => JSON.stringify({ type: 'users', list: [...r.clients].map(c => ({ id: c.id, name: c.user.name, color: c.user.color })) });

// ---------------- server & export ----------------
const server = http.createServer(app);

process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

// Bind listener for local dev fallback
if (process.env.NODE_ENV !== 'production') {
  server.listen(PORT, () => console.log(`CodeSync listening on ${PORT}`));
}

// Mandatory Cloudflare Workers ES Module export handler
export default httpServerHandler(app);
