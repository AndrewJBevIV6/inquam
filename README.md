# Respond

Real-time classroom activities on a server-authoritative op log.

- `shared/engine.js` — state, reducer, policy, visibility, presence locks, activity plugins (runs on server and client)
- `server.js` — rooms, WebSocket, op log, per-item timers, sealed-phase snapshots
- `public/index.html` — presenter and participant views, deck editor, CSV export, read-only replay

Run: `npm install && npm start` (port from `PORT`, default 3000). On Render: Node web service, build `npm install`, start `npm start`.

## Deck format
One item per block, blank line between blocks, optional `# Title` first.
```
mcq: question        options one per line, * marks the key
frq: question        key: optional exact answer
num: prompt          key: 6.02e23 mol^-1    tol: 0.02 (relative)
match: prompt        left = right, one pair per line (right column is shuffled)
product: prompt      target: 360   bank: 2 3 4 5 6 8 9 12
place: prompt        label x y lines   mode: shared|individual   range: 5   tol: 0.5
collab: prompt       seed: starting text
```

## Adding an activity
`Engine.register({ kind, label, init(config), allowed(doc, op, user, state), reduce(doc, op, state), judge(doc, state) -> { perUser: { [id]: { answer, correct } } }, stripFor?(doc, userId), private?(doc), visible?(doc, op, viewer) })`
plus a stage renderer in `index.html`. Activity ops carry `payload.item`.
