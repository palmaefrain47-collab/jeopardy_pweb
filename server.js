const express = require('express'), http = require('http'), crypto = require('crypto');
const { Server } = require('socket.io');
const app = express(), srv = http.createServer(app), io = new Server(srv);
const Q = require('./questions.json');
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'cambiar123';
const T = 20000, tokens = new Set(), rooms = {};
app.use(express.static('public'));

const shuffle = a => a.map(x => [Math.random(), x]).sort((p, q) => p[0] - q[0]).map(x => x[1]);

function view(r) {
  const o = {
    code: r.code, cats: Q.map(c => c.cat), used: [...r.used], q: null,
    players: Object.values(r.players).sort((a, b) => b.score - a.score)
  };
  const q = r.q;
  if (q) o.q = {
    c: q.c, i: q.i, text: Q[q.c].qs[q.i].q, opts: q.opts, value: (q.i + 1) * 100,
    ms: Math.max(0, q.end - Date.now()), done: q.done, n: Object.keys(q.ans).length,
    right: q.done ? q.right : null
  };
  return o;
}
const push = r => io.to(r.code).emit('state', view(r));

function reveal(r) {
  const q = r.q;
  if (!q || q.done) return;
  q.done = true; clearTimeout(q.t); r.used.add(q.c + '-' + q.i);
  for (const [n, v] of Object.entries(q.ans))
    if (r.players[n]) r.players[n].score += (v === q.right ? 1 : -1) * (q.i + 1) * 100;
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
    rooms[code] = { code, players: {}, used: new Set(), q: null };
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
    r.players[n] = r.players[n] || { name: n, score: 0 };
    cb({ ok: true, code: r.code }); push(r);
  });
  s.on('q:open', d => {
    const r = R();
    if (!r || !adm() || (r.q && !r.q.done) || !d || !Q[d.c] || !Q[d.c].qs[d.i] || r.used.has(d.c + '-' + d.i)) return;
    const o = Q[d.c].qs[d.i].o, ord = shuffle([0, 1, 2, 3]);
    r.q = { c: d.c, i: d.i, opts: ord.map(i => o[i]), right: ord.indexOf(0), end: Date.now() + T, ans: {}, done: false };
    r.q.t = setTimeout(() => reveal(r), T); push(r);
  });
  s.on('answer', d => {
    const r = R(), q = r && r.q;
    if (!q || q.done || !s.data.name || s.data.name in q.ans) return;
    q.ans[s.data.name] = d.opt;
    if (Object.keys(q.ans).length >= Object.keys(r.players).length) reveal(r); else push(r);
  });
  s.on('q:reveal', () => { const r = R(); if (r && adm()) reveal(r); });
  s.on('q:close', () => { const r = R(); if (r && adm() && r.q && r.q.done) { r.q = null; push(r); } });
});
srv.listen(process.env.PORT || 3000, () => console.log('Servidor listo'));
