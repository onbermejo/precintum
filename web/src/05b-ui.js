/* Interfaz: escenario, guion, panel "bajo el capó", laboratorio y controles. */
const ACTOR_X = { emisor: 85, nora: 238, umbral: 391, precintum: 544, relays: 697, tsa: 850, btc: 1003, aud: 1156 };
const $ = (s) => document.querySelector(s);
const state = { i: 0, scen: null, playing: false, timer: null };

/* ---------- escenario ---------- */
function jumpPacket(p, x) {
  p.style.transition = 'none';
  p.style.setProperty('--px', x + 'px');
  void p.getBoundingClientRect();
  p.style.transition = '';
}
function relayStates(w) {
  const base = Object.assign({ damus: 'idle', nos: 'idle', primal: 'idle' }, w.relays || {});
  const f = state.scen ? state.scen.flags : {};
  if (f.relayLost === 1) base.damus = 'lost';
  if (f.relayLost === 3) { base.damus = 'lost'; base.nos = 'lost'; base.primal = 'lost'; }
  return base;
}
function renderStage(w, step, animate) {
  const focus = new Set(step.focus);
  document.querySelectorAll('.actor').forEach((g) => {
    const on = focus.has(g.dataset.id);
    g.classList.toggle('dim', !on);
    g.classList.toggle('on', on);
    g.classList.remove('pulse');
    if (animate && on && step.msg && (step.msg.from === g.dataset.id || step.msg.to === g.dataset.id)) {
      void g.getBoundingClientRect();
      g.classList.add('pulse');
    }
  });
  $('#cred').classList.toggle('show', w.credential);
  const rl = relayStates(w);
  document.querySelectorAll('.dot').forEach((d) => d.setAttribute('class', 'dot ' + rl[d.dataset.relay]));
  const seal = $('#seal-g');
  seal.classList.remove('stamp');
  const block = $('#block-hot');
  block.classList.remove('lit');
  if (animate && step.msg && step.msg.to === 'tsa') { void seal.getBoundingClientRect(); seal.classList.add('stamp'); }
  if (animate && step.msg && step.msg.from === 'btc') { void block.getBoundingClientRect(); block.classList.add('lit'); }

  const p = $('#packet'), lane = $('#lane'), arrow = $('#lane-arrow');
  if (!step.msg) { p.classList.remove('show'); lane.classList.remove('show'); arrow.classList.remove('show'); return; }
  const from = ACTOR_X[step.msg.from], to = ACTOR_X[step.msg.to];
  const t = $('#packet-text'), r = $('#packet-rect');
  t.textContent = step.msg.text;
  let wdt = 140;
  try { wdt = Math.max(90, t.getComputedTextLength() + 30); } catch (e) { /* sin layout aún */ }
  r.setAttribute('x', -wdt / 2); r.setAttribute('width', wdt);
  p.classList.toggle('self', from === to);
  if (from === to) {
    lane.classList.remove('show'); arrow.classList.remove('show');
    jumpPacket(p, from); p.classList.add('show'); return;
  }
  const dir = to > from ? 1 : -1;
  lane.setAttribute('x1', from + dir * 30); lane.setAttribute('x2', to - dir * 40);
  arrow.setAttribute('transform', `translate(${to - dir * 44} 45) rotate(${dir > 0 ? 0 : 180})`);
  lane.classList.add('show'); arrow.classList.add('show');
  if (animate) {
    jumpPacket(p, from);
    p.classList.add('show');
    requestAnimationFrame(() => requestAnimationFrame(() => p.style.setProperty('--px', to + 'px')));
  } else { jumpPacket(p, to); p.classList.add('show'); }
}

/* ---------- reparto y privacidad ---------- */
function buildCast() {
  $('#cast').innerHTML = ACTORS.map((a) => `<div class="cell"><div class="name">${a.name}</div><div class="sub">${a.sub}</div><span class="st" data-st="${a.id}">—</span></div>`).join('');
}
function renderCast(w) {
  for (const a of ACTORS) {
    const el = document.querySelector(`.st[data-st="${a.id}"]`);
    const s = w.status[a.id];
    el.textContent = s ? s.text : '—';
    el.className = 'st' + (s && s.cls ? ' ' + s.cls : '');
  }
}
const PRIV_IDS = ['emisor', 'umbral', 'precintum', 'relays', 'tsa', 'btc', 'aud'];
function renderPriv(w) {
  $('#priv').innerHTML = PRIV_IDS.map((id) => {
    const a = ACTORS.find((x) => x.id === id);
    const k = w.knows[id];
    const text = k || (id === 'umbral' && w.verified ? '' : 'Todavía no interviene.');
    const none = /^Nada/.test(text);
    return `<div class="cell"><div class="who"><i style="--tint:${a.tint}"></i>${a.name}</div><div class="what${none ? ' none' : ''}">${text}</div></div>`;
  }).join('');
}

/* ---------- guion ---------- */
function renderScript(step) {
  $('#script').innerHTML = `<div class="where">Capítulo ${step.ch} · ${CHAPTERS[step.ch]} · ${step.when}</div><h2>${step.title}</h2>
    <div class="blk que"><div class="lbl">Qué pasa</div>${step.que}</div>
    <div class="blk por"><div class="lbl">Por qué pasa</div>${step.por}</div>
    <div class="blk no"><div class="lbl">Qué no pasa</div>${step.no}</div>
    <details class="tech" open><summary>Dato técnico</summary>${step.tech}</details>`;
}

/* ---------- bajo el capó ---------- */
function panelReceipt(list) {
  const x = list.find((y) => y.meta.nora);
  if (!x) return '';
  const r = x.r;
  const line = (k, v, c) => `  <span class="f">"${k}"</span>: <span class="v">${v}</span>,  <span class="c">${c}</span>`;
  return `<section class="panel"><div class="ttl">Recibo #${r.seq}: el de Nora</div><pre class="receipt">{
${line('v', '1', 'versión del esquema')}
${line('seq', r.seq, 'número de orden: detecta huecos')}
${line('prev', '"' + ab(r.prev) + '"', 'huella del #' + (r.seq - 1) + ': detecta cambios y reordenaciones')}
${line('nonce', '"' + ab(r.nonce) + '"', '32 bytes aleatorios: id único, sin nada de la sesión')}
${line('policy', '"' + ab(r.policy) + '"', 'sha256("age_over_18/v1"): qué regla se aplicó')}
${line('verifier', '"' + ab(r.verifier) + '"', 'sha256(id del despliegue): qué verifier lo comprobó')}
${line('result', '"' + r.result + '"', 'over_18 · under_18 · error')}
  <span class="f">"ts"</span>: <span class="v">${r.ts}</span>   <span class="c">${fmtT(r.ts)}, truncado al minuto</span>
}
<span class="c">hash = sha256("precintum/receipt/v1" ‖ 0x0a ‖ JSON canónico) =</span> ${hashSpan(x.h)}</pre>
<p class="note">Ocho campos, sin identificadores personales ni de sesión. Otros registros del operador pueden permitir correlacionar este recibo.</p></section>`;
}
function panelChain(list, scen) {
  const links = chainLinks(list);
  const rows = [];
  list.forEach((x, i) => {
    const l = links[i];
    if (scen && scen.alter === 'delAfter' && x.r.seq === 816) rows.push(`<li class="gone"><span class="seq">#815</span><span class="t">14:41</span><span class="res error">error</span><span>borrado</span><span class="lnk ko">falta</span></li>`);
    rows.push(`<li class="${x.meta.nora ? 'nora' : ''}${!l.ok ? ' broken' : ''}"><span class="seq">#${x.r.seq}</span><span class="t">${fmtT(x.r.ts)}</span><span class="res ${x.r.result}">${x.r.result}${x.edited ? ' ✎' : ''}</span>${hashSpan(x.h, !x.meta.nora)}<span class="lnk ${l.ok ? 'ok' : 'ko'}">${l.ok ? '⟵ prev ✓' : 'prev ✗'}</span></li>`);
  });
  return `<section class="panel"><div class="ttl">Cadena de recibos</div><ul class="chainlist"><li><span class="seq">#811</span><span class="t">13:58</span><span class="res">…</span>${hashSpan(HIDDEN_HEAD, true)}<span class="lnk ok">anterior a la ventana</span></li>${rows.join('')}</ul>
  <p class="note">Cada fila guarda en <code>prev</code> la huella de la anterior. La huella de cada recibo se recalcula a partir de sus campos: si algo cambió, el enlace siguiente falla.</p></section>`;
}
function panelDedup() {
  return `<section class="panel"><div class="ttl">Deduplicación</div><div class="kv"><span class="k">clave</span><span>HMAC(k, tx 9f2c…) = ${hashSpan(C.randHex(9, 32), true)}</span><span class="k">apunta a</span><span>recibo #814</span><span class="k">caduca</span><span>4 de septiembre, 14:33 (TTL 24 h)</span></div>
  <p class="note">El id de transacción del verifier nunca entra en el recibo: solo su HMAC, en una tabla aparte y temporal.</p></section>`;
}
function treeSvg(tree, list, published) {
  if (!tree.leaves || !tree.leaves.length) return '';
  const n = tree.leaves.length, leafY = 118, W = 62 * n + 24, H = 150;
  const depth = (node) => (node.leaf ? 0 : 1 + Math.max(depth(node.l), depth(node.r)));
  const D = Math.max(1, depth(tree));
  const nodes = [], edges = [];
  const noraIdx = list.findIndex((x) => x.meta.nora);
  const onPath = (node) => noraIdx >= 0 && node.i0 <= noraIdx && noraIdx <= node.i1;
  (function place(node) {
    if (node.leaf) { node.x = 43 + node.i0 * 62; node.y = leafY; } else {
      place(node.l); place(node.r);
      node.x = (node.l.x + node.r.x) / 2; node.y = leafY - (leafY - 22) * (depth(node) / D);
      edges.push([node, node.l], [node, node.r]);
    }
    nodes.push(node);
  })(tree);
  const bad = tree.h !== published;
  const es = edges.map(([a, b]) => `<line class="e${onPath(a) && onPath(b) ? ' path' : ''}" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"/>`).join('');
  const ns = nodes.map((nd) => {
    const isRoot = nd === tree;
    const cls = ['n', onPath(nd) ? 'path' : '', nd.leaf && nd.i0 === noraIdx ? 'leaf-nora' : '', isRoot ? 'root' : '', isRoot && bad ? 'bad' : ''].join(' ');
    const label = nd.leaf ? '#' + list[nd.i0].r.seq : nd.h.slice(0, 6) + '…';
    return `<rect class="${cls}" x="${nd.x - 25}" y="${nd.y - 10}" width="50" height="20" rx="4"/><text x="${nd.x}" y="${nd.y + 4}" text-anchor="middle">${label}</text>`;
  }).join('');
  return `<svg class="tree" viewBox="0 0 ${W} ${H}" role="img" aria-label="Árbol Merkle del lote">${es}${ns}<text x="${tree.x + 30}" y="${tree.y + 4}">raíz ${bad ? '≠ publicada' : '= publicada'}</text><text x="12" y="${H - 8}" style="fill:var(--ink-3)">hoja = sha256(0x00‖hash recibo) · nodo = sha256(0x01‖izq‖der)</text></svg>`;
}
function panelBatch(w, list, scen) {
  const batch = batchFor(w, scen, list);
  const recomputed = C.merkleTree(list.map((x) => x.h));
  return `<section class="panel"><div class="ttl">Lote #207 · ventana ${fmtT(WINDOW.start)}–${fmtT(WINDOW.end)}</div>
  <div class="kv"><span class="k">recibos</span><span>${list.length} en la ventana (el de Nora, #814, es la hoja 3)</span><span class="k">raíz publicada</span><span>${hashSpan(batch.root)}</span><span class="k">raíz recalculada</span><span>${hashSpan(recomputed.h, recomputed.h === batch.root)} ${recomputed.h === batch.root ? '✓' : '✗ no coincide'}</span></div>
  ${treeSvg(recomputed, list, batch.root)}
  ${w.heartbeat ? `<div class="kv"><span class="k">latido</span><span>lote #196 · 03:00–04:00 · 0 recibos · raíz del árbol vacío ${hashSpan(C.merkleTree([]).h, true)}</span></div>` : ''}
  <p class="note">Con la raíz y unos pocos hashes (la ruta marcada) se prueba que el #814 estaba en el lote, sin enseñar los otros cuatro.</p></section>`;
}
function panelEvent(w) {
  const b = BATCH;
  const tags = b.tags.map((t) => '  ' + JSON.stringify(t.map((v) => (v.length === 64 ? ab(v) : v)))).join('\n');
  return `<section class="panel"><div class="ttl">Evento de lote (kind 7676)</div><pre class="tags">kind: 7676   created_at: ${b.created} (${fmtT(b.created, true)})
pubkey: ${ab(PUBKEY)}   (la clave pública de Precintum en Umbral)
id: ${b.id}
tags:
${tags}
content: ${ab(b.root)}   (la raíz del lote)
sig: ${ab(SIG)}   (Schnorr BIP-340; simulada en esta página)</pre>
  <p class="note">El id es el sha256 de <code>[0, pubkey, created_at, 7676, tags, ""]</code>, calculado aquí. La etiqueta <code>count</code> es sha256("precintum/count/v1" ‖ 0x0a ‖ "5:" ‖ sal): compromete el recuento sin publicarlo.</p></section>`;
}
function panelWitness(w) {
  const rl = relayStates(w);
  const txt = { ok: 'OK ✓ conserva el evento', retry: 'rate-limited: · reintento en 30 s', lost: 'ya no devuelve el evento · alerta witness_lost', idle: '—' };
  const names = { damus: 'wss://relay.damus.io', nos: 'wss://nos.lol', primal: 'wss://relay.primal.net' };
  const oks = Object.values(rl).filter((s) => s === 'ok').length;
  return `<section class="panel"><div class="ttl">Testigos</div><div class="wit">${['damus', 'nos', 'primal'].map((k) => `<div class="row"><b>${names[k]}</b><span class="s ${rl[k]}">${txt[rl[k]]}</span></div>`).join('')}
  <div class="row"><b>archivo local append-only</b><span class="s ok">escrito ✓</span></div></div>
  <p class="note">Quórum: ${oks} de 3 (mínimo 2). El id del evento es idéntico en los tres: se deriva del contenido.</p></section>`;
}
function panelAnchors(w) {
  const f = state.scen ? state.scen.flags : {};
  const tsa = !w.tsa ? '' : f.tsaGone
    ? `<span class="k">sello TSA</span><span class="s warn" style="color:var(--warn)">certificado caducado en 2031: validación solo con cadena archivada (LTV)</span>`
    : `<span class="k">sello TSA</span><span>genTime ${fmtT(WINDOW.end + 7, true)} · 7 s tras el cierre (límite 24 h) ✓ · imprint = id del evento ✓ · TSA cualificada (simulada en la página)</span>`;
  const ots = w.ots === 'none' ? '' : w.ots === 'pending'
    ? `<span class="k">OpenTimestamps</span><span>enviado ${fmtT(WINDOW.end + 8, true)} a a.pool y b.pool · atestación pendiente en el calendario</span>`
    : `<span class="k">OpenTimestamps</span><span>bloque ${BLOCK} · 17:41 · .ots completo (unos 500 bytes) ✓</span>`;
  return `<section class="panel"><div class="ttl">Anclas de tiempo del lote #207</div><div class="kv">${tsa}${ots}</div>
  <p class="note">Lo que se ancla es el id del evento: ni la raíz ni los recibos salen hacia la TSA ni hacia Bitcoin.</p></section>`;
}
function panelAudit(w, scen) {
  const checks = computeChecks(w, scen);
  const icon = { ok: '✓', fail: '✗', warn: '!', todo: '·' };
  const li = checks.map((c) => `<li class="${c.status}"><span class="ic">${icon[c.status]}</span><span>${c.n}. ${c.text}${c.why ? `<span class="why">${c.why}</span>` : ''}</span></li>`).join('');
  let verdict = '';
  if (scen) verdict = `<div class="verdict ${scen.verdict}">${scen.verdictText}</div>`;
  else if (w.verdict) verdict = `<div class="verdict good">La evidencia registrada es coherente en este caso simulado. La firma y las anclas de tiempo están simuladas. El registro no contiene identificadores personales de Nora.</div>`;
  return `<section class="panel"><div class="ttl">Lista de comprobaciones de la inspectora</div><ul class="checks">${li}</ul>${verdict}</section>`;
}
function renderHood(w) {
  const scen = state.scen;
  const list = receiptsFor(w, scen);
  const panels = [];
  if (w.receiptsShown > 0) panels.push(panelReceipt(list));
  if (w.chainShown) panels.push(panelChain(list, scen));
  if (w.dedup && !w.batchClosed) panels.push(panelDedup());
  if (w.batchClosed) panels.push(panelBatch(w, list, scen));
  if (w.eventBuilt) panels.push(panelEvent(w));
  if (w.relays) panels.push(panelWitness(w));
  if (w.tsa || w.ots !== 'none') panels.push(panelAnchors(w));
  if (w.exported || w.lab) panels.push(panelAudit(w, scen));
  const body = panels.length ? panels.reverse().join('') : `<div class="empty">Precintum todavía no ha escrito nada. Cuando lo haga, aquí aparecerán el recibo, la cadena, el lote, los testigos, las anclas y las comprobaciones, con hashes reales calculados en tu navegador.</div>`;
  $('#hood').innerHTML = `<h3><i></i>Bajo el capó</h3>${body}`;
}

/* ---------- laboratorio ---------- */
function buildLab() {
  $('#scens').innerHTML = SCENARIOS.map((s) => `<button class="scen" data-id="${s.id}"><b>${s.title}</b><span>${s.desc}</span></button>`).join('') + `<button class="scen reset" data-id=""><b>Restablecer</b><span>Volver al registro honesto.</span></button>`;
  $('#scens').addEventListener('click', (e) => {
    const b = e.target.closest('.scen');
    if (!b) return;
    state.scen = SCENARIOS.find((s) => s.id === b.dataset.id) || null;
    renderAll(false);
  });
}
function renderLab(step) {
  const lab = $('#lab');
  lab.hidden = step.ch !== 7;
  if (lab.hidden) return;
  document.querySelectorAll('.scen').forEach((b) => b.classList.toggle('active', (state.scen ? state.scen.id : '') === b.dataset.id));
  const s = state.scen;
  if (!s) { $('#lab-result').innerHTML = `<p class="intro">Sin sabotaje: todas las comprobaciones pasan. Elige uno arriba.</p>`; return; }
  const box = (cls, lbl, html) => (html ? `<div class="box ${cls}"><div class="lbl">${lbl}</div>${html}</div>` : '');
  $('#lab-result').innerHTML = `<div class="result">${box('det', 'Qué se detecta', s.det)}${box('nodet', 'Qué no se detecta', s.nodet)}${box('por', 'Por qué', s.por)}${box('mit', 'Qué lo mitiga', s.mit)}</div>`;
}

/* ---------- capítulos y controles ---------- */
const firstOf = (ch) => STEPS.findIndex((s) => s.ch === ch);
function buildChapters() {
  $('#chapters').innerHTML = CHAPTERS.map((c, i) => `<button data-ch="${i}" role="tab"><span class="n">${i}</span>${c}</button>`).join('');
  $('#chapters').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) go(firstOf(Number(b.dataset.ch))); });
}
function renderChapters(step) {
  document.querySelectorAll('#chapters button').forEach((b) => {
    const ch = Number(b.dataset.ch);
    b.classList.toggle('active', ch === step.ch);
    b.classList.toggle('done', ch < step.ch);
    b.setAttribute('aria-selected', ch === step.ch ? 'true' : 'false');
  });
}
function renderControls() {
  $('#btn-prev').disabled = state.i === 0;
  $('#btn-next').disabled = state.i === STEPS.length - 1;
  $('#bar').style.width = ((state.i + 1) / STEPS.length) * 100 + '%';
  $('#counter').textContent = `paso ${state.i + 1} de ${STEPS.length}`;
  $('#btn-play').textContent = state.playing ? '⏸ Pausa' : '▶ Reproducir';
}
function renderAll(animate) {
  const step = STEPS[state.i];
  const w = worldAt(state.i);
  renderChapters(step); renderStage(w, step, animate); renderCast(w); renderPriv(w);
  renderScript(step); renderHood(w); renderLab(step); renderControls();
}
function go(i, animate = true) {
  i = Math.max(0, Math.min(STEPS.length - 1, i));
  state.i = i;
  if (STEPS[i].ch !== 7) state.scen = null;
  renderAll(animate);
  try { localStorage.setItem('nora-umbral-step', String(i)); } catch (e) { /* sin almacenamiento */ }
  if (state.playing && i === STEPS.length - 1) stopPlay();
}
function stopPlay() { state.playing = false; if (state.timer) clearInterval(state.timer); state.timer = null; renderControls(); }
function togglePlay() {
  if (state.playing) return stopPlay();
  state.playing = true;
  state.timer = setInterval(() => go(state.i + 1), 4800);
  renderControls();
}

function init() {
  buildChapters(); buildCast(); buildLab();
  $('#btn-prev').addEventListener('click', () => { stopPlay(); go(state.i - 1); });
  $('#btn-next').addEventListener('click', () => { stopPlay(); go(state.i + 1); });
  $('#btn-play').addEventListener('click', togglePlay);
  $('#tech-toggle').addEventListener('change', (e) => {
    document.body.classList.toggle('notech', !e.target.checked);
    try { localStorage.setItem('nora-umbral-tech', e.target.checked ? '1' : '0'); } catch (err) { /* nada */ }
  });
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('input,textarea,button,summary')) return;
    if (e.key === 'ArrowRight') { stopPlay(); go(state.i + 1); }
    else if (e.key === 'ArrowLeft') { stopPlay(); go(state.i - 1); }
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  });
  let saved = 0, tech = '1';
  try { saved = Number(localStorage.getItem('nora-umbral-step')) || 0; tech = localStorage.getItem('nora-umbral-tech') || '1'; } catch (e) { /* nada */ }
  if (tech === '0') { $('#tech-toggle').checked = false; document.body.classList.add('notech'); }
  go(saved, false);
}
init();
