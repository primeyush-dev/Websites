/**
 * YUSH TOOLS — Offset Finder engine
 */
(function (global) {
  'use strict';

  function extractOffset(line) {
    var li = line.toLowerCase(), idx = li.indexOf('offset:');
    if (idx !== -1) {
      var m = line.slice(idx).match(/0x[0-9a-fA-F]+/);
      if (m) return m[0];
    }
    var m2 = line.match(/0x[0-9a-fA-F]+/);
    return m2 ? m2[0] : null;
  }

  function newSS() { return { stack: [], depth: 0, namespace: '', pending: null }; }

  function updScope(s, line) {
    var ns = line.match(/^\s*\/\/\s*[Nn]amespace:\s*(.+?)\s*$/);
    if (ns) { s.namespace = ns[1]; return; }
    if (!s.pending) {
      var dm = line.match(/(?:^|\s|[^\w])(?:class|struct|interface|enum)\s+([\w<>.]+)/);
      if (dm) s.pending = dm[1];
    }
    if (line.indexOf('{') === -1 && line.indexOf('}') === -1) return;
    for (var i = 0; i < line.length; i++) {
      var ch = line[i];
      if (ch === '{') {
        s.depth++;
        if (s.pending) { s.stack.push({ name: s.pending, baseDepth: s.depth }); s.pending = null; }
      } else if (ch === '}') {
        var top = s.stack[s.stack.length - 1];
        if (top && s.depth === top.baseDepth) s.stack.pop();
        s.depth = Math.max(0, s.depth - 1);
      }
    }
  }

  function parseDumpText(text) {
    var state = newSS();
    var lines = text.split('\n');
    var pendingOff = null;
    var pendingFieldOff = null;
    var parsed = [];
    for (var i = 0; i < lines.length; i++) {
      var raw = lines[i];
      updScope(state, raw);
      var tr = raw.trim();
      if (!tr) continue;

      // FieldOffset attribute on its own line
      var fo = tr.match(/\[FieldOffset\(\s*"?(0x[0-9A-Fa-f]+)"?\s*\)\]/i);
      if (fo) {
        pendingFieldOff = fo[1];
        pendingOff = null;
        continue;
      }

      if (tr.indexOf('//') === 0) {
        var off = extractOffset(tr);
        if (off) { pendingOff = off; pendingFieldOff = null; }
        continue;
      }

      var ns = state.namespace || null;
      var cls = state.stack.length ? state.stack[state.stack.length - 1].name : null;

      // Method/RVA line after // Offset comment
      if (pendingOff !== null) {
        var isM = tr.indexOf('(') !== -1 && tr.indexOf(')') !== -1;
        var name = '';
        if (isM) {
          var mm = tr.match(/\b(\w+)\s*\(/);
          name = mm ? mm[1] : '';
        } else {
          var fm = tr.match(/(\w+)\s*[;=\[]/);
          name = fm ? fm[1] : '';
        }
        parsed.push({
          namespace: ns,
          className: cls,
          name: name,
          signature: tr,
          lineNumber: i + 1,
          offset: pendingOff,
          type: isM ? 'method' : 'field'
        });
        pendingOff = null;
        continue;
      }

      // Field after [FieldOffset]
      if (pendingFieldOff !== null) {
        var fm2 = tr.match(/(\w+)\s*[;=\[]/);
        if (fm2) {
          parsed.push({
            namespace: ns,
            className: cls,
            name: fm2[1],
            signature: tr,
            lineNumber: i + 1,
            offset: pendingFieldOff,
            type: 'field'
          });
          pendingFieldOff = null;
        }
        continue;
      }

      // Inline field: type name; // 0xNN
      var inline = tr.match(/^[\w\s<>,\[\]\.*]+\s+(\w+)\s*;\s*\/\/\s*(0x[0-9A-Fa-f]+)/i);
      if (inline && tr.indexOf('(') === -1) {
        parsed.push({
          namespace: ns,
          className: cls,
          name: inline[1],
          signature: tr,
          lineNumber: i + 1,
          offset: inline[2],
          type: 'field'
        });
      }
    }
    return parsed;
  }

  /**
   * filter: 'all' | 'methods' | 'fields'
   * all = methods + fields
   */
  function search(parsed, query, filter) {
    var ql = String(query || '').toLowerCase().trim();
    var base = parsed.filter(function (r) {
      return (r.signature || '').toLowerCase().indexOf(ql) !== -1
        || (r.className || '').toLowerCase().indexOf(ql) !== -1
        || (r.namespace || '').toLowerCase().indexOf(ql) !== -1
        || (r.name || '').toLowerCase().indexOf(ql) !== -1
        || (r.offset || '').toLowerCase().indexOf(ql) !== -1;
    });
    if (filter === 'methods') base = base.filter(function (r) { return r.type === 'method'; });
    else if (filter === 'fields') base = base.filter(function (r) { return r.type === 'field'; });
    // 'all' keeps both
    return base;
  }

  global.YushFinder = { parseDumpText: parseDumpText, search: search };
})(typeof self !== 'undefined' ? self : this);
