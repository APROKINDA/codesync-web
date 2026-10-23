// CodeSync — realtime multiplayer web editor (HTML, CSS, JavaScript). 
// Pure Cloudflare Workers Module script (Native WebSockets + API + Cloudflare Static Assets).

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = 'data';
const SECRET = 'dev-secret-change-me';

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {}

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

// Rooms setup
const STARTERS = {
  html: `<!DOCTYPE html>\n<html>\n<head><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n<body><button id="restart">Restart</button></body>\n</html>`,
  css: `body { margin: 0; background: #14111f; font-family: sans-serif; }`,
  js: `console.log("Hello from CodeSync!");`,
  assets: `{}`
};
const LANGS = Object.keys(STARTERS);
const rooms = new Map();
function room(name) {
  if (!rooms.has(name)) {
    const docs = {};
    for (const l of LANGS) docs[l] = { text: STARTERS[l], v: 0 };
    rooms.set(name, { docs, clients: new Set(), lastRun: 0 });
  }
  return rooms.get(name);
}
const broadcast = (r, s, except) => {
  for (const c of r.clients) {
    if (c !== except) {
      try { c.ws.send(s); } catch {}
    }
  }
};
const usersMsg = r => JSON.stringify({ type: 'users', list: [...r.clients].map(c => ({ id: c.id, name: c.user.name, color: c.user.color })) });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const inviteEnv = env.INVITE_CODE || '';

    // 1. Native Cloudflare WebSocket Handler
    if (url.pathname.startsWith('/ws')) {
      const cookies = parseCookies(request.headers.get('cookie') || '');
      const user = fromToken(cookies.cs);
      if (!user) {
        return new Response('Unauthorized', { status: 401 });
      }

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
        server.send(JSON.stringify({ type: 'id', id: clientId }));
        for (const l of LANGS) {
          server.send(JSON.stringify({ type: 'init', lang: l, v: r.docs[l].v, doc: r.docs[l].text }));
        }
        broadcast(r, usersMsg(r));
      } catch (e) {}

      server.addEventListener('message', event => {
        try {
          const m = JSON.parse(event.data);
          if (m.type === 'op') {
            if (!LANGS.includes(m.lang)) return;
            const d = r.docs[m.lang];
            if (m.base !== d.v) {
              server.send(JSON.stringify({ type: 'init', lang: m.lang, v: d.v, doc: d.text }));
              return;
            }
            let text = d.text;
            for (const o of m.ops) {
              if (o.t === 'i') text = text.slice(0, o.p) + o.s + text.slice(o.p);
              else if (o.t === 'd') text = text.slice(0, o.p) + text.slice(o.p + o.n);
            }
            d.text = text; d.v++;
            broadcast(r, JSON.stringify({ type: 'op', lang: m.lang, v: d.v, id: clientId, ops: m.ops }));
          } else if (m.type === 'cur' && LANGS.includes(m.lang)) {
            broadcast(r, JSON.stringify({ type: 'cur', lang: m.lang, id: clientId, s: m.s, e: m.e }), clientObj);
          } else if (m.type === 'profile') {
            broadcast(r, usersMsg(r));
          } else if (m.type === 'ping') {
            server.send(JSON.stringify({ type: 'pong', t: m.t }));
          } else if (m.type === 'run') {
            const now = Date.now();
            if (now - r.lastRun < 400) return;
            r.lastRun = now;
            broadcast(r, JSON.stringify({ type: 'run', by: clientObj.user.name }), clientObj);
          }
        } catch (e) {}
      });

      server.addEventListener('close', () => {
        r.clients.delete(clientObj);
        broadcast(r, usersMsg(r));
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // 2. API Routes
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

    // 3. Fallback to Cloudflare's static asset handler
    return env.ASSETS.fetch(request);
  }
};
