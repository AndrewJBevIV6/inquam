# Respond

Real-time classroom activities on a server-authoritative op log.

- `shared/engine.js` — state, reducer, policy, visibility, locks, activity plugins (runs on server and client)
- `server.js` — rooms, WebSocket, op log, timers, sealed-phase snapshots
- `public/index.html` — presenter and participant views, replay

Run: `npm install && npm start` (port from `PORT`, default 3000). On Render: Node web service, build `npm install`, start `npm start`.

Adding an activity: `Engine.register({ kind, label, init(config), allowed(state, op, user), reduce(state, op), judge(state), visible?(state, op, viewer) })` and a view in `index.html`.
