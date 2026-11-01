# ADR-0002 — El agente como proceso

- **Estado:** aceptado (2026-09-05)
- **Contexto:** inicialmente solo había comandos de una sola ejecución
  (`batch close`, `witness run`, `anchor upgrade`, `witness check`, `witness deletions`) más un
  panel aparte (`serve`). Nada corría cada hora, aunque el producto promete "cada hora publica
  una raíz". Consecuencias detectadas: si el operador no ejecuta `batch close` a tiempo, el cierre
  en bloque de las ventanas atrasadas lleva sellos de hoy que la propia regla de ventana de
  anclaje marca en rojo; la seguridad dependía de un cron externo que ningún documento describía;
  y con la base de datos por defecto (PGlite, un solo proceso) el panel y los comandos no podían
  convivir. La ingesta, la exportación y el despliegue necesitan un proceso continuo coordinado.

## Decisión

### Un solo proceso largo: `precintum run`

`precintum run` aloja en un mismo proceso:

1. **La ingesta** (`POST /receipts`, ADR-0003): el único camino por el que entran verificaciones en
   producción.
2. **El planificador**: cierre de ventanas, publicación en los testigos, anclajes, comprobación de
   presencia en los relays y detección de peticiones de borrado NIP-09, cada uno con su cadencia.
3. **El panel de operación** de solo lectura y `/metrics` (lo que hoy hace `serve`).
4. **`/health`** para Docker y para los orquestadores: responde 200 mientras el planificador
   avanza y 503 si lleva demasiado sin completar un pase.

Los comandos de una ejecución siguen existiendo para la demo, la depuración y la recuperación
manual, y comparten el mismo código que el planificador (`BatchService`, `WitnessWorker`,
`checkPresence`, `detectDeletions`). No hay dos implementaciones.

### Cadencias por defecto

| Tarea | Cadencia | Por qué |
|---|---|---|
| Cerrar ventanas terminadas (`closeDueWindows`) | cada 30 s | El cierre real lo decide la ventana más el periodo de gracia; el bucle solo comprueba si toca |
| Publicar la outbox en los relays (`runOnce`) | cada 30 s | La outbox ya reintenta con backoff; el bucle la vacía en cuanto hay algo |
| Anclajes pendientes (`anchorPending`) | cada 10 min | Los calendarios OpenTimestamps tardan horas en atestar; preguntar más a menudo no ayuda |
| Presencia en los testigos (`checkPresence` de los últimos lotes) | cada 6 h | Detecta relays que "olvidan"; una vez al día sería tarde para reaccionar, cada minuto es ruido |
| Peticiones de borrado NIP-09 (`detectDeletions`) | cada 1 h | Un `kind 5` del propio agente es alerta de primer nivel |
| Purga de la tabla de deduplicación | en cada cierre | Ya lo hace `closeDueWindows` |

Todas las cadencias son configurables por variables de entorno con el prefijo `PRECINTUM_RUN_`;
el planificador tolera que un pase tarde más que su cadencia (no se solapan: cada tarea corre
cuando termina la anterior).

### Reglas

- **Una instancia por base de datos.** Con PGlite lo impone el bloqueo de fichero; con PostgreSQL
  el lock de advisory de la cadena impide que dos instancias se pisen al ingerir o cerrar, pero
  no evita trabajo duplicado: se documenta que `run` debe ser único por despliegue.
- **Apagado limpio.** `SIGINT`/`SIGTERM` terminan el pase en curso, cierran los relays y la base
  de datos, y liberan el bloqueo de PGlite. El planificador no deja lotes a medias: el cierre es
  transaccional (ADR-0001).
- **El panel no escribe.** Sigue siendo solo GET/HEAD; compartir proceso con la ingesta no le da
  ninguna ruta de escritura.
- **La ingesta se autentica.** Un token compartido con el adaptador del verifier
  (`PRECINTUM_INGEST_TOKEN`), obligatorio; el servidor escucha en la interfaz local por defecto.

## Alternativas descartadas

- **Cron del sistema con los comandos de una ejecución.** Funciona con PostgreSQL, y se documenta
  como alternativa para quien ya opere así, pero deja la seguridad del sistema en manos de un
  fichero de cron que nadie audita, no puede alojar la ingesta HTTP y no funciona con PGlite.
- **Un contenedor por tarea (agente, panel, ingesta).** Más superficie, más configuración y el
  mismo problema de instancia única sobre PGlite. Se podrá separar cuando haya un cliente que lo
  necesite; el código ya está en servicios independientes.
- **Planificador dentro del panel (`serve`).** Mezclaría un proceso pensado para ser inofensivo
  con las escrituras; `run` es el que escribe y `serve` queda para inspeccionar sin tocar.

## Consecuencias

- El adaptador del verifier se integra con `precintum run`: habla con
  `POST /receipts`, no con la base de datos.
- El despliegue en contenedores previsto agrupará `precintum run` con PostgreSQL y el
  relay privado; `/health` servirá como comprobación de salud.
- La demo se ejecuta desde una sola terminal.
