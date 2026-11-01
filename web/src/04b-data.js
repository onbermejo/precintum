/* Guion: capítulos 4 a 7, y escenarios del laboratorio. */
STEPS.push(
  /* ---------- 4 · Lote y testigos ---------- */
  {
    ch: 4, title: 'A las 15:00 se cierra la ventana', when: '15:00:05',
    msg: { from: 'precintum', to: 'precintum', text: 'lote #207: 5 recibos → raíz' }, focus: ['precintum'],
    que: `<p>Cada hora, Precintum toma los recibos de la ventana (de 14:00 a 15:00 hubo <b>5</b>, el de Nora entre ellos) y calcula una <b>raíz Merkle</b>: una sola huella de 32 bytes que resume los cinco.</p>`,
    por: `<p>Publicar la raíz permite comprometerse públicamente con los cinco recibos <b>sin publicar los recibos</b>. Y más tarde se puede probar que uno concreto estaba dentro, con una prueba de unos pocos hashes.</p>`,
    no: `<p>Los recibos no salen de Umbral. Solo saldrá la raíz.</p>`,
    tech: `<p>Árbol RFC 6962 (prefijo 0x00 en hojas, 0x01 en nodos), ventanas fijas de <code>PRECINTUM_BATCH_WINDOW_SECONDS</code> (3600). Hoja = hash del recibo. La raíz de una ventana sin recibos es la del árbol vacío.</p>`,
    apply(w) { w.receiptsShown = 5; w.batchClosed = true; st(w, 'precintum', 'lote #207 cerrado', 'good'); },
  },
  {
    ch: 4, title: 'Sin recibos también hay lote: el latido', when: 'cada hora, siempre',
    msg: null, focus: ['precintum', 'relays'],
    que: `<p>Esa misma noche, entre las 03:00 y las 04:00, nadie entró en Umbral. Precintum publicó igualmente un lote: el <b>#196</b>, vacío.</p>`,
    por: `<p>Así el silencio se nota. Si un día falta una hora, o alguien apagó Precintum o alguien borró el lote: en ambos casos hay algo que explicar. Sin latidos, borrar una hora entera de actividad sería invisible.</p>`,
    no: `<p>No se inventan recibos para rellenar. Un lote vacío representa una ventana sin verificaciones registradas; no prueba que no ocurriera ninguna.</p>`,
    tech: `<p><i>Heartbeat</i>: lote con <code>EMPTY_ROOT</code> y recuento 0; el <code>seq</code> de los lotes es consecutivo, y la inspectora exige una raíz por cada hora del periodo.</p>`,
    apply(w) { w.heartbeat = true; },
  },
  {
    ch: 4, title: 'Precintum firma el evento de lote', when: '15:00:05',
    msg: { from: 'precintum', to: 'precintum', text: 'evento kind 7676 · firmado' }, focus: ['precintum'],
    que: `<p>Precintum construye un evento Nostr con la raíz, la ventana, el número de lote, el enlace al lote anterior, la política y un <b>compromiso del recuento</b>, y lo firma con su clave. A la derecha está el evento real, con su id calculado.</p>`,
    por: `<p>La firma dice "esto lo publicó el Precintum de Umbral"; el enlace al lote anterior encadena también los lotes; y el compromiso del recuento permite probar a la inspectora cuántos recibos hubo <b>sin publicar el volumen de negocio</b> en un relay público.</p>`,
    no: `<p>La clave privada no sale del servidor. El número exacto de recibos no se publica: solo su compromiso.</p>`,
    tech: `<p>Kind 7676 (evento regular). La raíz Merkle va en <code>content</code>; etiquetas <code>v</code>, <code>seq</code>, <code>prev</code>, <code>window</code>, <code>policy</code>, <code>count = sha256("precintum/count/v1" || 0x0a || "5:" || sal)</code>. <code>id = sha256([0, pubkey, created_at, kind, tags, content])</code> (NIP-01); firma Schnorr BIP-340. El formato del directorio de claves kind 37676 (<code>d=precintum/keys</code>) existe; su uso operativo para rotarlas sigue pendiente.</p>`,
    apply(w) { w.eventBuilt = true; st(w, 'precintum', 'evento 7676 firmado', 'good'); },
  },
  {
    ch: 4, title: 'Lo publica en tres relays', when: '15:00:06',
    msg: { from: 'precintum', to: 'relays', text: 'EVENT 7676 · raíz · 32 bytes' }, focus: ['precintum', 'relays'],
    que: `<p>Precintum envía el evento a tres relays de tres operadores distintos. Damus y nos.lol responden <b>OK</b>; Primal responde <code>rate-limited</code>. Ya se alcanzó el quórum de 2: el prototipo da el lote por publicado y no programa otro intento para Primal.</p>`,
    por: `<p>Un relay es un <b>testigo público e independiente</b>: cualquiera puede pedirle los lotes de Precintum y guardarlos. Tres testigos son más difíciles de callar que uno. Si no se alcanza el quórum, los fallos transitorios se reintentan con esperas crecientes.</p>`,
    no: `<p>Los relays no reciben recibos ni datos personales: 32 bytes de raíz y unas etiquetas.</p>`,
    tech: `<p>NIP-01: <code>["EVENT", …]</code> → <code>["OK", id, true|false, "motivo"]</code>. Quórum <code>PRECINTUM_WITNESS_QUORUM=2</code>; cola <i>outbox</i> con <i>backoff</i> exponencial y <i>jitter</i> (30 s → 1 h); prefijos estándar de rechazo (<code>rate-limited:</code>, <code>blocked:</code>, <code>invalid:</code>…). Además, archivo local <i>append-only</i> como tercer tipo de testigo.</p>`,
    apply(w) { w.relays = { damus: 'ok', nos: 'ok', primal: 'retry' }; st(w, 'relays', 'OK · OK · rate-limited', 'warn'); w.knows.relays = 'Nada: 32 bytes de raíz y unas etiquetas.'; },
  },
  {
    ch: 4, title: 'Una tercera copia, simulada', when: '15:00:36 · paso simulado',
    msg: { from: 'relays', to: 'precintum', text: 'OK · OK · OK' }, focus: ['relays', 'precintum'],
    que: `<p>En esta simulación añadimos una aceptación de Primal: el lote #207 queda en tres relays y en el archivo local. Este reintento posterior al quórum no lo realiza el worker actual del prototipo.</p>`,
    por: `<p>La cola de salida reintenta mientras falta quórum, con un límite de intentos. Al alcanzarlo, termina. Precintum anota qué relay aceptó y cuándo; ese registro es del operador. Lo que vale como evidencia es que el evento <b>esté</b> en los relays.</p>`,
    no: `<p>El OK de un relay no está firmado: no es una prueba por sí mismo. Por eso hacen falta las dos piezas siguientes.</p>`,
    tech: `<p>Tabla <code>witness_publications</code> (telemetría del operador). El id del evento es el mismo en los tres relays: es determinista a partir del contenido.</p>`,
    apply(w) { w.relays = { damus: 'ok', nos: 'ok', primal: 'ok' }; st(w, 'relays', 'OK ✓ ✓ ✓ · quórum 3/3', 'good'); },
  },
  {
    ch: 4, title: 'Los relays son testigos, no notarios', when: 'a partir de ahora',
    msg: null, focus: ['relays'],
    que: `<p>Cualquiera puede pedir a los relays los lotes de Precintum y guardarse una copia. Pero un relay puede borrar, cerrar o cambiar de política, y <b>no garantiza la hora</b>: la fecha del evento la pone quien lo publica.</p>`,
    por: `<p>Por eso hay tres, más el archivo local, y por eso Precintum vigila periódicamente que los eventos sigan ahí. Y por eso la fecha la certifican otros: la TSA y Bitcoin, en el siguiente capítulo.</p>`,
    no: `<p>Un relay no es un archivo inmutable ni un reloj. Precintum no le pide que lo sea.</p>`,
    tech: `<p><code>checkPresence</code>: comparar "aceptó" con "conserva" → alerta <code>witness_lost</code>. <code>detectDeletions</code>: un kind 5 firmado con la clave de Precintum se trata como ataque (<code>deletion_request</code>). Los relays con strfry admiten <code>created_at</code> hasta 3 años en el pasado.</p>`,
    apply(w) { w.witnessNote = true; st(w, 'relays', 'conservan el evento (por ahora)'); },
  },

  /* ---------- 5 · Anclaje ---------- */
  {
    ch: 5, title: 'Pide un sello de tiempo a la TSA', when: '15:00:07',
    msg: { from: 'precintum', to: 'tsa', text: 'sha256(evento) + nonce' }, focus: ['precintum', 'tsa'],
    que: `<p>Precintum envía el <b>hash del evento</b> (no el evento) a una Autoridad de Sellado de Tiempo, que devuelve un token firmado: "este hash existía a las 15:00:07".</p>`,
    por: `<p>Es el <b>testimonio de un tercero identificado</b>, al segundo. Si la TSA es un prestador cualificado, el sello tiene presunción legal de fecha e integridad en toda la UE. Es lo que un tribunal ya conoce.</p>`,
    no: `<p>La TSA no sabe qué hay detrás del hash. No recibe la raíz, ni los recibos, ni sabe quién es Umbral más allá de un cliente que pide sellos.</p>`,
    tech: `<p>RFC 3161: <code>TimeStampReq</code> (sha256, nonce, certReq) → <code>TimeStampResp</code> con <code>TSTInfo.genTime</code>. Regla de ventana de anclaje: el sello debe llegar antes de 24 h tras el cierre (<code>PRECINTUM_ANCHOR_MAX_GAP_SECONDS</code>). En desarrollo: freetsa.org (no cualificada; la CLI avisa). En producción: la TSA cualificada de un QTSP de la lista de confianza. Credenciales: <code>PRECINTUM_TSA_USER</code>/<code>PRECINTUM_TSA_PASSWORD</code>.</p>`,
    apply(w) { w.tsa = true; st(w, 'tsa', 'sello 15:00:07 ✓', 'good'); st(w, 'precintum', 'sello guardado', 'good'); w.knows.tsa = 'Nada: un hash de 32 bytes.'; },
  },
  {
    ch: 5, title: 'Y lo ancla en Bitcoin', when: '15:00:08',
    msg: { from: 'precintum', to: 'btc', text: 'sha256(evento) → calendario OTS' }, focus: ['precintum', 'btc'],
    que: `<p>Precintum envía el mismo hash a un calendario de OpenTimestamps. El calendario lo agrega con miles de hashes de otros y, horas después, mete el resumen en una transacción de Bitcoin.</p>`,
    por: `<p>Es una prueba <b>matemática</b> de "existía antes del bloque N" que no depende de que ninguna empresa siga existiendo en 2035. Complementa al sello de la TSA: no lo sustituye.</p>`,
    no: `<p>Ni la raíz ni nada de Umbral aparece legible en Bitcoin: solo un compromiso agregado. No hay coste por lote.</p>`,
    tech: `<p>OpenTimestamps: fichero <code>.ots</code> separado con la ruta de operaciones hasta la atestación; calendarios a/b.pool.opentimestamps.org; atestación <code>pending</code> hasta que el calendario ancla; luego <code>anchor upgrade</code> la completa. Implementado desde el formato binario, sin librería de terceros.</p>`,
    apply(w) { w.ots = 'pending'; st(w, 'btc', 'pendiente en el calendario', 'warn'); w.knows.btc = 'Nada: un compromiso agregado con miles de hashes ajenos.'; },
  },
  {
    ch: 5, title: 'Horas después: en un bloque', when: '17:41',
    msg: { from: 'btc', to: 'precintum', text: 'bloque 966.412 · atestación' }, focus: ['btc', 'precintum'],
    que: `<p>El calendario confirma: el compromiso quedó en una transacción del bloque 966.412. Precintum actualiza el fichero <code>.ots</code> del lote #207: ya se puede verificar contra la cadena de bloques.</p>`,
    por: `<p>Desde este momento, para negar que el lote existía el 3 de septiembre habría que reescribir Bitcoin. La fecha del lote ya no depende de la palabra de nadie.</p>`,
    no: `<p>La precisión es de horas ("antes del bloque N"), no de segundos: por eso la TSA sigue siendo necesaria para la hora exacta.</p>`,
    tech: `<p><code>anchor upgrade</code> consulta el calendario, incorpora la atestación Bitcoin y guarda el <code>.ots</code> completo (unos 500 bytes). <code>verifyBitcoin</code> recalcula la ruta hasta la raíz Merkle de la cabecera del bloque (en <i>little-endian</i>). Número de bloque de ejemplo.</p>`,
    apply(w) { w.ots = 'complete'; st(w, 'btc', 'bloque 966.412 (17:41) ✓', 'good'); },
  },
  {
    ch: 5, title: 'El notario y el periódico', when: 'resumen',
    msg: null, focus: ['tsa', 'btc'],
    que: `<div class="tablewrap"><table>
      <tr><th></th><th>Sello RFC 3161 (TSA)</th><th>Ancla en Bitcoin (OTS)</th></tr>
      <tr><td>Naturaleza</td><td>Testimonio firmado de un tercero identificado</td><td>Dependencia matemática: nadie declara nada</td></tr>
      <tr><td>Precisión</td><td>Al segundo</td><td>"Antes del bloque N", horas</td></tr>
      <tr><td>Presunción legal (eIDAS)</td><td>Sí, si la TSA es cualificada</td><td>Ninguna</td></tr>
      <tr><td>Sobrevive a…</td><td>Depende de la TSA y de sus certificados</td><td>A que cierre la TSA, caduque su certificado o sea cómplice</td></tr>
      <tr><td>Analogía</td><td>El notario</td><td>El periódico del día, imposible de reimprimir</td></tr>
      </table></div>`,
    por: `<p>Dos pruebas de tiempo de naturaleza distinta cubren las debilidades una de otra: la TSA da precisión y valor legal hoy; Bitcoin da supervivencia a largo plazo.</p>`,
    no: `<p>Ninguna de las dos revela datos, y ninguna de las dos sustituye a la otra.</p>`,
    tech: `<p>RFC 4998 (Evidence Record) exige un sello de TSA en cada <code>ArchiveTimeStamp</code>; el <code>.ots</code> va al lado como prueba independiente. Bitcoin no es la TSA de Precintum ni lo pretende.</p>`,
    apply(w) { w.compare = true; },
  },

  /* ---------- 6 · Auditoría ---------- */
  {
    ch: 6, title: 'Seis meses después llega la inspectora', when: 'marzo de 2027',
    msg: { from: 'aud', to: 'umbral', text: 'Demuestre que verificaba la edad en septiembre' }, focus: ['aud', 'umbral'],
    que: `<p>La inspectora pide a Umbral pruebas de que en septiembre verificaba la edad y de que su registro no se ha retocado. Umbral exporta el <b>paquete de evidencia</b>: recibos, cadena, lotes, pruebas de inclusión, tokens de la TSA y ficheros <code>.ots</code>.</p>`,
    por: `<p>La prueba tiene que poder examinarla alguien que <b>no se fía de Umbral</b> y no tiene acceso a sus servidores. Por eso todo lo necesario cabe en un paquete y se verifica con una herramienta independiente.</p>`,
    no: `<p>El paquete no contiene identificadores de persona, sesión, dispositivo ni transacción. La inspectora puede revisar su coherencia sin recibir esos identificadores, pero la hora y el resultado pueden correlacionarse con otros registros. Para Umbral, mientras conserve sus logs con hora, un recibo puede seguir siendo enlazable a una sesión; esa retención es decisión suya y va en su evaluación de impacto.</p>`,
    tech: `<p><code>precintum-verify</code> es la CLI independiente prevista, sin acceso a la base de datos del operador. El prototipo dispone de <code>web/verificador.html</code>. El contenedor ASiC-E, Evidence Record RFC 4998 y la validación CMS del sello con DSS siguen pendientes.</p>`,
    apply(w) { w.exported = true; st(w, 'aud', 'recibe el paquete'); st(w, 'umbral', 'exporta el paquete', 'good'); w.knows.aud = 'Recibe evidencia sin identificadores personales de Nora.'; },
  },
  {
    ch: 6, title: 'Pide un rango: "todo septiembre"', when: 'la petición normal',
    msg: { from: 'aud', to: 'umbral', text: 'del 1 al 30 de septiembre' }, focus: ['aud', 'umbral'],
    que: `<p>La inspectora no pide "la verificación de las 14:32": pide un mes. Y esa es la consulta natural del sistema, porque la unidad de todo es la ventana de una hora. Un rango de fechas es un rango de lotes: 720 en un mes de 30 días.</p>
      <p><b>El rango se redondea a horas completas.</b> Si pide de 14:20 a 15:40, se entregan las ventanas 14:00–15:00 y 15:00–16:00 enteras, y el comando dice el rango pedido y el entregado.</p>`,
    por: `<p>Por una razón que no es obvia: entregar media ventana significaría entregar menos recibos de los que dice su compromiso de recuento, y eso es <b>indistinguible de haber borrado recibos</b>. La inspectora vería un fallo donde no lo hay. Mejor entregar la hora completa y decirlo.</p>
      <p>Y aquí se paga un diseño hecho antes: la sal del compromiso de recuento es <b>por lote</b>. Revelar cuántas verificaciones hubo en las horas del rango no revela cuántas hubo en ninguna otra. Con una sal única, responder por un día habría destapado el volumen de todo el histórico.</p>`,
    no: `<p>No se puede filtrar por persona, porque no hay por dónde. Ni pedir "la de las 14:32:41": la hora de los recibos está truncada al minuto, a propósito.</p>
      <p>Y una distinción que la herramienta hace explícita: las horas anteriores al arranque del servicio no son huecos, y las posteriores al último lote cerrado tampoco. "No había registro" y "borré el registro" no son lo mismo.</p>`,
    tech: `<p><code>pnpm precintum export --desde 2026-09-01 --hasta 2026-10-01 --salida septiembre.json</code>. <code>ExportService.exportRange</code> alinea el rango con <code>alignRange</code>, consulta <code>BatchStore.inTimeRange</code> y entrega por lote: evento firmado, raíz, ventana, recuento con su sal, token de la TSA, <code>.ots</code>, recibos y pruebas de inclusión. <code>verifyPackage</code> pasa las comprobaciones y separa problemas (integridad o completitud rotas, salida con código 1) de avisos (lote sin sellar aún). Cuenta aparte <code>windowsBeforeService</code> y <code>windowsNotClosed</code>. El contenedor ASiC-E con Evidence Record RFC 4998 sigue previsto, sin implementar.</p>`,
    apply(w) { w.exported = true; w.rangeAsked = true; st(w, 'aud', 'pide septiembre completo'); st(w, 'umbral', 'exporta 720 lotes', 'good'); },
  },
  {
    ch: 6, title: 'Recalcula la cadena y el árbol', when: 'verificador · sin conexión',
    msg: { from: 'aud', to: 'aud', text: 'verificador: hashes ✓' }, focus: ['aud'],
    que: `<p>La herramienta recalcula todos los hashes: comprueba que los recibos están bien formados y sin datos personales, que cada uno enlaza con el anterior sin huecos, y que cada uno está incluido en la raíz de su lote.</p>`,
    por: `<p>Si alguien hubiera cambiado un solo carácter, una huella no cuadraría. No hace falta creer a nadie: es aritmética sobre el paquete.</p>`,
    no: `<p>Para esto no necesita a Umbral, ni a Precintum, ni internet.</p>`,
    tech: `<p><code>verifyChain(expectHead, expectLength)</code>: además de los enlaces, comprueba que la cabeza y la longitud son las esperadas (completitud). <code>verifyInclusion</code> según RFC 9162 §2.1.3.2.</p>`,
    apply(w) { w.auditDone = 3; st(w, 'aud', 'hashes ✓ cadena ✓ árbol ✓', 'good'); },
  },
  {
    ch: 6, title: 'Pregunta a los relays por su cuenta', when: 'consulta independiente prevista',
    msg: { from: 'aud', to: 'relays', text: 'REQ kinds 7676 · authors Precintum' }, focus: ['aud', 'relays'],
    que: `<p>En el recorrido previsto, descarga de dos relays los lotes firmados por Precintum entre septiembre y hoy, verifica sus firmas y los compara con el paquete: mismas raíces, mismos números, <b>una raíz por cada hora</b>, sin huecos. Esta consulta está simulada aquí y sigue pendiente en el verificador del prototipo.</p>`,
    por: `<p>Los relays son testigos que Umbral no controla. Si Umbral hubiera reescrito su historia después, los relays tendrían la versión original, y las dos versiones no podrían coexistir sin delatarse.</p>`,
    no: `<p>Los relays no le dan nada sobre Nora: no lo tienen.</p>`,
    tech: `<p><code>["REQ", sub, {"kinds":[7676], "authors":[pubkey de Precintum], "since": …}]</code>; verificación de la firma Schnorr; continuidad de <code>seq</code>/<code>prev</code>; latidos horarios; clave vigente según el directorio kind 37676.</p>`,
    apply(w) { w.auditDone = 4; st(w, 'aud', 'relays coinciden ✓', 'good'); st(w, 'relays', 'sirven los lotes a la inspectora', 'good'); },
  },
  {
    ch: 6, title: 'Verifica el sello y el ancla', when: 'validación externa · simulada aquí',
    msg: { from: 'aud', to: 'aud', text: 'DSS: sello ✓ · OTS: bloque ✓' }, focus: ['aud', 'tsa', 'btc'],
    que: `<p>En este caso simulado, la inspectora valida con herramientas externas la firma de la TSA y su cadena de certificados contra la lista de confianza europea, comprueba la ventana de anclaje de 24 horas y contrasta el <code>.ots</code> con el bloque 966.412. El verificador del prototipo no realiza la validación CMS ni consulta Bitcoin.</p>`,
    por: `<p>La fecha ya no depende de la palabra de Umbral: la afirma un tercero (la TSA) y la fija un bloque que nadie puede reescribir.</p>`,
    no: `<p>Tampoco hace falta confiar en Precintum ni en quien lo programó: el verificador es abierto y cualquiera puede reimplementarlo.</p>`,
    tech: `<p>DSS valida el token CMS y la cadena hasta la lista de confianza (LOTL/TSL). Para OTS basta la cabecera del bloque (de un nodo propio o de varios exploradores). Regla de ventana de anclaje: <code>gap ≤ 86400 s</code>.</p>`,
    apply(w) { w.auditDone = 6; st(w, 'aud', 'sello ✓ ancla ✓', 'good'); },
  },
  {
    ch: 6, title: 'El recuento', when: 'verificador independiente',
    msg: { from: 'umbral', to: 'aud', text: 'sal del compromiso de recuento' }, focus: ['umbral', 'aud'],
    que: `<p>Umbral entrega la <b>sal</b> del compromiso de recuento del lote #207. La inspectora comprueba que el compromiso publicado corresponde a "5 recibos": ni uno más, ni uno menos.</p>`,
    por: `<p>El volumen de verificaciones es dato de negocio: no se publica en un relay público, pero se puede probar cuando toca.</p>`,
    no: `<p>Quien lea el relay sigue sin saber cuántas verificaciones hace Umbral por hora.</p>`,
    tech: `<p><code>sha256("precintum/count/v1" || 0x0a || "5:" || sal) == tag count</code>. La sal se genera por lote y viaja solo en el paquete de evidencia.</p>`,
    apply(w) { w.auditDone = 7; w.salt = true; st(w, 'aud', 'recuento ✓', 'good'); },
  },
  {
    ch: 6, title: 'Veredicto', when: 'marzo de 2027',
    msg: null, focus: ['aud'],
    que: `<p>"La evidencia entregada es coherente en este caso simulado e incluye un resultado <i>mayor de 18</i> registrado a las 14:32. Autenticar sus anclas de tiempo requiere validación externa. Esto no prueba por sí solo que las verificaciones ocurrieran ni que se registraran todas."</p>`,
    por: `<p>Ese es exactamente el trabajo de Precintum: convertir "confíe en mí" en "compruébelo usted".</p>`,
    no: `<p>La inspectora no sabe quién es Nora. Y eso es lo que se buscaba: prueba sistémica sin registro de personas.</p>`,
    tech: `<p>Evidencia sobre lo registrado. Relacionarla con una persona concreta depende de los datos que Umbral conserve en sus propios sistemas, bajo su responsabilidad. Precintum no guarda una relación cuenta ↔ nonce en el recibo.</p>`,
    apply(w) { w.verdict = true; st(w, 'aud', 'evidencia registrada coherente', 'good'); },
  },

  /* ---------- 7 · Laboratorio ---------- */
  {
    ch: 7, title: 'Laboratorio de sabotajes', when: 'juega',
    msg: null, focus: ['umbral', 'precintum', 'relays', 'tsa', 'btc', 'aud'],
    que: `<p>Ya has visto el camino feliz. Ahora elige abajo un sabotaje: la página altera los datos, recalcula los hashes y vuelve a pasar la lista de comprobaciones de la inspectora.</p>`,
    por: `<p>Un sistema de evidencia se juzga por lo que detecta, no por lo que promete. Y también por lo que reconoce que <b>no</b> puede detectar.</p>`,
    no: `<p>Ningún sabotaje de la lista revela datos de Nora: no los hay.</p>`,
    tech: `<p>Los escenarios modifican la copia de los recibos o el estado de los testigos y ejecutan las mismas comprobaciones que el capítulo anterior.</p>`,
    apply(w) { w.lab = true; w.auditDone = 7; },
  },
);

const SCENARIOS = [
  {
    id: 'edit', title: 'Umbral edita el recibo #813',
    desc: 'Meses después cambia "under_18" por "over_18" en su base de datos.',
    alter: 'edit', flags: {}, verdict: 'good',
    det: `<p>La huella del #813 cambia. El #814 guardaba en <code>prev</code> la huella antigua: la cadena se rompe ahí. La raíz Merkle recalculada tampoco coincide con la que firmaron los relays, la TSA y Bitcoin el 3 de septiembre.</p>`,
    nodet: null,
    por: `<p>Un hash es una huella de todo el contenido: un carácter distinto, huella distinta. Y las copias externas fijan la huella original.</p>`,
    mit: `<p>Para ocultarlo, Umbral tendría que reescribir la cadena y republicar todos los lotes. Pero los relays ya tienen los originales con su hora, y el sello y el bloque son de septiembre. Aparecerían dos versiones: eso ya es la prueba.</p>`,
    verdictText: 'Detectado: registro alterado tras su publicación.',
  },
  {
    id: 'delAfter', title: 'Umbral borra el recibo #815 tras el lote',
    desc: 'Una verificación con resultado "error" desaparece de la base de datos.',
    alter: 'delAfter', flags: {}, verdict: 'good',
    det: `<p>Salto en la numeración (814 → 816) y el <code>prev</code> del #816 no coincide con la huella del #814. La raíz recalculada con cuatro hojas no es la publicada. Y el compromiso de recuento decía 5.</p>`,
    nodet: null,
    por: `<p>Cada recibo está contado tres veces: en la secuencia, en el árbol y en el recuento.</p>`,
    mit: `<p>Nada que mitigar: es el caso para el que está hecho el sistema.</p>`,
    verdictText: 'Detectado: falta un recibo que estaba en el lote publicado.',
  },
  {
    id: 'delBefore', title: 'Umbral "olvida" registrar una verificación',
    desc: 'El verifier procesa una presentación pero el resultado nunca llega a Precintum (o alguien apaga el adaptador).',
    alter: 'delBefore', flags: {}, verdict: 'bad',
    det: null,
    nodet: `<p>Todas las comprobaciones pasan. Precintum prueba que <b>lo registrado</b> no se ha tocado; no puede probar lo que nunca se registró. Es el límite de cualquier registro de evidencia, y conviene decirlo en voz alta.</p>`,
    por: `<p>Un recibo que no existe no deja hueco en la cadena: la cadena solo conoce lo que entró en ella.</p>`,
    mit: `<ul>
      <li>El adaptador registra <b>todo</b> resultado del verifier, incluidos errores y rechazos, de forma automática: no hay un humano decidiendo qué se anota.</li>
      <li>Los latidos hacen visible un apagado largo: un lote vacío a las 14:00 en una plataforma con tráfico llama la atención.</li>
      <li>La inspectora puede hacer verificaciones de prueba (<i>mystery shopping</i>) y buscarlas por hora y resultado.</li>
      <li>El recuento de Precintum se puede contrastar con los logs del verifier de Umbral, otra fuente.</li></ul>`,
    verdictText: 'No detectable por Precintum: límite conocido y documentado.',
  },
  {
    id: 'selective', title: 'Umbral registra solo los "sí"',
    desc: 'Anota las verificaciones que pasan y descarta en silencio las de menores.',
    alter: null, flags: { selective: true }, verdict: 'bad',
    det: null,
    nodet: `<p>Todas las comprobaciones pasan, y el veredicto es correcto: lo registrado está íntegro y completo. El registro es veraz, pero <b>de un subconjunto</b>. Esta es la pregunta más importante que se le puede hacer a Precintum, y la respuesta honesta es que no lo detecta.</p>`,
    por: `<p>Hay tres cosas distintas y Precintum solo prueba dos: <b>integridad</b> (nada de lo registrado se alteró) y <b>completitud</b> (no falta nada de lo registrado). La tercera, <b>cobertura</b> (se registró todo lo que ocurrió), no. Un recibo que nunca existió no deja hueco en la cadena, porque la cadena solo conoce lo que entró en ella. Es el mismo límite de cualquier registro: los libros de una empresa no prueban que no hubiera una venta en efectivo sin apuntar.</p>`,
    mit: `<ul>
      <li><b>Muestreo, con comprobante para la persona.</b> El control más barato y decisivo: el regulador se verifica a una hora conocida y luego exige el paquete de esa hora. Para señalar su recibo exacto, la propuesta es que Precintum devuelva la referencia del recibo a la plataforma y esta se la dé a la persona. Se le entrega, no se guarda: nadie construye un registro de personas y aun así cualquiera puede comprobar que su verificación se anotó.</li>
      <li><b>Registrar en el camino, no al lado.</b> Hoy Precintum es espectador, y por eso es inofensiva y desconectable. En el modo fuerte, el resultado no llega a la aplicación hasta que el recibo está escrito: descartar deja de ser un silencio y pasa a ser un cambio de despliegue, que deja rastro.</li>
      <li><b>Contrastar el recuento con otra fuente:</b> los propios registros del verificador, el tráfico de la plataforma, lo que vio el emisor. Dos contadores llevados por separado que no cuadran es la detección clásica.</li>
      <li><b>Estadística.</b> Una plataforma con cero rechazos de menores en un mes es implausible. Precintum hace auditable la forma de los datos, así que la omisión selectiva es visible estadísticamente aunque sea invisible criptográficamente.</li>
      <li><b>Y la capa legal:</b> si el operador declara bajo su responsabilidad que registra todas, una omisión detectada no es un hueco técnico, es una declaración falsa.</li>
      </ul>
      <p>La lección de Certificate Transparency: lo que le dio fuerza no fue el registro, fue que el navegador empezó a <b>exigir</b> la prueba. El día que un regulador exija el recibo, el incentivo cambia de lado.</p>`,
    verdictText: 'No detectable por Precintum. La promesa es "lo que vuestro sistema registró", nunca "verificamos a todos".',
  },
  {
    id: 'relay1', title: 'Un relay borra el evento',
    desc: 'Damus purga eventos antiguos, o cierra.',
    alter: null, flags: { relayLost: 1 }, verdict: 'good',
    det: `<p>El comprobador periódico de Precintum ve que Damus ya no devuelve el evento y anota la alerta <code>witness_lost</code>. La inspectora encuentra el lote en los otros dos relays y en el paquete.</p>`,
    nodet: null,
    por: `<p>Por eso son tres relays de tres operadores más el archivo local: un testigo puede fallar sin que falle la prueba.</p>`,
    mit: `<p>Si un relay falla de forma persistente, se sustituye en la configuración; los lotes anteriores siguen en los otros.</p>`,
    verdictText: 'Sin efecto sobre la prueba: quedan dos testigos y las dos anclas.',
  },
  {
    id: 'relay3', title: 'Los tres relays pierden el evento',
    desc: 'Todos purgan lo antiguo, o Nostr desaparece.',
    alter: null, flags: { relayLost: 3 }, verdict: 'mixed',
    det: `<p>Se pierde el <b>testigo público</b>: nadie ajeno a Umbral sirve ya el evento.</p>`,
    nodet: null,
    por: `<p>El evento firmado sigue en el paquete y en el archivo local, y el sello de la TSA y el ancla en Bitcoin siguen fijando <b>su id</b> en el 3 de septiembre a las 15:00. La integridad y la fecha siguen probadas; lo que se debilita es la publicidad independiente.</p>`,
    mit: `<p>Los eventos firmados ya se incluyen en el paquete exportado. Publicar también los anclajes (<code>.ots</code> y token) en los relays sigue pendiente; los terceros pueden conservar copias de los lotes públicos.</p>`,
    verdictText: 'La prueba se sostiene por TSA y Bitcoin; el testigo público se ha perdido.',
  },
  {
    id: 'tsa', title: 'La TSA cierra en 2031',
    desc: 'Su certificado caduca y ya nadie lo renueva.',
    alter: null, flags: { tsaGone: true }, verdict: 'mixed',
    det: `<p>El token sigue verificándose si se archivó la cadena de certificados (validación a largo plazo), pero sin re-sellado periódico su fuerza probatoria decae.</p>`,
    nodet: null,
    por: `<p>Bitcoin no cierra: la prueba de "antes del bloque 966.412" se verifica igual en 2035. Por eso están las dos.</p>`,
    mit: `<p>RFC 4998 prevé renovar el Evidence Record (re-sellar) antes de que caduque el certificado de la TSA. Esta renovación está prevista, sin implementar aún.</p>`,
    verdictText: 'La fecha sigue probada por Bitcoin; el sello pide renovación.',
  },
  {
    id: 'key', title: 'Roban la clave Nostr de Precintum',
    desc: 'Un atacante publica un lote #208 falso firmado con la clave de Precintum.',
    alter: null, flags: { keyStolen: true }, verdict: 'good',
    det: `<p>En este escenario simulado aparecen dos lotes con el mismo número, o un lote cuyo <code>prev</code> no encaja: una bifurcación. El sello y el ancla de cada versión delatan cuándo se creó cada una. El recorrido previsto incluye rotar la clave y publicar su revocación, con fecha, en el directorio de claves; esa gestión operativa sigue pendiente.</p>`,
    nodet: null,
    por: `<p>La clave firma, pero no manda: lo que cuenta es encajar en la cadena de lotes y en el tiempo.</p>`,
    mit: `<p>Custodiar la clave en un gestor de secretos y revisar las alertas del comprobador de presencia. La rotación periódica con el directorio kind 37676 es una mitigación prevista, todavía sin flujo operativo en el prototipo. El evento falso no tiene sello ni ancla de la fecha que pretende.</p>`,
    verdictText: 'Detectado: bifurcación de la cadena de lotes.',
  },
  {
    id: 'claim', title: 'Nora dice: "yo nunca me verifiqué"',
    desc: 'O un padre: "mi hijo entró en Umbral".',
    alter: null, flags: { claim: true }, verdict: 'mixed',
    det: `<p>Precintum permite comprobar que a esa hora se registró un resultado <i>mayor de 18</i> y que encaja con la evidencia entregada; no prueba por sí solo que la verificación ocurriera.</p>`,
    nodet: `<p>Precintum no puede decir nada sobre Nora en concreto: no tiene con qué buscarla. Es una consecuencia deliberada del diseño.</p>`,
    por: `<p>Un registro que pudiera responder "sí, fue Nora" sería un registro de personas, y ese es el problema que Precintum quiere evitar.</p>`,
    mit: `<p>Umbral responde con sus propios sistemas: sus logs de sesión. Y si decidió guardar en sus tablas la relación cuenta ↔ nonce del recibo (decisión suya, bajo su responsabilidad de protección de datos), puede señalar el recibo #814 y demostrar que está en el lote sellado.</p>`,
    verdictText: 'Prueba sistémica sí; prueba individual, solo con datos que guarde Umbral.',
  },
];
