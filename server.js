// CodeSync — realtime multiplayer web editor (HTML, CSS, JavaScript). Pure Node.js, no Express/build step.
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

try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
} catch (e) {}

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

// ---------------- HTTP Server & API Router ----------------
const server = http.createServer(async (req, res) => {
  const parseBody = () => new Promise(resolve => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); }
    });
  });

  const sendJSON = (status, obj) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(obj));
  };

  const cookies = parseCookies(req.headers.cookie);
  const currentUser = () => fromToken(cookies.cs);
  const setCookieHeader = (u) => {
    const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
    res.setHeader('Set-Cookie', `cs=${token(u)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
  };

  // API Routes
  if (req.method === 'POST' && req.url === '/api/signup') {
    const body = await parseBody();
    const r = createUser(body.name, body.password, body.invite);
    if (r.error) return sendJSON(400, { error: r.error });
    setCookieHeader(r.user);
    return sendJSON(200, pub(r.user));
  }
  if (req.method === 'POST' && req.url === '/api/login') {
    const body = await parseBody();
    const u = login(body.name, body.password);
    if (!u) {
      await new Promise(r => setTimeout(r, 500));
      return sendJSON(401, { error: 'Wrong name or password' });
    }
    setCookieHeader(u);
    return sendJSON(200, pub(u));
  }
  if (req.method === 'POST' && req.url === '/api/logout') {
    res.setHeader('Set-Cookie', 'cs=; Path=/; Max-Age=0');
    return sendJSON(200, { ok: true });
  }
  if (req.method === 'GET' && req.url === '/api/me') {
    const u = currentUser();
    return u ? sendJSON(200, pub(u)) : res.statusCode = 401, res.end();
  }
  if (req.method === 'POST' && req.url === '/api/profile') {
    const u = currentUser();
    if (!u) return res.statusCode = 401, res.end();
    const body = await parseBody();
    const r = updateUser(u, body.name, body.color);
    if (r.error) return sendJSON(400, { error: r.error });
    return sendJSON(200, pub(r.user));
  }

  // Static files handler for public folder
  let filePath = path.join(process.cwd(), 'public', req.url === '/' ? 'index.html' : req.url);
  try {
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      const ext = path.extname(filePath);
      const mimeTypes = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg' };
      res.setHeader('Content-Type', mimeTypes[ext] || 'text/plain');
      res.end(fs.readFileSync(filePath));
      return;
    }
  } catch (e) {}

  // Fallback to index.html for SPA routing if needed
  try {
    const indexPath = path.join(process.cwd(), 'public', 'index.html');
    if (fs.existsSync(indexPath)) {
      res.setHeader('Content-Type', 'text/html');
      res.end(fs.readFileSync(indexPath));
      return;
    }
  } catch (e) {}

  res.statusCode = 404;
  res.end('Not Found');
});

// ---------------- WebSocket setup ----------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 20 });
server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws')) return socket.destroy();
  const user = fromToken(parseCookies(req.headers.cookie).cs);
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

  ws.on('error', () => {});
  ws.on('message', raw => {
    try {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'op') {
        if (!LANGS.includes(m.lang)) return;
        const d = r.docs[m.lang];
        if (m.base !== d.v) { send(client, initMsg(r, m.lang)); return; }
        let text = d.text;
        for (const o of m.ops) {
          if (o.t === 'i') text = text.slice(0, o.p) + o.s + text.slice(o.p);
          else if (o.t === 'd') text = text.slice(0, o.p) + text.slice(o.p + o.n);
        }
        d.text = text; d.v++;
        broadcast(r, JSON.stringify({ type: 'op', lang: m.lang, v: d.v, id: client.id, ops: m.ops }));
      } else if (m.type === 'cur' && LANGS.includes(m.lang)) {
        broadcast(r, JSON.stringify({ type: 'cur', lang: m.lang, id: client.id, s: m.s, e: m.e }), client);
      } else if (m.type === 'profile') {
        broadcast(r, usersMsg(r));
      } else if (m.type === 'ping') {
        send(client, JSON.stringify({ type: 'pong', t: m.t }));
      } else if (m.type === 'run') {
        const now = Date.now();
        if (now - r.lastRun < 400) return;
        r.lastRun = now;
        broadcast(r, JSON.stringify({ type: 'run', by: client.user.name }), client);
      }
    } catch (e) {}
  });
  ws.on('close', () => { r.clients.delete(client); broadcast(r, usersMsg(r)); });
});

process.on('uncaughtException', e => {});
process.on('unhandledRejection', e => {});

if (process.env.NODE_ENV !== 'production') {
  server.listen(PORT, () => console.log(`CodeSync listening on ${PORT}`));
}

export default httpServerHandler(server);
