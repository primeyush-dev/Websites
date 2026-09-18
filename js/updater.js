function normHex(h) {
  if (!h) return h;
  var s = String(h).trim();
  var neg = false;
  if (s[0] === '-') { neg = true; s = s.slice(1); }
  s = s.replace(/^0x/i, '').toLowerCase().replace(/^0+(?=.)/, '');
  if (s === '') s = '0';
  return (neg ? '-' : '') + '0x' + s;
}

function normKey(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function normSig(s) {
  if (!s) return '';
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function deriveShortName(name) {
  if (!name) return '';
  var idx = name.lastIndexOf('::');
  if (idx !== -1 && idx + 2 < name.length) return name.slice(idx + 2);
  var us = name.lastIndexOf('_');
  if (us !== -1 && us < name.length - 1) return name.slice(us + 1);
  return name;
}

var SKIP = {
  'if':1, 'while':1, 'for':1, 'switch':1, 'catch':1, 'return':1,
  'new':1, 'typeof':1, 'get':1, 'set':1, 'public':1, 'private':1,
  'protected':1, 'internal':1, 'static':1, 'readonly':1, 'const':1,
  'override':1, 'virtual':1, 'sealed':1
};

var CLASS_RE = /\bclass\s+(\w+)/;
var RVA_RE = /RVA\s*:?\s*(0x[0-9A-Fa-f]+)\s*Offset\s*:?\s*(0x[0-9A-Fa-f]+)/i;
var METHOD_RE = /\b(\w+)\s*\(/;
var FIELDOFFSET_RE = /\[FieldOffset\(\s*"?(0x[0-9A-Fa-f]+)"?\s*\)\]/i;
var FIELDDECL_RE = /(\w+)\s*[;=\[]/g;
var INLINE_FIELD_RE = /^\s*(?:public|private|protected|internal)?\s*[\w<>\[\],\s]+?\s+(\w+)\s*;\s*\/\/\s*(0x[0-9A-Fa-f]+)/i;
var NAMED_HEX_RE = /\b([\w_]+)\b\s*[=:]\s*(0x[0-9A-Fa-f]+)\b/g;
var BARE_HEX_RE = /\b(0x[0-9A-Fa-f]+)\b/g;

/* Range gate — only offsets inside this window are eligible for update */
var OFFSET_MIN = 0x00;
var OFFSET_MAX = 0x0FFFFFFF;

function parseDump(lines, weightStart, weightSpan) {
  var byFQN = new Map(), byName = new Map(), byHex = new Map(), byCombined = new Map(), bySig = new Map();

  function addEntry(e) {
    var fqn = (e.cls + '::' + e.name).toLowerCase();
    if (!byFQN.has(fqn)) byFQN.set(fqn, e);

    var nl = e.name.toLowerCase();
    if (!byName.has(nl)) byName.set(nl, []);
    byName.get(nl).push(e);

    var ck = normKey(e.cls + e.name);
    if (!byCombined.has(ck)) byCombined.set(ck, []);
    byCombined.get(ck).push(e);

    var hexes = e.isField ? [e.field] : [e.rva, e.offset];
    for (var h = 0; h < hexes.length; h++) {
      if (!hexes[h]) continue;
      var hl = normHex(hexes[h]);
      if (!byHex.has(hl)) byHex.set(hl, []);
      byHex.get(hl).push(e);
    }

    if (e.sig) {
      var sk = normSig(e.sig);
      if (!bySig.has(sk)) bySig.set(sk, []);
      bySig.get(sk).push(e);
    }
  }

  var currentCls = '';
  var n = lines.length;
  var REPORT_EVERY = 50000;

  for (var i = 0; i < n; i++) {
    var ln = lines[i];
    var tr = ln.trim();

    if (i % REPORT_EVERY === 0) {
      postMessage({ type: 'progress', pct: weightStart + (i / n) * weightSpan });
    }

    if (tr.length === 0) continue;

    var cm = CLASS_RE.exec(tr);
    if (cm) { currentCls = cm[1]; continue; }

    if (tr.indexOf('RVA:') !== -1 || tr.indexOf('RVA ') !== -1) {
      var rm = RVA_RE.exec(tr);
      if (rm && currentCls) {
        var rvaL = normHex(rm[1]);
        var offL = normHex(rm[2]);
        var mname = '', msig = '';
        for (var j = i + 1; j < Math.min(i + 7, n); j++) {
          var jt = lines[j].trim();
          if (!jt || jt.indexOf('//') === 0) continue;
          var mm = METHOD_RE.exec(jt);
          if (mm && !SKIP[mm[1].toLowerCase()]) { mname = mm[1]; msig = jt; break; }
        }
        if (mname) {
          addEntry({ cls: currentCls, name: mname, sig: msig, rva: rvaL, offset: offL, field: null, isField: false });
        }
      }
      continue;
    }

    if (tr.indexOf('FieldOffset') !== -1) {
      var fm = FIELDOFFSET_RE.exec(tr);
      if (fm && currentCls) {
        var fhex = normHex(fm[1]);
        for (var k = i + 1; k < Math.min(i + 5, n); k++) {
          var kt = lines[k].trim();
          if (!kt) continue;
          FIELDDECL_RE.lastIndex = 0;
          var last = null, tmp;
          while ((tmp = FIELDDECL_RE.exec(kt)) !== null) last = tmp;
          if (last && last[1] && !SKIP[last[1].toLowerCase()]) {
            addEntry({ cls: currentCls, name: last[1], rva: null, offset: null, field: fhex, isField: true });
            break;
          }
        }
      }
      continue;
    }

    var inlineField = INLINE_FIELD_RE.exec(ln);
    if (inlineField && currentCls) {
      addEntry({ cls: currentCls, name: inlineField[1], rva: null, offset: null, field: normHex(inlineField[2]), isField: true });
    }
  }

  postMessage({ type: 'progress', pct: weightStart + weightSpan });
  return { byFQN: byFQN, byName: byName, byHex: byHex, byCombined: byCombined, bySig: bySig };
}

function findOffsets(text) {
  var found = [];
  var usedPos = new Set();
  var tlines = text.split('\n');
  var pos = 0;
  for (var li = 0; li < tlines.length; li++) {
    var line = tlines[li];
    /* Never touch // comments — strip comment portion before matching hex */
    var codePart = line;
    var cmtIdx = line.indexOf('//');
    if (cmtIdx !== -1) {
      codePart = line.slice(0, cmtIdx);
    }
    /* Skip pure-comment lines entirely */
    if (!codePart.trim()) {
      pos += line.length + 1;
      continue;
    }

    NAMED_HEX_RE.lastIndex = 0;
    var m;
    while ((m = NAMED_HEX_RE.exec(codePart)) !== null) {
      var hexStart = pos + m.index + m[0].lastIndexOf(m[2]);
      if (!usedPos.has(hexStart)) {
        var hx = m[2];
        var hxV = parseInt(hx.replace(/^0x/i, ''), 16);
        if (!isNaN(hxV) && hxV >= OFFSET_MIN && hxV <= OFFSET_MAX) {
          usedPos.add(hexStart);
          found.push({
            name: m[1],
            shortName: deriveShortName(m[1]),
            oldVal: hx,
            oldValL: normHex(hx),
            matchStart: hexStart,
            matchEnd: hexStart + hx.length
          });
        }
      }
    }

    BARE_HEX_RE.lastIndex = 0;
    while ((m = BARE_HEX_RE.exec(codePart)) !== null) {
      var abs = pos + m.index;
      if (!usedPos.has(abs)) {
        var hx2 = m[1];
        var hx2V = parseInt(hx2.replace(/^0x/i, ''), 16);
        if (!isNaN(hx2V) && hx2V >= OFFSET_MIN && hx2V <= OFFSET_MAX) {
          usedPos.add(abs);
          found.push({
            name: '',
            shortName: '',
            oldVal: hx2,
            oldValL: normHex(hx2),
            matchStart: abs,
            matchEnd: abs + hx2.length
          });
        }
      }
    }
    pos += line.length + 1;
  }
  found.sort(function(a, b) { return a.matchStart - b.matchStart; });
  return found;
}

function valMatches(h, valL) {
  return h.isField ? (h.field === valL) : (h.rva === valL || h.offset === valL);
}

function lookupOld(ofs, data) {
  // Step 1: search the RVA/Field VALUE found in the target file against
  // the OLD dump. This is the single source of truth for "what symbol
  // does this hex belong to" — a name label in the target file is only
  // used later, and only to break a tie if the exact same value is
  // shared by more than one old-dump entry. We never guess by name
  // alone: if the value isn't in the old dump, we simply don't know
  // what it was, so we don't match anything.
  var hexHits = data.byHex.get(ofs.oldValL);
  if (!hexHits || !hexHits.length) return null;

  if (hexHits.length === 1) return hexHits[0];

  if (ofs.name) {
    var nlf = ofs.name.toLowerCase();
    for (var h = 0; h < hexHits.length; h++) {
      if (hexHits[h].name.toLowerCase() === nlf) return hexHits[h];
    }
    var snf = (ofs.shortName || '').toLowerCase();
    if (snf) {
      for (var h2 = 0; h2 < hexHits.length; h2++) {
        if (hexHits[h2].name.toLowerCase() === snf) return hexHits[h2];
      }
    }
  }

  return hexHits[0];
}

function lookupNew(data, oldE) {
  // Step 3-4: for methods, primary match is the full method signature line
  // (the line sitting below the RVA comment in the dump). This matches exactly
  // what the user described: search the method signature text in the new dump,
  // then grab the RVA sitting above it. Falls back to class::name if no sig hit.
  // Fields always go straight to FQN — field lines don't have a reliable sig.
  if (!oldE.isField && oldE.sig) {
    var sk = normSig(oldE.sig);
    var sigHits = data.bySig ? data.bySig.get(sk) : null;
    if (sigHits && sigHits.length) {
      if (sigHits.length === 1) return sigHits[0];
      // Multiple classes share the same sig — prefer same class name
      var clsL = oldE.cls.toLowerCase();
      for (var s = 0; s < sigHits.length; s++) {
        if (sigHits[s].cls.toLowerCase() === clsL) return sigHits[s];
      }
      return sigHits[0];
    }
  }

  // Fallback: FQN then combined-key
  var fqn = (oldE.cls + '::' + oldE.name).toLowerCase();
  var direct = data.byFQN.get(fqn);
  if (direct && direct.isField === oldE.isField) return direct;

  var ck = normKey(oldE.cls + oldE.name);
  var combinedHits = data.byCombined.get(ck);
  if (combinedHits) {
    for (var c = 0; c < combinedHits.length; c++) {
      if (combinedHits[c].isField === oldE.isField) return combinedHits[c];
    }
  }

  return null;
}

function processOne(ofs, oldData, newData) {
  var res = { name: ofs.name || ofs.oldVal, cls: '', oldVal: ofs.oldVal, newVal: ofs.oldVal, entryType: 'unknown', status: 'ignored' };

  // Step 1-2: locate the value in the OLD dump, which also gives us the
  // class and method/field it belongs to.
  var oldE = lookupOld(ofs, oldData);
  if (!oldE) {
    res.status = ofs.name ? 'failed' : 'ignored';
    return res;
  }

  res.cls = oldE.cls;
  res.name = oldE.name;
  res.entryType = oldE.isField ? 'field' : 'rva';

  // Step 3-4: search that same method signature (then class::name fallback) in the NEW dump.
  var newE = lookupNew(newData, oldE);
  if (!newE) { res.status = 'failed'; return res; }

  var newVal = null;
  if (oldE.isField) {
    newVal = newE.field;
  } else {
    if (oldE.rva === ofs.oldValL) newVal = newE.rva;
    else if (oldE.offset === ofs.oldValL) newVal = newE.offset;
    else newVal = newE.rva || newE.offset;
  }
  if (!newVal) { res.status = 'failed'; return res; }

  if (newVal === ofs.oldValL) { res.status = 'same'; res.newVal = ofs.oldVal; return res; }

  // Step 5: replace the old value with the latest value from the new dump.
  res.status = 'updated';
  res.newVal = '0x' + newVal.replace(/^0x/, '').toUpperCase();
  res._spliceVal = newVal;
  return res;
}

self.onmessage = function(e) {
  try {
    var d = e.data;
    var decoder = new TextDecoder('utf-8');

    var oldText = decoder.decode(d.oldBuf); d.oldBuf = null;
    var newText = decoder.decode(d.newBuf); d.newBuf = null;
    var tgtText = decoder.decode(d.tgtBuf); d.tgtBuf = null;

    var oldLines = oldText.split('\n'); oldText = null;
    var newLines = newText.split('\n'); newText = null;

    var oldData = parseDump(oldLines, 2, 43);
    oldLines = null;
    var newData = parseDump(newLines, 45, 43);
    newLines = null;

    postMessage({ type: 'progress', pct: 90 });
    var offsets = findOffsets(tgtText);

    var R = { all: [], updated: [], failed: [], ignored: [], same: [] };
    for (var i = 0; i < offsets.length; i++) {
      var res = processOne(offsets[i], oldData, newData);
      res._matchStart = offsets[i].matchStart;
      res._matchEnd = offsets[i].matchEnd;
      R.all.push(res);
      R[res.status].push(res);
    }

    postMessage({ type: 'progress', pct: 96 });

    var updates = R.updated.slice().sort(function(a, b) { return a._matchStart - b._matchStart; });
    var out = [];
    var cursor = 0;
    for (var u = 0; u < updates.length; u++) {
      var it = updates[u];
      out.push(tgtText.slice(cursor, it._matchStart));
      out.push(it._spliceVal.replace(/^0x/i, '0x').toUpperCase().replace('0X', '0x'));
      cursor = it._matchEnd;
    }
    out.push(tgtText.slice(cursor));
    var updatedText = out.join('');

    function clean(r) { return { name: r.name, cls: r.cls, oldVal: r.oldVal, newVal: r.newVal, entryType: r.entryType, status: r.status }; }
    var out2 = {
      updated: R.updated.map(clean),
      failed: R.failed.map(clean),
      ignored: R.ignored.map(clean),
      same: R.same.map(clean),
      total: R.all.length
    };

    postMessage({ type: 'done', results: out2, updatedText: updatedText });
  } catch (err) {
    postMessage({ type: 'error', message: (err && err.message) ? err.message : String(err) });
  }
};