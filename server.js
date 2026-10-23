// CodeSync — realtime multiplayer web editor (HTML, CSS, JavaScript, Assets).
// Full original application logic adapted for Cloudflare Workers (Native WebSockets + API + Assets).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'data';
const SECRET = process.env.SECRET || 'dev-secret-change-me';

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {}

// ---------------- account store (JSON file / Edge fallback) ----------------
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
  } catch (e) {}
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

function createUser(name, pw, invite, inviteEnv) {
  name = (name || '').trim();
  if (inviteEnv && invite !== inviteEnv) return { error: 'Invalid invite code' };
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

// ---------------- rooms & operational transform ----------------
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
  js: `world.size(480, 320);
world.background = "#14111f";
controls({ dpad: { size: 130 } });

let score = 0;
let safeTime = 2;

spawn("tree", 50, 130);
spawn("tree", world.width - 50, 210);

const player = spawn("player", world.width / 2, world.height / 2);
player.opacity = 0.5;

function dropCoin() {
  spawn("coin", random(30, world.width - 30), random(70, world.height - 170));
}
for (let i = 0; i < 3; i++) dropCoin();

for (let i = 0; i < 2; i++) {
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
  assets: `{
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

const sendSocket = (ws, s) => { try { ws.send(s); } catch {} };
const broadcast = (r, s, exceptWs) => {
  for (const c of r.clients) {
    if (c.ws !== exceptWs) sendSocket(c.ws, s);
  }
};
const initMsg = (r, lang) => JSON.stringify({ type: 'init', lang, v: r.docs[lang].v, doc: r.docs[lang].text });
const usersMsg = r => JSON.stringify({ type: 'users', list: [...r.clients].map(c => ({ id: c.id, name: c.user.name, color: c.user.color })) });

function applyOp(doc, o) {
  if (o.t === 'i') return doc.slice(0, o.p) + o.s + doc.slice(o.p);
  return doc.slice(0, o.p) + doc.slice(o.p + o.n);
}

const validOps = ops => Array.isArray(ops) && ops.length > 0 && ops.length <= 10000 && ops.every(o => o && Number.isInteger(o.p) && (
  (o.t === 'i' && typeof o.s === 'string' && o.s.length > 0 && o.s.length <= MAX_DOC) ||
  (o.t === 'd' && Number.isInteger(o.n) && o.n > 0)));

function opOnRoom(r, ws, clientId, lang, base, ops) {
  if (!LANGS.includes(lang)) return;
  const d = r.docs[lang];
  if (!validOps(ops)) { sendSocket(ws, initMsg(r, lang)); return; }
  if (base !== d.v) return;
  let text = d.text;
  for (const o of ops) {
    if (o.p < 0 || o.p > text.length) { sendSocket(ws, initMsg(r, lang)); return; }
    if (o.t === 'd' && o.p + o.n > text.length) { sendSocket(ws, initMsg(r, lang)); return; }
    text = applyOp(text, o);
    if (text.length > MAX_DOC) { sendSocket(ws, initMsg(r, lang)); return; }
  }
  d.text = text; d.v++;
  broadcast(r, JSON.stringify({ type: 'op', lang, v: d.v, id: clientId, ops }), ws);
}

// ---------------- Cloudflare Worker Export ----------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const inviteEnv = env.INVITE_CODE || '';

    // 1. WebSocket Upgrade Handler
    if (url.pathname.startsWith('/ws')) {
      const cookies = parseCookies(request.headers.get('cookie') || '');
      const user = fromToken(cookies.cs);
      if (!user) return new Response('Unauthorized', { status: 401 });

      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.accept();

      const roomName = (url.searchParams.get('room') || 'lobby').slice(0, 40) || 'lobby';
      const r = room(roomName);
      const clientId = crypto.randomUUID().slice(0, 6);
      const clientObj = { id: clientId, user, ws: server };
      r.clients.add(clientObj);

      try {
        sendSocket(server, JSON.stringify({ type: 'id', id: clientId }));
        for (const l of LANGS) sendSocket(server, initMsg(r, l));
        broadcast(r, usersMsg(r));
      } catch (e) {}

      server.addEventListener('message', event => {
        try {
          let m; try { m = JSON.parse(event.data); } catch { return; }
          if (m.type === 'op') {
            opOnRoom(r, server, clientId, m.lang, m.base, m.ops);
          } else if (m.type === 'cur' && LANGS.includes(m.lang) && Number.isInteger(m.s) && Number.isInteger(m.e)) {
            broadcast(r, JSON.stringify({ type: 'cur', lang: m.lang, id: clientId, s: m.s, e: m.e }), server);
          } else if (m.type === 'profile') {
            broadcast(r, usersMsg(r));
          } else if (m.type === 'ping') {
            sendSocket(server, JSON.stringify({ type: 'pong', t: m.t }));
          } else if (m.type === 'run') {
            const now = Date.now();
            if (now - r.lastRun < 400) return;
            r.lastRun = now;
            broadcast(r, JSON.stringify({ type: 'run', by: clientObj.user.name }), server);
          }
        } catch (e) {}
      });

      server.addEventListener('close', () => {
        r.clients.delete(clientObj);
        broadcast(r, usersMsg(r));
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. HTTP API Routes
    const getBody = async () => {
      try { return await request.json(); } catch { return {}; }
    };
    const setCookieHeader = (headers, u) => {
      const secure = request.url.startsWith('https');
      headers.append('Set-Cookie', `cs=${token(u)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
    };
    const cookies = parseCookies(request.headers.get('cookie') || '');
    const currentUser = fromToken(cookies.cs);

    if (request.method === 'POST' && url.pathname === '/api/signup') {
      const body = await getBody();
      const resData = createUser(body.name, body.password, body.invite, inviteEnv);
      if (resData.error) return new Response(JSON.stringify({ error: resData.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const headers = new Headers({ 'Content-Type': 'application/json' });
      setCookieHeader(headers, resData.user);
      return new Response(JSON.stringify(pub(resData.user)), { status: 200, headers });
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const body = await getBody();
      const u = login(body.name, body.password);
      if (!u) {
        await new Promise(r => setTimeout(r, 500));
        return new Response(JSON.stringify({ error: 'Wrong name or password' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      }
      const headers = new Headers({ 'Content-Type': 'application/json' });
      setCookieHeader(headers, u);
      return new Response(JSON.stringify(pub(u)), { status: 200, headers });
    }
    if (request.method === 'POST' && url.pathname === '/api/logout') {
      const headers = new Headers({ 'Content-Type': 'application/json', 'Set-Cookie': 'cs=; Path=/; Max-Age=0' });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }
    if (request.method === 'GET' && url.pathname === '/api/me') {
      return currentUser ? new Response(JSON.stringify(pub(currentUser)), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response(null, { status: 401 });
    }
    if (request.method === 'POST' && url.pathname === '/api/profile') {
      if (!currentUser) return new Response(null, { status: 401 });
      const body = await getBody();
      const resData = updateUser(currentUser, body.name, body.color);
      if (resData.error) return new Response(JSON.stringify({ error: resData.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(pub(resData.user)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // 3. Static Assets serving via Cloudflare Asset Binding
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  }
};
