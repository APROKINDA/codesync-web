// CodeSync — realtime multiplayer web editor (HTML, CSS, JavaScript). Plain Node.js (Express + ws), no build step.
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || 'data';
const INVITE_CODE = process.env.INVITE_CODE || '';
const SECRET = process.env.SECRET || 'dev-secret-change-me';
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------------- account store (JSON file on disk) ----------------
const USERS_FILE = path.join(DATA_DIR, 'users.json');
let users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')) : [];
const saveUsers = () => fs.writeFileSync(USERS_FILE, JSON.stringify(users));
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
app.use(express.static(path.join(__dirname, 'public')));

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

// ---------------- rooms: three synced documents (HTML, CSS, JavaScript) ----------------
// Nothing in here ever runs anyone's code. "Run" just tells the rest of the
// room to rebuild their preview; each browser puts the three files together
// and runs the page itself, in a sandboxed frame.
const STARTERS = {
  html: `<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body>
  <h1 id="score">Score: 0</h1>
  <button id="target">Catch me!</button>
</body>
</html>
`,
  css: `body {
  margin: 0;
  height: 100vh;
  overflow: hidden;
  background: #14111f;
  color: white;
  font-family: sans-serif;
}

h1 {
  margin: 0;
  padding: 16px;
  text-align: center;
}

#target {
  position: absolute;
  font-size: 22px;
  padding: 14px 24px;
  border: 0;
  border-radius: 12px;
  background: #b48cff;
  color: #1a1030;
}
`,
  js: `// Tap the button to score. It jumps somewhere new every time!
const target = document.getElementById("target");
const scoreText = document.getElementById("score");
let score = 0;

function jump() {
  const x = Math.random() * Math.max(0, window.innerWidth - target.offsetWidth);
  const y = 60 + Math.random() * Math.max(0, window.innerHeight - target.offsetHeight - 60);
  target.style.left = x + "px";
  target.style.top = y + "px";
}

target.addEventListener("click", () => {
  score++;
  scoreText.textContent = "Score: " + score;
  jump();
});

jump();
`,
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

function applyOp(doc, o) {
  if (o.t === 'i') return doc.slice(0, o.p) + o.s + doc.slice(o.p);
  return doc.slice(0, o.p) + doc.slice(o.p + o.n);
}
const validOps = ops => Array.isArray(ops) && ops.length > 0 && ops.length <= 10000 && ops.every(o => o && Number.isInteger(o.p) && (
  (o.t === 'i' && typeof o.s === 'string' && o.s.length > 0 && o.s.length <= MAX_DOC) ||
  (o.t === 'd' && Number.isInteger(o.n) && o.n > 0)));
function opOnRoom(r, from, lang, base, ops) {
  if (!LANGS.includes(lang)) return;
  const d = r.docs[lang];
  if (!validOps(ops)) { send(from, initMsg(r, lang)); return; }
  if (base !== d.v) return;   // made against an older version: the client transforms and resends
  let text = d.text;
  for (const o of ops) {
    if (o.p < 0 || o.p > text.length) { send(from, initMsg(r, lang)); return; }
    if (o.t === 'd' && o.p + o.n > text.length) { send(from, initMsg(r, lang)); return; }
    text = applyOp(text, o);
    if (text.length > MAX_DOC) { send(from, initMsg(r, lang)); return; }
  }
  d.text = text; d.v++;
  broadcast(r, JSON.stringify({ type: 'op', lang, v: d.v, id: from.id, ops }));
}

// ---------------- websocket ----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const user = me(req);
  if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, user));
});
wss.on('connection', (ws, req, user) => {
  const url = new URL(req.url, 'http://x');
  const roomName = (url.searchParams.get('room') || 'lobby').slice(0, 40) || 'lobby';
  const r = room(roomName);
  const client = { id: crypto.randomUUID().slice(0, 6), user, ws };
  r.clients.add(client);
  send(client, JSON.stringify({ type: 'id', id: client.id }));
  for (const l of LANGS) send(client, initMsg(r, l));
  broadcast(r, usersMsg(r));

  // A socket error with no listener here would otherwise crash the whole Node
  // process (taking down every room's in-memory docs along with it) — one
  // flaky phone connection could knock everyone else off and reset the text.
  ws.on('error', () => {});

  ws.on('message', raw => {
    try {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'op') opOnRoom(r, client, m.lang, m.base, m.ops);
      else if (m.type === 'cur' && LANGS.includes(m.lang) && Number.isInteger(m.s) && Number.isInteger(m.e)) broadcast(r, JSON.stringify({ type: 'cur', lang: m.lang, id: client.id, s: m.s, e: m.e }), client);
      else if (m.type === 'profile') broadcast(r, usersMsg(r));
      else if (m.type === 'ping') send(client, JSON.stringify({ type: 'pong', t: m.t }));
      else if (m.type === 'run') {
        // The sender already restarted their own preview; tell everyone else to do the same.
        const now = Date.now();
        if (now - r.lastRun < 400) return;   // ignore a flurry of presses
        r.lastRun = now;
        broadcast(r, JSON.stringify({ type: 'run', by: client.user.name }), client);
      }
    } catch (e) { console.error('message handler error:', e); }
  });
  ws.on('close', () => { r.clients.delete(client); broadcast(r, usersMsg(r)); });
});

// Last-resort safety nets: log and keep running instead of crashing the
// process (a crash wipes every room's in-memory documents back to the starters).
process.on('uncaughtException', e => console.error('uncaughtException:', e));
process.on('unhandledRejection', e => console.error('unhandledRejection:', e));

server.listen(PORT, () => console.log(`CodeSync listening on ${PORT}`));
