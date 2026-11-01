/* Personajes, capítulos y guion (capítulos 0 a 3). */
const ACTORS = [
  { id: 'emisor', name: 'Emisor', sub: 'emisor ficticio de atributos', tint: 'var(--c-emisor)' },
  { id: 'nora', name: 'Nora', sub: '24 años · cartera EUDI en el móvil', tint: 'var(--c-nora)' },
  { id: 'umbral', name: 'Umbral', sub: 'plataforma solo +18 · su verifier', tint: 'var(--c-umbral)' },
  { id: 'precintum', name: 'Precintum', sub: 'agente de evidencia (en casa de Umbral)', tint: 'var(--c-precintum)' },
  { id: 'relays', name: 'Relays', sub: 'Damus · nos.lol · Primal (testigos Nostr)', tint: 'var(--c-relays)' },
  { id: 'tsa', name: 'TSA', sub: 'sellado de tiempo RFC 3161 (QTSP)', tint: 'var(--c-tsa)' },
  { id: 'btc', name: 'Bitcoin', sub: 'ancla vía OpenTimestamps', tint: 'var(--c-btc)' },
  { id: 'aud', name: 'Inspectora', sub: 'regulador · verificador independiente', tint: 'var(--c-aud)' },
];

const CHAPTERS = [
  'Quién es quién',
  'Antes: la credencial',
  'La verificación · 14:32',
  'El recibo',
  'Lote y testigos · 15:00',
  'Anclaje en el tiempo',
  'La auditoría · marzo 2027',
  '¿Y si…?',
];

const st = (w, id, text, cls) => { w.status[id] = { text, cls: cls || 'on' }; };

const STEPS = [
  /* ---------- 0 · Quién es quién ---------- */
  {
    ch: 0, title: 'Los personajes', when: 'antes de empezar',
    msg: null, focus: ['emisor', 'nora', 'umbral', 'precintum', 'relays', 'tsa', 'btc', 'aud'],
    que: `<ul>
      <li><b>Nora</b>, 24 años, tiene la cartera de identidad europea en el móvil.</li>
      <li><b>El emisor</b>, ficticio en este caso, le dio una atestación que dice solo "mayor de 18".</li>
      <li><b>Umbral</b> es una plataforma solo para mayores de edad. Tiene un <i>verifier</i>: el software que valida lo que la cartera presenta.</li>
      <li><b>Precintum</b> es un programa que corre dentro de la infraestructura de Umbral y conserva evidencia de las verificaciones registradas, sin identificadores personales.</li>
      <li><b>Los relays</b> son tres servidores públicos de la red Nostr, de tres operadores distintos: testigos de lo que Precintum publica.</li>
      <li><b>La TSA</b> es una autoridad de sellado de tiempo; <b>Bitcoin</b>, un ancla temporal que no depende de nadie.</li>
      <li><b>La inspectora</b> aparece seis meses después y no se fía de Umbral.</li></ul>`,
    por: `<p>Precintum solo tiene sentido viendo quién confía en quién. La cartera es de Nora; el verifier es de Umbral; Precintum también vive en casa de Umbral. Por eso Precintum deja huellas <b>fuera</b> (relays, TSA, Bitcoin): para que la inspectora pueda comprobar sin fiarse del propio Umbral.</p>`,
    no: `<p>Los terceros reciben compromisos y pruebas, sin identificadores personales de Nora. Otros registros que conserve Umbral pueden permitir correlacionar un recibo con una sesión.</p>`,
    tech: `<p>Vocabulario: <code>relying party</code> = Umbral; <code>verifier</code> = <code>eudi-srv-verifier-endpoint</code> (referencia de la Comisión) o <code>av-srv-verifier-endpoint</code> (blueprint de verificación de edad); <code>Evidence Agent</code> = Precintum; testigos = relays Nostr; TSA = RFC 3161; ancla = OpenTimestamps.</p>`,
    apply(w) { for (const a of ACTORS) st(w, a.id, 'en escena', ''); },
  },

  /* ---------- 1 · Antes: la credencial ---------- */
  {
    ch: 1, title: 'Nora activa su cartera', when: 'semanas antes',
    msg: { from: 'nora', to: 'nora', text: 'Cartera Digital lista' }, focus: ['nora'],
    que: `<p>En este escenario, Nora activa su cartera acreditando su identidad ante el emisor. A partir de ahí, la cartera guarda sus credenciales en su móvil.</p>`,
    por: `<p>La cartera es el lugar donde vivirán sus credenciales, bajo su control. Nadie más las guarda por ella: ni Umbral, ni Precintum, ni el Estado en una base central de "quién entró dónde".</p>`,
    no: `<p>Umbral y Precintum no existen todavía en esta historia. No saben nada de Nora.</p>`,
    tech: `<p>EUDI Wallet y su marco de arquitectura (ARF). La activación y la custodia de las claves dependen de la implementación de la cartera. La cartera de este caso es simulada y no forma parte del prototipo de Precintum.</p>`,
    apply(w) { st(w, 'nora', 'cartera activada'); },
  },
  {
    ch: 1, title: 'El emisor le da una atestación de edad', when: 'semanas antes',
    msg: { from: 'emisor', to: 'nora', text: 'age_over_18 = true · firmado' }, focus: ['emisor', 'nora'],
    que: `<p>El emisor comprueba la identidad de Nora una vez y firma una atestación que dice solo <b>"mayor de 18"</b>, ligada al móvil de Nora. La cartera la guarda.</p>`,
    por: `<p>Así Nora podrá demostrar que es mayor sin enseñar el DNI cada vez. Lo que hace creíble la atestación es la <b>firma del emisor</b>, que cualquier verifier puede comprobar contra la lista de confianza.</p>`,
    no: `<p>La fecha de nacimiento no viaja en esta atestación. Y el emisor no sabrá dónde la usa Nora después.</p>`,
    tech: `<p>Atestación electrónica de atributos, (Q)EAA; en el blueprint AV, la "proof of age attestation". Formatos: mdoc (ISO/IEC 18013-5) o SD-JWT VC. El emisor de este caso es ficticio: no representa una integración con un proveedor real. La vinculación al dispositivo (<i>holder binding</i>) impide copiarla a otro móvil.</p>`,
    apply(w) { w.credential = true; st(w, 'nora', 'tiene: mayor de 18 ✓', 'good'); st(w, 'emisor', 'atestación emitida', 'good'); w.knows.emisor = 'Su identidad, una vez, al emitir. No sabe dónde usará la atestación.'; },
  },

  /* ---------- 2 · La verificación ---------- */
  {
    ch: 2, title: 'Nora quiere entrar en Umbral', when: 'jueves 3 de septiembre de 2026 · 14:32',
    msg: { from: 'nora', to: 'umbral', text: 'Quiero entrar' }, focus: ['nora', 'umbral'],
    que: `<p>Nora abre Umbral. En este escenario, la plataforma restringe el acceso a mayores de edad y pide comprobarlo antes de dejarla pasar.</p>`,
    por: `<p>Umbral necesita aplicar su control de acceso y poder revisar después <b>qué resultados registró su verifier y si ese registro se alteró</b>. Esa evidencia de lo registrado es el trabajo de Precintum.</p>`,
    no: `<p>Umbral todavía no sabe nada de Nora, ni siquiera su edad. Solo hay una sesión anónima llamando a la puerta.</p>`,
    tech: `<p>Umbral es la <i>relying party</i>. Su verifier crea una transacción con un <code>transaction_id</code> propio y un <code>nonce</code> anti-repetición.</p>`,
    apply(w) { st(w, 'umbral', '¿mayor de edad?'); st(w, 'nora', 'llama a la puerta'); },
  },
  {
    ch: 2, title: 'Umbral pide solo una cosa', when: '14:32',
    msg: { from: 'umbral', to: 'nora', text: '¿age_over_18? Nada más' }, focus: ['umbral', 'nora'],
    que: `<p>El verifier de Umbral genera una petición de presentación: "necesito el atributo <b>mayor de 18</b> y nada más", y se la envía a la cartera (un enlace en el mismo móvil o un QR).</p>`,
    por: `<p>Pedir el mínimo es una obligación (minimización de datos) y también una ventaja para Umbral: menos datos, menos riesgo, menos que custodiar.</p>`,
    no: `<p>No se pide nombre, DNI, ni fecha de nacimiento. La petición no podría pedirlos sin que la cartera se lo mostrara a Nora.</p>`,
    tech: `<p>OpenID for Verifiable Presentations (OpenID4VP) con la consulta del atributo (DCQL / presentation definition). Flujo <code>same-device</code> (deep link) o <code>cross-device</code> (QR). El verifier expone la petición por referencia (<code>request_uri</code>).</p>`,
    apply(w) { st(w, 'umbral', 'petición enviada · tx 9f2c…'); },
  },
  {
    ch: 2, title: 'La cartera pide permiso a Nora', when: '14:32',
    msg: { from: 'nora', to: 'nora', text: 'Umbral pide: mayor de 18. ¿Compartir?' }, focus: ['nora'],
    que: `<p>La cartera muestra a Nora quién pide qué: "Umbral quiere saber si eres mayor de 18". Nora acepta con su huella o su PIN.</p>`,
    por: `<p>El consentimiento y la <b>divulgación selectiva</b> son el corazón de la identidad europea: Nora decide, atributo a atributo. Sin su gesto, nada sale del móvil.</p>`,
    no: `<p>La cartera no envía nada hasta que Nora acepta. Puede negarse, y entonces simplemente no entra.</p>`,
    tech: `<p>Con SD-JWT solo se revela el <i>claim</i> <code>age_over_18</code>; con mdoc, solo ese elemento de datos. La cartera comprueba además la identidad del verifier (certificado de relying party registrado) antes de mostrar la petición.</p>`,
    apply(w) { st(w, 'nora', 'decide… acepta'); },
  },
  {
    ch: 2, title: 'La cartera responde: mayor de 18', when: '14:32',
    msg: { from: 'nora', to: 'umbral', text: 'mayor de 18 · firma del emisor · ligado al móvil' }, focus: ['nora', 'umbral'],
    que: `<p>La cartera envía a Umbral la atestación mínima, firmada por el emisor, más la prueba de que este móvil es el titular legítimo.</p>`,
    por: `<p>Para que Umbral pueda comprobar dos cosas: que la atestación es <b>auténtica</b> (la firmó un emisor de confianza) y que <b>no es una copia</b> (la presenta el dispositivo al que está ligada).</p>`,
    no: `<p>No viaja el nombre ni la fecha de nacimiento. Umbral no puede deducir la edad exacta de Nora: solo que supera los 18.</p>`,
    tech: `<p><code>vp_token</code> enviado a <code>POST /wallet/direct_post</code> del verifier. La respuesta incluye la firma del emisor (verificable contra la lista de confianza), la prueba de posesión de la clave del dispositivo y el <code>nonce</code> del verifier (anti-repetición).</p>`,
    apply(w) { w.presented = true; st(w, 'nora', 'compartido: solo eso', 'good'); st(w, 'umbral', 'validando…'); },
  },
  {
    ch: 2, title: 'Umbral verifica y abre la puerta', when: '14:32:41',
    msg: { from: 'umbral', to: 'nora', text: 'Adelante' }, focus: ['umbral', 'nora'],
    que: `<p>El verifier valida la firma del emisor, la vinculación al dispositivo y la vigencia de la atestación. Resultado: <b>over_18</b>. Umbral deja entrar a Nora.</p>`,
    por: `<p>Solo con esas tres comprobaciones el "sí" es fiable: firma (quién lo dice), vinculación (quién lo presenta) y vigencia (que sigue valiendo).</p>`,
    no: `<p>Nora no ha creado una cuenta con su identidad. Umbral sabe que <i>esta sesión</i> es de alguien mayor de edad, y nada más de la atestación.</p>`,
    tech: `<p>El verifier publica el estado por transacción: <code>GET /ui/presentations/{transactionId}</code> devuelve la presentación validada y los <i>claims</i> revelados. Comprobación de revocación/estado según el formato (status list).</p>`,
    apply(w) { w.verified = true; st(w, 'umbral', 'resultado: over_18 ✓', 'good'); st(w, 'nora', 'dentro ✓', 'good'); w.knows.umbral = 'Que esta sesión es de alguien mayor de 18, más lo que su propio sistema guarde (cuenta, IP). No su nombre ni su fecha de nacimiento.'; },
  },

  /* ---------- 3 · El recibo ---------- */
  {
    ch: 3, title: 'El adaptador comunica el resultado a Precintum', when: '14:32:45',
    msg: { from: 'umbral', to: 'precintum', text: 'tx 9f2c… · over_18 · 14:32:41' }, focus: ['umbral', 'precintum'],
    que: `<p>En la integración prevista, un adaptador externo consulta al verifier las verificaciones terminadas y envía al agente de Precintum el mensaje de ingesta con la transacción, el resultado y la hora.</p>`,
    por: `<p>Precintum <b>lee</b> del verifier; no toca la cartera ni el protocolo europeo. Es un espectador: así no puede romper la verificación ni frenarla, y se puede añadir a cualquier verifier existente.</p>`,
    no: `<p>Precintum no recibe la presentación ni la atestación de Nora. Solo el resultado.</p>`,
    tech: `<p>Adaptador de <i>polling</i> previsto: consulta el verifier, espera la confirmación y envía a <code>POST /receipts</code> el contrato <code>{transactionId, result, policy, verifier, at?}</code>. La ingesta rechaza los campos ajenos al contrato; el adaptador no debe enviar presentaciones ni atributos personales.</p>`,
    apply(w) { st(w, 'precintum', 'leyendo el verifier'); w.knows.precintum = 'Un resultado (over_18) y una hora. El id de transacción se usa un instante y no se guarda en el recibo.'; },
  },
  {
    ch: 3, title: 'Precintum escribe un recibo sin nombres', when: '14:32:45',
    msg: { from: 'precintum', to: 'precintum', text: 'recibo #814' }, focus: ['precintum'],
    que: `<p>Precintum escribe un recibo de <b>8 campos</b>: versión, número de orden, enlace al anterior, un número aleatorio, la política aplicada, el verifier que lo comprobó, el resultado y la hora redondeada al minuto. Mira el panel de la derecha: es el recibo real.</p>`,
    por: `<p>Cada campo tiene un trabajo y el recibo <b>no contiene identificadores personales de Nora</b>. El número aleatorio da al recibo un identificador único sin derivarlo de la sesión. La hora se redondea al minuto para reducir su precisión; aun así puede correlacionarse con otros registros del operador.</p>`,
    no: `<p>No hay id de transacción, IP, cuenta, fecha de nacimiento ni atributos de la atestación en el recibo. Esto reduce los datos conservados, pero no elimina el riesgo de correlación con otros registros de Umbral.</p>`,
    tech: `<p>Esquema v1 (ADR-0001), validado con zod estricto: <code>{v, seq, prev, nonce, policy, verifier, result, ts}</code>. <code>nonce</code> = 32 bytes aleatorios; <code>ts</code> truncado al minuto; <code>result ∈ {over_18, under_18, error}</code>; <code>policy</code> y <code>verifier</code> son hashes.</p>`,
    apply(w) { w.receiptsShown = 3; st(w, 'precintum', 'recibo #814 escrito', 'good'); },
  },
  {
    ch: 3, title: 'El recibo se encadena al anterior', when: '14:32:45',
    msg: null, focus: ['precintum'],
    que: `<p>El recibo lleva la huella (hash) del recibo anterior, y su propia huella será el <code>prev</code> del siguiente. Cada recibo queda soldado al anterior.</p>`,
    por: `<p>Una huella resume todo el contenido: si alguien cambia un carácter de un recibo, su huella cambia, y el siguiente ya no encaja. <b>No se puede cambiar, quitar ni insertar</b> un recibo sin que la cadena se rompa.</p>`,
    no: `<p>Nada ha salido todavía de Umbral. Precintum acumula recibos en su base de datos local.</p>`,
    tech: `<p><code>hash = sha256("precintum/receipt/v1" || 0x0a || JSON canónico)</code>; el primero enlaza con un génesis fijo (<code>precintum/genesis/v1</code>). La separación de dominios evita que un hash calculado para otro fin "cuele" como recibo.</p>`,
    apply(w) { w.chainShown = true; },
  },
  {
    ch: 3, title: '¿Esto es Nostr? ¿Es una blockchain?', when: 'la pregunta obligada',
    msg: null, focus: ['precintum'],
    que: `<p><b>Nostr no encadena nada.</b> En Nostr cada evento es una isla: va firmado y tiene un identificador, pero no apunta al anterior. El <code>prev</code> de los recibos, y el que enlaza unos lotes con otros, son invención de Precintum. Nostr aparece dos capítulos más adelante, como tablón donde publicar el resumen.</p>
      <p><b>De cadena de bloques tiene la mitad.</b> Encadenar por huellas es más antiguo que Bitcoin: viene del sellado de tiempo digital de Haber y Stornetta, 1991, que el propio artículo de Bitcoin cita. Git hace lo mismo con los commits.</p>
      <div class="tablewrap"><table>
        <tr><th>Ingrediente de una cadena de bloques</th><th>Qué aporta</th><th>¿Lo tiene Precintum?</th></tr>
        <tr><td>Encadenado por huellas</td><td>Nadie toca, quita ni inserta algo <b>en medio</b> sin romper los enlaces</td><td>Sí, idéntico</td></tr>
        <tr><td>Consenso distribuido (prueba de trabajo, miles de nodos)</td><td>Nadie <b>reescribe la cadena entera</b> y la hace pasar por la buena</td><td>No</td></tr>
      </table></div>`,
    por: `<p>Ese "no" es el motivo de todo lo que viene después. La cadena de Precintum la escribe una sola parte: el propio Umbral. Podría tirar su base de datos, generar cinco recibos nuevos, recalcular las huellas y tener una cadena impecable que diga lo que le convenga. <b>La cadena prueba coherencia interna, no que sea la original.</b> Los testigos, el sello y el ancla existen para fijar por fuera cuál era la cadena buena y desde cuándo. Lo que Bitcoin resuelve con su consenso, Precintum lo resuelve apoyándose en terceros que ya existen.</p>`,
    no: `<p>Precintum no monta una cadena de bloques propia: no tiene token, red ni mecanismo de consenso propios. Conserva los recibos localmente y publica compromisos; OpenTimestamps ancla un compromiso agregado en Bitcoin.</p>`,
    tech: `<p>Cadena de hashes (no un DLT): un solo escritor, sin consenso ni tolerancia a fallos bizantinos. La misma idea que los registros de transparencia de certificados (RFC 6962), que también combinan cadena, árboles Merkle y monitores externos. En Nostr, el <code>id</code> de un evento es hash de su contenido, pero ningún campo apunta al evento anterior del mismo autor.</p>`,
    apply(w) { w.chainShown = true; },
  },
  {
    ch: 3, title: 'Si el verifier repite, Precintum no duplica', when: '14:33',
    msg: { from: 'umbral', to: 'precintum', text: 'tx 9f2c… (otra vez)' }, focus: ['umbral', 'precintum'],
    que: `<p>Por un reintento, el mismo resultado llega dos veces. Precintum lo reconoce y no escribe un segundo recibo.</p>`,
    por: `<p>Un registro con duplicados no vale como evidencia: inflaría los recuentos y permitiría discutir cada cifra.</p>`,
    no: `<p>Para reconocer la repetición, Precintum no guarda el id de transacción en el recibo: conserva una marca calculada con HMAC en una tabla aparte, con caducidad de 24 horas por defecto.</p>`,
    tech: `<p><code>ingest_dedup(HMAC(k, transaction_id), seq, expires_at)</code>, TTL 24 h, clave <code>PRECINTUM_DEDUP_KEY</code>. La caducidad limita este enlace de deduplicación; otros registros del operador pueden seguir permitiendo la correlación.</p>`,
    apply(w) { w.dedup = true; st(w, 'precintum', 'duplicado ignorado', 'good'); },
  },
];
