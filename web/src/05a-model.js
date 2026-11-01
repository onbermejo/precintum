/* Modelo: recibos, cadena, lote, evento y comprobaciones. Todo con hashes reales. */
const C = PrecintumCrypto;
const T = (h, m, s = 0) => Math.floor(Date.UTC(2026, 8, 3, h - 2, m, s) / 1000); /* hora de Madrid (CEST) → epoch */
const WINDOW = { start: T(14, 0), end: T(15, 0) };
const POLICY = C.hex(C.sha256(C.enc.encode('age_over_18/v1')));
const VERIFIER = C.hex(C.sha256(C.enc.encode('umbral/eudi-srv-verifier-endpoint/prod-01')));
const GENESIS = C.hex(C.hashDomain('precintum/genesis/v1', new Uint8Array(0)));
const PUBKEY = C.hex(C.sha256(C.enc.encode('acta-demo-umbral-pubkey')));
const PREV_ROOT = C.hex(C.sha256(C.enc.encode('acta-demo-batch-206-root')));
const SALT = C.randHex(207, 16);
const SIG = C.randHex(7676, 64);
const BLOCK = '966.412';

const RAW = [
  { seq: 811, h: 13, m: 58, result: 'over_18', hidden: true },
  { seq: 812, h: 14, m: 4, result: 'over_18' },
  { seq: 813, h: 14, m: 17, result: 'under_18' },
  { seq: 814, h: 14, m: 32, result: 'over_18', nora: true },
  { seq: 815, h: 14, m: 41, result: 'error' },
  { seq: 816, h: 14, m: 55, result: 'over_18' },
];

const canonical = (r) => JSON.stringify(Object.keys(r).sort().reduce((o, k) => ((o[k] = r[k]), o), {}));
const receiptHash = (r) => C.hex(C.hashDomain('precintum/receipt/v1', C.enc.encode(canonical(r))));

/* Construye una cadena honesta a partir de la lista bruta: prev = hash del anterior. */
function buildChain(raw) {
  let prev = GENESIS;
  const out = [];
  for (const x of raw) {
    const r = { v: 1, seq: x.seq, prev, nonce: C.randHex(1000 + x.seq, 32), policy: POLICY, verifier: VERIFIER, result: x.result, ts: T(x.h, x.m) };
    const h = receiptHash(r);
    out.push({ r, h, meta: x, stored: h });
    prev = h;
  }
  return out;
}
const HONEST = buildChain(RAW);
const HIDDEN_HEAD = HONEST[0].h; /* huella del #811, anterior a la ventana */
const VISIBLE = HONEST.filter((x) => !x.meta.hidden);

function batchFromLeaves(list) {
  const tree = C.merkleTree(list.map((x) => x.stored));
  const count = list.length;
  const commit = C.hex(C.hashDomain('precintum/count/v1', C.enc.encode(`${count}:${SALT}`)));
  const created = WINDOW.end + 5;
  // Igual que buildBatchEvent en el código real: la raíz va en content, no en una etiqueta.
  const tags = [['v', '1'], ['seq', '207'], ['prev', PREV_ROOT], ['window', String(WINDOW.start), String(WINDOW.end)], ['policy', POLICY], ['count', commit]];
  const id = C.hex(C.sha256(C.enc.encode(JSON.stringify([0, PUBKEY, created, 7676, tags, tree.h]))));
  return { tree, root: tree.h, count, commit, created, tags, id };
}
const BATCH = batchFromLeaves(VISIBLE);

/* Recibos tal y como los ve la inspectora en un escenario: copia alterada + hashes recalculados. */
function receiptsFor(w, scen) {
  let list = VISIBLE.slice(0, w.receiptsShown).map((x) => ({ r: { ...x.r }, meta: x.meta, stored: x.stored }));
  const alter = scen ? scen.alter : null;
  if (alter === 'edit') {
    const t = list.find((x) => x.r.seq === 813);
    if (t) { t.r.result = 'over_18'; t.edited = true; }
  } else if (alter === 'delAfter') {
    list = list.filter((x) => x.r.seq !== 815);
  } else if (alter === 'delBefore') {
    const raw = RAW.filter((x) => x.seq !== 815).map((x) => ({ ...x, seq: x.seq > 815 ? x.seq - 1 : x.seq }));
    list = buildChain(raw).filter((x) => !x.meta.hidden).map((x) => ({ r: { ...x.r }, meta: x.meta, stored: x.stored }));
  }
  for (const x of list) x.h = receiptHash(x.r); /* lo que recalcula precintum-verify */
  return list;
}

/* El lote publicado: el original, salvo en el mundo donde el #815 nunca existió. */
function batchFor(w, scen, list) {
  if (scen && scen.alter === 'delBefore') return batchFromLeaves(list);
  return BATCH;
}

function chainLinks(list) {
  return list.map((x, i) => {
    const prevHash = i === 0 ? HIDDEN_HEAD : list[i - 1].h;
    const prevSeq = i === 0 ? 811 : list[i - 1].r.seq;
    return { ok: x.r.prev === prevHash && x.r.seq === prevSeq + 1, gap: x.r.seq !== prevSeq + 1 };
  });
}

const CHECKS = [
  'Recibos bien formados y sin datos personales (esquema estricto)',
  'Cadena íntegra y completa: cada recibo enlaza con el anterior, sin huecos',
  'Cada recibo incluido en la raíz de su lote (Merkle)',
  'Las raíces coinciden con los eventos firmados en los relays; una por hora, sin huecos <span class="sim" title="En esta página la firma Schnorr y la consulta a los relays están simuladas; el verificador independiente comprueba firmas, y la consulta del auditor a los relays sigue pendiente">simulado</span>',
  'Sello RFC 3161 válido (firma, cadena de la TSA, lista de confianza) y dentro de las 24 h <span class="sim" title="El token de la TSA está simulado; la firma CMS la valida DSS">simulado</span>',
  `Ancla en Bitcoin verificada contra la cabecera del bloque ${BLOCK} <span class="sim" title="La atestación de Bitcoin está simulada; verificarla exige un nodo o un explorador">simulado</span>`,
  'Recuento: el compromiso publicado coincide con los recibos revelados',
];

function computeChecks(w, scen) {
  const list = receiptsFor(w, scen);
  const batch = batchFor(w, scen, list);
  const flags = scen ? scen.flags : {};
  const links = chainLinks(list);
  const recomputed = C.merkleTree(list.map((x) => x.h));
  const rootOk = recomputed.h === batch.root;
  const res = [];
  const put = (status, why) => res.push({ status, why });

  put('ok', 'Los ' + list.length + ' recibos cumplen el esquema v1; ningún campo identifica a una persona.');

  const broken = links.findIndex((l) => !l.ok);
  if (broken < 0) put('ok', `Del #${list[0].r.seq} al #${list[list.length - 1].r.seq}, cada prev coincide con la huella del anterior.`);
  else {
    const x = list[broken];
    put('fail', links[broken].gap ? `Salto de numeración: tras el #${list[broken - 1].r.seq} viene el #${x.r.seq}, y su prev no coincide con la huella del #${list[broken - 1].r.seq}.` : `El #${x.r.seq} guarda como prev la huella original del #${list[broken - 1].r.seq}; la huella recalculada es otra.`);
  }

  if (rootOk) put('ok', `Raíz recalculada ${ab(recomputed.h)} = raíz del lote #207.`);
  else put('fail', `Raíz recalculada ${ab(recomputed.h)} ≠ raíz publicada ${ab(batch.root)}.`);

  if (flags.relayLost === 3) put('fail', 'Ningún relay devuelve el evento: se ha perdido el testigo público. El evento firmado sigue en el paquete y en el archivo local.');
  else if (flags.keyStolen) put('fail', 'Dos lotes con seq 208 firmados con la misma clave: bifurcación. El falso no tiene sello ni ancla de la fecha que pretende.');
  else if (!rootOk) put('fail', 'Los relays conservan el evento original: su raíz coincide con el paquete original, no con los recibos recalculados.');
  else if (flags.relayLost === 1) put('warn', 'Damus ya no devuelve el evento (alerta witness_lost registrada); nos.lol y Primal sí. Una raíz por hora, sin huecos.');
  else put('ok', 'Los tres relays devuelven el lote #207 con firma válida; del #196 al #207 hay una raíz por hora.');

  if (flags.tsaGone) put('warn', 'El certificado de la TSA caducó en 2031: el token se valida solo con la cadena archivada (LTV) y pierde fuerza sin re-sellado.');
  else put('ok', `Imprint = id del evento; genTime 15:00:07, 7 s después del cierre (límite 24 h); cadena hasta la lista de confianza UE.`);

  put('ok', `La ruta del .ots llega a la raíz Merkle de la cabecera del bloque ${BLOCK}.`);

  if (list.length === batch.count) put('ok', `sha256("precintum/count/v1"‖0x0a‖"${batch.count}:sal") = compromiso publicado; hay ${list.length} recibos.`);
  else put('fail', `El compromiso corresponde a ${batch.count} recibos; el paquete trae ${list.length}.`);

  const done = w.auditDone || 0;
  return res.map((c, i) => ({ n: i + 1, text: CHECKS[i], status: i < done ? c.status : 'todo', why: i < done ? c.why : '' }));
}

/* Formato */
function ab(h) { return h.slice(0, 8) + '…' + h.slice(-4); }
function hashSpan(h, plain) { return `<span class="hash${plain ? ' plain' : ''}" title="${h}">${ab(h)}</span>`; }
function fmtT(epoch, sec) {
  const o = { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' };
  if (sec) o.second = '2-digit';
  return new Date(epoch * 1000).toLocaleTimeString('es-ES', o);
}
function esc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]); }

function freshWorld() {
  return { credential: false, presented: false, verified: false, receiptsShown: 0, chainShown: false, dedup: false, batchClosed: false, heartbeat: false, eventBuilt: false, relays: null, witnessNote: false, tsa: false, ots: 'none', compare: false, exported: false, auditDone: 0, salt: false, verdict: false, lab: false, status: {}, knows: {} };
}
function worldAt(i) {
  const w = freshWorld();
  for (let k = 0; k <= i; k++) if (STEPS[k].apply) STEPS[k].apply(w);
  return w;
}
