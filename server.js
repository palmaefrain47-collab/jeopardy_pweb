// Jeopardy de Programación — server.js v2 (trampas + música es solo cliente)
// Cambios frente a la v1:
//  - room:create acepta { seconds, traps }: seconds 0 = sin límite, 20 = 20 s.
//    traps false = sala sin trampas (modo examen).
//  - Nuevo evento 'item:use' { item, target }.
//  - El estado 'state' ahora es personalizado por jugador: myItem, myHidden,
//    myShuffle, spyPick, effects, announce, traps, you.
//  - Al acertar hay probabilidad de ganar un ítem (más si vas último).
//  - Los efectos duran 5-6 s, el Escudo bloquea una trampa sin gastar el ítem
//    del atacante, y no se puede atacar en los últimos 3 s ni repetir objetivo.
const express = require('express'), http = require('http'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
const Q = require('./questions.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'cambiar123';
const T = 20000, tokens = new Set(), rooms = {};
app.use(express.static('public'));

const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(x => x[1]);
const ITEMS = ['lupa', 'escudo', 'tiempo', 'niebla', 'barajar', 'espia'];
const GOOD_ITEMS = ['lupa', 'escudo', 'tiempo'];
const pickItem = isLast => {
  if (isLast && Math.random() < 0.7) return GOOD_ITEMS[Math.floor(Math.random() * GOOD_ITEMS.length)];
  return ITEMS[Math.floor(Math.random() * ITEMS.length)];
};
const activeEffects = r => (r.effects || []).filter(e => e.until > Date.now());

function view(r, forName) {
  const o = {
    code: r.code, cats: Q.map(c => c.cat), used: [...r.used], q: null,
    players: Object.values(r.players).sort((a, b) => b.score - a.score)
      .map(p => ({ name: p.name, score: p.score, hasItem: !!p.item, shield: !!p.shield })),
    traps: r.traps !== false, you: forName || null,
    myItem: forName && r.players[forName] ? r.players[forName].item : null,
    myShield: !!(forName && r.players[forName] && r.players[forName].shield),
    announce: r.announce || null,
    effects: activeEffects(r).map(e => ({ type: e.type, target: e.target, from: e.from, until: e.until })),
    myHidden: [], myShuffle: null, spyPick: null
  };
  const q = r.q;
  if (q) {
    o.q = {
      c: q.c, i: q.i, text: Q[q.c].qs[q.i].q, opts: q.opts, value: (q.i + 1) * 100,
      ms: r.limit === 0 ? 3600000 : Math.max(0, q.end - Date.now()),
      done: q.done, n: Object.keys(q.ans).length,
      right: q.done ? q.right : null
    };
    if (forName) {
      o.myHidden = (q.lupa && q.lupa[forName]) || [];
      const sh = activeEffects(r).find(e => e.type === 'barajar' && e.target === forName);
      if (sh) o.myShuffle = sh.order;
      const target = q.spy && q.spy[forName];
      if (target && target in q.ans) {
        const opt = q.ans[target];
        o.spyPick = { target, opt, text: q.opts[opt] };
      }
    }
  }
  return o;
}
// Estado personalizado: cada socket recibe su propia vista (su ítem,
// sus opciones ocultas, su orden barajado y su espionaje).
const push = r => {
  for (const sock of io.sockets.sockets.values()) {
    if (sock.data.code === r.code) sock.emit('state', view(r, sock.data.name || null));
  }
};
const announce = (r, text) => { r.announceId = (r.announceId || 0) + 1; r.announce = { id: r.announceId, text, at: Date.now() }; };

function grantItems(r) {
  const q = r.q; if (!q) return;
  const sorted = Object.values(r.players).sort((a, b) => b.score - a.score);
  const minScore = sorted.length ? sorted[sorted.length - 1].score : 0;
  for (const [name, v] of Object.entries(q.ans)) {
    const p = r.players[name];
    if (!p || v !== q.right || p.item) continue;
    const isLast = p.score === minScore && sorted.length > 1;
    if (Math.random() < (isLast ? 0.5 : 0.35)) p.item = pickItem(isLast);
  }
}

function reveal(r) {
  const q = r.q;
  if (!q || q.done) return;
  q.done = true; clearTimeout(q.t); r.used.add(q.c + '-' + q.i);
  r.effects = [];
  for (const [n, v] of Object.entries(q.ans))
    if (r.players[n]) r.players[n].score += (v === q.right ? 1 : -1) * (q.i + 1) * 100;
  grantItems(r);
  push(r);
}

io.on('connection', s => {
  const R = () => rooms[s.data.code];
  const adm = () => s.data.admin && tokens.has(s.data.token);

  s.on('admin:login', (d, cb) => {
    if (d && d.user === ADMIN_USER && d.pass === ADMIN_PASS) {
      const t = crypto.randomUUID(); tokens.add(t); return cb({ ok: true, token: t });
    }
    cb({ ok: false });
  });
  s.on('room:create', (d, cb) => {
    if (!d || !tokens.has(d.token)) return cb({ ok: false });
    let code;
    do code = crypto.randomBytes(2).toString('hex').toUpperCase(); while (rooms[code]);
    rooms[code] = {
      code, players: {}, used: new Set(), q: null, effects: [], announce: null, announceId: 0,
      limit: d.seconds === 0 ? 0 : T, traps: d.traps !== false, lastTarget: {}
    };
    Object.assign(s.data, { code, admin: true, token: d.token }); s.join(code);
    cb({ ok: true, code }); push(rooms[code]);
  });
  s.on('admin:resume', (d, cb) => {
    const r = d && rooms[d.code];
    if (!r || !tokens.has(d.token)) return cb({ ok: false });
    Object.assign(s.data, { code: r.code, admin: true, token: d.token }); s.join(r.code);
    cb({ ok: true, code: r.code }); push(r);
  });
  s.on('room:join', (d, cb) => {
    const r = rooms[String((d && d.code) || '').toUpperCase()];
    const n = String((d && d.name) || '').trim().slice(0, 20);
    if (!r) return cb({ ok: false, err: 'Sala no encontrada' });
    if (!n) return cb({ ok: false, err: 'Escribe tu nombre' });
    Object.assign(s.data, { code: r.code, name: n }); s.join(r.code);
    r.players[n] = r.players[n] || { name: n, score: 0, item: null, shield: false };
    cb({ ok: true, code: r.code }); push(r);
  });
  s.on('q:open', d => {
    const r = R();
    if (!r || !adm() || (r.q && !r.q.done) || !d || !Q[d.c] || !Q[d.c].qs[d.i] || r.used.has(d.c + '-' + d.i)) return;
    const o = Q[d.c].qs[d.i].o, ord = shuffle([0, 1, 2, 3]);
    const limit = r.limit === 0 ? 0 : T;
    r.effects = [];
    r.q = {
      c: d.c, i: d.i, opts: ord.map(i => o[i]), right: ord.indexOf(0),
      end: Date.now() + (limit || 3600000), ans: {}, done: false,
      lupa: {}, spy: {}, timeUsed: false
    };
    if (limit) r.q.t = setTimeout(() => reveal(r), limit);
    push(r);
  });
  s.on('answer', d => {
    const r = R(), q = r && r.q;
    if (!q || q.done || !s.data.name || s.data.name in q.ans) return;
    q.ans[s.data.name] = d.opt;
    if (Object.keys(q.ans).length >= Object.keys(r.players).length) reveal(r); else push(r);
  });
  s.on('q:reveal', () => { const r = R(); if (r && adm()) reveal(r); });
  s.on('q:close', () => { const r = R(); if (r && adm() && r.q && r.q.done) { r.q = null; push(r); } });

  // ---- Trampas / ítems (Mario Kart) ----
  s.on('item:use', (d, cb) => {
    const done = r => cb && cb(r);
    const r = R(), name = s.data.name, q = r && r.q;
    if (!r || !r.traps) return done({ ok: false, err: 'Las trampas están desactivadas en esta sala' });
    if (!name || !r.players[name]) return done({ ok: false, err: 'No estás en la sala' });
    const p = r.players[name];
    const item = d && d.item;
    if (!item || p.item !== item) return done({ ok: false, err: 'No tienes ese ítem' });
    const target = typeof d.target === 'string' ? d.target.trim().slice(0, 20) : null;

    // Escudo: se puede activar en cualquier momento, dura hasta que bloquea una trampa.
    if (item === 'escudo') {
      p.item = null; p.shield = true;
      announce(r, `🛡️ ${name} activó un Escudo`);
      push(r); return done({ ok: true });
    }

    if (!q || q.done) return done({ ok: false, err: 'Usa el ítem durante una pregunta activa' });
    if (name in q.ans) return done({ ok: false, err: 'Ya respondiste esta pregunta' });

    if (item === 'lupa') {
      const wrong = [0, 1, 2, 3].filter(k => k !== q.right);
      q.lupa[name] = shuffle(wrong).slice(0, 2);
      p.item = null; announce(r, `🔍 ${name} usó la Lupa`);
      push(r); return done({ ok: true });
    }
    if (item === 'tiempo') {
      if (q.timeUsed) return done({ ok: false, err: 'Ya se usó Tiempo Extra en esta pregunta' });
      if (r.limit === 0) return done({ ok: false, err: 'Sin límite de tiempo, no hace falta' });
      q.timeUsed = true; q.end += 8000;
      clearTimeout(q.t); q.t = setTimeout(() => reveal(r), Math.max(0, q.end - Date.now()));
      p.item = null; announce(r, `⏱️ ${name} añadió +8 s para todos`);
      push(r); return done({ ok: true });
    }

    // Ítems con objetivo: niebla, barajar, espía
    if (!['niebla', 'barajar', 'espia'].includes(item)) return done({ ok: false, err: 'Ítem desconocido' });
    if (!target || target === name || !r.players[target]) return done({ ok: false, err: 'Elige a otro jugador como objetivo' });
    // Anti-repetición: no repetir el MISMO ítem contra el MISMO rival dos
    // veces seguidas, pero solo si hay otro rival al que elegir. Con un solo
    // rival (partida de 2) no se bloquea, si no el ítem quedaría inutilizable.
    const rivals = Object.keys(r.players).filter(n => n !== name).length;
    const lastKey = name + ':' + item;
    if (rivals > 1 && r.lastTarget[lastKey] === target) return done({ ok: false, err: `No puedes repetir ${item} contra ${target} dos veces seguidas` });
    if (r.limit !== 0 && q.end - Date.now() < 3000) return done({ ok: false, err: 'Quedan menos de 3 s, ya es tarde para atacar' });

    // Escudo del objetivo: lo bloquea y el atacante CONSERVA su ítem (amigable).
    if (r.players[target].shield) {
      r.players[target].shield = false;
      announce(r, `🛡️ ¡El Escudo de ${target} bloqueó el ataque de ${name}!`);
      push(r); return done({ ok: true, blocked: true });
    }

    r.lastTarget[name + ':' + item] = target;
    p.item = null;
    if (item === 'espia') {
      q.spy[name] = target;
      // Secreto: sin aviso global, solo el espía lo ve en su pantalla.
      push(r); return done({ ok: true });
    }
    const eff = { type: item, target, from: name, until: Date.now() + 6000 };
    if (item === 'barajar') eff.order = shuffle([0, 1, 2, 3]);
    r.effects.push(eff);
    setTimeout(() => { r.effects = r.effects.filter(e => e !== eff); push(r); }, 6000);
    announce(r, item === 'niebla' ? `🌫️ ${name} lanzó Niebla sobre ${target}` : `🔀 ${name} barajó las opciones de ${target}`);
    push(r); return done({ ok: true });
  });
});
srv.listen(process.env.PORT || 3000, () => console.log('Servidor listo'));
