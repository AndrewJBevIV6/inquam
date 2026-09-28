// Engine v2: a deck of items (each an activity instance with its own phase),
// one ordered op log, a policy function, visibility, presence locks, plugins.
// Runs unchanged on the server (CommonJS) and in the browser (window.Engine).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(this, function () {

  const activities = {};
  function register(a) { activities[a.kind] = a; }
  const CORE = new Set(['join', 'leave', 'select', 'load_deck', 'clear_deck', 'goto', 'open', 'close', 'reset']);

  function initState() {
    return {
      seq: 0,
      users: {},      // id -> {id, name, role, color, online, joinedAt}
      presence: {},   // id -> {node, t}; node strings are "<itemId>:<what>"
      deck: null,     // {title, items:[{id, kind, config}]}
      current: null,  // item id the presenter is showing
      docs: {},       // itemId -> activity document
      phases: {},     // itemId -> {status, openedAt, closesAt, sealed, closedAt}
      results: {},    // itemId -> judge output
    };
  }
  const item = (s, id) => s.deck && s.deck.items.find(i => i.id === id);
  const plugin = (s, id) => { const it = item(s, id); return it && activities[it.kind]; };
  const phase = (s, id) => s.phases[id] || { status: 'idle' };

  function reduce(state, op) {
    state.seq = op.seq;
    const p = op.payload || {};
    switch (op.type) {
      case 'join':
        state.users[op.actor] = { id: op.actor, name: p.name, role: p.role, color: p.color, online: true, joinedAt: op.t };
        break;
      case 'leave':
        if (state.users[op.actor]) state.users[op.actor].online = false;
        delete state.presence[op.actor];
        break;
      case 'select':
        if (p.node) state.presence[op.actor] = { node: p.node, t: op.t }; else delete state.presence[op.actor];
        break;
      case 'load_deck':
        state.deck = p.deck; state.docs = {}; state.phases = {}; state.results = {}; state.presence = {};
        p.deck.items.forEach(it => { state.docs[it.id] = activities[it.kind].init(it.config); });
        state.current = p.deck.items.length ? p.deck.items[0].id : null;
        break;
      case 'clear_deck':
        state.deck = null; state.current = null; state.docs = {}; state.phases = {}; state.results = {}; state.presence = {};
        break;
      case 'goto':
        if (item(state, p.item)) state.current = p.item;
        break;
      case 'open':
        state.phases[p.item] = { status: 'open', openedAt: op.t, closesAt: p.seconds ? op.t + p.seconds * 1000 : null, sealed: !!p.sealed };
        delete state.results[p.item];
        break;
      case 'close':
        state.phases[p.item] = { ...phase(state, p.item), status: 'closed', closedAt: op.t };
        state.results[p.item] = plugin(state, p.item).judge(state.docs[p.item], state);
        break;
      case 'reset':
        state.docs[p.item] = plugin(state, p.item).init(item(state, p.item).config);
        state.phases[p.item] = { status: 'idle' }; delete state.results[p.item];
        break;
      default: {
        const pl = plugin(state, p.item);
        if (pl && pl.reduce) pl.reduce(state.docs[p.item], op, state);
      }
    }
    return state;
  }

  function allowed(state, op) {
    const u = state.users[op.actor], p = op.payload || {};
    if (op.type === 'join') return true;
    if (!u) return false;
    if (op.type === 'leave' || op.type === 'select') return true;
    if (op.type === 'load_deck' || op.type === 'clear_deck') return u.role === 'presenter';
    if (['goto', 'open', 'close', 'reset'].includes(op.type)) return u.role === 'presenter' && !!item(state, p.item);
    const pl = plugin(state, p.item);
    if (!pl || phase(state, p.item).status !== 'open') return false;
    return pl.allowed(state.docs[p.item], op, u, state);
  }

  // May this viewer receive this op now? Sealed phases withhold others' ops
  // until close (the server then snapshots everyone).
  function visible(state, op, viewer) {
    if (CORE.has(op.type)) return true;
    if (viewer.role === 'presenter' || viewer.id === op.actor) return true;
    const it = op.payload.item;
    if (phase(state, it).sealed) return false;
    const pl = plugin(state, it);
    return pl && pl.visible ? pl.visible(state.docs[it], op, viewer) : true;
  }

  // What a participant may see of a doc while it is still open.
  function stripDoc(state, itemId, viewer) {
    const pl = plugin(state, itemId), doc = state.docs[itemId], ph = phase(state, itemId);
    if (viewer.role === 'presenter' || ph.status !== 'open' || !pl) return doc;
    const sealed = ph.sealed || (pl.private && pl.private(doc));
    return sealed && pl.stripFor ? pl.stripFor(doc, viewer.id) : doc;
  }

  function holder(state, node) {
    let best = null;
    for (const id in state.presence) { const pr = state.presence[id]; if (pr.node === node && (!best || pr.t < best.t)) best = { id, t: pr.t }; }
    return best ? best.id : null;
  }
  function selectors(state, node) {
    return Object.keys(state.presence).filter(id => state.presence[id].node === node).sort((a, b) => state.presence[a].t - state.presence[b].t);
  }
  function replay(log, upTo) {
    const s = initState();
    for (let i = 0; i < log.length && (upTo == null || i < upTo); i++) reduce(s, log[i]);
    return s;
  }

  // ---- helpers shared by "one answer per participant" activities -----------
  const perUserAnswers = () => ({ answers: {} });
  const stripAnswers = (doc, uid) => ({ ...doc, answers: uid in doc.answers ? { [uid]: doc.answers[uid] } : {} });
  const isPart = u => u.role === 'participant';
  const near = (a, b, rel) => Math.abs(a - b) <= Math.abs(b) * rel + 1e-12;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ======================= multiple choice ==================================
  register({
    kind: 'mcq', label: 'Multiple choice',
    init: c => ({ question: c.question || '', options: c.options || [], key: Number.isInteger(c.key) ? c.key : null, ...perUserAnswers() }),
    allowed: (d, op, u) => op.type === 'answer' && isPart(u) && Number.isInteger(op.payload.choice) && op.payload.choice >= 0 && op.payload.choice < d.options.length,
    reduce: (d, op) => { if (op.type === 'answer') d.answers[op.actor] = op.payload.choice; },
    stripFor: stripAnswers,
    judge(d) {
      const counts = d.options.map(() => 0), perUser = {};
      for (const id in d.answers) { counts[d.answers[id]]++; perUser[id] = { answer: String.fromCharCode(65 + d.answers[id]), correct: d.key == null ? null : d.answers[id] === d.key }; }
      return { counts, perUser };
    },
    summary: d => d.key == null ? 'poll' : 'key ' + String.fromCharCode(65 + d.key),
  });

  // ======================= free response ====================================
  register({
    kind: 'frq', label: 'Free response',
    init: c => ({ question: c.question || '', key: c.key || null, ...perUserAnswers() }),
    allowed: (d, op, u) => op.type === 'text' && isPart(u) && typeof op.payload.text === 'string' && op.payload.text.length <= 4000,
    reduce: (d, op) => { if (op.type === 'text') d.answers[op.actor] = op.payload.text; },
    stripFor: stripAnswers,
    judge(d) {
      const norm = s => String(s).trim().toLowerCase().replace(/\s+/g, ' ');
      const perUser = {};
      for (const id in d.answers) perUser[id] = { answer: d.answers[id], correct: d.key == null ? null : norm(d.answers[id]) === norm(d.key) };
      return { perUser };
    },
  });

  // ======================= collaborative text ===============================
  // Ops are index-based inserts/deletes applied in server order; with one
  // authority the only race is the round-trip window, which is fine for a room.
  register({
    kind: 'collab', label: 'Collaborative text',
    init: c => ({ prompt: c.prompt || '', text: c.seed || '', authors: {} }),
    allowed: (d, op, u) => isPart(u) && (
      (op.type === 'insert' && typeof op.payload.text === 'string' && op.payload.text.length <= 500 && Number.isInteger(op.payload.pos) && op.payload.pos >= 0 && op.payload.pos <= d.text.length) ||
      (op.type === 'delete' && Number.isInteger(op.payload.pos) && Number.isInteger(op.payload.len) && op.payload.pos >= 0 && op.payload.len > 0 && op.payload.pos + op.payload.len <= d.text.length)),
    reduce(d, op) {
      const p = op.payload; d.authors[op.actor] = (d.authors[op.actor] || 0) + 1;
      if (op.type === 'insert') d.text = d.text.slice(0, p.pos) + p.text + d.text.slice(p.pos);
      if (op.type === 'delete') d.text = d.text.slice(0, p.pos) + d.text.slice(p.pos + p.len);
    },
    judge: d => ({ text: d.text, authors: d.authors }),
  });

  // ======================= matching =========================================
  register({
    kind: 'match', label: 'Matching',
    init: c => ({ prompt: c.prompt || '', left: c.left || [], right: c.right || [], key: c.key || null, ...perUserAnswers() }),
    allowed: (d, op, u) => op.type === 'match' && isPart(u) && Number.isInteger(op.payload.i) && op.payload.i >= 0 && op.payload.i < d.left.length && (op.payload.j === null || (Number.isInteger(op.payload.j) && op.payload.j >= 0 && op.payload.j < d.right.length)),
    reduce(d, op) { if (op.type === 'match') (d.answers[op.actor] = d.answers[op.actor] || d.left.map(() => null))[op.payload.i] = op.payload.j; },
    stripFor: stripAnswers,
    judge(d) {
      const perUser = {};
      for (const id in d.answers) {
        const a = d.answers[id]; const right = d.key ? a.filter((j, i) => j === d.key[i]).length : null;
        perUser[id] = { answer: a.map(j => j == null ? '–' : String.fromCharCode(65 + j)).join(' '), correct: d.key ? right === d.left.length : null, score: right, of: d.left.length };
      }
      return { perUser };
    },
  });

  // ======================= structured numeric ===============================
  // mantissa × 10^exponent unit, judged component-wise.
  register({
    kind: 'num', label: 'Numeric (mantissa · 10ⁿ · unit)',
    init: c => ({ prompt: c.prompt || '', key: c.key || null, relTol: c.relTol || 0.02, ...perUserAnswers() }),
    allowed: (d, op, u) => op.type === 'num' && isPart(u) && typeof op.payload.m === 'number' && Number.isInteger(op.payload.e) && typeof op.payload.u === 'string',
    reduce: (d, op) => { if (op.type === 'num') d.answers[op.actor] = { m: op.payload.m, e: op.payload.e, u: op.payload.u.trim() }; },
    stripFor: stripAnswers,
    judge(d) {
      const perUser = {}, unit = s => s.replace(/\s+/g, '').replace(/\*\*/g, '^').replace(/\*/g, '·');
      for (const id in d.answers) {
        const a = d.answers[id], v = a.m * Math.pow(10, a.e), text = `${a.m}e${a.e} ${a.u}`;
        if (!d.key) { perUser[id] = { answer: text, correct: null }; continue; }
        const kv = d.key.m * Math.pow(10, d.key.e);
        const value = near(v, kv, d.relTol), units = unit(a.u) === unit(d.key.u);
        const mag = value ? true : near(v, kv, 0.5);   // right order of magnitude?
        perUser[id] = { answer: text, correct: value && units, detail: { value, units, magnitude: mag } };
      }
      return { perUser };
    },
  });

  // ======================= build a product from factors =====================
  register({
    kind: 'product', label: 'Build a product',
    init: c => ({ prompt: c.prompt || '', target: c.target, bank: c.bank || [], ...perUserAnswers() }),
    allowed: (d, op, u) => op.type === 'pick' && isPart(u) && Array.isArray(op.payload.picks) && op.payload.picks.every(i => Number.isInteger(i) && i >= 0 && i < d.bank.length) && new Set(op.payload.picks).size === op.payload.picks.length,
    reduce: (d, op) => { if (op.type === 'pick') d.answers[op.actor] = op.payload.picks; },
    stripFor: stripAnswers,
    judge(d) {
      const perUser = {};
      for (const id in d.answers) {
        const prod = d.answers[id].reduce((a, i) => a * d.bank[i], 1);
        perUser[id] = { answer: d.answers[id].map(i => d.bank[i]).join(' × ') + ' = ' + +prod.toPrecision(6), correct: near(prod, d.target, 1e-9) };
      }
      return { perUser };
    },
  });

  // ======================= place objects on a grid ==========================
  register({
    kind: 'place', label: 'Place objects',
    init(c) {
      const objects = {};
      (c.objects || []).forEach(o => { objects[o.id] = { id: o.id, label: o.label, x: o.x || 0, y: o.y || 0 }; });
      return { prompt: c.prompt || '', mode: c.mode === 'individual' ? 'individual' : 'shared', range: c.range || 5, tolerance: c.tolerance || 0.5, objects, targets: c.targets || {}, copies: {} };
    },
    allowed(d, op, u, state) {
      if (op.type !== 'move' || !isPart(u)) return false;
      const p = op.payload;
      if (!d.objects[p.id] || typeof p.x !== 'number' || typeof p.y !== 'number') return false;
      if (d.mode === 'individual') return true;
      const hld = holder(state, p.item + ':' + p.id);
      return hld === null || hld === op.actor;
    },
    reduce(d, op) {
      if (op.type !== 'move') return;
      const p = op.payload;
      if (d.mode === 'individual') (d.copies[op.actor] = d.copies[op.actor] || {})[p.id] = { x: p.x, y: p.y };
      else { d.objects[p.id].x = p.x; d.objects[p.id].y = p.y; }
    },
    private: d => d.mode === 'individual',
    visible: (d) => d.mode !== 'individual',
    stripFor: (d, uid) => ({ ...d, copies: uid in d.copies ? { [uid]: d.copies[uid] } : {} }),
    positions(d, uid) {
      const out = {};
      for (const id in d.objects) { const c = d.mode === 'individual' && d.copies[uid] && d.copies[uid][id]; out[id] = c ? { ...d.objects[id], ...c } : d.objects[id]; }
      return out;
    },
    judge(d, state) {
      const score = pos => { const per = {}; let hits = 0, n = 0; for (const id in d.targets) { n++; const e = dist(pos[id], d.targets[id]); per[id] = { error: e, hit: e <= d.tolerance }; if (per[id].hit) hits++; } return { per, hits, n, answer: Object.keys(pos).map(id => `${id}(${pos[id].x}, ${pos[id].y})`).join(' '), correct: hits === n }; };
      if (d.mode === 'shared') return { board: score(d.objects), perUser: {} };
      const perUser = {};
      for (const id in state.users) if (isPart(state.users[id])) perUser[id] = score(activities.place.positions(d, id));
      return { perUser };
    },
  });

  return { activities, register, initState, reduce, allowed, visible, stripDoc, holder, selectors, replay, item, plugin, phase, CORE };
});
