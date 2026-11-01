/** Panel de operación: lee los cuatro endpoints de solo lectura y los pinta. Sin dependencias. */
(function () {
  'use strict';
  var STR = {
    en: {
      kicker: 'Precintum · evidence agent', title: 'Operations panel', readonly: 'read-only', refresh: 'Refresh',
      witnessTitle: 'Witnesses · last published batch',
      witnessNote: "What each relay answered when the last batch was published. This is the operator's own telemetry: it is not third-party evidence. What counts as evidence is that the event is still there, which <code>witness check</code> asks.",
      alertsTitle: 'Alerts',
      alertsNote: 'An alert nobody reads protects nothing. A lost witness or a deletion request is a first-level event: it means someone must look.',
      batchesTitle: 'Recent batches', configTitle: 'Configuration in force',
      configNote: 'Shown so it can be audited, not edited. Changing configuration is the real attack surface, so it is changed in the deployment and never from a browser. Secrets are never sent here: of the private key, the deduplication key and the TSA password, only whether they are set.',
      fReadT: 'Read-only by design.',
      fRead: 'This panel serves only GET and HEAD requests and has no route that writes to the database. Exporting and closing batches are command-line operations. Operational key rotation is still planned.',
      fAuthT: 'No authentication.',
      fAuth: 'Whoever can open this port sees everything on this page. It binds to localhost by default; publishing it elsewhere requires putting a reverse proxy with authentication in front.',
      fMetricsT: 'Metrics.', fMetrics: 'The same data is exposed for Prometheus at <code>/metrics</code>, which many teams will prefer over a page.',
      updated: 'updated', loading: 'loading…', failed: 'Could not read the agent:',
      demoData: 'Demonstration data. This copy of the panel has no agent behind it: it exists so the design can be reviewed without running anything. The panel served by "precintum serve" reads the real agent, and shows a real error when it cannot.',
      tReceiptsHour: 'receipts, last hour', tReceipts: 'receipts in total', tBatches: 'batches closed',
      tBehind: 'windows to close', tNoTsa: 'batches unsealed', tOts: 'anchors pending', tOutbox: 'outbox pending', tAlerts: 'alerts',
      allGood: '<b>Everything in order.</b> Batches up to date, quorum met, anchors complete and no open alerts.',
      issues: '<b>Needs attention.</b>',
      iBehind: '{n} finished window(s) have no batch yet: run <code>precintum batch close</code>.',
      iOutbox: '{n} event(s) waiting in the outbox: run <code>precintum witness run</code>.',
      iQuorum: 'The last batch reached quorum on {n} of {m} relays.',
      iNoTsa: '{n} batch(es) have no RFC 3161 timestamp.',
      iOts: '{n} batch(es) have no finished Bitcoin anchor.',
      iAlerts: '{n} alert(s) recorded.',
      iNoBatch: 'No batch has been closed yet.',
      accepted: 'accepted', rejected: 'rejected', noData: 'no data',
      thSeq: 'batch', thWindow: 'window (UTC)', thCount: 'receipts', thRoot: 'root', thTsa: 'seal', thOts: 'anchor',
      sealed: 'sealed', unsealed: 'none', inBlock: 'in a block', pending: 'pending', notSent: 'not sent',
      noAlerts: 'No alerts. Nothing has gone wrong that the agent noticed.',
      noBatches: 'No batches yet.',
      agent: 'agent', head: 'chain head', lastBatch: 'last batch', root: 'root',
    },
    es: {
      kicker: 'Precintum · agente de evidencia', title: 'Panel de operación', readonly: 'solo lectura', refresh: 'Actualizar',
      witnessTitle: 'Testigos · último lote publicado',
      witnessNote: 'Qué contestó cada relay al publicar el último lote. Es telemetría del propio operador: no es evidencia para terceros. Lo que vale como evidencia es que el evento siga ahí, que es lo que pregunta <code>witness check</code>.',
      alertsTitle: 'Alertas',
      alertsNote: 'Una alerta que nadie lee no protege nada. Un testigo perdido o una petición de borrado son sucesos de primer nivel: significan que alguien tiene que mirar.',
      batchesTitle: 'Últimos lotes', configTitle: 'Configuración vigente',
      configNote: 'Se muestra para poder auditarla, no para editarla. Cambiar la configuración es la superficie de ataque real, así que se toca en el despliegue y nunca desde un navegador. Aquí no viajan secretos: de la clave privada, la de deduplicación y la contraseña de la TSA solo se dice si están puestas.',
      fReadT: 'De solo lectura por diseño.',
      fRead: 'Este panel solo sirve peticiones GET y HEAD y no tiene ninguna ruta que escriba en la base de datos. Exportar y cerrar lotes son operaciones de la línea de comandos. La rotación operativa de claves sigue pendiente.',
      fAuthT: 'Sin autenticación.',
      fAuth: 'Quien pueda abrir este puerto ve todo lo que hay en esta página. Escucha en localhost por defecto; publicarlo en otro sitio exige poner delante un proxy inverso con autenticación.',
      fMetricsT: 'Métricas.', fMetrics: 'Los mismos datos se exponen para Prometheus en <code>/metrics</code>, que es lo que muchos equipos preferirán antes que una página.',
      updated: 'actualizado', loading: 'cargando…', failed: 'No se ha podido leer el agente:',
      demoData: 'Datos de demostración. Esta copia del panel no tiene ningún agente detrás: existe para poder revisar el diseño sin arrancar nada. El panel que sirve "precintum serve" lee el agente de verdad, y muestra un error real cuando no puede.',
      tReceiptsHour: 'recibos, última hora', tReceipts: 'recibos en total', tBatches: 'lotes cerrados',
      tBehind: 'ventanas por cerrar', tNoTsa: 'lotes sin sellar', tOts: 'anclas pendientes', tOutbox: 'cola pendiente', tAlerts: 'alertas',
      allGood: '<b>Todo en orden.</b> Lotes al día, quórum cumplido, anclas completas y ninguna alerta abierta.',
      issues: '<b>Requiere atención.</b>',
      iBehind: '{n} ventana(s) terminadas siguen sin lote: ejecuta <code>precintum batch close</code>.',
      iOutbox: '{n} evento(s) esperando en la cola de salida: ejecuta <code>precintum witness run</code>.',
      iQuorum: 'El último lote alcanzó quórum en {n} de {m} relays.',
      iNoTsa: '{n} lote(s) sin sello RFC 3161.',
      iOts: '{n} lote(s) sin anclaje en Bitcoin terminado.',
      iAlerts: '{n} alerta(s) registradas.',
      iNoBatch: 'Todavía no se ha cerrado ningún lote.',
      accepted: 'aceptó', rejected: 'rechazó', noData: 'sin dato',
      thSeq: 'lote', thWindow: 'ventana (UTC)', thCount: 'recibos', thRoot: 'raíz', thTsa: 'sello', thOts: 'ancla',
      sealed: 'sellado', unsealed: 'sin sello', inBlock: 'en un bloque', pending: 'pendiente', notSent: 'sin enviar',
      noAlerts: 'Sin alertas. No ha ido mal nada de lo que el agente se haya enterado.',
      noBatches: 'Todavía no hay lotes.',
      agent: 'agente', head: 'cabeza de la cadena', lastBatch: 'último lote', root: 'raíz',
    },
  };
  var lang = 'en';
  function t(k, p) {
    var s = (STR[lang] && STR[lang][k]) || STR.en[k] || k;
    return p ? s.replace(/\{(\w+)\}/g, function (m, x) { return p[x] === undefined ? '?' : String(p[x]); }) : s;
  }
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }
  function ab(h) { return typeof h === 'string' && h.length > 16 ? h.slice(0, 10) + '…' + h.slice(-4) : String(h == null ? '—' : h); }
  function iso(sec) { return typeof sec === 'number' ? new Date(sec * 1000).toISOString().slice(0, 16).replace('T', ' ') : '—'; }
  function hm(sec) { return typeof sec === 'number' ? new Date(sec * 1000).toISOString().slice(11, 16) : '—'; }
  function day(sec) { return typeof sec === 'number' ? new Date(sec * 1000).toISOString().slice(0, 10) : '—'; }
  function pill(state, label) { return '<span class="pill ' + state + '">' + esc(label) + '</span>'; }

  var data = { health: null, batches: [], alerts: [], config: null };
  var demo = globalThis.PRECINTUM_PANEL_DEMO;

  function applyStatic() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) { el.innerHTML = t(el.getAttribute('data-i18n')); });
    document.querySelectorAll('.lang button').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-lang') === lang); });
    document.documentElement.lang = lang;
  }

  function tile(cls, n, label, sub) {
    return '<div class="tile ' + cls + '"><div class="l">' + esc(label) + '</div><div class="n">' + esc(n) +
      '</div><div class="s">' + (sub ? esc(sub) : '&nbsp;') + '</div></div>';
  }

  function renderTiles() {
    var h = data.health;
    if (!h) { $('#tiles').innerHTML = ''; return; }
    var q = h.relays.filter(function (r) { return r.accepted === true; }).length;
    $('#tiles').innerHTML = [
      tile('', h.receipts.lastHour, t('tReceiptsHour'), '#' + (h.receipts.headSeq == null ? '—' : h.receipts.headSeq) + ' · ' + hm(h.receipts.headTs)),
      tile('', h.receipts.total, t('tReceipts')),
      tile('', h.batches.total, t('tBatches'), h.batches.headWindow ? day(h.batches.headWindow[0]) + ' ' + hm(h.batches.headWindow[0]) + '–' + hm(h.batches.headWindow[1]) : ''),
      tile(h.batches.windowsBehind > 0 ? 'warnv' : '', h.batches.windowsBehind, t('tBehind')),
      tile(h.batches.withoutTsa > 0 ? 'warnv' : '', h.batches.withoutTsa, t('tNoTsa')),
      tile(h.batches.otsPending > 0 ? 'warnv' : '', h.batches.otsPending, t('tOts')),
      tile((h.outbox.pending || 0) > 0 ? 'warnv' : '', h.outbox.pending || 0, t('tOutbox')),
      tile(h.alerts.total > 0 ? 'alert' : '', h.alerts.total, t('tAlerts'), q + '/' + h.relays.length + ' relays'),
    ].join('');
  }

  function renderBanner() {
    var h = data.health;
    var el = $('#banner');
    if (!h) { el.innerHTML = ''; return; }
    var msgs = [];
    if (h.batches.headSeq === null) msgs.push(t('iNoBatch'));
    if (h.batches.windowsBehind > 0) msgs.push(t('iBehind', { n: h.batches.windowsBehind }));
    if ((h.outbox.pending || 0) > 0) msgs.push(t('iOutbox', { n: h.outbox.pending }));
    var accepted = h.relays.filter(function (r) { return r.accepted === true; }).length;
    if (h.batches.headSeq !== null && accepted < h.relays.length) {
      msgs.push(t('iQuorum', { n: accepted, m: h.relays.length }));
    }
    if (h.batches.withoutTsa > 0) msgs.push(t('iNoTsa', { n: h.batches.withoutTsa }));
    if (h.batches.otsPending > 0) msgs.push(t('iOts', { n: h.batches.otsPending }));
    if (h.alerts.total > 0) msgs.push(t('iAlerts', { n: h.alerts.total }));
    if (!msgs.length) { el.innerHTML = '<div class="banner ok">' + t('allGood') + '</div>'; return; }
    var cls = h.alerts.total > 0 || h.batches.windowsBehind > 2 ? 'bad' : 'warn';
    el.innerHTML = '<div class="banner ' + cls + '">' + t('issues') + '<ul><li>' + msgs.join('</li><li>') + '</li></ul></div>';
  }

  function renderRelays() {
    var h = data.health;
    if (!h) { $('#relays').innerHTML = ''; return; }
    $('#relays').innerHTML = h.relays.map(function (r) {
      var p = r.accepted === null ? pill('q', t('noData')) : pill(r.accepted ? 'y' : 'n', r.accepted ? t('accepted') : t('rejected'));
      var extra = r.code ? ' <span class="mono">' + esc(r.code) + '</span>' : '';
      return '<div class="row"><span class="u">' + esc(r.url) + '</span><span>' + p + extra + '</span></div>';
    }).join('') + (h.batches.headSeq === null ? '' :
      '<div class="row"><span class="u">' + esc(t('lastBatch')) + ' #' + h.batches.headSeq + '</span><span class="mono">' + esc(ab(h.batches.headRoot)) + '</span></div>');
  }

  function renderAlerts() {
    var el = $('#alerts');
    if (!data.alerts.length) { el.innerHTML = '<div class="empty">' + esc(t('noAlerts')) + '</div>'; return; }
    el.innerHTML = data.alerts.slice(0, 20).map(function (a) {
      var detail = '';
      try { detail = JSON.stringify(a.detail); } catch (err) { detail = ''; }
      return '<div class="row"><span><span class="pill n">' + esc(a.kind) + '</span> <span class="mono">' + esc(detail.slice(0, 90)) +
        '</span></span><span class="mono">' + esc(iso(a.at)) + '</span></div>';
    }).join('');
  }

  function renderBatches() {
    var tbl = $('#batches');
    if (!data.batches.length) { tbl.innerHTML = '<tbody><tr><td class="empty">' + esc(t('noBatches')) + '</td></tr></tbody>'; return; }
    var head = '<thead><tr>' + ['thSeq', 'thWindow', 'thCount', 'thRoot', 'thTsa', 'thOts']
      .map(function (k) { return '<th>' + esc(t(k)) + '</th>'; }).join('') + '</tr></thead>';
    tbl.innerHTML = head + '<tbody>' + data.batches.map(function (b) {
      var tsa = b.hasTsa ? pill('y', hm(b.tsaGenTime)) : pill('w', t('unsealed'));
      var ots = b.otsComplete ? pill('y', t('inBlock')) : pill('w', b.hasOts ? t('pending') : t('notSent'));
      return '<tr><td class="num">' + b.seq + '</td><td class="num">' + esc(day(b.window[0]) + ' ' + hm(b.window[0]) + '–' + hm(b.window[1])) +
        '</td><td class="num">' + b.count + '</td><td class="h">' + esc(ab(b.root)) + '</td><td>' + tsa + '</td><td>' + ots + '</td></tr>';
    }).join('') + '</tbody>';
  }

  function renderConfig() {
    var c = data.config;
    var h = data.health;
    var el = $('#config');
    if (!c) { el.innerHTML = ''; return; }
    var rows = [];
    if (h) rows.push([t('agent'), '<span class="mono">' + esc(h.agent.npub) + '</span>']);
    Object.keys(c).forEach(function (k) {
      var v = c[k];
      rows.push([k, '<span class="mono">' + esc(Array.isArray(v) ? v.join(', ') : String(v)) + '</span>']);
    });
    el.innerHTML = rows.map(function (r) {
      return '<span class="k">' + esc(r[0]) + '</span><span class="v">' + r[1] + '</span>';
    }).join('');
  }

  function renderAll() {
    applyStatic();
    if (demo) {
      $('#error').hidden = false;
      $('#error').textContent = t('demoData');
    }
    renderBanner(); renderTiles(); renderRelays(); renderAlerts(); renderBatches(); renderConfig();
  }

  function get(path) {
    return fetch(path, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error(path + ': HTTP ' + r.status);
      return r.json();
    });
  }

  function load() {
    // La demostración es autosuficiente; solo el panel operativo consulta la API del agente.
    if (demo) {
      data.health = demo.health; data.batches = demo.batches; data.alerts = demo.alerts; data.config = demo.config;
      $('#stamp').textContent = '';
      renderAll();
      return;
    }
    $('#stamp').textContent = t('loading');
    Promise.all([get('api/health'), get('api/batches'), get('api/alerts'), get('api/config')])
      .then(function (all) {
        data.health = all[0]; data.batches = all[1]; data.alerts = all[2]; data.config = all[3];
        $('#error').hidden = true;
        $('#stamp').textContent = t('updated') + ' ' + new Date().toTimeString().slice(0, 8);
        renderAll();
      })
      .catch(function (err) {
        $('#error').hidden = false;
        $('#error').textContent = t('failed') + ' ' + err.message;
        $('#stamp').textContent = '';
      });
  }

  $('#refresh').addEventListener('click', load);
  document.querySelectorAll('.lang button').forEach(function (b) {
    b.addEventListener('click', function () {
      lang = b.getAttribute('data-lang');
      try { localStorage.setItem('precintum-panel-lang', lang); } catch (err) { /* sin almacenamiento */ }
      renderAll();
    });
  });
  try {
    var saved = localStorage.getItem('precintum-panel-lang');
    if (saved === 'es' || saved === 'en') lang = saved;
  } catch (err) { /* sin almacenamiento */ }
  applyStatic();
  load();
  setInterval(load, 30_000);
})();
