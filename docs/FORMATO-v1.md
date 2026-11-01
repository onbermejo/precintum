# Formato Precintum v1: recibo, cadena, lote, eventos, archivo y paquete de evidencia

> Especificación del formato que produce el agente y que verifica cualquier tercero. Todo lo que
> aquí se describe está implementado en `src/domain/evidence/` y comprobado por
> `test/format-vectors.test.ts`, que fija los vectores de este documento: si un vector cambia, el
> formato ha cambiado y hay que publicar un v2 con dominios nuevos, no editar el documento. Los
> vectores se regeneran con `pnpm vectors` (`scripts/format-vectors.ts`). Estado: 2026-09-05.

## 0. Convenciones

- Hash: SHA-256. Todos los hashes se escriben en hexadecimal minúsculo de 64 caracteres.
- Enteros: enteros seguros de JavaScript (≤ 2^53 − 1), en segundos Unix cuando son instantes.
- JSON canónico (para lo que se hashea): objeto plano, claves ordenadas por unidades de código
  UTF-16 (como RFC 8785), sin espacios, valores `undefined` omitidos, sin números no enteros.
- Los eventos Nostr siguen NIP-01: `id` = SHA-256 de `[0, pubkey, created_at, kind, tags, content]`
  serializado como JSON sin espacios; firma Schnorr BIP-340 sobre `id`.

### 0.1 Hash con dominio

Nada se hashea "a pelo". Cada artefacto lleva una etiqueta de dominio para que un verificador no
pueda aceptar el artefacto equivocado ni un atacante presentar un nodo como hoja:

```
H(dominio, datos) = SHA-256( UTF-8(dominio) || 0x0a || datos )
```

| Dominio | Uso |
|---|---|
| `precintum/receipt/v1` | hash de un recibo |
| `precintum/genesis/v1` | hash del "recibo cero" (`GENESIS`) |
| `precintum/count/v1` | compromiso del recuento de un lote |
| `precintum/archive/v1` | hash de una línea del archivo append-only |
| `precintum/batch/v1` | reservado para la cadena de lotes |

Excepción deliberada: las hojas y nodos del árbol de Merkle usan los prefijos `0x00` y `0x01` de
RFC 6962 (§3), para que un tercero pueda reimplementar la verificación desde la RFC.

```
GENESIS = H("precintum/genesis/v1", "")   = 7e6c350b2f5acef23c91fad3a671761d6ac9d4f23e22a4a58b140140ddcd61fd
EMPTY_ROOT = SHA-256("")                   = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
```

## 1. El recibo

Un recibo es un objeto JSON con **exactamente** estos ocho campos (esquema cerrado: cualquier campo
adicional invalida el recibo).

| Campo | Tipo | Regla |
|---|---|---|
| `v` | entero | siempre `1` |
| `seq` | entero ≥ 1 | posición en la cadena, consecutiva |
| `prev` | hex64 | hash del recibo anterior; `GENESIS` en el primero |
| `nonce` | hex64 | 32 bytes aleatorios generados por el agente; no es función de nada externo |
| `policy` | hex64 | hash de la política aplicada (por defecto `SHA-256("age_over_18/v1")`, o el hex que configure el operador) |
| `verifier` | hex64 | hash de la configuración del software que decidió |
| `result` | cadena | `over_18` \| `under_18` \| `error` |
| `ts` | entero ≥ 0 | instante de registro en segundos Unix, **múltiplo de 60** (truncado al minuto) |

Lo que no hay y no habrá en v1: identificador de sesión o de transacción del verifier (ni hasheado
ni con sal), atributos de la persona, IP, identificador de wallet o de dispositivo, instante exacto.
La razón está en `docs/adr/0001-esquema-recibo-v1.md`.

```
hash(recibo) = H("precintum/receipt/v1", UTF-8(JSON canónico del recibo))
```

### 1.1 Reglas de la cadena

1. `seq` empieza en 1 y avanza de uno en uno, sin huecos.
2. `prev` del recibo `n` es el hash del recibo `n − 1`; el del primero es `GENESIS`.
3. `ts` no decrece a lo largo de la cadena. Además, el agente nunca da a un recibo un `ts` anterior
   al fin de la última ventana ya publicada como lote (política de tiempo de la ingesta): así un
   recibo no puede "colarse" en una ventana cerrada. Un verificador que reciba recibos cuya ventana
   ya tenía lote publicado debe marcarlos como huérfanos.

### 1.2 Vectores

Política y verifier de ejemplo: `policy = SHA-256("age_over_18/v1")`,
`verifier = SHA-256("av-srv-verifier-endpoint/0.11.0")`.

```
policy   = 1027bd716c3cca38b1eaad5bae0246e06cba9f82d350ef92f58e2ac9e9fb324f
verifier = cb18e2135d836b6231cc7f33d833faa46f3e3f5537da0997ad5219649e38b372
```

Recibo 1 (canónico, en una sola línea):

```
{"nonce":"1111111111111111111111111111111111111111111111111111111111111111","policy":"1027bd716c3cca38b1eaad5bae0246e06cba9f82d350ef92f58e2ac9e9fb324f","prev":"7e6c350b2f5acef23c91fad3a671761d6ac9d4f23e22a4a58b140140ddcd61fd","result":"over_18","seq":1,"ts":1700000040,"v":1,"verifier":"cb18e2135d836b6231cc7f33d833faa46f3e3f5537da0997ad5219649e38b372"}
hash = 368e28f36234a7a1e91091d7ba6317e722c5ebce95b17366eb0866106aa97f70
```

Recibo 2: `nonce = 22…22`, `prev = 368e28f3…7f70`, `result = under_18`, `seq = 2`, `ts = 1700000100`:

```
hash = ee86f7f9e8c690decafcb083484e8501a5906d5922e7b2e9a61319e7c0e0a21c
```

Recibo 3: `nonce = 33…33`, `prev = ee86f7f9…a21c`, `result = error`, `seq = 3`, `ts = 1700000160`:

```
hash = ece53f79344102646850d62916f867c96785ed1a326bd75acbf6cb775be461ac
```

## 2. El lote

### 2.1 Ventanas

El tiempo se divide en ventanas alineadas de `W` segundos (3600 por defecto; configurable, mínimo
60): la ventana de un instante `ts` es `[k·W, (k+1)·W)` con `k = floor(ts / W)`. Cada ventana
produce **exactamente un lote**, también si no tiene recibos (latido). Un lote contiene los recibos
cuyo `ts` cae en su ventana, en orden de `seq`.

### 2.2 Árbol de Merkle (RFC 6962 §2.1)

Las hojas son los hashes de los recibos de la ventana, en orden de `seq`.

```
MTH({})    = SHA-256("")                                   (lote vacío: EMPTY_ROOT)
MTH({d0})  = SHA-256(0x00 || d0)
MTH(D[n])  = SHA-256(0x01 || MTH(D[0:k]) || MTH(D[k:n]))   k = mayor potencia de 2 menor que n
```

La prueba de inclusión de la hoja `i` es la de RFC 6962 §2.1.1 (hermanos de la hoja a la raíz) y se
verifica con el algoritmo de RFC 9162 §2.1.3.2 sobre `{index, size, path}`.

Vectores con las hojas `[hash(r1), hash(r2), hash(r3)]`:

```
MTH([h1])          = 6f2ef8077e09a3f0e559720e1a5048938e43b4574c6ab4993ac7fc3db5509c76
MTH([h1, h2])      = b2dfda4127866d3776343f73bdf411a1b6ab8baf53ed06b5c6a8049b26af6028
MTH([h1, h2, h3])  = 32399b79a2d3e559b39f8a4749f0a61441645684caf025f6e38da5a28ed88564
prueba de h2 en [h1, h2, h3]:
  index = 1, size = 3
  path  = [ 6f2ef8077e09a3f0e559720e1a5048938e43b4574c6ab4993ac7fc3db5509c76,
            34ab7147b915657cb550544abe586bb59d8bfa3dc72080db0c7b90bd0934801b ]
```

### 2.3 Compromiso del recuento

El número de recibos del lote no se publica en claro. Se publica un compromiso y la sal se entrega
solo al auditor, dentro del paquete:

```
commit(count, salt) = H("precintum/count/v1", UTF-8(`${count}:${salt}`))    salt: hex64 aleatoria por lote
commit(3, "44…44")  = 91962088d23594e5f2021ee3620302ba04d3f9f89e167483ba17e0d7a474808d
```

### 2.4 Cadena de lotes

`seq` de lote empieza en 1 y es consecutivo; `prev` de un lote es la raíz del lote anterior
(`GENESIS` en el primero). Una ventana sin lote dentro del periodo de servicio es un hueco, y un
verificador debe señalarlo.

## 3. El evento de lote (`kind 7676`)

Es lo **único** que el agente publica en relays públicos. Evento Nostr regular (no reemplazable).

| Parte | Contenido |
|---|---|
| `kind` | `7676` |
| `created_at` | instante de cierre del lote; **nunca anterior** al fin de la ventana |
| `content` | raíz Merkle del lote (hex64) |
| `tags` | `["v","1"]`, `["seq","<n>"]`, `["prev","<raíz anterior o GENESIS>"]`, `["window","<ini>","<fin>"]`, `["policy","<hex64>"]`, `["count","<compromiso>"]` |

Reglas de análisis: cada etiqueta del formato aparece **exactamente una vez** (una repetida invalida
el evento: dos verificadores podrían leer valores distintos); `window` tiene exactamente tres
elementos y `ini < fin`; `seq` y los extremos de la ventana son enteros decimales sin ceros a la
izquierda; las etiquetas ajenas al formato se ignoran. El evento no lleva hashes de recibos, ni el
recuento en claro, ni `["client", …]`.

Vector, con la identidad de pruebas `pubkey = 147b42e0d67759fa91c6f831e9cde86e8d2e5135af77c18d3413a404bd1f6b03`
(la firma varía en cada ejecución; el `id` no):

```
kind = 7676, created_at = 1700002800
tags = [["v","1"],["seq","1"],
        ["prev","7e6c350b2f5acef23c91fad3a671761d6ac9d4f23e22a4a58b140140ddcd61fd"],
        ["window","1699999200","1700002800"],
        ["policy","1027bd716c3cca38b1eaad5bae0246e06cba9f82d350ef92f58e2ac9e9fb324f"],
        ["count","91962088d23594e5f2021ee3620302ba04d3f9f89e167483ba17e0d7a474808d"]]
content = 32399b79a2d3e559b39f8a4749f0a61441645684caf025f6e38da5a28ed88564
id = fb0bb11ad4617bd6ea2bf3484b2285f449b5288c5d0bc1d514c2914c8999cf0f
```

## 4. El directorio de claves (`kind 37676`)

Evento *addressable* firmado por la **clave raíz** del operador; el relay conserva la última versión
por `(pubkey, d)`. Dice qué claves de agente eran válidas en qué ventanas.

| Parte | Contenido |
|---|---|
| `kind` | `37676` |
| `tags` | `["d","precintum/keys"]` |
| `content` | `{"v":1,"keys":[{"pubkey":"<hex64>","from":<seg>,"to":<seg>|null}, …]}` con este orden de campos |

`from` es inclusivo, `to` exclusivo y `null` significa vigente. Revocar es publicar una versión nueva
con `to` fijado. Un lote es aceptable solo si su `pubkey` estaba vigente en su `created_at`.

```
content = {"v":1,"keys":[{"pubkey":"147b42e0d67759fa91c6f831e9cde86e8d2e5135af77c18d3413a404bd1f6b03","from":1699999200,"to":null}]}
created_at = 1699999200 (firmado, en el vector, por la misma identidad)
id = 1b2eb99c2c4321a6f55e841875a95d20b058e3678373c390747f6c8e19daf145
```

Una petición de borrado NIP-09 (`kind 5`) firmada por el agente o por la raíz, o dirigida al
directorio (`["a","37676:<raíz>:precintum/keys"]`), es una **alerta**, nunca una orden.

## 5. El archivo append-only

Fichero JSONL en el servidor del operador. Cada línea es `{"seq","prev","hash","event"}` con el
evento de lote firmado completo. Solo se anexa (con `fdatasync`); nunca se reescribe.

```
hash(línea) = H("precintum/archive/v1", UTF-8(JSON canónico de {seq, prev, event_id, pubkey}))
prev de la primera línea = GENESIS
```

```
{"event_id":"fb0bb11ad4617bd6ea2bf3484b2285f449b5288c5d0bc1d514c2914c8999cf0f","prev":"7e6c350b2f5acef23c91fad3a671761d6ac9d4f23e22a4a58b140140ddcd61fd","pubkey":"147b42e0d67759fa91c6f831e9cde86e8d2e5135af77c18d3413a404bd1f6b03","seq":1}
hash = 4e5acac128a6750b1a2d7c2d87d644afbd5e7aebcf0c3cc99e4a29bddba6b6d0
```

## 6. Pruebas de tiempo

- **Sello RFC 3161.** Se pide a la TSA un sello del `id` del evento de lote (32 bytes, SHA-256). El
  token (DER, `TimeStampToken`) es válido para el lote si su `messageImprint` es exactamente ese `id`
  y su `genTime` cumple la regla de ventana de anclaje.
- **OpenTimestamps.** Fichero `.ots` *detached* cuyo digest es el `id` del evento. Está completo
  cuando alguna rama termina en una atestación Bitcoin; la altura del bloque da la segunda prueba de
  tiempo.
- **Regla de ventana de anclaje.** Sea `gap = instante de la prueba − fin de la ventana`. El lote es
  correcto si `0 ≤ gap ≤ G` (por defecto `G = 86 400` s, configurable y transportado en el paquete).
  Un `gap` entre −120 s y 0 se admite como aviso (desfase de reloj o `accuracy` de la TSA); uno menor
  es una imposibilidad y uno mayor que `G` es sospechoso de antedatado con clave robada.

## 7. El paquete de evidencia (`precintum/export/v1`)

JSON que el operador entrega al auditor para un rango de fechas, expandido a ventanas completas.

| Campo | Contenido |
|---|---|
| `format` | `"precintum/export/v1"` |
| `requested`, `covered` | rango pedido y rango entregado `[ini, fin]` |
| `windowSeconds`, `anchorMaxGapSeconds` | `W` y `G` con los que operaba el agente |
| `agentPubkey` | clave del agente **según el operador** (declaración: contrastar con otro canal) |
| `precedingReceiptHash` | `prev` del primer recibo entregado (viaja dentro de él; no hay que recalcularlo) |
| `serviceStart`, `serviceEnd` | periodo en el que existe registro (ventanas anteriores no son huecos) |
| `batches[]` | por lote: `seq`, `root`, `prevRoot`, `window`, `policy`, `count`, `countSalt`, `eventId`, `event` (firmado, tal cual se publicó), `tsaTokenDer` y `tsaGenTime` (o `null`), `ots` y `otsComplete`, `receipts[]`, `proofs[]` (`{receiptSeq, receiptHash, batchSeq, root, proof:{index,size,path}}`) |
| `gaps[]` | ventanas del periodo de servicio sin lote |
| `totals` | `batches`, `receipts`, `empty`, `withoutTsa`, `withoutOts`, `windowsBeforeService`, `windowsNotClosed` |
| `batchChainOk` | continuidad declarada (el verificador la recalcula) |
| `notice` | texto fijo que dice lo que el paquete no contiene |

### 7.1 Lo que un verificador debe comprobar, sin creerse nada declarado

1. Esquema de cada recibo (§1) y su hash.
2. Cadena de recibos: `seq` consecutivo, `prev` encadenado, `ts` no decreciente, cada recibo dentro
   de la ventana de su lote; huérfanos si su ventana ya tenía lote.
3. Por lote: raíz recalculada desde los recibos entregados igual a `root` y a `event.content`;
   `count` igual al número de recibos y `commit(count, countSalt)` igual a la etiqueta `count`;
   pruebas de inclusión válidas; `id` del evento recalculado igual a `event.id` y a `eventId`; firma
   Schnorr válida sobre el `id` recalculado; etiquetas coherentes con los campos del lote;
   `created_at ≥ fin de ventana`.
4. Cadena de lotes recalculada: `seq` consecutivo y `prevRoot` = raíz anterior; huecos recalculados
   frente al periodo de servicio, y comparados con `gaps` y `batchChainOk` declarados.
5. Una sola clave firmante en todo el paquete, igual a `agentPubkey` y a la que el auditor conozca
   por otro canal.
6. Sello: `messageImprint` = `eventId`, `genTime` del DER (no el declarado) dentro de la regla de
   ventana de anclaje. `.ots`: digest = `eventId`; atestación Bitcoin presente si `otsComplete`.
7. Lo que no puede comprobarse sin salir del paquete se dice como nota, no como éxito: firma CMS del
   sello y su cadena hasta la lista de confianza (DSS), altura del bloque contra un nodo Bitcoin,
   presencia de los eventos en los relays.

Las implementaciones de referencia son `application/export-service.ts` (`verifyPackage`) y
`web/verify/src/11-checks.js` (navegador), contrastadas entre sí en `test/verify-hardening.test.ts`.

## Anexo A. Ingesta (`POST /receipts`)

No forma parte del formato de evidencia, pero define qué entra. Cuerpo JSON de esquema cerrado
(ADR-0003): `transactionId` (1-256 caracteres), `result` (`over_18` \| `under_18` \| `error`),
`policy` (opcional; etiqueta o hex), `verifier` (opcional), `at` (opcional, segundos Unix). Máximo
4 KB. Respuestas: `201` recibo creado, `200` ya existía (idempotencia por `transactionId`), `400`
esquema inválido (mensaje genérico, sin eco del cuerpo), `401` sin token, `413` cuerpo grande, `422`
instante demasiado en el futuro.

## Anexo B. Versionado

Cualquier cambio en la canonicalización, en los dominios, en los campos del recibo, en las etiquetas
del evento o en el árbol es incompatible y exige `v2` con dominios `precintum/*/v2` y un kind nuevo si
cambia el evento. Los vectores de este documento están fijados por `test/format-vectors.test.ts`.
