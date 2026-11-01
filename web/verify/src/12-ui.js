/**
 * Interfaz del verificador. Todo el texto vive aquí, en inglés y en español; el motor de
 * comprobaciones no produce texto, solo hallazgos con clave y parámetros.
 */
(function () {
  'use strict';
  var Checks = globalThis.PrecintumChecks;
  var Crypto = globalThis.PrecintumCrypto;

  /* ---------------- textos ---------------- */
  var STR = {
    en: {
      kicker: 'Precintum · independent verifier',
      title: 'Evidence package verifier',
      lede: "Drop an evidence package exported with <code>precintum export</code> and this page recomputes every hash, root, inclusion proof and signature from scratch, without using the operator's software.",
      privacy: 'Nothing leaves your browser. There is no server: the file is read and verified locally.',
      dropTitle: 'Drop the package here',
      dropHelp: 'A <code>.json</code> file produced by <code>precintum export --from … --to …</code>. Nothing is uploaded.',
      idle: 'No package loaded yet. Drop one above, choose a file, or press “Load example package” to see a verified example.',
      pick: 'Choose file…',
      loadExample: 'Load example package',
      optSigs: 'Verify Schnorr signatures (slower on large packages)',
      optPubkey: 'Operator public key (npub or hex), from a source you trust',
      checksTitle: 'Checks',
      summaryTitle: 'Package',
      limitsTitle: 'What this tool cannot verify',
      batchesTitle: 'Batches',
      batchesLede: 'One row per hourly window. An empty batch is a heartbeat: it records a window with no registered verifications.',
      receiptsTitle: 'Receipts',
      receiptsLede: 'Eight fields each, none of which identifies a person. The hash is recomputed here from the fields.',
      fLocalT: 'Local verification.',
      fLocal: 'This page contains its own SHA-256 and BIP-340 Schnorr implementations, in plain JavaScript with no external libraries, so that verifying does not require trusting a download, a server or the operator. The code is part of the Precintum repository and a test in that repository cross-checks it against the server implementation on every run.',
      fScopeT: 'Scope.',
      fScope: 'These results concern the integrity and consistency of the delivered records. Authenticating the TSA timestamp and the Bitcoin anchor requires external validation. The checks do not prove that the recorded events happened or that all events were recorded; that requires independent checks and the operator’s responsibility.',
      fLegalT: 'Notice.',
      fLegal: 'Statements about eIDAS, legal presumption or evidential value are informational, not legal advice, and should be reviewed by a qualified professional.',

      verifying: 'Verifying…',
      passBig: 'Package verified',
      passSub: 'The delivered data passes the integrity checks. Review the notes and limits for signer identity, coverage and external anchor validation.',
      warnBig: 'Verified, with warnings',
      warnSub: 'The completed checks found no inconsistency. Review the warnings and limits for checks or evidence that remain incomplete.',
      failBig: 'Verification failed',
      failSub: 'At least one check does not recompute. The problems are listed below, with the exact batch or receipt.',
      sigsSkipped: 'Signatures were not verified: the check was turned off.',
      exampleName: 'example package (embedded)',
      fBatches: 'batches',
      fReceipts: 'receipts',
      fEmpty: 'empty (heartbeats)',
      elapsed: 'verified in',
      fatalNotJson: 'That file is not JSON, or could not be read.',
      fatalNotPackage: 'That JSON is not an Precintum evidence package (expected format precintum/export/v1).',

      cSchema: 'Receipts well formed, with no identifier of person, session, device or transaction',
      cSchemaD: 'Strict eight-field schema: version, sequence, previous hash, random nonce, policy, verifier, result and minute-truncated time. Nothing else is allowed.',
      cChain: 'Chain intact and complete',
      cChainD: 'Every receipt carries the hash of the previous one, sequence numbers run without gaps, and each timestamp falls inside its batch window.',
      cInclusion: 'Each receipt included in its batch root',
      cInclusionD: 'Merkle tree per RFC 6962 recomputed from the receipts, and each inclusion proof checked per RFC 9162.',
      cWitness: 'Signed batch events consistent, one root per hour',
      cWitnessD: 'Event id recomputed from the content, Schnorr BIP-340 signature verified against it, tags matching the delivered data, and no missing window inside the service period.',
      cCount: 'Count commitment opens to the delivered receipts',
      cCountD: 'The salt in the package opens the commitment published in the signed event to exactly the number of receipts delivered.',
      cPubkey: 'One signing key, the operator’s',
      cPubkeyD: 'All batches signed by the same key, compared with the operator key you provide. Without it, the signatures only prove that the package is consistent with itself.',
      cTsa: 'RFC 3161 token read and consistent',
      cTsaD: 'The token is parsed: its imprint must be the batch event id and its time must fall between the close of the window and the anchoring maximum. The CMS signature and the certificate chain are validated with DSS, not here.',
      cOts: 'Bitcoin anchor file read and consistent',
      cOtsD: 'The .ots file is parsed: header, digest equal to the event id and presence of a Bitcoin attestation when the package declares it complete. Following it to a block header needs a Bitcoin node.',

      lPubkey: '<b>Who owns the signing key.</b> The page checks that one key signs everything and that it matches the npub you type. Which npub belongs to the operator is something you learn from a contract, a register or the relays, never from the package itself.',
      lTsa: '<b>The TSA seal signature.</b> The token is read (imprint, time, anchoring window), but validating its CMS signature and the certificate chain against the EU trusted list requires DSS.',
      lOts: '<b>The Bitcoin anchor.</b> The .ots file is read (digest, attestation), but following its path to the Merkle root of a block header requires a Bitcoin node or a block explorer.',
      lRelays: '<b>What the relays hold today.</b> This page does not query the witnesses. Independent auditor lookup against the relays is planned.',
      lCoverage: '<b>Coverage.</b> These checks concern the delivered evidence. Establishing that all events were recorded requires independent checks and the operator’s declared responsibility.',

      thSeq: 'batch', thWindow: 'window (UTC)', thCount: 'committed', thDelivered: 'delivered',
      thRoot: 'root', thSig: 'signature', thRootOk: 'root', thTsa: 'seal', thOts: 'anchor',
      thRSeq: 'receipt', thTime: 'time (UTC)', thResult: 'result', thHash: 'recomputed hash', thBatch: 'batch', thPrev: 'links to',
      yes: 'ok', no: 'fails', none: '—', pending: 'pending', missing: 'none', complete: 'in a block', consistent: 'consistent', attested: 'attested', bad: 'fails', declared: 'declared', matches: 'matches', unchecked: 'not checked', mixed: 'mixed keys',
      showingFirst: 'Showing the first {n} receipts of {total}. The verification covered all of them.',
      linkOk: 'previous ok', linkKo: 'broken',

      gaps: '{n} window(s) inside the service period have no batch, not even an empty one. The first starts at {first}. Completeness is broken.',
      batchSeqJump: 'Jump in the batch sequence: from {from} to {to}.',
      batchChainBreak: 'Batch {seq} does not link to the root of the previous one.',
      windowJump: 'Batch {seq} does not start where the previous window ended.',
      noEvent: 'Batch {seq} has no signed event.',
      wrongKind: 'Batch {seq}: the event is kind {kind}, expected 7676.',
      eventId: 'Batch {seq}: the event id does not match its content. The event was rewritten.',
      eventIdMismatch: 'Batch {seq}: the package names an event id different from the event it carries.',
      signature: 'Batch {seq}: the Schnorr signature does not verify.',
      eventRoot: 'Batch {seq}: the root in the signed event is not the delivered root.',
      eventVersion: 'Batch {seq}: unexpected batch format version ({v}).',
      eventSeq: 'Batch {seq}: the sequence tag does not match.',
      eventPrev: 'Batch {seq}: the previous-root tag does not match.',
      eventWindow: 'Batch {seq}: the window in the signed event is not the delivered one.',
      eventDupTag: 'Batch {seq}: the signed event repeats the {tag} tag; two verifiers could read different values.',
      eventCreatedAt: 'Batch {seq}: the event is dated before the end of its window.',
      eventPolicy: 'Batch {seq}: the policy tag does not match.',
      countCommit: 'Batch {seq}: the published count commitment does not open to {count} with the salt in the package.',
      countMismatch: 'Batch {seq}: {delivered} receipts delivered, the commitment says {committed}.',
      badReceipt: 'Receipt {seq} does not fit the schema ({why}).',
      rootMismatch: 'Batch {seq}: recomputed root {recomputed} does not match the published root {published}. Some receipt in the window was changed, removed or added.',
      proofFails: 'The inclusion proof for receipt {seq} does not verify.',
      tsOutOfWindow: 'Receipt {seq}: its time falls outside the window of batch {batch}.',
      receiptSeqJump: 'Gap in the receipt chain: from {from} to {to}.',
      prevMismatch: 'Receipt {seq}: its previous-hash field is not the hash of the receipt before it.',
      noTsa: 'Batch {seq} has no RFC 3161 timestamp yet.',
      tsaBeforeClose: 'Batch {seq}: the seal is {gap} s earlier than the close of its window, which is impossible.',
      otsPending: 'Batch {seq}: the Bitcoin anchor is still pending at the calendar.',
      otsMissing: 'Batch {seq}: the Bitcoin anchor was never submitted.',
      badWindowSeconds: 'The package declares an invalid window size.',
      badRequestedRange: 'The requested range must have two valid whole-second dates in increasing order.',
      badCoveredRange: 'The delivered range must have two valid whole-second dates in increasing order.',
      rangeCoverage: 'The delivered range does not cover the requested range.',
      rangeAlignment: 'The delivered range is not aligned to complete windows.',
      batchOutsideRange: 'Batch {seq}: its window lies outside the delivered range.',
      badTypes: 'Batch {seq}: fields with invalid types (numbers expected). The package was edited by hand or is corrupt.',
      windowSize: 'Batch {seq}: its window is not {size} seconds long.',
      windowOverlap: 'Batch {seq}: its window overlaps the previous one.',
      gapsDeclaredMismatch: 'The package declares {declared} gap(s) but {found} are found between the delivered batches. The package hides missing windows.',
      chainDeclaredMismatch: 'The package declares the batch chain continuous and it is not.',
      edgeWindows: '{n} window(s) at the edges of the range have no batch. The package declares them earlier than the service start ({before}) or not yet closed ({notClosed}); that cannot be checked offline. Compare with the relays.',
      badExpectedPubkey: 'The operator key you typed is not a valid npub or 64-hex public key.',
      mixedPubkeys: 'The batches are signed by {n} different keys. One agent signs with one key; a key change must be announced in the key directory.',
      pubkeyMismatch: 'The key that signs the batches is not the operator key you provided.',
      pubkeyMatches: 'The signing key matches the operator key you provided.',
      pubkeyNotChecked: 'The signing key has not been compared with any external source: the signatures prove internal consistency, not who signed. Type the operator’s npub above, obtained from a source you trust.',
      declaredPubkeyMismatch: 'The key the package declares as the agent’s is not the key that signs the batches.',
      proofSize: 'Receipt {seq}: its inclusion proof declares a tree of {size} leaves and the batch has {count}.',
      tsaUnparseable: 'Batch {seq}: the RFC 3161 token cannot be read as a TimeStampToken.',
      tsaImprint: 'Batch {seq}: the imprint inside the RFC 3161 token is not the id of the batch event. The seal belongs to something else.',
      tsaGenTimeMismatch: 'Batch {seq}: the package declares the seal time {declared} but the token says {token}.',
      tsaSlightlyEarly: 'Batch {seq}: the seal is {gap} s earlier than the close of its window; tolerated as clock skew.',
      tsaLate: 'Batch {seq}: the seal arrives {gap} s after the close, above the maximum of {max} s. Possible backdating.',
      tsaCmsNotChecked: 'The RFC 3161 tokens were read and are consistent with the events and the anchoring window. Their CMS signature and the TSA certificate chain are validated with DSS, not here.',
      otsUnparseable: 'Batch {seq}: the .ots file cannot be read.',
      otsDigest: 'Batch {seq}: the .ots file is not for the id of this event.',
      otsNotComplete: 'Batch {seq}: the package declares the Bitcoin anchor complete and the .ots file has no Bitcoin attestation.',
      otsDeclaredPending: 'Batch {seq}: the package declares the Bitcoin anchor pending although the .ots file already carries a Bitcoin attestation.',
      otsBlockNotChecked: 'The Bitcoin attestations are present in the .ots files. Following them to a block header needs a Bitcoin node, so it is not done here.',
    },
    es: {
      kicker: 'Precintum · verificador independiente',
      title: 'Verificador de paquetes de evidencia',
      lede: 'Suelta un paquete de evidencia exportado con <code>precintum export</code> y esta página recalcula desde cero cada hash, raíz, prueba de inclusión y firma, sin usar el software del operador.',
      privacy: 'Nada sale de tu navegador. No hay servidor: el fichero se lee y se verifica en local.',
      dropTitle: 'Suelta el paquete aquí',
      dropHelp: 'Un fichero <code>.json</code> producido por <code>precintum export --desde … --hasta …</code>. No se sube nada.',
      idle: 'Aún no hay ningún paquete. Suelta uno arriba, elige un fichero o pulsa «Cargar paquete de ejemplo» para ver un ejemplo verificado.',
      pick: 'Elegir fichero…',
      loadExample: 'Cargar paquete de ejemplo',
      optSigs: 'Verificar las firmas Schnorr (más lento en paquetes grandes)',
      optPubkey: 'Clave pública del operador (npub o hex), de una fuente fiable',
      checksTitle: 'Comprobaciones',
      summaryTitle: 'Paquete',
      limitsTitle: 'Lo que esta herramienta no puede verificar',
      batchesTitle: 'Lotes',
      batchesLede: 'Una fila por ventana horaria. Un lote vacío es un latido: registra una ventana sin verificaciones registradas.',
      receiptsTitle: 'Recibos',
      receiptsLede: 'Ocho campos cada uno, y ninguno identifica a una persona. El hash se recalcula aquí a partir de los campos.',
      fLocalT: 'Verificación local.',
      fLocal: 'Esta página lleva su propia implementación de SHA-256 y de Schnorr BIP-340, en JavaScript y sin librerías externas, para que verificar no exija confiar en una descarga, en un servidor ni en el operador. El código forma parte del repositorio de Precintum y un test lo contrasta contra la implementación del servidor en cada ejecución.',
      fScopeT: 'Alcance.',
      fScope: 'Estos resultados se refieren a la integridad y coherencia de los registros entregados. Autenticar el sello de la TSA y el anclaje Bitcoin requiere validación externa. Las comprobaciones no prueban que los hechos registrados ocurrieran ni que se registraran todos; eso requiere controles independientes y la responsabilidad del operador.',
      fLegalT: 'Aviso.',
      fLegal: 'Lo que aquí se diga sobre eIDAS, presunción legal o valor probatorio es informativo, no asesoramiento jurídico, y debe revisarlo un profesional cualificado.',

      verifying: 'Verificando…',
      passBig: 'Paquete verificado',
      passSub: 'Los datos entregados pasan las comprobaciones de integridad. Revisa las notas y límites sobre identidad del firmante, cobertura y validación externa de las anclas.',
      warnBig: 'Verificado, con avisos',
      warnSub: 'Las comprobaciones realizadas no detectaron incoherencias. Revisa los avisos y límites de las comprobaciones o pruebas que siguen incompletas.',
      failBig: 'La verificación falla',
      failSub: 'Al menos una comprobación no recalcula. Los problemas están abajo, con el lote o el recibo exacto.',
      sigsSkipped: 'Las firmas no se han verificado: la comprobación está desactivada.',
      exampleName: 'paquete de ejemplo (incrustado)',
      fBatches: 'lotes',
      fReceipts: 'recibos',
      fEmpty: 'vacíos (latidos)',
      elapsed: 'verificado en',
      fatalNotJson: 'Ese fichero no es JSON, o no se ha podido leer.',
      fatalNotPackage: 'Ese JSON no es un paquete de evidencia de Precintum (se esperaba el formato precintum/export/v1).',

      cSchema: 'Recibos bien formados, sin identificadores de persona, sesión, dispositivo ni transacción',
      cSchemaD: 'Esquema estricto de ocho campos: versión, orden, hash anterior, nonce aleatorio, política, verificador, resultado y hora truncada al minuto. No se admite nada más.',
      cChain: 'Cadena íntegra y completa',
      cChainD: 'Cada recibo lleva el hash del anterior, la numeración va sin huecos y cada hora cae dentro de la ventana de su lote.',
      cInclusion: 'Cada recibo incluido en la raíz de su lote',
      cInclusionD: 'Árbol de Merkle según RFC 6962 recalculado desde los recibos, y cada prueba de inclusión comprobada según RFC 9162.',
      cWitness: 'Eventos de lote firmados y coherentes, una raíz por hora',
      cWitnessD: 'Id del evento recalculado desde su contenido, firma Schnorr BIP-340 verificada contra él, etiquetas que coinciden con lo entregado y ninguna ventana ausente dentro del periodo de servicio.',
      cCount: 'El compromiso de recuento se abre a los recibos entregados',
      cCountD: 'La sal del paquete abre el compromiso publicado en el evento firmado exactamente al número de recibos entregados.',
      cPubkey: 'Una sola clave firmante, la del operador',
      cPubkeyD: 'Todos los lotes firmados por la misma clave, contrastada con la del operador que indiques. Sin ella, las firmas solo prueban que el paquete es coherente consigo mismo.',
      cTsa: 'Token RFC 3161 leído y coherente',
      cTsaD: 'El token se parsea: su imprint debe ser el id del evento de lote y su hora debe caer entre el cierre de la ventana y el máximo de anclaje. La firma CMS y la cadena de certificados se validan con DSS, no aquí.',
      cOts: 'Fichero de anclaje en Bitcoin leído y coherente',
      cOtsD: 'El fichero .ots se parsea: cabecera, digest igual al id del evento y presencia de una atestación Bitcoin cuando el paquete lo declara completo. Seguirlo hasta la cabecera de un bloque exige un nodo.',

      lPubkey: '<b>De quién es la clave que firma.</b> La página comprueba que una sola clave firma todo y que coincide con el npub que escribas. Qué npub es del operador se sabe por un contrato, un registro o los relays, nunca por el propio paquete.',
      lTsa: '<b>La firma del sello de la TSA.</b> El token se lee (imprint, hora, ventana de anclaje), pero validar su firma CMS y la cadena de certificados contra la lista de confianza de la UE exige DSS.',
      lOts: '<b>El anclaje en Bitcoin.</b> El fichero .ots se lee (digest, atestación), pero seguir su ruta hasta la raíz Merkle de la cabecera de un bloque exige un nodo de Bitcoin o un explorador.',
      lRelays: '<b>Qué conservan hoy los relays.</b> Esta página no consulta a los testigos. La consulta independiente del auditor a los relays está prevista como trabajo futuro.',
      lCoverage: '<b>La cobertura.</b> Estas comprobaciones se refieren a la evidencia entregada. Determinar que se registraron todos los hechos requiere controles independientes y la responsabilidad declarada del operador.',

      thSeq: 'lote', thWindow: 'ventana (UTC)', thCount: 'comprometido', thDelivered: 'entregados',
      thRoot: 'raíz', thSig: 'firma', thRootOk: 'raíz', thTsa: 'sello', thOts: 'ancla',
      thRSeq: 'recibo', thTime: 'hora (UTC)', thResult: 'resultado', thHash: 'hash recalculado', thBatch: 'lote', thPrev: 'enlace',
      yes: 'ok', no: 'falla', none: '—', pending: 'pendiente', missing: 'sin enviar', complete: 'en un bloque', consistent: 'coherente', attested: 'atestado', bad: 'falla', declared: 'declarado', matches: 'coincide', unchecked: 'sin contrastar', mixed: 'claves mezcladas',
      showingFirst: 'Se muestran los primeros {n} recibos de {total}. La verificación cubrió todos.',
      linkOk: 'anterior ok', linkKo: 'roto',

      gaps: '{n} ventana(s) del periodo de servicio no tienen lote, ni siquiera vacío. La primera empieza en {first}. La completitud está rota.',
      batchSeqJump: 'Salto en la secuencia de lotes: del {from} al {to}.',
      batchChainBreak: 'El lote {seq} no enlaza con la raíz del anterior.',
      windowJump: 'El lote {seq} no empieza donde acabó la ventana anterior.',
      noEvent: 'El lote {seq} no trae evento firmado.',
      wrongKind: 'Lote {seq}: el evento es de kind {kind}, se esperaba 7676.',
      eventId: 'Lote {seq}: el id del evento no corresponde a su contenido. El evento se ha reescrito.',
      eventIdMismatch: 'Lote {seq}: el paquete nombra un id de evento distinto del evento que trae.',
      signature: 'Lote {seq}: la firma Schnorr no verifica.',
      eventRoot: 'Lote {seq}: la raíz del evento firmado no es la entregada.',
      eventVersion: 'Lote {seq}: versión de formato inesperada ({v}).',
      eventSeq: 'Lote {seq}: la etiqueta de secuencia no coincide.',
      eventPrev: 'Lote {seq}: la etiqueta de raíz anterior no coincide.',
      eventWindow: 'Lote {seq}: la ventana del evento firmado no es la entregada.',
      eventDupTag: 'Lote {seq}: el evento firmado repite la etiqueta {tag}; dos verificadores podrían leer valores distintos.',
      eventCreatedAt: 'Lote {seq}: el evento está fechado antes del fin de su ventana.',
      eventPolicy: 'Lote {seq}: la etiqueta de política no coincide.',
      countCommit: 'Lote {seq}: el compromiso de recuento publicado no se abre a {count} con la sal del paquete.',
      countMismatch: 'Lote {seq}: se entregan {delivered} recibos y el compromiso dice {committed}.',
      badReceipt: 'El recibo {seq} no cumple el esquema ({why}).',
      rootMismatch: 'Lote {seq}: la raíz recalculada {recomputed} no coincide con la publicada {published}. Algún recibo de la ventana se cambió, se borró o se añadió.',
      proofFails: 'La prueba de inclusión del recibo {seq} no verifica.',
      tsOutOfWindow: 'Recibo {seq}: su hora cae fuera de la ventana del lote {batch}.',
      receiptSeqJump: 'Salto en la cadena de recibos: del {from} al {to}.',
      prevMismatch: 'Recibo {seq}: su campo de hash anterior no es el hash del recibo que le precede.',
      noTsa: 'El lote {seq} todavía no tiene sello RFC 3161.',
      tsaBeforeClose: 'Lote {seq}: el sello es {gap} s anterior al cierre de su ventana, lo cual es imposible.',
      otsPending: 'Lote {seq}: el anclaje en Bitcoin sigue pendiente en el calendario.',
      otsMissing: 'Lote {seq}: el anclaje en Bitcoin no se envió nunca.',
      badWindowSeconds: 'El paquete declara un tamaño de ventana inválido.',
      badRequestedRange: 'El rango solicitado debe tener dos fechas válidas, en segundos enteros y ordenadas.',
      badCoveredRange: 'El rango entregado debe tener dos fechas válidas, en segundos enteros y ordenadas.',
      rangeCoverage: 'El rango entregado no cubre el solicitado.',
      rangeAlignment: 'El rango entregado no está alineado a ventanas completas.',
      batchOutsideRange: 'Lote {seq}: su ventana queda fuera del rango entregado.',
      badTypes: 'Lote {seq}: campos con tipos inválidos (se esperaban números). El paquete se ha editado a mano o está corrupto.',
      windowSize: 'Lote {seq}: su ventana no mide {size} segundos.',
      windowOverlap: 'Lote {seq}: su ventana se solapa con la anterior.',
      gapsDeclaredMismatch: 'El paquete declara {declared} hueco(s) pero se encuentran {found} entre los lotes entregados. El paquete oculta ventanas que faltan.',
      chainDeclaredMismatch: 'El paquete declara la cadena de lotes continua y no lo es.',
      edgeWindows: '{n} ventana(s) en los bordes del rango no tienen lote. El paquete las declara anteriores al arranque del servicio ({before}) o aún sin cerrar ({notClosed}); eso no se puede comprobar sin conexión. Contrastar con los relays.',
      badExpectedPubkey: 'La clave del operador escrita no es un npub ni una clave pública hex de 64 válida.',
      mixedPubkeys: 'Los lotes están firmados por {n} claves distintas. Un agente firma con una; un cambio de clave se anuncia en el directorio de claves.',
      pubkeyMismatch: 'La clave que firma los lotes no es la del operador que has indicado.',
      pubkeyMatches: 'La clave firmante coincide con la del operador que has indicado.',
      pubkeyNotChecked: 'La clave firmante no se ha contrastado con ninguna fuente externa: las firmas prueban coherencia interna, no quién firmó. Escribe arriba el npub del operador, obtenido de una fuente fiable.',
      declaredPubkeyMismatch: 'La clave que el paquete declara como la del agente no es la que firma los lotes.',
      proofSize: 'Recibo {seq}: su prueba de inclusión declara un árbol de {size} hojas y el lote tiene {count}.',
      tsaUnparseable: 'Lote {seq}: el token RFC 3161 no se puede leer como TimeStampToken.',
      tsaImprint: 'Lote {seq}: el imprint del token RFC 3161 no es el id del evento del lote. El sello es de otra cosa.',
      tsaGenTimeMismatch: 'Lote {seq}: el paquete declara la hora del sello {declared} pero el token dice {token}.',
      tsaSlightlyEarly: 'Lote {seq}: el sello es {gap} s anterior al cierre de su ventana; se tolera como desfase de reloj.',
      tsaLate: 'Lote {seq}: el sello llega {gap} s después del cierre, por encima del máximo de {max} s. Posible antedatado.',
      tsaCmsNotChecked: 'Los tokens RFC 3161 se han leído y cuadran con los eventos y con la ventana de anclaje. Su firma CMS y la cadena de certificados de la TSA se validan con DSS, no aquí.',
      otsUnparseable: 'Lote {seq}: el fichero .ots no se puede leer.',
      otsDigest: 'Lote {seq}: el fichero .ots no es del id de este evento.',
      otsNotComplete: 'Lote {seq}: el paquete declara el anclaje en Bitcoin completo y el fichero .ots no tiene atestación Bitcoin.',
      otsDeclaredPending: 'Lote {seq}: el paquete declara el anclaje en Bitcoin pendiente aunque el fichero .ots ya trae una atestación Bitcoin.',
      otsBlockNotChecked: 'Las atestaciones Bitcoin están en los ficheros .ots. Seguirlas hasta la cabecera de un bloque exige un nodo, así que no se hace aquí.',
    },
  };

  var lang = 'en';
  function t(key, params) {
    var s = (STR[lang] && STR[lang][key]) || STR.en[key] || key;
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) {
      return params[k] === undefined || params[k] === null ? '?' : String(params[k]);
    });
  }
  var $ = function (s) { return document.querySelector(s); };
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function ab(h) { return typeof h === 'string' && h.length > 16 ? h.slice(0, 10) + '…' + h.slice(-4) : String(h); }
  function iso(sec) {
    if (typeof sec !== 'number') return '—';
    return new Date(sec * 1000).toISOString().replace('.000Z', 'Z').replace('T', ' ').replace('Z', '');
  }
  function hm(sec) {
    if (typeof sec !== 'number') return '—';
    return new Date(sec * 1000).toISOString().slice(11, 16);
  }
  function day(sec) { return new Date(sec * 1000).toISOString().slice(0, 10); }

  /* ---------------- estado ---------------- */
  var current = null; // {pkg, result, name, bytes, ms}

  function applyStaticText() {
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      el.innerHTML = t(el.getAttribute('data-i18n'));
    });
    document.querySelectorAll('.lang button').forEach(function (b) {
      var on = b.getAttribute('data-lang') === lang;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    document.documentElement.lang = lang;
  }

  var CHECK_TEXT = {
    schema: ['cSchema', 'cSchemaD'],
    chain: ['cChain', 'cChainD'],
    inclusion: ['cInclusion', 'cInclusionD'],
    witness: ['cWitness', 'cWitnessD'],
    pubkey: ['cPubkey', 'cPubkeyD'],
    count: ['cCount', 'cCountD'],
    tsa: ['cTsa', 'cTsaD'],
    ots: ['cOts', 'cOtsD'],
  };
  var ICON = { ok: '✓', warn: '!', fail: '✗' };

  function findingText(f) {
    var p = {};
    for (var k in f.params) {
      p[k] = k === 'first' || k === 'window' ? iso(f.params[k]) : f.params[k];
      if ((k === 'recomputed' || k === 'published') && typeof f.params[k] === 'string') p[k] = ab(f.params[k]);
    }
    return t(f.key, p);
  }

  function renderVerdict() {
    var v = $('#verdict');
    if (!current) {
      v.innerHTML = '<div class="verdict idle"><span class="sub">' + esc(t('idle')) + '</span></div>';
      return;
    }
    var r = current.result;
    if (r.fatal) {
      v.innerHTML = '<div class="verdict fail"><span class="big">' + esc(t('failBig')) + '</span><span class="sub">' +
        esc(t(r.fatal === 'notJson' ? 'fatalNotJson' : 'fatalNotPackage')) + '</span></div>';
      return;
    }
    var cls = r.ok ? (r.warnings.length ? 'warn' : 'pass') : 'fail';
    var big = r.ok ? (r.warnings.length ? t('warnBig') : t('passBig')) : t('failBig');
    var sub = r.ok ? (r.warnings.length ? t('warnSub') : t('passSub')) : t('failSub');
    if (!r.signaturesChecked) sub += ' ' + t('sigsSkipped');
    v.innerHTML = '<div class="verdict ' + cls + '"><span class="big">' + esc(big) + '</span><span class="sub">' + esc(sub) + '</span></div>';
  }

  function renderChecks() {
    var el = $('#checks');
    if (!current || current.result.fatal) { el.innerHTML = ''; return; }
    el.innerHTML = current.result.checks.map(function (c) {
      var txt = CHECK_TEXT[c.id] || [c.id, ''];
      var findings = (c.findings || []).slice(0, 12).map(function (f) {
        var cls = f.level === 'problem' ? 'p' : f.level === 'warning' ? 'w' : 'n';
        return '<div class="' + cls + '">' + esc(findingText(f)) + '</div>';
      }).join('');
      var extra = (c.findings || []).length > 12 ? '<div>… ' + ((c.findings.length - 12)) + '</div>' : '';
      return '<li class="' + c.status + '"><span class="ic">' + ICON[c.status] + '</span><span>' +
        '<span class="t">' + esc(t(txt[0])) + '</span>' +
        '<span class="d">' + esc(t(txt[1])) + '</span>' +
        (findings ? '<span class="f">' + findings + extra + '</span>' : '') +
        '</span></li>';
    }).join('');
  }

  function renderSummary() {
    var el = $('#summary');
    if (!current || current.result.fatal) { el.innerHTML = ''; return; }
    var p = current.pkg;
    var rows = [
      ['format', esc(p.format)],
      ['range', esc(iso(p.covered[0]) + ' → ' + iso(p.covered[1]))],
      ['window', esc(String(p.windowSeconds) + ' s')],
      ['service', p.serviceStart ? esc(iso(p.serviceStart) + ' → ' + iso(p.serviceEnd)) : '—'],
      ['batches', esc(String(current.result.totals.batches) + ' (' + current.result.totals.empty + ' ' + t('fEmpty') + ')')],
      ['receipts', esc(String(current.result.totals.receipts))],
      ['pubkey', '<span class="mono">' + esc(ab(p.batches[0] && p.batches[0].event ? p.batches[0].event.pubkey : '—')) + '</span> ' + pubkeyPill()],
    ];
    if (p.totals && typeof p.totals.windowsBeforeService === 'number') {
      rows.push(['before service', esc(String(p.totals.windowsBeforeService) + ' windows')]);
      rows.push(['not closed', esc(String(p.totals.windowsNotClosed) + ' windows')]);
    }
    el.innerHTML = rows.map(function (r) {
      return '<span class="k">' + esc(r[0]) + '</span><span class="v">' + r[1] + '</span>';
    }).join('');
  }

  function pubkeyPill() {
    var c = current && current.result.checks ? current.result.checks.filter(function (x) { return x.id === 'pubkey'; })[0] : null;
    if (!c) return '';
    var keys = (c.findings || []).map(function (f) { return f.key; });
    if (keys.indexOf('mixedPubkeys') >= 0) return pill('n', t('mixed'));
    if (keys.indexOf('pubkeyMismatch') >= 0 || keys.indexOf('declaredPubkeyMismatch') >= 0 || keys.indexOf('badExpectedPubkey') >= 0) return pill('n', t('no'));
    if (keys.indexOf('pubkeyMatches') >= 0) return pill('y', t('matches'));
    return pill('q', t('unchecked'));
  }

  function renderLimits() {
    $('#limits').innerHTML = ['lPubkey', 'lTsa', 'lOts', 'lRelays', 'lCoverage'].map(function (k) {
      return '<li>' + t(k) + '</li>';
    }).join('');
  }

  function pill(state, label) { return '<span class="pill ' + state + '">' + esc(label) + '</span>'; }

  function renderBatches() {
    var tbl = $('#batches');
    if (!current || current.result.fatal) { tbl.innerHTML = ''; return; }
    var head = '<thead><tr>' +
      ['thSeq', 'thWindow', 'thCount', 'thDelivered', 'thRoot', 'thSig', 'thRootOk', 'thTsa', 'thOts']
        .map(function (k) { return '<th>' + esc(t(k)) + '</th>'; }).join('') + '</tr></thead>';
    var rows = current.pkg.batches.map(function (b, i) {
      var r = current.result.batches[i] || {};
      var sig = r.sig === null || r.sig === undefined ? pill('q', t('none')) : pill(r.sig ? 'y' : 'n', t(r.sig ? 'yes' : 'no'));
      var rootOk = r.rootOk === null || r.rootOk === undefined ? pill('q', t('none')) : pill(r.rootOk ? 'y' : 'n', t(r.rootOk ? 'yes' : 'no'));
      var tsa = r.tsa === 'consistent' ? pill('q', t('consistent') + ' ' + hm(r.tsaTime))
        : r.tsa === 'bad' ? pill('n', t('bad')) : pill('w', t('missing'));
      var ots = r.ots === 'attested' ? pill('q', t('attested')) : r.ots === 'pending' ? pill('w', t('pending'))
        : r.ots === 'bad' ? pill('n', t('bad')) : pill('w', t('missing'));
      return '<tr><td class="num">' + esc(String(b.seq)) + '</td>' +
        '<td class="num">' + esc(day(b.window[0]) + ' ' + hm(b.window[0]) + '–' + hm(b.window[1])) + '</td>' +
        '<td class="num">' + esc(String(b.count)) + '</td><td class="num">' + esc(String(Array.isArray(b.receipts) ? b.receipts.length : 0)) + '</td>' +
        '<td class="h">' + esc(ab(b.root)) + '</td><td>' + sig + '</td><td>' + rootOk + '</td><td>' + tsa + '</td><td>' + ots + '</td></tr>';
    }).join('');
    tbl.innerHTML = head + '<tbody>' + rows + '</tbody>';
  }

  var MAX_ROWS = 200;
  function renderReceipts() {
    var tbl = $('#receipts');
    var more = $('#receipts-more');
    if (!current || current.result.fatal) { tbl.innerHTML = ''; more.textContent = ''; return; }
    var all = [];
    current.pkg.batches.forEach(function (b) {
      (b.receipts || []).forEach(function (r) { all.push({ r: r, batch: b.seq }); });
    });
    var head = '<thead><tr>' +
      ['thRSeq', 'thTime', 'thResult', 'thBatch', 'thHash', 'thPrev']
        .map(function (k) { return '<th>' + esc(t(k)) + '</th>'; }).join('') + '</tr></thead>';
    var prevHash = current.pkg.precedingReceiptHash;
    var rows = [];
    for (var i = 0; i < all.length; i++) {
      var r = all[i].r;
      var h;
      try { h = Checks.receiptHash(r); } catch (err) { h = null; }
      var linked = prevHash === null || prevHash === undefined ? true : r.prev === prevHash;
      if (i < MAX_ROWS) {
        rows.push('<tr><td class="num">' + esc(r.seq) + '</td><td class="num">' + esc(day(r.ts) + ' ' + hm(r.ts)) + '</td>' +
          '<td class="res-' + esc(r.result) + '">' + esc(r.result) + '</td><td class="num">' + esc(String(all[i].batch)) + '</td>' +
          '<td class="h">' + esc(h ? ab(h) : '—') + '</td>' +
          '<td>' + pill(linked ? 'y' : 'n', t(linked ? 'linkOk' : 'linkKo')) + '</td></tr>');
      }
      prevHash = h;
    }
    tbl.innerHTML = head + '<tbody>' + rows.join('') + '</tbody>';
    more.textContent = all.length > MAX_ROWS ? t('showingFirst', { n: MAX_ROWS, total: all.length }) : '';
  }

  function renderFilebar() {
    var el = $('#filebar');
    if (!current) { el.innerHTML = ''; return; }
    var kb = (current.bytes / 1024).toFixed(1);
    el.innerHTML = '<span class="name">' + esc(current.name) + '</span><span class="sep">·</span>' +
      '<span>' + kb + ' kB</span><span class="sep">·</span>' +
      '<span>' + esc(t('elapsed')) + ' ' + current.ms + ' ms</span>';
  }

  function renderAll() {
    applyStaticText();
    renderLimits();
    renderFilebar();
    renderVerdict();
    renderChecks();
    renderSummary();
    renderBatches();
    renderReceipts();
    var show = !!current && !current.result.fatal;
    $('#detail').classList.toggle('hidden', !show);
    $('#batches-block').classList.toggle('hidden', !show);
    $('#receipts-block').classList.toggle('hidden', !show);
  }

  function run(pkg, name, bytes) {
    var t0 = (globalThis.performance || Date).now();
    var result;
    try {
      result = Checks.verifyPackage(pkg, { verifySignatures: $('#sigs').checked, expectedPubkey: $('#pubkey') ? $('#pubkey').value : undefined });
    } catch (err) {
      result = { fatal: 'notPackage', findings: [], checks: [], batches: [] };
    }
    var ms = Math.round(((globalThis.performance || Date).now()) - t0);
    current = { pkg: pkg, result: result, name: name, bytes: bytes, ms: ms };
    renderAll();
  }

  function showVerdict() {
    var v = $('#verdict');
    if (v && v.scrollIntoView) v.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function loadText(text, name) {
    var pkg;
    try { pkg = JSON.parse(text); } catch (err) {
      current = { pkg: null, result: { fatal: 'notJson', findings: [], checks: [], batches: [] }, name: name, bytes: text.length, ms: 0 };
      renderAll();
      showVerdict();
      return;
    }
    run(pkg, name, text.length);
    showVerdict();
  }

  function loadFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () { loadText(String(reader.result), file.name); };
    reader.onerror = function () {
      current = { pkg: null, result: { fatal: 'notJson', findings: [], checks: [], batches: [] }, name: file.name, bytes: 0, ms: 0 };
      renderAll();
    };
    reader.readAsText(file);
  }

  /* ---------------- eventos ---------------- */
  var drop = $('#drop');
  ['dragenter', 'dragover'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'drop'].forEach(function (ev) {
    drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
  });
  drop.addEventListener('click', function (e) { if (e.target === drop) $('#file').click(); });
  drop.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#file').click(); }
  });
  $('#pick').addEventListener('click', function () { $('#file').click(); });
  $('#file').addEventListener('change', function (e) { loadFile(e.target.files && e.target.files[0]); });
  $('#example').addEventListener('click', function () {
    var ex = globalThis.PRECINTUM_EXAMPLE;
    if (ex) {
      run(JSON.parse(JSON.stringify(ex)), t('exampleName'), JSON.stringify(ex).length);
      showVerdict();
    }
  });
  $('#sigs').addEventListener('change', function () {
    if (current && current.pkg) run(current.pkg, current.name, current.bytes);
  });
  $('#pubkey').addEventListener('change', function () {
    if (current && current.pkg) run(current.pkg, current.name, current.bytes);
  });
  document.querySelectorAll('.lang button').forEach(function (b) {
    b.addEventListener('click', function () {
      lang = b.getAttribute('data-lang');
      try { localStorage.setItem('precintum-verify-lang', lang); } catch (err) { /* sin almacenamiento */ }
      renderAll();
    });
  });

  /* ---------------- arranque ---------------- */
  try {
    var saved = localStorage.getItem('precintum-verify-lang');
    if (saved === 'es' || saved === 'en') lang = saved;
  } catch (err) { /* sin almacenamiento */ }
  // La página abre vacía; el ejemplo se carga al pulsar su botón.
  renderAll();
  void Crypto;
})();
