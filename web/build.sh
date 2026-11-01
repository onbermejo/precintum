#!/usr/bin/env bash
# Ensambla las páginas de web/. La lógica vive en build.mjs (documento HTML completo, CSP con
# hashes de los scripts incrustados, sin fuentes externas, HASHES.txt con las huellas).
#   bash build.sh
set -euo pipefail
cd "$(dirname "$0")"
node build.mjs "$@"
