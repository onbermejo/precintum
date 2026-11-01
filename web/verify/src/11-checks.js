/**
 * Motor de comprobaciones del verificador. Reimplementa desde cero, y sin usar el software del
 * operador, lo mismo que hace `verifyPackage` en el servidor: hashes de recibo con separación de
 * dominio, cadena, árbol de Merkle RFC 6962, pruebas de inclusión RFC 9162 §2.1.3.2, apertura del
 * compromiso de recuento, id y firma de los eventos de lote, cobertura horaria, lectura del token
 * RFC 3161 (imprint y genTime, regla de ventana de anclaje) y del fichero .ots (digest y
 * atestación Bitcoin), y quién firma.
 *
 * Regla: no se cree nada que haya escrito el operador. Lo declarado en el paquete (`gaps`,
 * `batchChainOk`, `tsaGenTime`, `otsComplete`, `agentPubkey`) se contrasta con lo recalculado.
 * Lo que no se puede recalcular sin salir del paquete se devuelve como `note`, no como aprobado.
 *
 * No emite texto: devuelve hallazgos como {level, key, params}. Los idiomas viven en la interfaz.
 * Así el motor se puede probar en Node contra la implementación del servidor.
 */
(function (root) {
  'use strict';
  var C = root.PrecintumCrypto;

  var DOMAINS = { receipt: 'precintum/receipt/v1', genesis: 'precintum/genesis/v1', count: 'precintum/count/v1' };
  var SEP = new Uint8Array([0x0a]);
  var BATCH_KIND = 7676;
  var RESULTS = { over_18: 1, under_18: 1, error: 1 };
  var RECEIPT_KEYS = ['nonce', 'policy', 'prev', 'result', 'seq', 'ts', 'v', 'verifier'];
  var DEFAULT_MAX_GAP = 86400;
  var CLOCK_SKEW_TOLERANCE = 120;
  var OID_SIGNED_DATA = '1.2.840.113549.1.7.2';
  var OID_TST_INFO = '1.2.840.113549.1.9.16.1.4';
  var OID_SHA256_HEX = '608648016503040201'; // 2.16.840.1.101.3.4.2.1, valor DER exacto.
  var OTS_MAGIC_HEX = '004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294';
  var OTS_BITCOIN_TAG = '0588960d73d71901';
  var OTS_PENDING_TAG = '83dfe30d2ef90c8e';

  var isInt = function (v) { return typeof v === 'number' && Number.isSafeInteger(v); };
  var isInstant = function (v) { return isInt(v) && Number.isFinite(new Date(v * 1000).getTime()); };
  var isRange = function (v) {
    return Array.isArray(v) && v.length === 2 && isInstant(v[0]) && isInstant(v[1]) && v[1] > v[0];
  };
  var hasOwn = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  function hashWithDomain(domain, data) {
    return C.hex(C.sha256(C.concat(C.utf8(domain), SEP, data)));
  }

  /** JSON canónico de un objeto plano: claves ordenadas, sin espacios. Igual que en el servidor. */
  function canonicalize(obj) {
    var keys = Object.keys(obj).sort();
    var parts = [];
    for (var i = 0; i < keys.length; i++) {
      var v = obj[keys[i]];
      if (v === undefined) continue;
      if (typeof v === 'number' && !Number.isSafeInteger(v)) throw new Error('valor no canonicalizable');
      parts.push(JSON.stringify(keys[i]) + ':' + JSON.stringify(v));
    }
    return '{' + parts.join(',') + '}';
  }

  function receiptHash(r) {
    return hashWithDomain(DOMAINS.receipt, C.utf8(canonicalize(r)));
  }
  function commitCount(count, salt) {
    return hashWithDomain(DOMAINS.count, C.utf8(String(count) + ':' + salt));
  }
  var EMPTY_ROOT = C.hex(C.sha256(new Uint8Array(0)));

  /* -------- Merkle RFC 6962 -------- */
  function leafHash(hex64) {
    return C.hex(C.sha256(C.concat(new Uint8Array([0]), C.fromHex(hex64))));
  }
  function nodeHash(l, r) {
    return C.hex(C.sha256(C.concat(new Uint8Array([1]), C.fromHex(l), C.fromHex(r))));
  }
  /** Mayor potencia de 2 estrictamente menor que n: el punto de corte de RFC 6962. */
  function splitPoint(n) {
    var k = 1;
    while (k * 2 < n) k *= 2;
    return k;
  }
  function merkleRootFromLeafHashes(leaves) {
    if (leaves.length === 0) return EMPTY_ROOT;
    if (leaves.length === 1) return leaves[0];
    var k = splitPoint(leaves.length);
    return nodeHash(merkleRootFromLeafHashes(leaves.slice(0, k)), merkleRootFromLeafHashes(leaves.slice(k)));
  }
  function merkleRoot(receiptHashes) {
    var leaves = [];
    for (var i = 0; i < receiptHashes.length; i++) leaves.push(leafHash(receiptHashes[i]));
    return merkleRootFromLeafHashes(leaves);
  }
  /** Verificación de inclusión de RFC 9162 §2.1.3.2, con el hash del recibo como dato de la hoja. */
  function verifyInclusion(receiptHashHex, proof, rootHex) {
    if (!proof || !isInt(proof.index) || !isInt(proof.size)) return false;
    if (!Array.isArray(proof.path)) return false;
    if (proof.index < 0 || proof.index >= proof.size) return false;
    var fn = proof.index;
    var sn = proof.size - 1;
    var r = leafHash(receiptHashHex);
    for (var i = 0; i < proof.path.length; i++) {
      var p = proof.path[i];
      if (!C.isHex64(p)) return false;
      if (sn === 0) return false;
      if (fn % 2 === 1 || fn === sn) {
        r = nodeHash(p, r);
        while (fn % 2 === 0 && fn !== 0) { fn = Math.floor(fn / 2); sn = Math.floor(sn / 2); }
      } else {
        r = nodeHash(r, p);
      }
      fn = Math.floor(fn / 2);
      sn = Math.floor(sn / 2);
    }
    return sn === 0 && r === rootHex;
  }

  /* -------- eventos Nostr -------- */
  function serializeEvent(e) {
    return JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content]);
  }
  function computeEventId(e) {
    return C.hex(C.sha256(C.utf8(serializeEvent(e))));
  }
  function tagValue(event, name) {
    for (var i = 0; i < event.tags.length; i++) if (event.tags[i][0] === name) return event.tags[i];
    return null;
  }
  function tagCount(event, name) {
    var n = 0;
    for (var i = 0; i < event.tags.length; i++) if (event.tags[i][0] === name) n++;
    return n;
  }
  var BATCH_TAGS = ['v', 'seq', 'prev', 'window', 'policy', 'count'];

  /* -------- npub (NIP-19, bech32) -------- */
  var BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  /** Decodifica un npub a pubkey hex; acepta también hex de 64. Devuelve null si no es válido. */
  function decodePubkey(input) {
    if (typeof input !== 'string') return null;
    var s = input.trim().toLowerCase();
    if (s.indexOf('nostr:') === 0) s = s.slice(6);
    if (C.isHex64(s)) return s;
    if (s.indexOf('npub1') !== 0 || s.length !== 63) return null;
    var data = [];
    for (var i = 5; i < s.length; i++) {
      var v = BECH32.indexOf(s[i]);
      if (v < 0) return null;
      data.push(v);
    }
    // checksum: polymod sobre hrp expandido + datos debe dar 1
    var values = [110 >> 5, 112 >> 5, 117 >> 5, 98 >> 5, 0, 110 & 31, 112 & 31, 117 & 31, 98 & 31].concat(data);
    var GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    var chk = 1;
    for (var j = 0; j < values.length; j++) {
      var top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ values[j];
      for (var k = 0; k < 5; k++) if ((top >> k) & 1) chk ^= GEN[k];
    }
    if (chk !== 1) return null;
    var bits = data.slice(0, data.length - 6);
    var acc = 0, nbits = 0, out = [];
    for (var m = 0; m < bits.length; m++) {
      acc = (acc << 5) | bits[m];
      nbits += 5;
      while (nbits >= 8) { nbits -= 8; out.push((acc >> nbits) & 0xff); }
    }
    if (out.length !== 32) return null;
    return C.hex(new Uint8Array(out));
  }

  /* -------- DER mínimo para leer el TSTInfo del token RFC 3161 -------- */
  function derNode(b, off) {
    if (off + 2 > b.length) throw new Error('DER truncado');
    var tag = b[off];
    var len = b[off + 1];
    var hl = 2;
    if (len & 0x80) {
      var n = len & 0x7f;
      if (n === 0 || n > 4) throw new Error('DER: longitud no soportada');
      len = 0;
      for (var i = 0; i < n; i++) len = len * 256 + b[off + 2 + i];
      hl = 2 + n;
    }
    if (off + hl + len > b.length) throw new Error('DER: longitud fuera del buffer');
    return { tag: tag, start: off + hl, end: off + hl + len };
  }
  function derChildren(b, node) {
    var out = [];
    var p = node.start;
    while (p < node.end) {
      var c = derNode(b, p);
      out.push(c);
      p = c.end;
    }
    return out;
  }
  function derOid(b, node) {
    if (node.tag !== 0x06) throw new Error('DER: no es un OID');
    var parts = [];
    var first = b[node.start];
    parts.push(Math.floor(first / 40), first % 40);
    var val = 0;
    for (var i = node.start + 1; i < node.end; i++) {
      val = val * 128 + (b[i] & 0x7f);
      if ((b[i] & 0x80) === 0) { parts.push(val); val = 0; }
    }
    return parts.join('.');
  }
  function derGeneralizedTime(b, node) {
    if (node.tag !== 0x18) throw new Error('DER: no es GeneralizedTime');
    var s = '';
    for (var i = node.start; i < node.end; i++) s += String.fromCharCode(b[i]);
    var m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(s);
    if (!m) throw new Error('DER: GeneralizedTime no UTC');
    return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) / 1000);
  }
  /** Lee imprint (hex) y genTime (segundos unix) de un TimeStampToken DER. Lanza si no cuadra. */
  function parseTsaToken(bytes) {
    var ci = derNode(bytes, 0);
    if (ci.tag !== 0x30) throw new Error('token: no es ContentInfo');
    var ciKids = derChildren(bytes, ci);
    if (derOid(bytes, ciKids[0]) !== OID_SIGNED_DATA) throw new Error('token: no es SignedData');
    var wrapped = derChildren(bytes, ciKids[1]);
    var sd = wrapped[0];
    var sdKids = derChildren(bytes, sd);
    // version, digestAlgorithms, encapContentInfo, [certificates], [crls], signerInfos
    var eci = sdKids[2];
    var eciKids = derChildren(bytes, eci);
    if (derOid(bytes, eciKids[0]) !== OID_TST_INFO) throw new Error('token: no es TSTInfo');
    var eContent = derChildren(bytes, eciKids[1])[0];
    if (eContent.tag !== 0x04) throw new Error('token: eContent no es OCTET STRING');
    var tst = bytes.subarray(eContent.start, eContent.end);
    var info = derNode(tst, 0);
    var kids = derChildren(tst, info);
    // version, policy, messageImprint, serialNumber, genTime, ...
    var imprintKids = derChildren(tst, kids[2]);
    var hashAlgorithm = imprintKids[0];
    if (hashAlgorithm.tag !== 0x30) throw new Error('token: hashAlgorithm no es SEQUENCE');
    var algorithm = derChildren(tst, hashAlgorithm)[0];
    if (algorithm.tag !== 0x06 || C.hex(tst.subarray(algorithm.start, algorithm.end)) !== OID_SHA256_HEX) {
      throw new Error('token: el algoritmo del imprint no es sha256');
    }
    var hashed = imprintKids[1];
    if (hashed.tag !== 0x04) throw new Error('token: hashedMessage no es OCTET STRING');
    if (hashed.end - hashed.start !== 32) throw new Error('token: el imprint debe tener 32 bytes');
    return {
      imprintHex: C.hex(tst.subarray(hashed.start, hashed.end)),
      genTime: derGeneralizedTime(tst, kids[4]),
    };
  }

  /* -------- OpenTimestamps: cabecera, digest y atestaciones -------- */
  function otsReader(bytes) {
    var off = 0;
    return {
      remaining: function () { return bytes.length - off; },
      byte: function () {
        if (off >= bytes.length) throw new Error('ots: fin de datos inesperado');
        return bytes[off++];
      },
      bytes: function (n) {
        if (!isInt(n) || n < 0 || n > bytes.length - off) throw new Error('ots: fin de datos inesperado');
        var out = bytes.subarray(off, off + n);
        off += n;
        return out;
      },
      varuint: function () {
        var value = 0;
        var scale = 1;
        while (true) {
          var b = this.byte();
          value += (b & 0x7f) * scale;
          if (!isInt(value)) throw new Error('ots: varuint demasiado grande');
          if ((b & 0x80) === 0) return value;
          scale *= 128;
          if (!isInt(scale)) throw new Error('ots: varuint demasiado grande');
        }
      },
      varbytes: function () {
        var n = this.varuint();
        if (n > 4096) throw new Error('ots: varbytes demasiado largo');
        return this.bytes(n);
      },
    };
  }

  function inspectOts(bytes) {
    var r = otsReader(bytes);
    if (C.hex(r.bytes(OTS_MAGIC_HEX.length / 2)) !== OTS_MAGIC_HEX) throw new Error('ots: cabecera inválida');
    if (r.varuint() !== 1) throw new Error('ots: versión no soportada');
    if (r.byte() !== 0x08) throw new Error('ots: el hash del fichero no es sha256');
    var result = { digestHex: C.hex(r.bytes(32)), hasBitcoin: false, hasPending: false };

    function attestation() {
      var tag = C.hex(r.bytes(8));
      var payload = otsReader(r.varbytes());
      if (tag === OTS_BITCOIN_TAG) {
        payload.varuint();
        if (payload.remaining() !== 0) throw new Error('ots: bytes sobrantes en atestación bitcoin');
        result.hasBitcoin = true;
      } else if (tag === OTS_PENDING_TAG) {
        var uri = new TextDecoder().decode(payload.varbytes());
        if (payload.remaining() !== 0) throw new Error('ots: bytes sobrantes en atestación pending');
        var calendarValid = false;
        if (/^https?:\/\/[A-Za-z0-9._\-:/]+$/.test(uri)) {
          try {
            var calendar = new URL(uri);
            calendarValid = (calendar.protocol === 'http:' || calendar.protocol === 'https:') && calendar.hostname !== '';
          } catch (_) { /* Puerto o dirección no válidos. */ }
        }
        if (!calendarValid) throw new Error('ots: uri de calendario inválida');
        result.hasPending = true;
      }
      // Los tags desconocidos tienen payload opaco: sus bytes no son otras atestaciones.
    }

    function item(tag, depth) {
      if (tag === 0x00) {
        attestation();
        return;
      }
      if (tag === 0xf0 || tag === 0xf1) r.varbytes();
      else if (tag !== 0x02 && tag !== 0x03 && tag !== 0x08 && tag !== 0x67 && tag !== 0xf2 && tag !== 0xf3) {
        throw new Error('ots: operación desconocida');
      }
      // Solo se comprueba la estructura; no se calculan mensajes ni se consulta Bitcoin.
      timestamp(depth + 1);
    }

    function timestamp(depth) {
      if (depth > 256) throw new Error('ots: anidamiento excesivo');
      var tag = r.byte();
      while (tag === 0xff) {
        item(r.byte(), depth);
        tag = r.byte();
      }
      item(tag, depth);
    }

    timestamp(0);
    if (r.remaining() !== 0) throw new Error('ots: bytes sobrantes');
    return result;
  }

  /* -------- recibos -------- */
  function receiptProblem(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return 'no es un objeto';
    var keys = Object.keys(r).sort();
    if (keys.length !== RECEIPT_KEYS.length || keys.join(',') !== RECEIPT_KEYS.join(',')) {
      return 'campos ' + keys.join(',');
    }
    if (r.v !== 1) return 'v';
    if (!isInt(r.seq) || r.seq < 1) return 'seq';
    if (!C.isHex64(r.prev)) return 'prev';
    if (!C.isHex64(r.nonce)) return 'nonce';
    if (!C.isHex64(r.policy)) return 'policy';
    if (!C.isHex64(r.verifier)) return 'verifier';
    if (typeof r.result !== 'string' || !hasOwn(RESULTS, r.result)) return 'result';
    if (!isInt(r.ts) || r.ts <= 0 || r.ts % 60 !== 0) return 'ts';
    return null;
  }

  function batchTypesOk(b) {
    return b && typeof b === 'object' && isInt(b.seq) && isInt(b.count) && isRange(b.window) &&
      (b.tsaGenTime === null || isInt(b.tsaGenTime)) &&
      C.isHex64(b.root) && C.isHex64(b.prevRoot) && C.isHex64(b.eventId) &&
      Array.isArray(b.receipts) && Array.isArray(b.proofs) &&
      (b.tsaTokenDer === null || typeof b.tsaTokenDer === 'string') &&
      (b.ots === null || typeof b.ots === 'string');
  }

  /**
   * Comprueba el paquete completo.
   *   opts.verifySignatures (true): la parte lenta; si se salta, se dice y no se marca verificado.
   *   opts.expectedPubkey: pubkey hex o npub del operador conocida por un canal fiable.
   */
  function verifyPackage(pkg, opts) {
    opts = opts || {};
    var findings = [];
    var checkSignatures = opts.verifySignatures !== false;

    if (!pkg || typeof pkg !== 'object') return { fatal: 'notJson', findings: [], checks: [], batches: [] };
    if (pkg.format !== 'precintum/export/v1') return { fatal: 'notPackage', found: pkg.format, findings: [], checks: [], batches: [] };
    if (!Array.isArray(pkg.batches)) return { fatal: 'notPackage', findings: [], checks: [], batches: [] };

    var perCheck = { schema: [], chain: [], inclusion: [], witness: [], pubkey: [], count: [], tsa: [], ots: [] };
    var pin = function (id, level, key, params) {
      perCheck[id].push({ level: level, key: key, params: params || {} });
      findings.push({ level: level, key: key, params: params || {}, check: id });
    };

    /* --- tipos: nada de lo que se opera puede ser texto disfrazado de número --- */
    var size = pkg.windowSeconds;
    if (!isInt(size) || size < 60) pin('witness', 'problem', 'badWindowSeconds', {});
    var typesOk = true;
    if (!isRange(pkg.requested)) { typesOk = false; pin('witness', 'problem', 'badRequestedRange', {}); }
    if (!isRange(pkg.covered)) { typesOk = false; pin('witness', 'problem', 'badCoveredRange', {}); }
    for (var i0 = 0; i0 < pkg.batches.length; i0++) {
      if (!batchTypesOk(pkg.batches[i0])) {
        typesOk = false;
        pin('witness', 'problem', 'badTypes', { seq: String(pkg.batches[i0] && pkg.batches[i0].seq) });
      }
    }
    if (!typesOk || !isInt(size) || size < 60) {
      var invalid = finish(pkg, findings, perCheck, [], 0, checkSignatures);
      // Los renderizadores no deben indexar rangos ni formatear fechas de un sobre inválido.
      invalid.fatal = 'notPackage';
      return invalid;
    }

    if (pkg.covered[0] > pkg.requested[0] || pkg.covered[1] < pkg.requested[1]) {
      pin('witness', 'problem', 'rangeCoverage', {});
    }
    if (pkg.covered[0] % size !== 0 || pkg.covered[1] % size !== 0) {
      pin('witness', 'problem', 'rangeAlignment', {});
    }

    var maxGap = isInt(opts.anchorMaxGapSeconds) ? opts.anchorMaxGapSeconds
      : isInt(pkg.anchorMaxGapSeconds) ? pkg.anchorMaxGapSeconds : DEFAULT_MAX_GAP;

    /* --- clave esperada --- */
    var expected = null;
    if (opts.expectedPubkey !== undefined && opts.expectedPubkey !== null && String(opts.expectedPubkey).trim() !== '') {
      expected = decodePubkey(opts.expectedPubkey);
      if (!expected) pin('pubkey', 'problem', 'badExpectedPubkey', {});
    }

    /* --- continuidad y huecos recalculados; lo declarado se contrasta --- */
    var interiorGaps = 0;
    var chainContinuous = true;
    for (var i = 0; i < pkg.batches.length; i++) {
      var curB = pkg.batches[i];
      if (curB.window[0] < pkg.covered[0] || curB.window[1] > pkg.covered[1]) {
        pin('witness', 'problem', 'batchOutsideRange', { seq: curB.seq });
      }
      if (curB.window[1] - curB.window[0] !== size) pin('witness', 'problem', 'windowSize', { seq: curB.seq, size: size });
      if (i === 0) continue;
      var prevB = pkg.batches[i - 1];
      if (curB.seq !== prevB.seq + 1) { chainContinuous = false; pin('witness', 'problem', 'batchSeqJump', { from: prevB.seq, to: curB.seq }); }
      else if (curB.prevRoot !== prevB.root) { chainContinuous = false; pin('witness', 'problem', 'batchChainBreak', { seq: curB.seq }); }
      if (curB.window[0] > prevB.window[1]) interiorGaps += Math.round((curB.window[0] - prevB.window[1]) / size);
      else if (curB.window[0] < prevB.window[1]) pin('witness', 'problem', 'windowOverlap', { seq: curB.seq });
    }
    var declaredGaps = Array.isArray(pkg.gaps) ? pkg.gaps.length : 0;
    var totalGaps = Math.max(interiorGaps, declaredGaps);
    if (totalGaps > 0) {
      var firstGap = declaredGaps && pkg.gaps[0] && Array.isArray(pkg.gaps[0].window) ? pkg.gaps[0].window[0] : null;
      pin('witness', 'problem', 'gaps', { n: totalGaps, first: firstGap });
    }
    if (declaredGaps < interiorGaps) pin('witness', 'problem', 'gapsDeclaredMismatch', { declared: declaredGaps, found: interiorGaps });
    if (!chainContinuous && pkg.batchChainOk === true) pin('witness', 'problem', 'chainDeclaredMismatch', {});
    var edgeWindows = 0;
    if (Array.isArray(pkg.covered) && isInt(pkg.covered[0]) && isInt(pkg.covered[1])) {
      if (pkg.batches.length === 0) edgeWindows = Math.round((pkg.covered[1] - pkg.covered[0]) / size);
      else edgeWindows = Math.round((pkg.batches[0].window[0] - pkg.covered[0]) / size) +
        Math.round((pkg.covered[1] - pkg.batches[pkg.batches.length - 1].window[1]) / size);
    }
    if (edgeWindows > 0) {
      var tot = pkg.totals || {};
      pin('witness', 'note', 'edgeWindows', { n: edgeWindows, before: tot.windowsBeforeService, notClosed: tot.windowsNotClosed });
    }

    /* --- quién firma --- */
    var pubkeys = {};
    var pubkeyCount = 0;
    for (var pi = 0; pi < pkg.batches.length; pi++) {
      var evp = pkg.batches[pi].event && pkg.batches[pi].event.pubkey;
      if (typeof evp === 'string' && !hasOwn(pubkeys, evp)) { pubkeys[evp] = 1; pubkeyCount++; }
    }
    var signer = pubkeyCount === 1 ? Object.keys(pubkeys)[0] : null;
    if (pubkeyCount > 1) pin('pubkey', 'problem', 'mixedPubkeys', { n: pubkeyCount });
    if (expected) {
      if (signer && signer !== expected) pin('pubkey', 'problem', 'pubkeyMismatch', {});
      else if (signer) pin('pubkey', 'note', 'pubkeyMatches', {});
    } else if (signer) {
      pin('pubkey', 'note', 'pubkeyNotChecked', {});
    }
    if (signer && typeof pkg.agentPubkey === 'string' && pkg.agentPubkey !== signer) {
      pin('pubkey', 'problem', 'declaredPubkeyMismatch', {});
    }

    /* --- por lote --- */
    var expectedPrev = pkg.precedingReceiptHash;
    var lastSeq = null;
    var rows = [];
    var totalReceipts = 0;
    var anyTsa = false;
    var anyBitcoin = false;
    for (var b = 0; b < pkg.batches.length; b++) {
      var batch = pkg.batches[b];
      var row = { seq: batch.seq, window: batch.window, count: batch.count, delivered: 0, root: batch.root, sig: null, rootOk: null, tsa: 'missing', tsaTime: null, ots: 'missing' };
      var receipts = batch.receipts;
      row.delivered = receipts.length;
      totalReceipts += receipts.length;

      /* evento firmado */
      if (!batch.event || typeof batch.event !== 'object') {
        pin('witness', 'problem', 'noEvent', { seq: batch.seq });
      } else {
        var ev = batch.event;
        if (ev.kind !== BATCH_KIND) pin('witness', 'problem', 'wrongKind', { seq: batch.seq, kind: ev.kind });
        // El id se recalcula desde el contenido; la firma se comprueba contra el id RECALCULADO,
        // no contra el que trae el fichero. Verificando sobre el id recalculado, un evento
        // reescrito falla en las dos cosas.
        var computedId = computeEventId(ev);
        if (computedId !== ev.id) pin('witness', 'problem', 'eventId', { seq: batch.seq });
        if (batch.eventId !== ev.id) pin('witness', 'problem', 'eventIdMismatch', { seq: batch.seq });
        if (checkSignatures) {
          row.sig = C.schnorrVerify(ev.sig, computedId, ev.pubkey);
          if (!row.sig) pin('witness', 'problem', 'signature', { seq: batch.seq });
        }
        // La raíz del lote viaja en `content`; el resto, en etiquetas: v, seq, prev, window,
        // policy y count. Todo ello está cubierto por el id y por la firma.
        if (ev.content !== batch.root) pin('inclusion', 'problem', 'eventRoot', { seq: batch.seq });
        var vTag = tagValue(ev, 'v');
        var seqTag = tagValue(ev, 'seq');
        var prevTag = tagValue(ev, 'prev');
        var winTag = tagValue(ev, 'window');
        var policyTag = tagValue(ev, 'policy');
        var countTag = tagValue(ev, 'count');
        // Las etiquetas del formato son únicas: con dos ["seq", …] cada verificador podría leer
        // un valor distinto del mismo evento firmado. Y el evento se fecha al cerrar la ventana,
        // nunca antes de que termine.
        for (var ft = 0; ft < BATCH_TAGS.length; ft++) {
          if (tagCount(ev, BATCH_TAGS[ft]) > 1) pin('witness', 'problem', 'eventDupTag', { seq: batch.seq, tag: BATCH_TAGS[ft] });
        }
        if (typeof ev.created_at !== 'number' || ev.created_at < batch.window[1]) {
          pin('witness', 'problem', 'eventCreatedAt', { seq: batch.seq });
        }
        if (!vTag || vTag[1] !== '1') pin('witness', 'problem', 'eventVersion', { seq: batch.seq, v: vTag && vTag[1] });
        if (!seqTag || Number(seqTag[1]) !== batch.seq) pin('witness', 'problem', 'eventSeq', { seq: batch.seq });
        if (!prevTag || prevTag[1] !== batch.prevRoot) pin('witness', 'problem', 'eventPrev', { seq: batch.seq });
        if (!winTag || Number(winTag[1]) !== batch.window[0] || Number(winTag[2]) !== batch.window[1]) {
          pin('witness', 'problem', 'eventWindow', { seq: batch.seq });
        }
        if (!policyTag || policyTag[1] !== batch.policy) pin('witness', 'problem', 'eventPolicy', { seq: batch.seq });
        if (!countTag || !C.isHex64(batch.countSalt) || countTag[1] !== commitCount(batch.count, batch.countSalt)) {
          pin('count', 'problem', 'countCommit', { seq: batch.seq, count: batch.count });
        }
      }

      /* recuento revelado */
      if (receipts.length !== batch.count) {
        pin('count', 'problem', 'countMismatch', { seq: batch.seq, delivered: receipts.length, committed: batch.count });
      }

      /* esquema de cada recibo */
      var wellFormed = [];
      for (var k = 0; k < receipts.length; k++) {
        var why = receiptProblem(receipts[k]);
        if (why) pin('schema', 'problem', 'badReceipt', { seq: receipts[k] && receipts[k].seq, why: why });
        else wellFormed.push(receipts[k]);
      }

      /* raíz recalculada; solo si cuadra tiene sentido mirar cada prueba */
      var hashes = [];
      for (k = 0; k < wellFormed.length; k++) hashes.push(receiptHash(wellFormed[k]));
      var recomputed = merkleRoot(hashes);
      row.rootOk = wellFormed.length === receipts.length && recomputed === batch.root;
      if (!row.rootOk) {
        pin('inclusion', 'problem', 'rootMismatch', { seq: batch.seq, recomputed: recomputed, published: batch.root });
      } else {
        for (k = 0; k < batch.proofs.length; k++) {
          var pr = batch.proofs[k];
          if (!pr || !pr.proof) { pin('inclusion', 'problem', 'proofFails', { seq: pr && pr.receiptSeq }); continue; }
          if (pr.proof.size !== batch.count) pin('inclusion', 'problem', 'proofSize', { seq: pr.receiptSeq, size: pr.proof.size, count: batch.count });
          else if (!verifyInclusion(pr.receiptHash, pr.proof, batch.root)) pin('inclusion', 'problem', 'proofFails', { seq: pr.receiptSeq });
        }
      }

      /* cadena de recibos, atravesando los lotes */
      for (k = 0; k < wellFormed.length; k++) {
        var r = wellFormed[k];
        if (r.ts < batch.window[0] || r.ts >= batch.window[1]) pin('chain', 'problem', 'tsOutOfWindow', { seq: r.seq, batch: batch.seq });
        if (lastSeq !== null && r.seq !== lastSeq + 1) pin('chain', 'problem', 'receiptSeqJump', { from: lastSeq, to: r.seq });
        if (expectedPrev !== null && expectedPrev !== undefined && r.prev !== expectedPrev) pin('chain', 'problem', 'prevMismatch', { seq: r.seq });
        expectedPrev = receiptHash(r);
        lastSeq = r.seq;
      }

      /* sello RFC 3161: se lee del token, no del JSON */
      if (batch.tsaTokenDer === null) {
        pin('tsa', 'warning', 'noTsa', { seq: batch.seq });
      } else {
        var parsedTsa = null;
        try {
          parsedTsa = parseTsaToken(C.fromHex(batch.tsaTokenDer));
        } catch (err) {
          pin('tsa', 'problem', 'tsaUnparseable', { seq: batch.seq });
          row.tsa = 'bad';
        }
        if (parsedTsa) {
          anyTsa = true;
          row.tsaTime = parsedTsa.genTime;
          if (parsedTsa.imprintHex !== batch.eventId) { pin('tsa', 'problem', 'tsaImprint', { seq: batch.seq }); row.tsa = 'bad'; }
          if (batch.tsaGenTime !== null && batch.tsaGenTime !== parsedTsa.genTime) {
            pin('tsa', 'problem', 'tsaGenTimeMismatch', { seq: batch.seq, declared: batch.tsaGenTime, token: parsedTsa.genTime });
            row.tsa = 'bad';
          }
          var gap = parsedTsa.genTime - batch.window[1];
          if (gap < -CLOCK_SKEW_TOLERANCE) { pin('tsa', 'problem', 'tsaBeforeClose', { seq: batch.seq, gap: -gap }); row.tsa = 'bad'; }
          else if (gap < 0) pin('tsa', 'warning', 'tsaSlightlyEarly', { seq: batch.seq, gap: -gap });
          else if (gap > maxGap) { pin('tsa', 'problem', 'tsaLate', { seq: batch.seq, gap: gap, max: maxGap }); row.tsa = 'bad'; }
          if (row.tsa !== 'bad') row.tsa = 'consistent';
        }
      }

      /* OpenTimestamps: el fichero se lee; "completo" es que haya atestación Bitcoin en él */
      if (batch.ots === null) {
        pin('ots', 'warning', 'otsMissing', { seq: batch.seq });
      } else {
        try {
          var o = inspectOts(C.fromHex(batch.ots));
          if (o.digestHex !== batch.eventId) { pin('ots', 'problem', 'otsDigest', { seq: batch.seq }); row.ots = 'bad'; }
          if (batch.otsComplete && !o.hasBitcoin) { pin('ots', 'problem', 'otsNotComplete', { seq: batch.seq }); row.ots = 'bad'; }
          else if (!o.hasBitcoin) { pin('ots', 'warning', 'otsPending', { seq: batch.seq }); if (row.ots !== 'bad') row.ots = 'pending'; }
          else {
            anyBitcoin = true;
            if (!batch.otsComplete) pin('ots', 'warning', 'otsDeclaredPending', { seq: batch.seq });
            if (row.ots !== 'bad') row.ots = 'attested';
          }
        } catch (err) {
          pin('ots', 'problem', 'otsUnparseable', { seq: batch.seq });
          row.ots = 'bad';
        }
      }

      rows.push(row);
    }
    if (anyTsa) pin('tsa', 'note', 'tsaCmsNotChecked', {});
    if (anyBitcoin) pin('ots', 'note', 'otsBlockNotChecked', {});

    return finish(pkg, findings, perCheck, rows, totalReceipts, checkSignatures);
  }

  function finish(pkg, findings, perCheck, rows, totalReceipts, checkSignatures) {
    var ids = ['schema', 'chain', 'inclusion', 'witness', 'pubkey', 'count', 'tsa', 'ots'];
    var count = function (id, level) {
      var n = 0;
      for (var i2 = 0; i2 < perCheck[id].length; i2++) if (perCheck[id][i2].level === level) n++;
      return n;
    };
    var statusOf = function (id) {
      if (count(id, 'problem') > 0) return 'fail';
      if (count(id, 'warning') > 0) return 'warn';
      return 'ok';
    };
    var checks = [];
    for (var c = 0; c < ids.length; c++) checks.push({ id: ids[c], status: statusOf(ids[c]), findings: perCheck[ids[c]] });
    var problems = findings.filter(function (f) { return f.level === 'problem'; });
    var warnings = findings.filter(function (f) { return f.level === 'warning'; });
    var notes = findings.filter(function (f) { return f.level === 'note'; });
    return {
      ok: problems.length === 0,
      signaturesChecked: checkSignatures,
      problems: problems,
      warnings: warnings,
      notes: notes,
      findings: findings,
      checks: checks,
      batches: rows,
      totals: {
        batches: pkg.batches.length,
        receipts: totalReceipts,
        empty: rows.filter(function (x) { return x.count === 0; }).length,
      },
      pkg: pkg,
    };
  }

  root.PrecintumChecks = {
    verifyPackage: verifyPackage,
    receiptHash: receiptHash,
    merkleRoot: merkleRoot,
    verifyInclusion: verifyInclusion,
    commitCount: commitCount,
    computeEventId: computeEventId,
    canonicalize: canonicalize,
    receiptProblem: receiptProblem,
    decodePubkey: decodePubkey,
    parseTsaToken: parseTsaToken,
    inspectOts: inspectOts,
    EMPTY_ROOT: EMPTY_ROOT,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
