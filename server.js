// Server-authoritative op log. Every client action becomes an op; the server
// checks policy, appends to the room log, reduces, and broadcasts to the
// clients allowed to see it. Sealed phases end with a full snapshot.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const Engine = require('./shared/engine');

const PORT = process.env.PORT || 3000;
const COLORS = ['#e0523f', '#2f7fd6', '#2ea36b', '#e0a021', '#8a55d6', '#d6489a',
                '#1fa6a6', '#c96a2c', '#5a7a2f', '#7a5c3a', '#3a5f9a', '#b03060'];

const rooms = new Map();   // code -> room

function newRoom() {
  let code;
  do { code = Array.from({ length: 4 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random() * 23)]).join(''); }
  while (rooms.has(code));
  const room = { code, log: [], state: Engine.initState(), clients: new Map(), timer: null, colorIdx: 0 };
  rooms.set(code, room);
  return room;
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// Try to commit an op. Returns the op if accepted, null if refused by policy.
function commit(room, actor, type, payload) {
  const op = { seq: room.log.length + 1, t: Date.now(), actor, type, payload: payload || {} };
  if (!Engine.allowed(room.state, op)) return null;
  const sealedBefore = room.state.phase.sealed && room.state.phase.status === 'open';
  room.log.push(op);
  Engine.reduce(room.state, op);
  for (const [ws, viewer] of room.clients) {
    if (Engine.visible(room.state, op, viewer)) send(ws, { type: 'op', op });
  }
  if (type === 'close' && sealedBefore) broadcastSnapshot(room);
  if (type === 'open') {
    clearTimeout(room.timer);
    if (payload.seconds) room.timer = setTimeout(() => commit(room, actor, 'close', {}), payload.seconds * 1000);
  }
  if (type === 'close' || type === 'load' || type === 'clear') clearTimeout(room.timer);
  return op;
}

function broadcastSnapshot(room) {
  for (const [ws] of room.clients) send(ws, { type: 'snapshot', state: room.state });
}

// A viewer-specific snapshot: strip what this viewer may not yet see.
function snapshotFor(room, viewer) {
  const s = JSON.parse(JSON.stringify(room.state));
  if (viewer.role === 'presenter' || s.phase.status !== 'open') return s;
  const a = Engine.activities[s.activity];
  if (!a || !s.doc) return s;
  if (s.phase.sealed || (a.kind === 'place' && s.doc.mode === 'individual')) {
    if (a.kind === 'mcq') s.doc.answers = viewer.id in s.doc.answers ? { [viewer.id]: s.doc.answers[viewer.id] } : {};
    if (a.kind === 'place') s.doc.copies = viewer.id in s.doc.copies ? { [viewer.id]: s.doc.copies[viewer.id] } : {};
  }
  return s;
}

// ---- HTTP: static files ----------------------------------------------------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0];
  if (url === '/') url = '/index.html';
  let file;
  if (url.startsWith('/shared/')) file = path.join(__dirname, url);
  else file = path.join(__dirname, 'public', url);
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- WebSocket ------------------------------------------------------------
const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let room = null, me = null;
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'hello') {
      if (msg.role === 'presenter' && !msg.room) room = newRoom();
      else room = rooms.get((msg.room || '').toUpperCase());
      if (!room) return send(ws, { type: 'error', message: 'No room with that code.' });
      const role = msg.role === 'presenter' ? 'presenter' : 'participant';
      // Rejoin: same name in same room reclaims the identity (and its record).
      const existing = Object.values(room.state.users).find(u => u.name === msg.name && u.role === role && !u.online);
      const id = existing ? existing.id : Math.random().toString(36).slice(2, 8);
      const color = existing ? existing.color : COLORS[room.colorIdx++ % COLORS.length];
      me = { id, role, name: msg.name || (role === 'presenter' ? 'Presenter' : 'Anonymous') };
      room.clients.set(ws, me);
      commit(room, id, 'join', { name: me.name, role, color });
      send(ws, { type: 'welcome', id, role, room: room.code, state: snapshotFor(room, me) });
      return;
    }
    if (!room || !me) return;

    if (msg.type === 'op') {
      const ok = commit(room, me.id, msg.op.type, msg.op.payload);
      if (!ok) send(ws, { type: 'refused', op: msg.op });
    }
    if (msg.type === 'log' && me.role === 'presenter') send(ws, { type: 'log', log: room.log });
  });
  ws.on('close', () => {
    if (!room || !me) return;
    room.clients.delete(ws);
    commit(room, me.id, 'leave', {});
  });
});

server.listen(PORT, () => console.log(`respond listening on ${PORT}`));
