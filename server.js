// CodeSync — realtime multiplayer web editor with Cloudflare KV user persistence.

import crypto from 'node:crypto';

const SECRET = process.env.SECRET || 'dev-secret-change-me';

const NAME_RX = /^[A-Za-z0-9_. -]{2,20}$/;
const COLOR_RX = /^#[0-9a-fA-F]{6}$/;
const PALETTE = ['#ff7a90', '#ffb454', '#7fe0b0', '#6cc3ff', '#b48cff', '#f2e96b', '#ff9de2', '#5eead4'];

const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('hex');
const pub = u => ({ name: u.name, color: u.color });

// ---------------- Cloudflare KV Account Store ----------------
async function getUsers(env) {
  if (!env || !env.USERS_KV) return [];
  try {
    const val = await env.USERS_KV.get('users_list');
    return val ? JSON.parse(val) : [];
  } catch {
    return [];
  }
}

async function saveUsers(env, users) {
  if (!env || !env.USERS_KV) return;
  try {
    await env.USERS_KV.put('users_list', JSON.stringify(users));
  } catch {}
}

async function checkName(env, name, self) {
  const users = await getUsers(env);
  if (!NAME_RX.test(name)) return 'Name must be 2-20 characters: letters, numbers, spaces, . _ -';
  if (users.some(u => u !== self && u.name.toLowerCase() === name.toLowerCase())) return 'That name is taken';
  return null;
}

async function createUser(env, name, pw) {
  name = (name || '').trim();
  const err = await checkName(env, name, null);
  if (err) return { error: err };
  if (!pw || pw.length < 6) return { error: 'Password must be at least 6 characters' };
  const salt = crypto.randomBytes(16).toString('hex');
  const u = { id: crypto.randomUUID(), name, salt, hash: hash(pw, salt), color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };
  const users = await getUsers(env);
  users.push(u);
  await saveUsers(env, users);
  return { user: u };
}

async function login(env, name, pw) {
  const users = await getUsers(env);
  const u = users.find(x => x.name.toLowerCase() === (name || '').trim().toLowerCase());
  if (!u) return null;
  const a = Buffer.from(hash(pw || '', u.salt)), b = Buffer.from(u.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
}

async function updateUser(env, u, name, color) {
  name = (name || '').trim();
  const err = await checkName(env, name, u);
  if (err) return { error: err };
  if (!COLOR_RX.test(color || '')) return { error: 'Pick a valid color' };
  u.name = name; u.color = color;
  const users = await getUsers(env);
  const idx = users.findIndex(x => x.id === u.id);
  if (idx >= 0) {
    users[idx] = u;
    await saveUsers(env, users);
  }
  return { user: u };
}

function token(u) {
  const p = `${u.id}.${Date.now() + 30 * 86400000}`;
  return `${p}.${sign(p)}`;
}

async function fromToken(env, t) {
  if (!t) return null;
  const [id, exp, sig] = t.split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
  const expect = sign(`${id}.${exp}`);
  if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  const users = await getUsers(env);
  return users.find(u => u.id === id) || null;
}

const parseCookies = h => Object.fromEntries((h || '').split(';').filter(Boolean).map(p => {
  const i = p.indexOf('='); return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
}));

// ---------------- Rooms & Starters ----------------
const STARTERS = {
  html: `<!DOCTYPE html>\n<html>\n<head>\n<meta name="viewport" content="width=device-width, initial-scale=1">\n</head>\n<body>\n  <button id="restart">Restart</button>\n</body>\n</html>\n`,
  css: `body {\n  margin: 0;\n  overflow: hidden;\n  background: #14111f;\n  font-family: sans-serif;\n}\n\n#restart {\n  position: fixed;\n  top: 10px;\n  right: 10px;\n  padding: 8px 14px;\n  border: 0;\n  border-radius: 8px;\n  background: #b48cff;\n  color: #1a1030;\n  font-size: 16px;\n}\n`,
  js: `world.size(480, 320);\nworld.background = "#14111f";\ncontrols({ dpad: { size: 130 } });\n\nlet score = 0;\nlet safeTime = 2;\n\nspawn("tree", 50, 130);\nspawn("tree", world.width - 50, 210);\n\nconst player = spawn("player", world.width / 2, world.height / 2);\nplayer.opacity = 0.5;\n\nfunction dropCoin() {\n  spawn("coin", random(30, world.width - 30), random(70, world.height - 170));\n}\nfor (let i = 0; i < 3; i++) dropCoin();\n\nfor (let i = 0; i < 2; i++) {\n  const enemy = spawn("enemy", i === 0 ? 40 : world.width - 40, random(30, 60));\n  enemy.vx = (i === 0 ? 1 : -1) * enemy.speed;\n  enemy.vy = enemy.speed * 0.1;\n}\n\nonTouch("player", "coin", (p, coin) => {\n  score += coin.value;\n  coin.destroy();\n  dropCoin();\n});\n\nonTouch("player", "enemy", () => {\n  if (safeTime > 0) return;\n  player.health -= 1;\n  safeTime = 1;\n  player.opacity = 0.5;\n  if (player.health <= 0) restart();\n});\n\nonUpdate(dt => {\n  if (safeTime > 0) {\n    safeTime -= dt;\n    if (safeTime <= 0) player.opacity = 1;\n  }\n  hud("Score: " + score + "    Health: " + player.health);\n});\n\nfunction restart() {\n  score = 0;\n  safeTime = 2;\n  player.health = 3;\n  player.opacity = 0.5;\n  player.x = world.width / 2;\n  player.y = world.height / 2;\n}\ndocument.getElementById("restart").addEventListener("click", restart);\n`,
  assets: `{\n  "player": {\n    "w": 40, "h": 40,\n    "control": "move",\n    "parts": [\n      { "shape": "rect", "w": 40, "h": 40, "radius": 10, "color": "#7fe0b0" },\n      { "shape": "circle", "x": -9, "y": -5, "w": 11, "h": 11, "color": "white" },\n      { "shape": "circle", "x": 9, "y": -5, "w": 11, "h": 11, "color": "white" },\n      { "shape": "circle", "x": -9, "y": -4, "w": 5, "h": 5, "color": "#14111f" },\n      { "shape": "circle", "x": 9, "y": -4, "w": 5, "h": 5, "color": "#14111f" }\n    ],\n    "props": { "speed": 220, "health": 3 }\n  },\n  "coin": {\n    "shape": "circle", "w": 20, "h": 20,\n    "color": "gold", "stroke": "#b8860b", "lineWidth": 2,\n    "props": { "value": 1 }\n  },\n  "enemy": {\n    "shape": "triangle", "w": 34, "h": 34,\n    "color": "#ff6b81",\n    "edges": "bounce",\n    "props": { "speed": 90 }\n  },\n  "tree": {\n    "w": 40, "h": 60,\n    "parts": [\n      { "shape": "rect", "x": 0, "y": 18, "w": 10, "h": 26, "color": "#8b5a2b" },\n      { "shape": "circle", "x": 0, "y": -8, "w": 40, "h": 40, "color": "#2e8b57" }\n    ]\n  }\n}\n`,
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

    // 1. WebSocket Upgrade Handler
    if (url.pathname.startsWith('/ws')) {
      const cookies = parseCookies(request.headers.get('cookie') || '');
      const user = await fromToken(env, cookies.cs);
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
    const currentUser = await fromToken(env, cookies.cs);

    if (request.method === 'POST' && url.pathname === '/api/signup') {
      const body = await getBody();
      const resData = await createUser(env, body.name, body.password);
      if (resData.error) return new Response(JSON.stringify({ error: resData.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const headers = new Headers({ 'Content-Type': 'application/json' });
      setCookieHeader(headers, resData.user);
      return new Response(JSON.stringify(pub(resData.user)), { status: 200, headers });
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const body = await getBody();
      const u = await login(env, body.name, body.password);
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
      const resData = await updateUser(env, currentUser, body.name, body.color);
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
