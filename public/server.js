// CodeSync — realtime multiplayer C# editor. Plain Node.js (Express + ws), no build step.
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || 'data';
const INVITE_CODE = process.env.INVITE_CODE || '';
const JUDGE0_KEY = process.env.JUDGE0_KEY || '';
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
const JUDGE0_HOST = 'judge0-ce.p.rapidapi.com';
let csharpLangId = null;
async function getCsharpLangId() {
  if (csharpLangId) return csharpLangId;
  const r = await fetch(`https://${JUDGE0_HOST}/languages`, {
    headers: { 'X-RapidAPI-Key': JUDGE0_KEY, 'X-RapidAPI-Host': JUDGE0_HOST },
  });
  const list = await r.json();
  const hit = list.find(l => /c#/i.test(l.name) && /mono|\.net/i.test(l.name)) || list.find(l => /c#/i.test(l.name));
  if (!hit) throw new Error('No C# runtime found on Judge0');
  csharpLangId = hit.id;
  return csharpLangId;
}
async function runCSharp(code) {
  if (!JUDGE0_KEY) return '[Run is not set up yet: the server is missing a JUDGE0_KEY. See .env.example.]';
  try {
    const language_id = await getCsharpLangId();
    const r = await fetch(`https://${JUDGE0_HOST}/submissions?base64_encoded=true&wait=true&fields=stdout,stderr,compile_output,status,message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-RapidAPI-Key': JUDGE0_KEY, 'X-RapidAPI-Host': JUDGE0_HOST },
      body: JSON.stringify({ language_id, source_code: Buffer.from(code, 'utf8').toString('base64'), cpu_time_limit: 10 }),
    });
    if (!r.ok) return `[Judge0 error ${r.status}: ${await r.text()}]`;
    const d = await r.json();
    const dec = b64 => (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');
    const out = (dec(d.compile_output) + dec(d.stdout) + dec(d.stderr)).trim();
    const status = d.status && d.status.description;
    return out || (status && status !== 'Accepted' ? `[${status}]` : '(no output)');
  } catch (e) { return `[Run failed: ${e.message}]`; }
}

// ---------------- rooms: shared doc + operational transform ----------------
const rooms = new Map();
function room(name) {
  if (!rooms.has(name)) rooms.set(name, {
    doc: 'Console.WriteLine("Hello from CodeSync!");\n\nfor (int i = 1; i <= 3; i++)\n    Console.WriteLine($"Line {i}");\n',
    v: 0, clients: new Set(), running: false,
  });
  return rooms.get(name);
}
const send = (c, s) => { try { c.ws.send(s); } catch {} };
const broadcast = (r, s, except) => { for (const c of r.clients) if (c !== except) send(c, s); };
const initMsg = r => JSON.stringify({ type: 'init', v: r.v, doc: r.doc });
const usersMsg = r => JSON.stringify({ type: 'users', list: [...r.clients].map(c => ({ id: c.id, name: c.user.name, color: c.user.color })) });

function applyOp(doc, o) {
  if (o.t === 'i') return doc.slice(0, o.p) + o.s + doc.slice(o.p);
  return doc.slice(0, o.p) + doc.slice(o.p + o.n);
}
function opOnRoom(r, from, base, ops) {
  if (base !== r.v) return;
  let d = r.doc;
  for (const o of ops) {
    if (o.p < 0 || o.p > d.length) { send(from, initMsg(r)); return; }
    if (o.t === 'd' && (o.n < 0 || o.p + o.n > d.length)) { send(from, initMsg(r)); return; }
    d = applyOp(d, o);
  }
  r.doc = d; r.v++;
  broadcast(r, JSON.stringify({ type: 'op', v: r.v, id: from.id, ops }));
}
async function runRoom(r) {
  if (r.running) return;
  r.running = true;
  broadcast(r, JSON.stringify({ type: 'out', status: 'running' }));
  const code = r.doc;
  const text = await runCSharp(code);
  r.running = false;
  broadcast(r, JSON.stringify({ type: 'out', text }));
}

// ---------------- websocket ----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
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
  send(client, initMsg(r));
  broadcast(r, usersMsg(r));

  ws.on('message', raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'op') opOnRoom(r, client, m.base, m.ops);
    else if (m.type === 'cur') broadcast(r, JSON.stringify({ type: 'cur', id: client.id, s: m.s, e: m.e }), client);
    else if (m.type === 'profile') broadcast(r, usersMsg(r));
    else if (m.type === 'ping') send(client, JSON.stringify({ type: 'pong', t: m.t }));
    else if (m.type === 'run') runRoom(r);
  });
  ws.on('close', () => { r.clients.delete(client); broadcast(r, usersMsg(r)); });
});

server.listen(PORT, () => console.log(`CodeSync listening on ${PORT}`));
