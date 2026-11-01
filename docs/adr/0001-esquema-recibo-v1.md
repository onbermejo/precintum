# ADR-0001 — Esquema del recibo v1 y del evento de lote

- **Estado:** aceptado (2026-09-03)
- **Contexto:** el diseño debe fijar cómo generar la unicidad del recibo sin derivarla de identificadores del verifier y qué publicar en relays: recibos individuales o una raíz por lote.

## Decisión

### Recibo v1

| Campo | Tipo | Origen | Por qué está |
|---|---|---|---|
| `v` | `1` | constante | versionar el esquema desde el primer día |
| `seq` | entero ≥ 1 | cadena | posición; detecta huecos y duplicados |
| `prev` | hex 64 | cadena | hash del recibo anterior (o `GENESIS`); integridad |
| `nonce` | hex 64 | CSPRNG de Precintum | unicidad del recibo **sin** relación con nada del verifier |
| `policy` | hex 64 | configuración | hash de la política aplicada; prueba "qué se exigió" |
| `verifier` | hex 64 | configuración | hash de la configuración del verifier; prueba "qué software decidió" |
| `result` | `over_18` \| `under_18` \| `error` | verifier (tras cuarentena) | el resultado; el motivo de error no entra (podría filtrar) |
| `ts` | entero, múltiplo de 60 | reloj de Precintum | minuto de la verificación; el segundo exacto no aporta y facilita correlación |

Campos que **no** existen y no existirán: identificador de sesión o transacción del verifier ni ningún derivado suyo (hash, HMAC, hash con sal), atributos de la credencial, dirección IP, identificador de wallet, agente de usuario, timestamp al segundo.

Hash del recibo: `sha256("precintum/receipt/v1" || 0x0a || JSON canónico)`. JSON canónico: claves ordenadas, sin espacios, solo enteros seguros.

### Idempotencia sin contaminar el recibo

La única necesidad legítima de relacionar un recibo con la transacción del verifier es no registrar dos veces la misma (reintentos del adaptador, replays). Se resuelve fuera del recibo: tabla `ingest_dedup(key, seq, expires_at)` con `key = HMAC-SHA256(k_operador, transaction_id)`, TTL corto (24 h por defecto) y purga. El recibo es dato personal seudónimo **para el operador** mientras exista cualquier conjunto de datos suyo que permita reenlazarlo: la fila de `ingest_dedup`, los logs del verifier o los de acceso de la plataforma con hora y resultado. Deja de serlo para el operador solo cuando todos se han borrado; para un tercero que recibe el paquete sin esos datos no lo es (TJUE C-413/23 P, EDPB 01/2025 §22). La tabla de deduplicación acota uno de esos enlaces, no todos; la plantilla de DPIA fija la retención de los demás y, para operadores con poco tráfico, valora una granularidad de `ts` mayor que el minuto.

### Evento de lote (lo único que va a relays públicos)

`kind 7676` (regular; sin asignar en el README de NIPs a 2026-09-02; provisional). `content` = raíz Merkle. Tags: `v`, `seq` (número de lote), `prev` (raíz anterior), `window` (inicio, fin), `policy`, `count` (compromiso `sha256("precintum/count/v1" || 0x0a || "recuento:sal")`). Un evento por ventana fija, **también si el lote está vacío**. Sin hashes de recibos, sin recuento en claro, sin tag `client`.

### Directorio de claves

`kind 37676` (direccionable, `d = "precintum/keys"`), firmado por una clave raíz del operador custodiada fuera de línea, con ventanas de validez por pubkey de agente. El diseño previsto es que el verificador acepte un lote solo si su pubkey era válida en su `created_at`, con el directorio anclado. El formato y sus helpers de dominio existen; la publicación operacional, el anclaje y su uso en la verificación de paquetes siguen pendientes.

## Alternativas descartadas

- **Id de sesión salteado en el recibo**: enlazable con los logs del verifier mientras exista la sal; la EDPB 02/2025 v2 (párr. 52) lo considera dato personal. Rompe la promesa "nada del usuario".
- **Evento por recibo en relays públicos**: expone la curva de tráfico del cliente al segundo, inviable con los volúmenes del pricing, y choca con las políticas antispam de los relays gratuitos.
- **Timestamp al segundo**: más correlación con logs externos a cambio de una precisión que ningún regulador exige por sesión.
- **NIP-03 / `kind 1040`** para el anclaje: marcado *unrecommended* en el índice oficial; se ancla el id del evento de lote con OTS directamente.

## Consecuencias

- El contrato de ingesta admite `{transactionId, result, policy, verifier, at?}`; el recibo no conserva el identificador de transacción.
- Los lotes se construyen por ventana, no por tamaño, y se publican también cuando están vacíos.
- La exportación revela `count` y su sal al auditor; en los relays solo se publican compromisos.
- Cambiar el esquema exige `v: 2` y una migración; nunca se muta un recibo existente.
