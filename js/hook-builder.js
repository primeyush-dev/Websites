/**
 * YUSH TOOLS — Hook Builder
 */
(function (global) {
  'use strict';

  var RETURN_TYPES = [
    'bool', 'int', 'float', 'void', 'void*', 'double',
    'int64_t', 'uint32_t', 'uint64_t', 'size_t',
    'const char*', 'Vector3', 'Quaternion'
  ];

  var DEFAULT_DUMP =
    '// Namespace: GameUI\n' +
    'public class BlueprintWeaponInfo : ItemBase\n' +
    '{\n' +
    '    // RVA: 0x79B2A00 Offset: 0x79B2A00\n' +
    '    public void SetLockNewFlag(bool visible) { }\n' +
    '}\n' +
    '\n';

  var DEFAULT_LIB = 'libunity.so';

  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sanitizeIdent(s, fallback) {
    s = String(s || '').trim().replace(/[^\w]/g, '_');
    if (!s || /^\d/.test(s)) s = (fallback || 'Target') + (s ? '_' + s : '');
    return s;
  }

  function normalizeOffset(off) {
    off = String(off || '').trim();
    if (!off) return '0x0';
    if (/^0x/i.test(off)) return '0x' + off.slice(2).toUpperCase();
    if (/^[0-9a-f]+$/i.test(off)) return '0x' + off.toUpperCase();
    return off;
  }

  function parseParams(raw) {
    raw = String(raw || '').trim();
    if (!raw) return { full: 'void', args: [] };
    var parts = raw.split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    var args = parts.map(function (p) {
      var m = p.match(/^(.+?)\s+([\w]+)$/);
      if (m) return { type: m[1].trim(), name: m[2].trim() };
      return { type: p, name: '' };
    });
    var full = args.map(function (a) {
      return a.name ? (a.type + ' ' + a.name) : a.type;
    }).join(', ');
    return { full: full || 'void', args: args };
  }

  function buildTemplate(opts) {
    var hasClass = !!(opts.className && String(opts.className).trim());
    var hasMethod = !!(opts.method && String(opts.method).trim());
    var cls = sanitizeIdent(opts.className || 'TargetClass', 'TargetClass');
    var method = sanitizeIdent(opts.method || 'TargetMethod', 'TargetMethod');
    // Default demo uses bool / void params when fields empty
    var ret = (opts.returnType || (hasClass ? 'void' : 'bool')).trim() || 'void';
    var offset = normalizeOffset(opts.offset || '0x0');
    var lib = DEFAULT_LIB;
    var p = parseParams(opts.params);
    if (!hasClass && !hasMethod && !String(opts.params || '').trim()) {
      p = { full: 'void', args: [] };
      ret = 'bool';
      offset = '0x0';
    }
    var origName = 'original_' + cls + '_' + method;
    var hookName = 'hooked_' + cls + '_' + method;
    var paramSig = p.full || 'void';
    var callArgs = p.args.filter(function (a) { return a.name; }).map(function (a) { return a.name; }).join(', ');

    var lines = [];
    // Compact single-line original pointer
    lines.push('inline ' + ret + ' (*' + origName + ')(' + paramSig + ') = nullptr;');
    lines.push('');
    lines.push('inline ' + ret + ' ' + hookName + '(' + paramSig + ')');
    lines.push('{');
    if (ret === 'void') {
      lines.push('    ' + origName + '(' + callArgs + ');');
    } else {
      lines.push('    return ' + origName + '(' + callArgs + ');');
    }
    lines.push('}');
    lines.push('');
    lines.push('HOOK_LIB("' + lib + '", "' + offset + '", ' + hookName + ', ' + origName + ');');
    return lines.join('\n');
  }

  function highlightCpp(src) {
    var tokens = [];
    var i = 0;
    var n = src.length;
    function push(type, text) {
      if (text) tokens.push({ type: type, text: text });
    }
    while (i < n) {
      if (src[i] === '/' && src[i + 1] === '/') {
        var end = src.indexOf('\n', i);
        if (end === -1) end = n;
        push('cm', src.slice(i, end));
        i = end;
        continue;
      }
      if (src[i] === '/' && src[i + 1] === '*') {
        var end2 = src.indexOf('*/', i + 2);
        if (end2 === -1) end2 = n; else end2 += 2;
        push('cm', src.slice(i, end2));
        i = end2;
        continue;
      }
      if (src[i] === '"') {
        var j = i + 1;
        while (j < n && src[j] !== '"') {
          if (src[j] === '\\') j++;
          j++;
        }
        push('str', src.slice(i, Math.min(j + 1, n)));
        i = Math.min(j + 1, n);
        continue;
      }
      if (/[0-9]/.test(src[i])) {
        var k = i;
        if (src[k] === '0' && (src[k + 1] === 'x' || src[k + 1] === 'X')) {
          k += 2;
          while (k < n && /[0-9a-fA-F]/.test(src[k])) k++;
        } else {
          while (k < n && /[0-9.]/.test(src[k])) k++;
        }
        push('num', src.slice(i, k));
        i = k;
        continue;
      }
      if (/[A-Za-z_]/.test(src[i])) {
        var m = i + 1;
        while (m < n && /[\w]/.test(src[m])) m++;
        var word = src.slice(i, m);
        var kw = {
          inline: 1, return: 1, void: 1, bool: 1, int: 1, float: 1, double: 1,
          const: 1, char: 1, nullptr: 1, true: 1, false: 1, public: 1, private: 1,
          protected: 1, class: 1, struct: 1, static: 1, virtual: 1, override: 1,
          int32_t: 1, int64_t: 1, uint32_t: 1, uint64_t: 1, size_t: 1
        };
        // Type / base class after ':' often red in dump viewers
        if (kw[word]) push('kw', word);
        else if (word === 'HOOK_LIB') push('fn', word);
        else {
          // Heuristic: identifiers right after "class " or ": " look like types
          var before = src.slice(Math.max(0, i - 8), i);
          if (/:\s*$/.test(before) || /class\s+$/.test(before)) push('type', word);
          else push('id', word);
        }
        i = m;
        continue;
      }
      push('op', src[i]);
      i++;
    }
    return tokens.map(function (t) {
      return '<span class="hb-tok hb-' + t.type + '">' + escHtml(t.text) + '</span>';
    }).join('');
  }

  function parseDumpEntry(text) {
    text = String(text || '');
    var out = { className: '', method: '', offset: '', returnType: '', params: '', namespace: '' };
    var ns = text.match(/\/\/\s*Namespace:\s*(\S+)/i);
    if (ns) out.namespace = ns[1];
    var cls = text.match(/\b(?:public|private|protected|internal)?\s*(?:static\s+)?(?:class|struct)\s+(\w+)/);
    if (cls) out.className = cls[1];
    var off = text.match(/Offset\s*:\s*(0x[0-9A-Fa-f]+)/i)
      || text.match(/RVA\s*:\s*(0x[0-9A-Fa-f]+)/i);
    if (off) out.offset = off[1];

    var lines = text.split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var tr = lines[i].trim();
      if (!tr || tr.indexOf('//') === 0 || tr === '{' || tr === '}') continue;
      if (/\b(?:class|struct|namespace|interface)\b/.test(tr)) continue;
      var sig = tr.match(/^(?:public|private|protected|internal)?\s*(?:static\s+)?(?:virtual\s+|override\s+|abstract\s+)?([\w:<>,\s\*]+?)\s+(\w+)\s*\(([^)]*)\)/);
      if (sig) {
        out.returnType = sig[1].replace(/\s+/g, ' ').trim();
        out.method = sig[2];
        out.params = sig[3].trim();
        var map = {
          'System.Void': 'void', Void: 'void', void: 'void',
          'System.Boolean': 'bool', Boolean: 'bool', bool: 'bool',
          'System.Int32': 'int', Int32: 'int', int: 'int',
          'System.Single': 'float', Single: 'float', float: 'float',
          'System.Double': 'double', Double: 'double', double: 'double',
          'System.Int64': 'int64_t', Int64: 'int64_t', long: 'int64_t',
          'System.UInt32': 'uint32_t', UInt32: 'uint32_t',
          'System.UInt64': 'uint64_t', UInt64: 'uint64_t',
          'System.String': 'const char*', String: 'const char*', string: 'const char*'
        };
        if (map[out.returnType]) out.returnType = map[out.returnType];
        break;
      }
    }
    return out;
  }

  /* Meta chips are a fixed guide (example dump) — only overwrite when we have real values */
  function setMeta(id, val) {
    var el = document.getElementById(id);
    if (!el) return;
    var v = val && String(val).trim();
    if (!v) return; // keep permanent guide text
    el.textContent = v;
    el.classList.remove('hb-meta-tip');
  }

  function resizeDumpEditor() {
    var ta = document.getElementById('hbDumpPaste');
    var pre = document.getElementById('hbDumpHighlight');
    if (!ta) return;
    ta.style.height = '0px';
    // Fit all lines; allow horizontal scroll instead of mid-token wrap
    var h = Math.max(160, ta.scrollHeight + 8);
    ta.style.height = h + 'px';
    if (pre) {
      pre.style.height = h + 'px';
      pre.style.minHeight = h + 'px';
    }
  }

  function syncDumpHighlight() {
    var ta = document.getElementById('hbDumpPaste');
    var pre = document.getElementById('hbDumpHighlight');
    if (!ta || !pre) return;
    var text = ta.value;
    // Trailing newline keeps last line fully visible in the mirror
    pre.innerHTML = text ? (highlightCpp(text) + (text.slice(-1) === '\n' ? '\n' : '\n\n')) : '';
    resizeDumpEditor();
  }

  function bindHookBuilder() {
    var panel = document.getElementById('hbRetPanel');
    var trigger = document.getElementById('hbRetTrigger');
    var label = document.getElementById('hbRetLabel');
    var hidden = document.getElementById('hbReturn');
    if (!panel || !trigger) return;

    panel.innerHTML = RETURN_TYPES.map(function (t) {
      return '<button type="button" class="hb-type-opt" role="option" data-value="' + escHtml(t) + '">' +
        '<span class="hb-type-name">' + escHtml(t) + '</span>' +
        '<span class="hb-type-radio" aria-hidden="true"></span>' +
        '</button>';
    }).join('');

    function setReturn(val, silent) {
      val = (val || '').trim();
      hidden.value = val;
      if (val) {
        label.textContent = val;
        label.classList.remove('hb-placeholder');
      } else {
        label.textContent = 'Select Return Type';
        label.classList.add('hb-placeholder');
      }
      panel.querySelectorAll('.hb-type-opt').forEach(function (btn) {
        btn.classList.toggle('selected', btn.getAttribute('data-value') === val);
      });
      if (!silent) refresh();
    }

    function closePanel() {
      panel.hidden = true;
      trigger.classList.remove('open');
    }

    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var willOpen = panel.hidden;
      panel.hidden = !willOpen;
      trigger.classList.toggle('open', willOpen);
    });

    panel.addEventListener('click', function (e) {
      var btn = e.target.closest('.hb-type-opt');
      if (!btn) return;
      setReturn(btn.getAttribute('data-value'));
      closePanel();
    });

    document.addEventListener('click', function (e) {
      if (!panel.hidden && !panel.contains(e.target) && e.target !== trigger && !trigger.contains(e.target)) {
        closePanel();
      }
    });

    function readOpts() {
      return {
        offset: (document.getElementById('hbOffset') || {}).value || '0x0',
        className: (document.getElementById('hbClass') || {}).value || 'TargetClass',
        method: (document.getElementById('hbMethod') || {}).value || 'TargetMethod',
        returnType: (document.getElementById('hbReturn') || {}).value || 'void',
        params: (document.getElementById('hbParams') || {}).value || ''
      };
    }

    function refresh() {
      var opts = readOpts();
      var codeEl = document.getElementById('hbCodeInner');
      var linesEl = document.getElementById('hbLineCount');
      if (!codeEl) return;
      var src = buildTemplate(opts);
      codeEl.innerHTML = highlightCpp(src);
      if (linesEl) linesEl.textContent = src.split('\n').length + ' lines';
    }

    function onFieldInput() {
      // Meta chips stay as permanent guide — form edits only refresh output
      refresh();
    }

    function applyParsed(parsed, fillFields) {
      if (!parsed) return;
      // Guide chips: only update when value is present
      if (parsed.className) setMeta('hbMetaClass', parsed.className);
      if (parsed.offset) setMeta('hbMetaOffset', parsed.offset);
      if (parsed.method) setMeta('hbMetaMethod', parsed.method);
      if (parsed.returnType) setMeta('hbMetaRet', parsed.returnType);
      if (parsed.params) setMeta('hbMetaParams', parsed.params);
      if (fillFields) {
        var off = (parsed.offset || '').trim();
        if (off && off !== '0' && off !== '0x0') {
          var o = document.getElementById('hbOffset');
          if (o) o.value = off;
        }
        if (parsed.className) {
          var c = document.getElementById('hbClass');
          if (c) c.value = parsed.className;
        }
        if (parsed.method) {
          var m = document.getElementById('hbMethod');
          if (m) m.value = parsed.method;
        }
        if (parsed.params) {
          var p = document.getElementById('hbParams');
          if (p) p.value = parsed.params;
        }
        // Do not auto-set return type — user picks it
      }
      refresh();
    }

    ['hbOffset', 'hbClass', 'hbMethod', 'hbParams'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', onFieldInput);
        el.addEventListener('change', onFieldInput);
      }
    });

    var ta = document.getElementById('hbDumpPaste');
    if (ta) {
      ta.value = DEFAULT_DUMP;
      ta.readOnly = true;
      // Guide only — no editing / no auto-fill of form from dump
      ta.addEventListener('scroll', function () {
        var pre = document.getElementById('hbDumpHighlight');
        if (pre) { pre.scrollTop = ta.scrollTop; pre.scrollLeft = ta.scrollLeft; }
      });
      syncDumpHighlight();
      applyParsed(parseDumpEntry(DEFAULT_DUMP), false);
      setReturn('', true);
      // Clear any leftover form values from older sessions
      ['hbOffset', 'hbClass', 'hbMethod', 'hbParams'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
      });
      refresh();
      setTimeout(function () { syncDumpHighlight(); setReturn('', true); }, 0);
      setTimeout(function () { syncDumpHighlight(); }, 60);
    }

    function fallbackCopy(text) {
      var ta2 = document.createElement('textarea');
      ta2.value = text;
      ta2.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta2);
      ta2.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta2);
    }

    var copyBtn = document.getElementById('hbCopy');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var src = buildTemplate(readOpts());
        function ok() {
          var prev = copyBtn.innerHTML;
          copyBtn.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg> Copied';
          setTimeout(function () { copyBtn.innerHTML = prev; }, 1400);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(src).then(ok).catch(function () { fallbackCopy(src); ok(); });
        } else { fallbackCopy(src); ok(); }
      });
    }

    var dlBtn = document.getElementById('hbDownload');
    if (dlBtn) {
      dlBtn.addEventListener('click', function () {
        var opts = readOpts();
        var src = buildTemplate(opts);
        var cls = sanitizeIdent(opts.className, 'Target');
        var method = sanitizeIdent(opts.method, 'Method');
        var blob = new Blob([src], { type: 'text/plain;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'hook_' + cls + '_' + method + '.h';
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      });
    }

    setReturn((document.getElementById('hbReturn') || {}).value || 'void', true);
    refresh();
  }

  global.YushHookBuilder = {
    bind: bindHookBuilder,
    buildTemplate: buildTemplate,
    parseDumpEntry: parseDumpEntry,
    RETURN_TYPES: RETURN_TYPES
  };
})(typeof window !== 'undefined' ? window : this);
