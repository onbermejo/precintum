// Ensambla las páginas de web/ a partir de sus fuentes. Se ejecuta desde cualquier sitio:
//   node web/build.mjs
//
// Cada página sale como documento HTML completo (doctype, lang, charset, viewport) con una
// Content-Security-Policy en <meta> que solo admite los <script> incrustados, identificados por su
// hash SHA-256, y sin conexiones salientes salvo las que la página necesita. Las fuentes de
// Google se retiran: la promesa "nada sale de tu navegador" incluye no avisar a nadie de que la
// página se ha abierto. Las pilas de fuentes de la CSS ya llevan alternativas del sistema.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p) => readFileSync(join(here, p), 'utf8');

const stripExternalFonts = (html) =>
  html
    .split('\n')
    .filter((line) => !/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(line))
    .join('\n');

const sha256b64 = (s) => createHash('sha256').update(s, 'utf8').digest('base64');

/**
 * Página = cabecera (title + style) + cuerpo + scripts incrustados. Devuelve el documento y los
 * hashes de los scripts para la CSP.
 */
function page({ lang, head, body, scripts, connect = "'none'", img = 'data:' }) {
  const blocks = scripts.map((code) => ({ code, hash: `'sha256-${sha256b64(code)}'` }));
  const csp = [
    "default-src 'none'",
    `script-src ${blocks.length ? blocks.map((b) => b.hash).join(' ') : "'none'"}`,
    "style-src 'unsafe-inline'",
    `img-src ${img}`,
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return (
    `<!doctype html>\n<html lang="${lang}">\n<head>\n<meta charset="utf-8">\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
    `${stripExternalFonts(head).trim()}\n</head>\n<body>\n${body.trim()}\n` +
    blocks.map((b) => `<script>${b.code}</script>`).join('\n') +
    '\n</body>\n</html>\n'
  );
}

const out = {};

// 1. Caso de uso interactivo (español).
out['caso-nora.html'] = page({
  lang: 'es',
  head: read('src/01-head.html'),
  body: read('src/02-body.html'),
  scripts: [
    read('src/03-crypto.js'),
    [read('src/04a-data.js'), read('src/04b-data.js'), read('src/05a-model.js'), read('src/05b-ui.js')].join('\n'),
  ],
});

// 2. Verificador independiente. El paquete de ejemplo lo regenera:
//    cd .. && node scripts/make-web-example.ts
out['verificador.html'] = page({
  lang: 'en',
  head: read('verify/src/01-head.html'),
  body: read('verify/src/02-body.html'),
  scripts: [
    read('verify/src/10-crypto.js'),
    read('verify/src/11-checks.js'),
    read('verify/src/13-example.js'),
    read('verify/src/12-ui.js'),
  ],
});

// 3. Panel de operación. Dos copias del mismo código:
//    - la que sirve `precintum serve`, sin datos: si su API falla, muestra el error de verdad;
//    - panel-demo.html, con datos de demostración incrustados, para revisar el diseño sin arrancar
//      el agente. Se regeneran con: cd .. && node scripts/make-panel-demo.ts
const panelHead = read('admin/src/01-head.html');
const panelBody = read('admin/src/02-body.html');
const panelUi = read('admin/src/10-ui.js');
out['../src/infra/http/panel.html'] = page({
  lang: 'en',
  head: panelHead,
  body: panelBody,
  scripts: [panelUi],
  connect: "'self'",
});
out['panel-demo.html'] = page({
  lang: 'en',
  head: panelHead,
  body: panelBody,
  scripts: [read('admin/src/11-demo.js'), panelUi],
  connect: "'self'",
});

const hashes = [];
for (const [name, html] of Object.entries(out)) {
  const target = join(here, name);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, html, 'utf8');
  const sha = createHash('sha256').update(html, 'utf8').digest('hex');
  hashes.push(`${sha}  ${name}`);
  console.log(`${name}: ${Buffer.byteLength(html, 'utf8')} bytes`);
}
// Huellas de las páginas: un inspector puede comprobar que su copia del verificador es la
// publicada (sha256sum verificador.html).
writeFileSync(join(here, 'HASHES.txt'), `${hashes.join('\n')}\n`, 'utf8');
console.log('HASHES.txt actualizado');
