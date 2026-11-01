# Modelo de amenazas de Precintum, con estado de mitigación

> Documento inicial de 2026-09-05, con alcance revisado el 2026-10-30 para el candidato local. Cada fila dice qué hace el código, qué falta y dónde mirar. Estados: ✅ hecho y con test · 🔶 parcial · ⏳ pendiente · ✖ fuera de alcance por
> diseño (se dice en vez de prometer).

## Activos

Los recibos y su cadena (base de datos del operador); los eventos de lote publicados; la clave del
agente (firma lotes) y la clave raíz (firma el directorio de claves); el directorio de claves; la
tabla de deduplicación transacción↔recibo, con TTL; las pruebas de tiempo (token RFC 3161, `.ots`);
el archivo append-only; el paquete de evidencia exportado.

## Garantía

**Lo que comprueba el prototipo:** la integridad y coherencia de la evidencia entregada con sus lotes
firmados. El auditor debe contrastar el firmante con una clave conocida por otro canal. Comprobar que
esa es la historia publicada completa requiere consultar los testigos; autenticar las pruebas de tiempo
requiere validar la firma CMS y la cadena de la TSA, y contrastar la prueba Bitcoin con un bloque,
fuera de los verificadores del prototipo. **Lo que no garantiza:** que lo registrado ocurriera (los recibos los emite el sistema del
operador) ni que se registrara todo (una verificación que nunca entró no deja rastro). Lo segundo solo
lo suplen controles no criptográficos: muestreo con un comprobante entregado a la persona, registrar
en el camino y no al lado, contrastar el recuento con otra fuente y estadística sobre los recuentos
horarios.

## Adversarios y ataques

### Operador deshonesto, o insider con acceso a la base de datos

| Ataque | Cómo se detecta o se impide | Estado | Dónde |
|---|---|---|---|
| Alterar un recibo | El hash cambia; el `prev` del siguiente no coincide; la raíz del lote publicado no se reproduce | ✅ | `chain verify`; `verifyPackage`; verificador web |
| Borrar recibos intermedios | Hueco de `seq`; el recuento revelado no cuadra con el compromiso publicado | ✅ | `verifyPackage` (`countMismatch`, continuidad) |
| Truncar la cadena ("acaba en k") | Cadencia fija con lotes vacíos: una ventana sin lote es un hueco explícito (`gaps`); la cabeza se contrasta con los lotes publicados en los testigos | 🔶 | `batch-service.ts`; `export-service.ts`; **falta** la consulta a relays desde el verificador (CLI `precintum-verify`) |
| Antedatar un recibo metiéndolo en una ventana ya publicada | El instante del recibo nunca cae antes del último lote cerrado (`closedUntil`); los recibos huérfanos se detectan en el export | ✅ | `record-verification.ts`; test `late-receipt.test.ts` |
| Reescribir la historia con un lote nuevo "anterior" | Se comprueban `created_at` ≥ fin, el tiempo declarado en el token y el encadenamiento `prev`; autenticar el sello y contrastar la historia publicada requieren validación externa | 🔶 | `batch-event.ts`; `checkAnchorWindow`; notas de `verifyPackage` |
| Fabricar recibos (inflar volumen) | Solo estadística (tasas de error y de menores anómalas); cofirma de la raíz por el vendor en una fase posterior | ✖ v1 | Controles no criptográficos (ver "Garantía") |
| Registrar unas verificaciones sí y otras no | No criptográfico: muestreo con comprobante entregado a la persona, registro en el camino, contraste con el recuento del verifier | ✖ v1 | Controles no criptográficos (ver "Garantía") |
| Pedir a los relays que borren los lotes (`kind 5`, NIP-09) | Búsqueda periódica de `kind 5` del agente, de la raíz y de los que apuntan al directorio de claves; alerta `deletion_request`; el relay privado rechaza `kind 5`; sello, `.ots` y archivo conservan la prueba | ✅ | `witness-verifier.ts`; `relay init`; `PRECINTUM_ROOT_NPUB` |
| Presentar al auditor un paquete "coherente consigo mismo" firmado por otra clave | Clave firmante única en el paquete y contrastada con la que el auditor conoce por otro canal (`--nsec`/npub esperado) | ✅ | `verifyPackage({ expectedPubkey })`; campo npub del verificador web |
| Dos procesos sobre la misma base PGlite (corrupción silenciosa) | Fichero de bloqueo con PID; el segundo proceso falla con mensaje | ✅ | `pglite-client.ts` |

### Atacante con la clave del agente

| Ataque | Cómo se detecta o se impide | Estado | Dónde |
|---|---|---|---|
| Antedatar lotes (los relays aceptan `created_at` de años atrás) | Se comprueba que la hora leída del token cae en la ventana de anclaje, con tolerancia de 120 s hacia atrás; la firma CMS y la prueba contra un bloque Bitcoin requieren validación externa | 🔶 | `checkAnchorWindow`; `verifyPackage`; web; herramientas externas |
| Publicar lotes falsos hacia el futuro | Automonitorización: el agente compara lo que hay en los relays con su outbox y alerta de eventos suyos que no publicó | ⏳ | previsto en el planificador (`runner.ts`) |
| Seguir firmando tras el robo | Directorio de claves con ventanas de validez firmado por la raíz; revocar = publicar versión nueva con `to`; el verificador acepta un lote solo si su clave estaba vigente | 🔶 | dominio hecho (`key-directory.ts`); **faltan** CLI de publicación y uso en `verifyPackage` |
| Leer el nsec del servidor | Secretos fuera del código (`.env` 0600, gestor de secretos en producción); el panel no necesita el nsec (`PRECINTUM_NPUB`); pino censura claves en los logs | 🔶 | `keygen --to-env`; `serve`; `logger.ts`; **falta** HSM/KMS |

### Relay hostil o coludido

| Ataque | Cómo se detecta o se impide | Estado | Dónde |
|---|---|---|---|
| No servir, retener u "olvidar" eventos | Quórum N de M (4 relays de 4 operadores y 2 programas por defecto); verificación diferida "conserva / no lo sirve / sin respuesta"; alerta `witness_lost` solo cuando contesta que no tiene lo que aceptó | ✅ | `witness-service.ts`; `witness-verifier.ts` |
| Devolver eventos ajenos al filtro, basura, frames binarios, cortar la conexión | Todo lo recibido se revalida (firma, filtro); el cliente tolera basura y reconecta; tests con un relay hostil en memoria | ✅ | `relay-client.ts`; `test/support/mini-relay.ts` |
| Falsificar o alterar un evento | Firma Schnorr sobre el id recalculado | ✅ | `verifyEvent`; verificador web (cripto propia contrastada con nostr-tools) |
| Borrar en silencio | Reduce redundancia, no verificabilidad: el sello, el `.ots` y el archivo local siguen probando el lote | ✅ | `export-service.ts` |
| Exigir autenticación o pedir rescate | NIP-42 automático con la identidad del agente; un relay que rechaza cuenta como fallo y no bloquea el quórum | ✅ | `relay-client.ts` |

### Verifier comprometido o mal configurado

| Ataque | Cómo se detecta o se impide | Estado | Dónde |
|---|---|---|---|
| Resultados falsos registrados como buenos | Fuera del alcance: Precintum prueba el registro, no el juicio del verifier. El campo `verifier` (hash de la configuración) acota el periodo afectado | ✖ | `receipt.ts` |
| El adaptador manda datos personales por error | Cuarentena: esquema cerrado, cualquier campo ajeno rechaza el mensaje con un 400 genérico y no se registra ni se devuelve; las etiquetas `policy` y `verifier` solo admiten formato de versión o hash (un nombre o un correo no pasan); test de que la PII no sobrevive en recibo, respuesta ni log | ✅ | ADR-0003; `ingest.ts`; `ingest-server.test.ts` |
| Reenvíos y duplicados del adaptador | Idempotencia por identificador de transacción con clave HMAC fija y TTL de 24 h, purgado en cada pase; la misma transacción con otro resultado se rechaza con 409 y gana la primera | ✅ | `record-verification.ts`; `PRECINTUM_DEDUP_KEY` |

### Atacante de red

| Ataque | Cómo se detecta o se impide | Estado | Dónde |
|---|---|---|---|
| Suprimir o retrasar publicaciones | Outbox persistente con reintentos y backoff; quórum; verificación diferida | ✅ | `witness-service.ts` |
| Interceptar credenciales de la TSA | Solo `https://` cuando hay credenciales; TLS en los relays (`wss://`) | ✅ | `config.ts` |
| Colgar el agente con una TSA o un calendario que no contestan | Plazo de 20 s por petición; cierre y reintentos procesan anclajes secuencialmente. Una acumulación puede retrasar el resto del agente; la recuperación de grandes colas sigue pendiente | 🔶 | `shared/http.ts`; `batch-service.ts`; `runner.ts` |
| Alcanzar el panel o la ingesta desde fuera | Ambos escuchan en loopback por defecto; la ingesta exige token (comparación en tiempo constante); el panel avisa si se expone y oculta la contraseña de la base de datos | ✅ | `panel-server.ts`; `ingest-server.ts` |

### Auditor que no confía en el operador

| Necesidad | Cómo se cubre | Estado | Dónde |
|---|---|---|---|
| Comprobar el paquete sin ejecutar software del operador | Verificador en el navegador, un solo fichero, cripto propia, CSP por hashes, sin conexiones; recalcula continuidad, huecos, inclusión, firma, sello (imprint y hora) y `.ots` | ✅ | `web/verificador.html`; `verify-hardening.test.ts` |
| Contrastar con los testigos en vivo | Consulta a los relays desde el verificador | ⏳ | CLI `precintum-verify`, prevista |
| Validar la firma CMS del sello hasta la lista de confianza de la UE | Fuera de la herramienta: DSS; el verificador lo dice en una nota | 🔶 | `notes` de `verifyPackage` |
| Recuperar los anclajes si el operador destruye todo | Hoy los anclajes viven en la base de datos y en el paquete; publicar el `.ots` y el token en los relays con un kind propio | ⏳ | Publicación de anclas en relays, prevista |

### Observador externo (competidor, prensa, el propio relay)

| Ataque | Cómo se detecta o se impide | Estado | Dónde |
|---|---|---|---|
| Medir el volumen y los horarios del cliente | Un evento por ventana, también vacía; el recuento va como compromiso con sal; los recibos nunca salen | ✅ | `batch-event.ts` |
| Saber qué cliente es cada npub | La asociación se comunica al auditor, no se publica | ✅ | (organizativo) |
| Saber que el operador está activo | Aceptado por diseño: la cadencia fija revela existencia, no actividad | ✖ | — |

### Riesgo para las personas verificadas (protección de datos)

| Riesgo | Cómo se mitiga | Estado | Dónde |
|---|---|---|---|
| Reidentificar a alguien desde la evidencia | Ocho campos, ninguno derivado de la persona ni de la sesión; nonce aleatorio, no hash con sal; minuto truncado | ✅ | ADR-0001; `receipt.ts` |
| El operador enlaza recibo y sesión | La tabla de deduplicación caduca a las 24 h y se purga; otros registros del operador pueden seguir permitiendo correlación mientras se conserven | 🔶 | `record-verification.ts`; migración 4; retención de los registros del operador |
| Tráfico muy bajo que permita inferir a una persona por el minuto | Ventana de agrupación configurable (5-10 min) y publicación por lotes; lo decide la evaluación de impacto del operador | 🔶 | `PRECINTUM_BATCH_WINDOW_SECONDS` |

## Supuestos

La clave raíz se custodia fuera de línea. Al menos un testigo externo conserva los eventos o, si no,
el paquete lleva las pruebas de tiempo completas. El auditor dispone de un nodo Bitcoin o de un
explorador de confianza para el `.ots`, y de DSS para la firma CMS del sello. El reloj del agente
está sincronizado (NTP); la tolerancia de 120 s cubre el desfase normal.

## Lo que este documento no cubre

Seguridad del verifier EUDI y de la wallet (son de la Comisión y de los Estados); la infraestructura
del operador (parcheado, acceso a la base de datos, copias de seguridad); la disponibilidad de los
calendarios OpenTimestamps y de la TSA como servicio (se reintenta, no se sustituye).

## Lo que queda abierto

Automonitorización del propio pubkey, directorio de claves en la verificación, CLI con consulta a
relays, anclajes publicados en relays, firma CMS del sello validada con DSS y custodia de la clave en
HSM/KMS: son las filas 🔶 y ⏳ de arriba, y el trabajo previsto del proyecto.
