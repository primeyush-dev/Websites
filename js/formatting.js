/**
 * YUSH TOOLS — Bypass Formatting
 */
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /* ════════════════════════════════════════
     BYPASS FORMATTING
     ════════════════════════════════════════ */
  function parseBpOffsets(raw) {
    var lines = String(raw || '').split(/\r?\n/);
    var out = [];
    var seen = {};
    lines.forEach(function (line) {
      line = line.replace(/[#;].*$/, '').trim();
      if (!line) return;
      var m = line.match(/(?:0x)?([0-9A-Fa-f]{3,16})\b/);
      if (!m) return;
      var hex = m[1].toUpperCase().replace(/^0+/, '') || '0';
      var norm = '0x' + hex;
      if (seen[norm]) return;
      seen[norm] = true;
      out.push(norm);
    });
    return out;
  }

  function highlightCpp(code) {
    var lines = String(code || '').split('\n');
    return lines.map(function (line) {
      var escMap = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
      var s = line.replace(/[&<>]/g, function (c) { return escMap[c]; });
      // order: strings, then numbers, then keywords, then call names
      s = s.replace(/("(?:\\.|[^"\\])*")/g, '§S§$1§E§');
      s = s.replace(/\b(0x[0-9A-Fa-f]+|\d+)\b/g, '§N§$1§E§');
      s = s.replace(/\b(inline|uintptr_t|void)\b/g, '§K§$1§E§');
      s = s.replace(/\b([A-Za-z_][\w:]*)\s*(?=\()/g, '§F§$1§E§');
      s = s
        .replace(/§S§/g, '<span class="tok-str">')
        .replace(/§N§/g, '<span class="tok-num">')
        .replace(/§K§/g, '<span class="tok-kw">')
        .replace(/§F§/g, '<span class="tok-fn">')
        .replace(/§E§/g, '</span>');
      return s;
    }).join('\n');
  }


  function buildBpFormats(lib, hex, offsets) {
    lib = String(lib || 'libanogs.so').trim() || 'libanogs.so';
    hex = String(hex || '00 00 80 D2 C0 03 5F D6').trim() || '00 00 80 D2 C0 03 5F D6';
    var formats = [];

    formats.push({
      name: 'EncOff Format',
      code: offsets.map(function (o) { return 'EncOff(' + o + '),'; }).join('\n')
    });

    formats.push({
      name: 'Bypass Format',
      code: offsets.map(function (o, i) {
        return 'inline uintptr_t bypass' + (i + 1) + ' = ' + o + ';';
      }).join('\n')
    });

    formats.push({
      name: 'Direct Memory Patch',
      code: offsets.map(function (o) {
        return 'MemoryPatch::createWithHex("' + lib + '", ' + o + ', "' + hex + '").Modify();';
      }).join('\n')
    });

    formats.push({
      name: 'ArmFalse Patch',
      code: offsets.map(function (o, i) {
        return 'MemoryPatch::createWithHex(OBFUSCATE("' + lib + '"), bypass' + (i + 1) + ', armFalse).Modify();';
      }).join('\n')
    });

    formats.push({
      name: 'Tools::Hook Calls',
      code: offsets.map(function (o) {
        return 'Tools::Hook((void*)getAbsoluteAddress(OBFUSCATE("' + lib + '"), ' + o + '), (void*)hook_bypass, (void**)&orig_bypass);';
      }).join('\n')
    });

    formats.push({
      name: 'Dobby Hook Calls',
      code: offsets.map(function (o) {
        return 'DobbyHook((void*)getAbsoluteAddress(OBFUSCATE("' + lib + '"), ' + o + '), (void*)hook_bypass, (void**)&orig_bypass);';
      }).join('\n')
    });

    formats.push({
      name: 'Hook Lib Format',
      code: offsets.map(function (o) {
        return 'HOOK_LIB("' + lib + '", "' + o + '", h_disabled, o_disabled);';
      }).join('\n')
    });

    formats.push({
      name: 'HexPatch (Injector)',
      code: offsets.map(function (o) {
        return 'HexPatches.MemoryPatch("' + lib + '", ' + o + ', "' + hex + '", 32);';
      }).join('\n')
    });

    return formats;
  }


  function renderBpResults(formats) {
    var host = document.getElementById('bpResults');
    if (!host) return;
    host.style.display = '';
    host.innerHTML = formats.map(function (f, i) {
      return '<div class="bp-format-card">' +
        '<div class="bp-format-head">' +
          '<div class="bp-format-title">' + esc(f.name) + '</div>' +
          '<div class="bp-format-actions">' +
            '<button type="button" class="bp-copy-btn" data-bp-copy="' + i + '">Copy</button>' +
          '</div>' +
        '</div>' +
        '<pre class="bp-code" id="bpCode' + i + '">' + highlightCpp(f.code) + '</pre>' +
      '</div>';
    }).join('');

    host.querySelectorAll('[data-bp-copy]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var idx = parseInt(btn.getAttribute('data-bp-copy'), 10);
        var text = formats[idx] ? formats[idx].code : '';
        function done() {
          btn.textContent = 'Copied';
          btn.classList.add('copied');
          setTimeout(function () {
            btn.textContent = 'Copy';
            btn.classList.remove('copied');
          }, 1400);
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(text).then(done).catch(function () {
            try {
              var ta = document.createElement('textarea');
              ta.value = text;
              document.body.appendChild(ta);
              ta.select();
              document.execCommand('copy');
              document.body.removeChild(ta);
              done();
            } catch (e) {}
          });
        } else {
          try {
            var ta2 = document.createElement('textarea');
            ta2.value = text;
            document.body.appendChild(ta2);
            ta2.select();
            document.execCommand('copy');
            document.body.removeChild(ta2);
            done();
          } catch (e2) {}
        }
      });
    });
  }

  function bindBypassFormatting() {
    var btn = document.getElementById('btnBpGenerate');
    var ta = document.getElementById('bpOffsets');
    if (!btn) return;

    function run() {
      var lib = (document.getElementById('bpLibrary') || {}).value || 'libanogs.so';
      var hex = (document.getElementById('bpHex') || {}).value || '00 00 80 D2 C0 03 5F D6';
      var offsets = parseBpOffsets((ta && ta.value) || '');
      var host = document.getElementById('bpResults');
      if (!offsets.length) {
        if (host) {
          host.style.display = '';
          host.innerHTML = '<div class="card empty-state"><h3>No offsets</h3><p>Paste at least one offset (e.g. 0x4E3E9D4).</p></div>';
        }
        return;
      }
      renderBpResults(buildBpFormats(lib, hex, offsets));
    }

    btn.addEventListener('click', run);
    if (ta) {
      ta.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
          e.preventDefault();
          run();
        }
      });
    }
  }



  window.YushFormatting = {
    init: function () {
      if (typeof bindBypassFormatting === 'function') bindBypassFormatting();
    },
    generate: function () {
      var btn = document.getElementById('btnBpGenerate');
      if (btn) btn.click();
    }
  };
})();
