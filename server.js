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

// ---------------- rooms: four synced documents (HTML, CSS, JavaScript, Assets) ----------------
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
  <button id="restart">Restart</button>
</body>
</html>
`,
  css: `body {
  margin: 0;
  overflow: hidden;
  background: #14111f;
  font-family: sans-serif;
}

#restart {
  position: fixed;
  top: 10px;
  right: 10px;
  padding: 8px 14px;
  border: 0;
  border-radius: 8px;
  background: #b48cff;
  color: #1a1030;
  font-size: 16px;
}
`,
  js: `// Your game! The things in it live in the Assets tab (player, coin, enemy, tree).
//
// Handy commands:
//   spawn("coin", x, y)             put an asset on the screen
//   onUpdate(dt => { ... })         runs every frame (dt = seconds since the last frame)
//   onTouch("player", "coin", (a, b) => { ... })    runs when two things touch
//   hud("text")                     text in the top-left corner
//   controls({ dpad: { size: 130 }, buttons: ["A", "B"] })    on-screen controls
//   input.left  input.right  input.up  input.down  input.A  input.B
//   thing.x  thing.y  thing.w  thing.h  thing.scale  thing.color  thing.destroy()
//   after(2, fn)   every(2, fn)     timers (seconds)
//   random(1, 10)   world.width   world.height   world.background

world.size(480, 320);                   // a fixed game screen (delete this line to fill the whole screen)
world.background = "#14111f";
controls({ dpad: { size: 130 } });      // on-screen D-pad (arrow keys and WASD work too)

let score = 0;
let safeTime = 2;                      // a moment of safety at the start

spawn("tree", 50, 130);
spawn("tree", world.width - 50, 210);

const player = spawn("player", world.width / 2, world.height / 2);
player.opacity = 0.5;                     // faded = safe for a moment

function dropCoin() {
  spawn("coin", random(30, world.width - 30), random(70, world.height - 170));
}
for (let i = 0; i < 3; i++) dropCoin();

for (let i = 0; i < 2; i++) {
  // start in the top corners, away from the player
  const enemy = spawn("enemy", i === 0 ? 40 : world.width - 40, random(30, 60));
  enemy.vx = (i === 0 ? 1 : -1) * enemy.speed;
  enemy.vy = enemy.speed * 0.1;
}

onTouch("player", "coin", (p, coin) => {
  score += coin.value;
  coin.destroy();
  dropCoin();
});

onTouch("player", "enemy", () => {
  if (safeTime > 0) return;
  player.health -= 1;
  safeTime = 1;
  player.opacity = 0.5;
  if (player.health <= 0) restart();
});

onUpdate(dt => {
  if (safeTime > 0) {
    safeTime -= dt;
    if (safeTime <= 0) player.opacity = 1;
  }
  hud("Score: " + score + "    Health: " + player.health);
});

function restart() {
  score = 0;
  safeTime = 2;
  player.health = 3;
  player.opacity = 0.5;
  player.x = world.width / 2;
  player.y = world.height / 2;
}
document.getElementById("restart").addEventListener("click", restart);
`,
  assets: `// Assets are the things in your game. Make one here, then in your
// JavaScript write spawn("name", x, y) to put it on the screen.
//
//   shape    rect, circle, ellipse, triangle, diamond, polygon, star, heart, line, text
//   w, h     size (change these and the asset resizes everywhere)
//   color    a color name or a #hex code (the gallery on the right has color dots)
//   parts    build one asset out of several shapes (see "player" and "tree")
//   props    your own values, like speed or health. In your game: player.speed
//   control  "move" (arrow keys, WASD, on-screen D-pad), "pointer" (follows your finger) or "both"
//   edges    what happens at the screen edge: "stop", "bounce" or "wrap"
//   tags     extra names, so one rule can match many assets
{
  "player": {
    "w": 40, "h": 40,
    "control": "move",
    "parts": [
      { "shape": "rect", "w": 40, "h": 40, "radius": 10, "color": "#7fe0b0" },
      { "shape": "circle", "x": -9, "y": -5, "w": 11, "h": 11, "color": "white" },
      { "shape": "circle", "x": 9, "y": -5, "w": 11, "h": 11, "color": "white" },
      { "shape": "circle", "x": -9, "y": -4, "w": 5, "h": 5, "color": "#14111f" },
      { "shape": "circle", "x": 9, "y": -4, "w": 5, "h": 5, "color": "#14111f" }
    ],
    "props": { "speed": 220, "health": 3 }
  },

  "coin": {
    "shape": "circle", "w": 20, "h": 20,
    "color": "gold", "stroke": "#b8860b", "lineWidth": 2,
    "props": { "value": 1 }
  },

  "enemy": {
    "shape": "triangle", "w": 34, "h": 34,
    "color": "#ff6b81",
    "edges": "bounce",
    "props": { "speed": 90 }
  },

  "tree": {
    "w": 40, "h": 60,
    "parts": [
      { "shape": "rect", "x": 0, "y": 18, "w": 10, "h": 26, "color": "#8b5a2b" },
      { "shape": "circle", "x": 0, "y": -8, "w": 40, "h": 40, "color": "#2e8b57" }
    ]
  }
}
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
