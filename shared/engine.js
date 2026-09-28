// Engine: one shared state tree, an ordered op log, a policy function, and
// activity plugins. Loaded by the server (CommonJS) and the client (global).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Engine = factory();
})(this, function () {

  const activities = {};
  function register(a) { activities[a.kind] = a; }
  function act(state) { return state.activity ? activities[state.activity] : null; }

  const CORE = new Set(['join', 'leave', 'select', 'load', 'open', 'close', 'clear']);

  function initState() {
    return {
      seq: 0,
      users: {},      // id -> {id, name, role, color, online, joinedAt}
      presence: {},   // id -> {node, t}   (what each user is touching)
      phase: { status: 'idle' },
      activity: null,
      doc: null,
      results: null,
    };
  }

  // ---- reduce: pure state transition -------------------------------------
  function reduce(state, op) {
    state.seq = op.seq;
    const p = op.payload || {};
    switch (op.type) {
      case 'join':
        state.users[op.actor] = {
          id: op.actor, name: p.name, role: p.role, color: p.color,
          online: true, joinedAt: op.t,
        };
        break;
      case 'leave':
        if (state.users[op.actor]) state.users[op.actor].online = false;
        delete state.presence[op.actor];
        break;
      case 'select':
        if (p.node) state.presence[op.actor] = { node: p.node, t: op.t };
        else delete state.presence[op.actor];
        break;
      case 'load':
        state.activity = p.kind;
        state.doc = activities[p.kind].init(p.config, state);
        state.phase = { status: 'idle' };
        state.results = null;
        state.presence = {};
        break;
      case 'open':
        state.phase = {
          status: 'open', openedAt: op.t,
          closesAt: p.seconds ? op.t + p.seconds * 1000 : null,
          sealed: !!p.sealed,
        };
        state.results = null;
        break;
      case 'close':
        state.phase = { status: 'closed', closedAt: op.t, sealed: state.phase.sealed };
        state.results = act(state) ? act(state).judge(state) : null;
        break;
      case 'clear':
        state.activity = null; state.doc = null; state.results = null;
        state.phase = { status: 'idle' }; state.presence = {};
        break;
      default:
        if (act(state) && act(state).reduce) act(state).reduce(state, op);
    }
    return state;
  }

  // ---- policy: (state, op) -> boolean --------------------------------------
  function allowed(state, op) {
    const u = state.users[op.actor];
    if (op.type === 'join') return true;
    if (!u) return false;
    if (op.type === 'leave' || op.type === 'select') return true;
    if (['load', 'open', 'close', 'clear'].includes(op.type)) return u.role === 'presenter';
    if (state.phase.status !== 'open') return false;
    const a = act(state);
    return !!a && a.allowed(state, op, u);
  }

  // ---- visibility: may this viewer receive this op right now? -------------
  // Sealed phases withhold other participants' activity ops until close;
  // the server then sends everyone a snapshot.
  function visible(state, op, viewer) {
    if (CORE.has(op.type)) return true;
    if (viewer.role === 'presenter' || viewer.id === op.actor) return true;
    if (state.phase.sealed) return false;
    const a = act(state);
    return a && a.visible ? a.visible(state, op, viewer) : true;
  }

  // ---- lock helper: the first user currently selecting a node holds it -----
  function holder(state, node) {
    let best = null;
    for (const id in state.presence) {
      const pr = state.presence[id];
      if (pr.node === node && (!best || pr.t < best.t)) best = { id, t: pr.t };
    }
    return best ? best.id : null;
  }
  function selectors(state, node) {
    return Object.keys(state.presence)
      .filter(id => state.presence[id].node === node)
      .sort((a, b) => state.presence[a].t - state.presence[b].t);
  }

  function replay(log, upTo) {
    const s = initState();
    for (let i = 0; i < log.length && (upTo == null || i < upTo); i++) reduce(s, log[i]);
    return s;
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  // ======================= Activity: multiple choice ========================
  register({
    kind: 'mcq',
    label: 'Multiple choice',
    init(config) {
      return {
        question: config.question || '',
        options: config.options || [],
        key: typeof config.key === 'number' ? config.key : null,
        answers: {},   // userId -> option index
      };
    },
    allowed(state, op, u) {
      return op.type === 'answer' && u.role === 'participant'
        && Number.isInteger(op.payload.choice)
        && op.payload.choice >= 0 && op.payload.choice < state.doc.options.length;
    },
    reduce(state, op) {
      if (op.type === 'answer') state.doc.answers[op.actor] = op.payload.choice;
    },
    judge(state) {
      const d = state.doc;
      const counts = d.options.map(() => 0);
      const perUser = {};
      for (const id in d.answers) {
        counts[d.answers[id]]++;
        perUser[id] = { choice: d.answers[id], correct: d.key == null ? null : d.answers[id] === d.key };
      }
      return { counts, perUser };
    },
  });

  // ================= Activity: place objects on a grid ======================
  // config: { objects:[{id,label,x,y}], targets:{id:{x,y}}, tolerance, mode }
  // mode 'shared': one board, write lock = first selector of the object.
  // mode 'individual': every participant has their own copy of the positions.
  register({
    kind: 'place',
    label: 'Place objects',
    init(config) {
      const objects = {};
      (config.objects || []).forEach(o => { objects[o.id] = { id: o.id, label: o.label, x: o.x, y: o.y }; });
      return {
        prompt: config.prompt || '',
        mode: config.mode === 'individual' ? 'individual' : 'shared',
        range: config.range || 5,
        tolerance: config.tolerance || 0.5,
        objects, targets: config.targets || {},
        copies: {},   // individual mode: userId -> {objId: {x,y}}
      };
    },
    allowed(state, op, u) {
      if (op.type !== 'move' || u.role !== 'participant') return false;
      const d = state.doc, p = op.payload;
      if (!d.objects[p.id] || typeof p.x !== 'number' || typeof p.y !== 'number') return false;
      if (d.mode === 'individual') return true;
      const h = holder(state, p.id);
      return h === null || h === op.actor;   // first selector owns the object
    },
    reduce(state, op) {
      if (op.type !== 'move') return;
      const d = state.doc, p = op.payload;
      if (d.mode === 'individual') {
        (d.copies[op.actor] = d.copies[op.actor] || {})[p.id] = { x: p.x, y: p.y };
      } else {
        d.objects[p.id].x = p.x; d.objects[p.id].y = p.y;
      }
    },
    // Individual mode: your own moves are private; presenter sees all.
    visible(state, op, viewer) { return state.doc.mode !== 'individual'; },
    positions(state, userId) {
      const d = state.doc, out = {};
      for (const id in d.objects) {
        const c = d.mode === 'individual' && d.copies[userId] && d.copies[userId][id];
        out[id] = c ? { ...d.objects[id], ...c } : d.objects[id];
      }
      return out;
    },
    judge(state) {
      const d = state.doc, self = activities.place;
      const score = pos => {
        const per = {}; let hits = 0, n = 0;
        for (const id in d.targets) {
          n++;
          const e = dist(pos[id], d.targets[id]);
          per[id] = { error: e, hit: e <= d.tolerance };
          if (per[id].hit) hits++;
        }
        return { per, hits, n };
      };
      if (d.mode === 'shared') return { board: score(d.objects) };
      const perUser = {};
      for (const id in state.users) if (state.users[id].role === 'participant')
        perUser[id] = score(self.positions(state, id));
      return { perUser };
    },
  });

  return { activities, register, initState, reduce, allowed, visible, holder, selectors, replay, CORE };
});
