// CodeSync — realtime multiplayer web editor (HTML, CSS, JavaScript, Assets).
// Cloudflare Workers Module script with 3D starter templates.
//
// Accounts and each room's code live in Durable Objects (one "Accounts" object,
// one "Room" object per room), not in plain Worker memory or the filesystem.
// A plain Worker can run many copies of itself at once with no shared memory —
// two friends can land on different copies and never see each other, and every
// copy forgets everything the moment it restarts (which happens often). A
// Durable Object is the one place in Cloudflare Workers that is both a single
// shared instance (so everyone in a room really is in the same room) and has
// real persistent storage (so accounts and code survive restarts and redeploys).

import crypto from 'node:crypto';
import { DurableObject } from 'cloudflare:workers';

// ---------------- accounts ----------------
const NAME_RX = /^[A-Za-z0-9_. -]{2,20}$/;
const COLOR_RX = /^#[0-9a-fA-F]{6}$/;
const PALETTE = ['#ff7a90', '#ffb454', '#7fe0b0', '#6cc3ff', '#b48cff', '#f2e96b', '#ff9de2', '#5eead4'];

const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const sign = (secret, s) => crypto.createHmac('sha256', secret).update(s).digest('hex');
const pub = u => ({ name: u.name, color: u.color });

function checkName(users, name, self) {
  if (!NAME_RX.test(name)) return 'Name must be 2-20 characters: letters, numbers, spaces, . _ -';
  if (users.some(u => u !== self && u.name.toLowerCase() === name.toLowerCase())) return 'That name is taken';
  return null;
}

function token(secret, u) {
  const p = `${u.id}.${Date.now() + 30 * 86400000}`;
  return `${p}.${sign(secret, p)}`;
}
// Checks the cookie's signature and expiry only — cheap, needs no Durable Object call.
// The live user record (current name/color) is fetched separately, only when needed.
function verifyToken(secret, t) {
  if (!t) return null;
  const [id, exp, sig] = t.split('.');
  if (!id || !exp || !sig || Number(exp) < Date.now()) return null;
  const expect = sign(secret, `${id}.${exp}`);
  if (expect.length !== sig.length || !crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(sig))) return null;
  return { id };
}

const parseCookies = h => Object.fromEntries((h || '').split(';').filter(Boolean).map(p => {
  const i = p.indexOf('='); return [p.slice(0, i).trim(), decodeURIComponent(p.slice(i + 1).trim())];
}));

// One shared Durable Object instance holds every account, in its own persistent SQLite storage.
export class Accounts extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.users = null;   // loaded lazily from storage, then kept in memory for this instance's lifetime
  }
  async load() {
    if (this.users === null) this.users = (await this.ctx.storage.get('users')) || [];
    return this.users;
  }
  async save() { await this.ctx.storage.put('users', this.users); }

  async signup(name, password, invite) {
    const users = await this.load();
    name = (name || '').trim();
    const inviteCode = this.env.INVITE_CODE || '';
    if (inviteCode && invite !== inviteCode) return { error: 'Invalid invite code' };
    const err = checkName(users, name, null);
    if (err) return { error: err };
    if (!password || password.length < 6) return { error: 'Password must be at least 6 characters' };
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: crypto.randomUUID(), name, salt, hash: hashPw(password, salt), color: PALETTE[Math.floor(Math.random() * PALETTE.length)] };
    users.push(u);
    await this.save();
    return { user: u };
  }
  async login(name, password) {
    const users = await this.load();
    const u = users.find(x => x.name.toLowerCase() === (name || '').trim().toLowerCase());
    if (!u) return null;
    const a = Buffer.from(hashPw(password || '', u.salt)), b = Buffer.from(u.hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b) ? u : null;
  }
  async updateProfile(id, name, color) {
    const users = await this.load();
    const u = users.find(x => x.id === id);
    if (!u) return { error: 'Not signed in' };
    name = (name || '').trim();
    const err = checkName(users, name, u);
    if (err) return { error: err };
    if (!COLOR_RX.test(color || '')) return { error: 'Pick a valid color' };
    u.name = name; u.color = color;
    await this.save();
    return { user: u };
  }
  async getUser(id) {
    const users = await this.load();
    return users.find(u => u.id === id) || null;
  }
}

// ---------------- rooms & starters (with 3D instructions) ----------------
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
// Want it in 3D? Put use3D() on the first line and spawn with x, y, z (y is up).
//
// Handy commands:
// (Below, "fn" always means "a function you write" — something like
// dt => { ... } or () => { ... }. You're writing the code that goes where
// the dots are; the engine calls it for you at the right moment.)
//
// -- Putting things on screen --
//
//   spawn("coin", x, y)
//     Puts an asset from the Assets tab onto the screen at position x, y, and
//     gives back the new object so you can read or change it afterwards.
//     Example: const c = spawn("coin", 100, 50); c.color = "red";
//
// -- Running code every frame --
// A "frame" is one single redraw of the screen. Your game redraws about 60
// times every second, so anything you put inside onUpdate also runs about
// 60 times a second — that's what makes things move smoothly.
//
//   onUpdate(dt => { ... })
//     Runs your code once every frame, automatically, forever. dt is how
//     many seconds passed since the last frame — a tiny number, like 0.016.
//     Multiply movement by dt, like player.x += 100 * dt, so things move at
//     the same speed on every device instead of faster on a quick phone and
//     slower on an older one.
//
// -- Making things react to each other --
//
//   onTouch("player", "coin", (a, b) => { ... })
//     Runs your code once, the exact moment something named "player" touches
//     something named "coin". a is the player, b is the coin, so inside you
//     can write things like b.destroy() or a.health -= 1.
//
//   hud("text")
//     Shows text in the top-left corner of the screen, like a score or
//     health display. Call it every frame (inside onUpdate) so it stays
//     up to date — it only shows whatever you told it last.
//
// -- Controls --
//
//   controls({ dpad: { size: 130 }, buttons: ["A", "B"] })
//     Draws a D-pad and round buttons on screen for touch play, alongside
//     your keyboard controls (which still work too). Call it once, usually
//     near the top of your code, not every frame.
//
//   input.left  input.right  input.up  input.down  input.A  input.B
//     Each one is true for as long as that key or button is being held
//     down, and false the rest of the time. Arrow keys or WASD move
//     left/right/up/down; Space or Z is A; X or Shift is B.
//     Example: if (input.left) player.x -= 100 * dt;
//
// -- Changing something you've spawned --
//
//   thing.x  thing.y  thing.w  thing.h  thing.scale  thing.color  thing.destroy()
//     Every spawned object has these. x and y are its position, w and h are
//     its size, scale resizes it all at once, color changes its color — set
//     any of them, any time, like coin.color = "blue". destroy() removes it
//     from the game for good (use it when a coin gets collected, for example).
//
// -- Camera (3D games only, after use3D() on the first line) --
//
//   camera.attach(player)
//     Makes the camera automatically follow that object around.
//
//   camera.mode = "thirdperson"   (the default)
//     Watches from a little way behind and above — like most 3D games.
//
//   camera.mode = "firstperson"
//     Puts the camera right where the object is, looking out — like you're
//     seeing through its eyes instead of watching it from outside.
//
//   In either mode, drag the screen (or use the D-pad/arrow keys) to look
//   or turn around.
//
// -- Timers --
//
//   after(2, fn)
//     Waits 2 seconds, then runs fn once.
//
//   every(2, fn)
//     Runs fn, then keeps running it again every 2 seconds, forever (or
//     until the game restarts). Example: every(1, () => score += 1);
//
// -- Useful values --
//
//   random(1, 10)
//     Gives back a random number between 1 and 10 — a different one each
//     time you call it.
//
//   world.width   world.height   world.background
//     world.width and world.height are the size of the game screen, in
//     pixels. world.background is its color, like "#14111f" or "black".

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

const sendSocket = (ws, s) => { try { ws.send(s); } catch {} };
const initMsg = (docs, lang) => JSON.stringify({ type: 'init', lang, v: docs[lang].v, doc: docs[lang].text });
const usersMsg = clients => JSON.stringify({ type: 'users', list: [...clients].map(c => ({ id: c.id, name: c.user.name, color: c.user.color })) });

function applyOp(doc, o) {
  if (o.t === 'i') return doc.slice(0, o.p) + o.s + doc.slice(o.p);
  return doc.slice(0, o.p) + doc.slice(o.p + o.n);
}
const validOps = ops => Array.isArray(ops) && ops.length > 0 && ops.length <= 10000 && ops.every(o => o && Number.isInteger(o.p) && (
  (o.t === 'i' && typeof o.s === 'string' && o.s.length > 0 && o.s.length <= MAX_DOC) ||
  (o.t === 'd' && Number.isInteger(o.n) && o.n > 0)));

// One Durable Object instance per room name. Everyone who opens the same room
// talks to this same instance, so there is exactly one shared copy of the code
// and exactly one list of who's connected — never two different copies that
// can't see each other.
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.docs = null;
    this.clients = new Set();
    this.lastRun = 0;
    this.dirty = false;
    this.saveTimer = null;
  }
  async loadDocs() {
    if (this.docs === null) {
      const saved = await this.ctx.storage.get('docs');
      this.docs = saved || Object.fromEntries(LANGS.map(l => [l, { text: STARTERS[l], v: 0 }]));
    }
    return this.docs;
  }
  async saveDocsNow() { await this.ctx.storage.put('docs', this.docs); }
  // Keystrokes arrive fast; writing to storage on every single one would be
  // wasteful, so small bursts of edits are combined into one save shortly after
  // typing pauses. The open WebSocket connection keeps this object alive in the
  // meantime, so the save is never lost.
  scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) { this.dirty = false; this.ctx.waitUntil(this.saveDocsNow()); }
    }, 800);
  }
  async flushSave() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (this.dirty) { this.dirty = false; await this.saveDocsNow(); }
  }

  broadcast(s, exceptWs) {
    for (const c of this.clients) if (c.ws !== exceptWs) sendSocket(c.ws, s);
  }

  opOnRoom(ws, clientId, lang, base, ops) {
    if (!LANGS.includes(lang)) return;
    const d = this.docs[lang];
    if (!validOps(ops)) { sendSocket(ws, initMsg(this.docs, lang)); return; }
    if (base !== d.v) return;   // made against an older version: the client transforms and resends
    let text = d.text;
    for (const o of ops) {
      if (o.p < 0 || o.p > text.length) { sendSocket(ws, initMsg(this.docs, lang)); return; }
      if (o.t === 'd' && o.p + o.n > text.length) { sendSocket(ws, initMsg(this.docs, lang)); return; }
      text = applyOp(text, o);
      if (text.length > MAX_DOC) { sendSocket(ws, initMsg(this.docs, lang)); return; }
    }
    d.text = text; d.v++;
    this.scheduleSave();
    this.broadcast(JSON.stringify({ type: 'op', lang, v: d.v, id: clientId, ops }), ws);
  }

  async fetch(request) {
    await this.loadDocs();
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });

    let authed;
    try { authed = JSON.parse(request.headers.get('X-User') || 'null'); } catch { authed = null; }
    if (!authed || typeof authed.id !== 'string' || typeof authed.name !== 'string' || typeof authed.color !== 'string') return new Response('Unauthorized', { status: 401 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();

    const clientId = crypto.randomUUID().slice(0, 6);
    const clientObj = { id: clientId, userId: authed.id, user: { name: authed.name, color: authed.color }, ws: server };
    this.clients.add(clientObj);

    try {
      sendSocket(server, JSON.stringify({ type: 'id', id: clientId }));
      for (const l of LANGS) sendSocket(server, initMsg(this.docs, l));
      this.broadcast(usersMsg(this.clients));
    } catch (e) {}

    server.addEventListener('message', event => {
      try {
        let m; try { m = JSON.parse(event.data); } catch { return; }
        if (m.type === 'op') {
          this.opOnRoom(server, clientId, m.lang, m.base, m.ops);
        } else if (m.type === 'cur' && LANGS.includes(m.lang) && Number.isInteger(m.s) && Number.isInteger(m.e)) {
          this.broadcast(JSON.stringify({ type: 'cur', lang: m.lang, id: clientId, s: m.s, e: m.e }), server);
        } else if (m.type === 'profile') {
          // A saved profile change is a new, disconnected copy of the account record, not a
          // live reference, so re-fetch it from Accounts rather than trusting the message itself.
          this.ctx.waitUntil((async () => {
            const fresh = await this.env.ACCOUNTS.getByName('v1').getUser(clientObj.userId);
            if (fresh) { clientObj.user = { name: fresh.name, color: fresh.color }; this.broadcast(usersMsg(this.clients)); }
          })());
        } else if (m.type === 'ping') {
          sendSocket(server, JSON.stringify({ type: 'pong', t: m.t }));
        } else if (m.type === 'run') {
          const now = Date.now();
          if (now - this.lastRun < 400) return;
          this.lastRun = now;
          this.broadcast(JSON.stringify({ type: 'run', by: clientObj.user.name }), server);
        } else if (m.type === 'reset') {
          // Wipes this room's code back to the starter template, for every tab and
          // every connected person at once. The client only sends this after its own
          // multi-step "are you sure" flow, so there's nothing further to confirm here.
          for (const l of LANGS) { const d = this.docs[l]; d.text = STARTERS[l]; d.v++; }
          this.scheduleSave();
          for (const l of LANGS) this.broadcast(initMsg(this.docs, l));   // includes the sender, so everyone's screen snaps to the fresh template together
        }
      } catch (e) {}
    });

    server.addEventListener('close', () => {
      this.clients.delete(clientObj);
      this.broadcast(usersMsg(this.clients));
      if (this.clients.size === 0) this.ctx.waitUntil(this.flushSave());
    });
    server.addEventListener('error', () => {});

    return new Response(null, { status: 101, webSocket: client });
  }
}

// ---------------- Cloudflare Worker Export ----------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const secret = env.SECRET || 'dev-secret-change-me';
    const accounts = () => env.ACCOUNTS.getByName('v1');

    // 1. WebSocket Upgrade Handler
    if (url.pathname.startsWith('/ws')) {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket upgrade', { status: 426 });
      const cookies = parseCookies(request.headers.get('cookie') || '');
      const decoded = verifyToken(secret, cookies.cs);
      if (!decoded) return new Response('Unauthorized', { status: 401 });
      const user = await accounts().getUser(decoded.id);
      if (!user) return new Response('Unauthorized', { status: 401 });

      const roomName = (url.searchParams.get('room') || 'lobby').slice(0, 40) || 'lobby';
      const roomStub = env.ROOMS.getByName(roomName);
      const fwdHeaders = new Headers(request.headers);
      fwdHeaders.set('X-User', JSON.stringify({ id: user.id, ...pub(user) }));
      return roomStub.fetch(new Request(request.url, { headers: fwdHeaders }));
    }

    // 2. HTTP API Routes
    const getBody = async () => { try { return await request.json(); } catch { return {}; } };
    const setCookieHeader = (headers, u) => {
      const secure = request.url.startsWith('https');
      headers.append('Set-Cookie', `cs=${token(secret, u)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
    };
    const cookies = parseCookies(request.headers.get('cookie') || '');
    const decoded = verifyToken(secret, cookies.cs);

    if (request.method === 'POST' && url.pathname === '/api/signup') {
      const body = await getBody();
      const res = await accounts().signup(body.name, body.password, body.invite);
      if (res.error) return new Response(JSON.stringify({ error: res.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      const headers = new Headers({ 'Content-Type': 'application/json' });
      setCookieHeader(headers, res.user);
      return new Response(JSON.stringify(pub(res.user)), { status: 200, headers });
    }
    if (request.method === 'POST' && url.pathname === '/api/login') {
      const body = await getBody();
      const u = await accounts().login(body.name, body.password);
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
      if (!decoded) return new Response(null, { status: 401 });
      const u = await accounts().getUser(decoded.id);
      return u ? new Response(JSON.stringify(pub(u)), { status: 200, headers: { 'Content-Type': 'application/json' } }) : new Response(null, { status: 401 });
    }
    if (request.method === 'POST' && url.pathname === '/api/profile') {
      if (!decoded) return new Response(null, { status: 401 });
      const body = await getBody();
      const res = await accounts().updateProfile(decoded.id, body.name, body.color);
      if (res.error) return new Response(JSON.stringify({ error: res.error }), { status: 400, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(pub(res.user)), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // 3. Static Assets serving via Cloudflare Asset Binding
    try {
      return await env.ASSETS.fetch(request);
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  }
};
