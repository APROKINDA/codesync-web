const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, 'users.json');
const PORT = process.env.PORT || 3000;

function loadUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')); }
  catch (e) { return {}; }
}
function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'codesync-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

app.post('/api/register', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password || username.length < 2 || password.length < 4) {
    return res.status(400).json({ error: 'Username (2+ chars) and password (4+ chars) required.' });
  }
  const users = loadUsers();
  const key = username.toLowerCase();
  if (users[key]) return res.status(409).json({ error: 'That username is taken.' });
  users[key] = { username, passwordHash: bcrypt.hashSync(password, 10) };
  saveUsers(users);
  req.session.username = username;
  res.json({ username });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const users = loadUsers();
  const record = users[(username || '').toLowerCase()];
  if (!record || !bcrypt.compareSync(password || '', record.passwordHash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }
  req.session.username = record.username;
  res.json({ username: record.username });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (req.session.username) res.json({ username: req.session.username });
  else res.status(401).json({ error: 'Not logged in' });
});

app.get('/', (req, res) => {
  if (!req.session.username) return res.redirect('/login.html');
  const roomId = crypto.randomBytes(4).toString('hex');
  res.redirect('/room/' + roomId);
});

app.get('/room/:id', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editor.html'));
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const rooms = new Map();
const COLORS = ['#6ea8fe', '#f28b82', '#81c995', '#fdd663', '#c58af9', '#78d9ec', '#ff8bcb', '#ffab70'];

function getRoom(id) {
  if (!rooms.has(id)) rooms.set(id, { text: '', clients: new Map() });
  return rooms.get(id);
}

function broadcastPeers(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const users = Array.from(room.clients.values()).map(c => ({ id: c.id, name: c.name, color: c.color, line: c.line }));
  const msg = JSON.stringify({ type: 'peers', users });
  for (const client of room.clients.keys()) {
    if (client.readyState === WebSocket.OPEN) client.send(msg);
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://placeholder');
  const roomId = (url.searchParams.get('room') || 'lobby').slice(0, 40);
  const name = (url.searchParams.get('name') || 'Someone').slice(0, 40);

  const room = getRoom(roomId);
  const id = crypto.randomBytes(6).toString('hex');
  const color = COLORS[room.clients.size % COLORS.length];
  room.clients.set(ws, { id, name, color, line: 1 });

  ws.send(JSON.stringify({ type: 'init', text: room.text, selfId: id }));
  broadcastPeers(roomId);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    const me = room.clients.get(ws);
    if (!me) return;

    if (msg.type === 'edit' && typeof msg.text === 'string') {
      room.text = msg.text;
      const out = JSON.stringify({ type: 'edit', text: msg.text, fromId: me.id });
      for (const client of room.clients.keys()) {
        if (client !== ws && client.readyState === WebSocket.OPEN) client.send(out);
      }
    } else if (msg.type === 'cursor' && typeof msg.line === 'number') {
      me.line = msg.line;
      broadcastPeers(roomId);
    }
  });

  ws.on('close', () => {
    room.clients.delete(ws);
    broadcastPeers(roomId);
  });
});

server.listen(PORT, () => console.log('CodeSync web listening on port ' + PORT));
