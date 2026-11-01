# ADR-0003 — Ingesta de verificaciones y cuarentena

- **Estado:** aceptado (2026-09-05)
- **Contexto:** hasta ahora los recibos solo entraban por la CLI (`receipt add`). El verifier de
  referencia del EU Age Verification Blueprint no tiene webhook: el resultado se recupera por
  *polling* y la respuesta completa contiene la presentación de la wallet (comprobado en septiembre de
  2026). Además existe `GET /ui/presentations/{id}/events`, que desde junio de
  2026 conserva un registro "PII-free" del que aún no se ha comprobado si basta para obtener el
  resultado (pendiente de validar durante la integración). Otras fuentes son los
  vendors comerciales que envían eventos por webhook. La ingesta tiene que servir a los dos
  mundos y garantizar por construcción que nada del usuario llega al recibo.

## Decisión

### Un único punto de entrada: `POST /receipts`

El agente expone `POST /receipts` (en el proceso `precintum run`, ADR-0002). Cualquier fuente,
sea el adaptador del verifier EUDI, un webhook de un vendor o la propia CLI, convierte su evento en
el **mensaje de ingesta** y lo envía ahí. El adaptador vive fuera del agente y es reemplazable; el
agente solo conoce el mensaje.

```json
{
  "transactionId": "…",          // solo para idempotencia; nunca entra en el recibo
  "result": "over_18" | "under_18" | "error",
  "policy": "age_over_18/v1",     // etiqueta de versión o hash hex; se hashea si es etiqueta
  "verifier": "av-verifier/0.11", // ídem, de la configuración del verifier
  "at": 1789000000                // opcional; segundos unix según el adaptador
}
```

### La cuarentena es el propio esquema

El cuerpo se valida con un esquema **estricto y cerrado** (`z.strictObject`): cualquier campo que
no sea uno de los cinco anteriores hace que la petición se rechace con `400` **sin describir el
campo**. No hay "extraer lo que interesa e ignorar el resto": lo que no está en el esquema no se
lee, no se registra y no se responde. Consecuencias que se prueban con tests:

- un cuerpo con campos de más (`name`, `birth_date`, `vp_token`, cabeceras de sesión) se rechaza y
  ninguno de esos valores aparece en el recibo, en la base de datos, en la respuesta ni en el log;
- el log de la ingesta solo registra `seq`, `result`, `created` y `adjusted`: nunca el cuerpo ni
  el `transactionId`;
- la respuesta es `{ seq, created, adjusted }`; el error `400` es genérico;
- `policy` y `verifier` solo admiten una etiqueta de versión (letras, números y `. _ : / -`, hasta 64)
  o un hash hex: se hashean sin sal y van al recibo, así que un texto libre (un nombre, un correo)
  dejaría en él un hash adivinable;
- la misma `transactionId` con otro `result` se rechaza con `409` (gana la primera) y el log solo
  dice que hubo conflicto.

El adaptador es quien reduce la respuesta del verifier (o del vendor) al mensaje; si se equivoca y
manda más, el agente lo rechaza. Así el punto donde la PII podría colarse es un componente pequeño,
externo y con contrato, y el agente no puede almacenarla ni por error.

### Autenticación y red

`Authorization: Bearer <PRECINTUM_INGEST_TOKEN>`; el token es obligatorio (sin él `run` no arranca la
ingesta) y se compara en tiempo constante. El servidor escucha en `127.0.0.1` por defecto. En un
despliegue en contenedores, el adaptador y el agente deben compartir una red interna. Cuerpos de más de 4 KB se
rechazan con `413`.

### Tiempo

`at` es el instante que declara el adaptador; el recibo registra la hora de **registro** según las
reglas de `recordVerification`: nunca antes de la cabeza de la cadena ni de la última ventana
cerrada, y nunca más de `PRECINTUM_MAX_FUTURE_SKEW_SECONDS` por delante del reloj del agente (se
rechaza con `422`). Si `at` no viene, es el reloj del agente.

### Idempotencia

`transactionId` es la clave de deduplicación (HMAC con `PRECINTUM_DEDUP_KEY`, ADR-0001). Reintentos y
replays devuelven el mismo `seq` con `created: false`. El adaptador debe usar el identificador que
el verifier o el vendor da a la transacción, no uno propio.

### Adaptadores

- **Adaptador del verifier AV de referencia, previsto:** sondeará el verifier y
  publicará el mensaje. Si `GET /ui/presentations/{id}/events` basta para conocer el resultado, el
  adaptador no pedirá la presentación completa; si no basta, la recuperará, la reducirá en
  memoria y la descartará. Ese componente deberá tener su propio test de "nada del `vp_token` sobrevive".
- **Webhook genérico**: cualquier vendor que empuje eventos configura la URL de la ingesta; una
  función de mapeo por vendor produce el mensaje. La CLI `receipt add` pasa a ser un cliente más
  de la ingesta cuando `run` está arrancado, y sigue escribiendo directo cuando no lo está.

## Alternativas descartadas

- **Que el agente hable directamente con el verifier.** Acopla el agente a una API que cambia cada
  pocos meses y mete la PII efímera dentro del proceso que custodia la evidencia.
- **Un esquema permisivo que ignore campos desconocidos.** Es exactamente cómo la PII acaba en un
  log: lo que se ignora hoy se registra mañana en un `debug`.
- **Autenticación mutua TLS desde el primer día.** Deseable para producción; el prototipo usa el
  token sobre una red local. mTLS se evaluará al diseñar el despliegue de producción.

## Consecuencias

- Nuevo servidor `infra/http/ingest-server.ts` y esquema `application/ingest.ts`, con tests que
  mandan PII y comprueban que no sobrevive en ningún sitio.
- Variables nuevas: `PRECINTUM_INGEST_TOKEN`, `PRECINTUM_INGEST_HOST`, `PRECINTUM_INGEST_PORT`.
- La integración debe confirmar qué endpoint proporciona el resultado sin recuperar datos personales
  innecesarios.
