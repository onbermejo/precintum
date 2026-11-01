/* SHA-256 síncrono y utilidades: los hashes de la página son reales. */
(function () {
  'use strict';
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ]);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));

  function sha256(msg) {
    const l = msg.length;
    const padLen = ((l + 9 + 63) >> 6) << 6;
    const buf = new Uint8Array(padLen);
    buf.set(msg);
    buf[l] = 0x80;
    const dv = new DataView(buf.buffer);
    const bitLen = l * 8;
    dv.setUint32(padLen - 4, bitLen >>> 0);
    dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000));
    const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    const W = new Uint32Array(64);
    for (let off = 0; off < padLen; off += 64) {
      for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3);
        const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0;
      }
      let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
      }
      H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0; H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
      H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0; H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
  }

  const enc = new TextEncoder();
  const hex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const fromHex = (h) => {
    const o = new Uint8Array(h.length / 2);
    for (let i = 0; i < o.length; i++) o[i] = parseInt(h.substr(i * 2, 2), 16);
    return o;
  };
  const concat = (...as) => {
    let n = 0;
    for (const a of as) n += a.length;
    const o = new Uint8Array(n);
    let p = 0;
    for (const a of as) { o.set(a, p); p += a.length; }
    return o;
  };
  /* Separación de dominios, como en precintum/src/domain/evidence/hash.ts: sha256(dominio || 0x0a || carga) */
  const hashDomain = (domain, payload) => sha256(concat(enc.encode(domain), Uint8Array.of(0x0a), payload));

  /* Árbol Merkle RFC 6962: hoja = sha256(0x00 || dato), nodo = sha256(0x01 || izq || der), corte en la mayor potencia de 2 menor que n. */
  function merkleTree(leafDataHex) {
    if (!leafDataHex.length) return { h: hex(sha256(new Uint8Array(0))), leaves: [], empty: true };
    const leaves = leafDataHex.map((d, i) => ({ h: hex(sha256(concat(Uint8Array.of(0), fromHex(d)))), i0: i, i1: i, leaf: true }));
    const mth = (nodes) => {
      if (nodes.length === 1) return nodes[0];
      let k = 1;
      while (k * 2 < nodes.length) k *= 2;
      const l = mth(nodes.slice(0, k));
      const r = mth(nodes.slice(k));
      return { h: hex(sha256(concat(Uint8Array.of(1), fromHex(l.h), fromHex(r.h)))), l, r, i0: l.i0, i1: r.i1 };
    };
    const root = mth(leaves);
    root.leaves = leaves;
    return root;
  }

  /* PRNG determinista (mulberry32) para que los "aleatorios" de la demo sean estables entre recargas. */
  function prng(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const randHex = (seed, bytes) => {
    const r = prng(seed);
    let s = '';
    for (let i = 0; i < bytes; i++) s += Math.floor(r() * 256).toString(16).padStart(2, '0');
    return s;
  };

  globalThis.PrecintumCrypto = { sha256, hex, fromHex, concat, enc, hashDomain, merkleTree, randHex };
})();
