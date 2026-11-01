/**
 * Criptografía del verificador, sin dependencias: SHA-256 y verificación de firmas Schnorr
 * BIP-340 sobre secp256k1. Vive en el propio fichero de la página para que el auditor no tenga
 * que confiar en ninguna descarga externa ni en el software del operador.
 *
 * Se ejecuta igual en el navegador y en Node, y hay un test en el repositorio
 * (`precintum/test/web-verifier.test.ts`) que lo contrasta contra la implementación del servidor.
 */
(function (root) {
  'use strict';

  /* ======================= SHA-256 ======================= */
  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  function sha256(msg) {
    var l = msg.length;
    var padLen = ((l + 9 + 63) >> 6) << 6;
    var buf = new Uint8Array(padLen);
    buf.set(msg);
    buf[l] = 0x80;
    var dv = new DataView(buf.buffer);
    var bits = l * 8;
    dv.setUint32(padLen - 4, bits >>> 0);
    dv.setUint32(padLen - 8, Math.floor(bits / 0x100000000));
    var H = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    var W = new Uint32Array(64);
    var i;
    for (var off = 0; off < padLen; off += 64) {
      for (i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        var s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    var out = new Uint8Array(32);
    var odv = new DataView(out.buffer);
    for (var j = 0; j < 8; j++) odv.setUint32(j * 4, H[j]);
    return out;
  }

  /* ======================= bytes ======================= */
  var enc = new TextEncoder();
  function utf8(s) { return enc.encode(s); }
  function hex(b) {
    var s = '';
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16);
    return s;
  }
  function isHex64(s) { return typeof s === 'string' && /^[0-9a-f]{64}$/.test(s); }
  function fromHex(h) {
    if (typeof h !== 'string' || h.length % 2 !== 0 || /[^0-9a-f]/.test(h)) {
      throw new Error('no es hexadecimal: ' + String(h).slice(0, 24));
    }
    var o = new Uint8Array(h.length / 2);
    for (var i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
    return o;
  }
  function concat() {
    var n = 0, i;
    for (i = 0; i < arguments.length; i++) n += arguments[i].length;
    var o = new Uint8Array(n), p = 0;
    for (i = 0; i < arguments.length; i++) { o.set(arguments[i], p); p += arguments[i].length; }
    return o;
  }

  /* ======================= secp256k1 / BIP-340 =======================
   * Solo verificación: no firma, no genera claves y no necesita aleatoriedad, así que no hay
   * secreto que proteger frente a canal lateral. Coordenadas jacobianas para evitar una
   * inversión modular en cada duplicación; una sola inversión al final.
   */
  var P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
  var N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  var GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
  var GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

  function mod(a, m) { var r = a % m; return r >= 0n ? r : r + m; }
  function powMod(base, exp, m) {
    var r = 1n, b = mod(base, m), e = exp;
    while (e > 0n) {
      if (e & 1n) r = (r * b) % m;
      b = (b * b) % m;
      e >>= 1n;
    }
    return r;
  }
  function invMod(a, m) {
    var lm = 1n, hm = 0n, low = mod(a, m), high = m;
    if (low === 0n) throw new Error('sin inverso modular de 0');
    while (low > 1n) {
      var r = high / low;
      var nm = hm - lm * r;
      var nn = high - low * r;
      hm = lm; lm = nm; high = low; low = nn;
    }
    return mod(lm, m);
  }
  function bigFromBytes(b) {
    var x = 0n;
    for (var i = 0; i < b.length; i++) x = (x << 8n) | BigInt(b[i]);
    return x;
  }
  function bytes32(x) {
    var o = new Uint8Array(32), v = x;
    for (var i = 31; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; }
    return o;
  }

  /* Punto jacobiano {X, Y, Z}: x = X/Z², y = Y/Z³. Z = 0n es el punto en el infinito. */
  var INF = { X: 0n, Y: 1n, Z: 0n };

  function jDouble(p) {
    if (p.Z === 0n || p.Y === 0n) return INF;
    var A = (p.X * p.X) % P;
    var B = (p.Y * p.Y) % P;
    var C = (B * B) % P;
    var t = (p.X + B) % P;
    var D = mod(2n * (((t * t) % P) - A - C), P);
    var E = (3n * A) % P;
    var F = (E * E) % P;
    var X3 = mod(F - 2n * D, P);
    var Y3 = mod(E * mod(D - X3, P) - 8n * C, P);
    var Z3 = mod(2n * p.Y * p.Z, P);
    return { X: X3, Y: Y3, Z: Z3 };
  }

  function jAdd(p, q) {
    if (p.Z === 0n) return q;
    if (q.Z === 0n) return p;
    var Z1Z1 = (p.Z * p.Z) % P;
    var Z2Z2 = (q.Z * q.Z) % P;
    var U1 = (p.X * Z2Z2) % P;
    var U2 = (q.X * Z1Z1) % P;
    var S1 = (((p.Y * q.Z) % P) * Z2Z2) % P;
    var S2 = (((q.Y * p.Z) % P) * Z1Z1) % P;
    var H = mod(U2 - U1, P);
    var r = mod(2n * (S2 - S1), P);
    if (H === 0n) return r === 0n ? jDouble(p) : INF;
    var I = (mod(2n * H, P) * mod(2n * H, P)) % P;
    var J = (H * I) % P;
    var V = (U1 * I) % P;
    var X3 = mod(r * r - J - 2n * V, P);
    var Y3 = mod(r * mod(V - X3, P) - 2n * S1 * J, P);
    var s = (p.Z + q.Z) % P;
    var Z3 = (mod(s * s - Z1Z1 - Z2Z2, P) * H) % P;
    return { X: X3, Y: Y3, Z: Z3 };
  }

  function jMul(p, k) {
    var scalar = mod(k, N);
    if (scalar === 0n || p.Z === 0n) return INF;
    var acc = INF;
    var add = p;
    var s = scalar;
    while (s > 0n) {
      if (s & 1n) acc = jAdd(acc, add);
      add = jDouble(add);
      s >>= 1n;
    }
    return acc;
  }

  function toAffine(p) {
    if (p.Z === 0n) return null;
    var zi = invMod(p.Z, P);
    var zi2 = (zi * zi) % P;
    return { x: (p.X * zi2) % P, y: (((p.Y * zi2) % P) * zi) % P };
  }

  /** lift_x de BIP-340: del x de 32 bytes al punto de y par, o null si no está en la curva. */
  function liftX(x) {
    if (x <= 0n || x >= P) return null;
    var c = mod(((x * x) % P) * x + 7n, P);
    var y = powMod(c, (P + 1n) / 4n, P);
    if ((y * y) % P !== c) return null;
    return { X: x, Y: y % 2n === 0n ? y : P - y, Z: 1n };
  }

  var taggedCache = {};
  /** tagged_hash de BIP-340: sha256(sha256(tag) || sha256(tag) || msg). */
  function taggedHash(tag, msg) {
    var pre = taggedCache[tag];
    if (!pre) {
      var t = sha256(utf8(tag));
      pre = taggedCache[tag] = concat(t, t);
    }
    return sha256(concat(pre, msg));
  }

  /**
   * Verificación BIP-340. `sigHex` 64 bytes, `msgHex` 32 bytes (en Nostr, el id del evento),
   * `pubHex` 32 bytes (la clave x-only). Devuelve true solo si la firma es válida.
   */
  function schnorrVerify(sigHex, msgHex, pubHex) {
    try {
      if (!/^[0-9a-f]{128}$/.test(sigHex) || !isHex64(msgHex) || !isHex64(pubHex)) return false;
      var sig = fromHex(sigHex);
      var msg = fromHex(msgHex);
      var pub = fromHex(pubHex);
      var r = bigFromBytes(sig.subarray(0, 32));
      var s = bigFromBytes(sig.subarray(32, 64));
      if (r >= P || s >= N) return false;
      var Pt = liftX(bigFromBytes(pub));
      if (!Pt) return false;
      var e = mod(bigFromBytes(taggedHash('BIP0340/challenge', concat(sig.subarray(0, 32), pub, msg))), N);
      // R = s·G − e·P
      var R = jAdd(jMul({ X: GX, Y: GY, Z: 1n }, s), jMul(Pt, mod(N - e, N)));
      var aff = toAffine(R);
      if (!aff) return false;
      if (aff.y % 2n !== 0n) return false;
      return aff.x === r;
    } catch (err) {
      return false;
    }
  }

  root.PrecintumCrypto = {
    sha256: sha256,
    utf8: utf8,
    hex: hex,
    fromHex: fromHex,
    isHex64: isHex64,
    concat: concat,
    schnorrVerify: schnorrVerify,
    taggedHash: taggedHash,
    // expuesto para los tests
    _bigFromBytes: bigFromBytes,
    _bytes32: bytes32,
    _liftX: liftX,
    _jMul: jMul,
    _toAffine: toAffine,
    _G: { X: GX, Y: GY, Z: 1n },
    _N: N,
    _P: P,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
