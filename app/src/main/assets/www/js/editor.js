/* =========================================================================
 * editor.js — 编辑器（高亮叠层方案）
 *
 * 功能：
 *   - textarea 透明文字 + <pre> 彩色高亮叠层
 *   - 行号 / 同步滚动 / Tab 缩进
 *   - 文件内查找（find / findNext / findPrev）
 *   - 字体缩放（按钮 + 双指捏合 + Ctrl+/-/0）
 *   - 撤回 / 重做（undo / redo）
 *   - 花括号匹配高亮
 *   - 自定义右侧拖拽滑块
 *   - 长按唤起复制
 *   - 光标位置跟踪（行:列）
 * ========================================================================= */
(function (global) {
  'use strict';

  let wrap, gutter, gutterInner, scrollBox, pre, code, ta;
  let scrollbar, scrollThumb;
  let lang = 'text';
  let currentFile = null;
  let onChangeCb = null;
  let matches = [];
  let matchIdx = -1;

  // ---- 字体缩放 ----
  let fontSize = 13;
  const FS_MIN = 9, FS_MAX = 32, FS_DEFAULT = 13;
  let onZoomCb = null;

  // ---- 撤回 / 重做 ----
  let undoStack = [];
  let redoStack = [];
  let inputTimer = null;
  let onUndoChangedCb = null;

  // ---- 花括号匹配 ----
  let currentBracketMatch = null; // [pos1, pos2] 或 null

  // ---- 光标跟踪 ----
  let onCursorCb = null;

  // ---- 捏合缩放 ----
  let pinchDist = 0, pinchFs = 0;

  // ---- 长按复制 ----
  let lastTouchX = 0, lastTouchY = 0;

  // ======================== 字体缩放 ========================
  function applyFontSize() {
    if (!wrap) return;
    var lh = Math.round(fontSize * 1.5);
    wrap.style.setProperty('--fs', fontSize + 'px');
    wrap.style.setProperty('--lh', lh + 'px');
    if (onZoomCb) onZoomCb(fontSize);
  }
  function setFontSize(px) {
    fontSize = Math.max(FS_MIN, Math.min(FS_MAX, Math.round(px)));
    applyFontSize();
    try { localStorage.setItem('codex-font-size', String(fontSize)); } catch (e) {}
  }
  function zoomIn() { setFontSize(fontSize + 1); }
  function zoomOut() { setFontSize(fontSize - 1); }
  function zoomReset() { setFontSize(FS_DEFAULT); }

  // ======================== 捏合手势 ========================
  function touchDist(e) {
    var dx = e.touches[0].clientX - e.touches[1].clientX;
    var dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }
  function onPinchStart(e) {
    if (e.touches.length === 2) {
      pinchDist = touchDist(e);
      pinchFs = fontSize;
      e.preventDefault();
    }
  }
  function onPinchMove(e) {
    if (e.touches.length === 2 && pinchDist > 10) {
      setFontSize(pinchFs * (touchDist(e) / pinchDist));
      e.preventDefault();
    }
  }
  function onPinchEnd(e) {
    if (e.touches.length < 2) pinchDist = 0;
  }

  // ======================== 撤回 / 重做 ========================
  function snapshot() {
    return { value: ta.value, start: ta.selectionStart, end: ta.selectionEnd };
  }
  function restoreSnap(s) {
    ta.value = s.value;
    ta.selectionStart = s.start;
    ta.selectionEnd = s.end;
    render();
    syncScroll();
    updateCursorInfo();
  }
  function initUndo() {
    undoStack = [snapshot()];
    redoStack = [];
    notifyUndoChanged();
  }
  function notifyUndoChanged() {
    if (onUndoChangedCb) onUndoChangedCb(undoStack.length > 1, redoStack.length > 0);
  }
  function flushInput() {
    if (inputTimer) { clearTimeout(inputTimer); inputTimer = null; }
    var cur = snapshot();
    if (undoStack.length === 0 || undoStack[undoStack.length - 1].value !== cur.value) {
      undoStack.push(cur);
      if (undoStack.length > 100) undoStack.shift();
      redoStack = [];
      notifyUndoChanged();
    }
  }
  function undo() {
    flushInput();
    if (undoStack.length <= 1) return;
    redoStack.push(undoStack.pop());
    restoreSnap(undoStack[undoStack.length - 1]);
    notifyUndoChanged();
  }
  function redo() {
    if (redoStack.length === 0) return;
    var snap = redoStack.pop();
    undoStack.push(snap);
    restoreSnap(snap);
    notifyUndoChanged();
  }

  // ======================== 花括号匹配 ========================
  var BRACKETS = { '(': ')', '[': ']', '{': '}', ')': '(', ']': '[', '}': '{' };
  var OPEN = '([{', CLOSE = ')]}';

  function findMatchingBracket(text, pos) {
    var ch = text[pos];
    if (!ch || !BRACKETS[ch]) return -1;
    var target = BRACKETS[ch];
    var isOpen = OPEN.indexOf(ch) >= 0;
    var depth = 0;
    if (isOpen) {
      for (var i = pos; i < text.length; i++) {
        if (text[i] === ch) depth++;
        else if (text[i] === target) { depth--; if (depth === 0) return i; }
      }
    } else {
      for (var i = pos; i >= 0; i--) {
        if (text[i] === ch) depth++;
        else if (text[i] === target) { depth--; if (depth === 0) return i; }
      }
    }
    return -1;
  }

  function checkBracketAtCursor() {
    var pos = ta.selectionStart;
    var text = ta.value;
    // 优先检查光标前的字符
    if (pos > 0 && BRACKETS[text[pos - 1]]) {
      var m = findMatchingBracket(text, pos - 1);
      if (m >= 0) return [pos - 1, m];
    }
    // 再检查光标处的字符
    if (pos < text.length && BRACKETS[text[pos]]) {
      var m2 = findMatchingBracket(text, pos);
      if (m2 >= 0) return [pos, m2];
    }
    return null;
  }

  function updateBracketMatch() {
    var m = checkBracketAtCursor();
    var changed = !currentBracketMatch ? !!m :
                  !m ? true :
                  m[0] !== currentBracketMatch[0] || m[1] !== currentBracketMatch[1];
    currentBracketMatch = m;
    if (changed) render();
  }

  function highlightBracketsInDom(codeEl, positions) {
    if (!positions || positions.length === 0) return;
    var posSet = {};
    positions.forEach(function (p) { posSet[p] = true; });
    var rawPos = 0;
    var toReplace = [];
    function walk(node) {
      if (node.nodeType === 3) {
        var text = node.nodeValue;
        var has = false;
        for (var i = 0; i < text.length; i++) { if (posSet[rawPos + i]) { has = true; break; } }
        if (has) {
          var frag = document.createDocumentFragment();
          var last = 0;
          for (var i = 0; i < text.length; i++) {
            if (posSet[rawPos + i]) {
              if (i > last) frag.appendChild(document.createTextNode(text.slice(last, i)));
              var sp = document.createElement('span');
              sp.className = 'bracket-match';
              sp.textContent = text[i];
              frag.appendChild(sp);
              last = i + 1;
            }
          }
          if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
          toReplace.push({ old: node, frag: frag });
        }
        rawPos += text.length;
      } else if (node.nodeType === 1) {
        if (node.classList && node.classList.contains('bracket-match')) return;
        var child = node.firstChild;
        while (child) { walk(child); child = child.nextSibling; }
      }
    }
    walk(codeEl);
    toReplace.forEach(function (r) { r.old.parentNode.replaceChild(r.frag, r.old); });
  }

  // ======================== 光标信息 ========================
  function updateCursorInfo() {
    if (!onCursorCb || !ta) return;
    var pos = ta.selectionStart;
    var before = ta.value.substring(0, pos);
    var line = before.split('\n').length;
    var lastNl = before.lastIndexOf('\n');
    var col = pos - (lastNl < 0 ? -1 : lastNl);
    var total = ta.value.split('\n').length;
    onCursorCb({ line: line, col: col, totalLines: total });
  }

  // ======================== 自定义滚动条 ========================
  function buildScrollbar() {
    scrollbar = document.createElement('div');
    scrollbar.className = 'custom-scrollbar';
    scrollThumb = document.createElement('div');
    scrollThumb.className = 'custom-scroll-thumb';
    scrollbar.appendChild(scrollThumb);
    scrollBox.appendChild(scrollbar);
    updateScrollbar();

    // 拖拽
    var dragging = false;
    scrollThumb.addEventListener('pointerdown', function (e) {
      dragging = true;
      e.preventDefault();
      e.stopPropagation();
      var startY = e.clientY;
      var startScroll = ta.scrollTop;
      var maxScroll = ta.scrollHeight - ta.clientHeight;
      var thumbH = scrollThumb.offsetHeight;
      var range = ta.clientHeight - thumbH;
      function onMove(ev) {
        if (!dragging) return;
        ev.preventDefault();
        if (range > 0 && maxScroll > 0) {
          var dy = ev.clientY - startY;
          ta.scrollTop = Math.max(0, Math.min(maxScroll, startScroll + (dy / range) * maxScroll));
        }
      }
      function onUp() {
        dragging = false;
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
      }
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  }

  function updateScrollbar() {
    if (!scrollbar || !ta) return;
    var maxScroll = ta.scrollHeight - ta.clientHeight;
    if (maxScroll <= 0) {
      scrollbar.style.display = 'none';
      return;
    }
    scrollbar.style.display = '';
    var ratio = ta.scrollTop / maxScroll;
    var visibleRatio = ta.clientHeight / ta.scrollHeight;
    var thumbH = Math.max(30, visibleRatio * ta.clientHeight);
    var thumbTop = ratio * (ta.clientHeight - thumbH);
    scrollThumb.style.height = thumbH + 'px';
    scrollThumb.style.top = thumbTop + 'px';
  }

  // ======================== DOM 构建 ========================
  function buildDom(container) {
    container.innerHTML = '';
    container.classList.add('editor-host');
    wrap = container;

    gutter = document.createElement('div');
    gutter.className = 'gutter';
    gutterInner = document.createElement('div');
    gutterInner.className = 'gutter-inner';
    gutter.appendChild(gutterInner);

    scrollBox = document.createElement('div');
    scrollBox.className = 'code-scroll';

    pre = document.createElement('pre');
    pre.className = 'hl';
    code = document.createElement('code');
    pre.appendChild(code);

    ta = document.createElement('textarea');
    ta.className = 'ta';
    ta.spellcheck = false;
    ta.setAttribute('autocapitalize', 'off');
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('autocomplete', 'off');
    ta.wrap = 'off';

    scrollBox.appendChild(pre);
    scrollBox.appendChild(ta);
    container.appendChild(gutter);
    container.appendChild(scrollBox);

    // 自定义滚动条
    buildScrollbar();

    // 事件
    ta.addEventListener('input', onInput);
    ta.addEventListener('scroll', onScroll);
    ta.addEventListener('keydown', onKeydown);
    ta.addEventListener('click', function () { updateBracketMatch(); updateCursorInfo(); });
    ta.addEventListener('keyup', function (e) {
      if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' || e.key === 'PageUp' || e.key === 'PageDown') {
        updateBracketMatch();
        updateCursorInfo();
      }
    });

    // 捏合缩放
    container.addEventListener('touchstart', onPinchStart, { passive: false });
    container.addEventListener('touchmove', onPinchMove, { passive: false });
    container.addEventListener('touchend', onPinchEnd);
    container.addEventListener('touchcancel', onPinchEnd);

    // 长按复制 — 记录触摸位置 + contextmenu 唤起
    container.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        lastTouchX = e.touches[0].clientX;
        lastTouchY = e.touches[0].clientY;
      }
    }, { passive: true });
    container.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      var x = lastTouchX || e.clientX || 100;
      var y = lastTouchY || e.clientY || 100;
      if (global.App && global.App.showCopyPopup) global.App.showCopyPopup(x, y);
    });

    // 恢复字号
    try {
      var saved = parseInt(localStorage.getItem('codex-font-size'), 10);
      if (saved >= FS_MIN && saved <= FS_MAX) fontSize = saved;
    } catch (e) {}
    applyFontSize();
  }

  // ======================== 事件处理 ========================
  function onInput() {
    render();
    updateBracketMatch();
    updateCursorInfo();
    if (onChangeCb) onChangeCb(currentFile, ta.value);
    // 延迟快照入栈
    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = setTimeout(function () {
      flushInput();
    }, 500);
  }

  function onKeydown(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      var s = ta.selectionStart, en = ta.selectionEnd;
      var pad = '  ';
      ta.value = ta.value.slice(0, s) + pad + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + pad.length;
      render();
      if (onChangeCb) onChangeCb(currentFile, ta.value);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      global.App && global.App.openSearch();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      global.App && global.App.saveCurrent();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      redo();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault(); zoomIn();
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault(); zoomOut();
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault(); zoomReset();
    }
  }

  function onScroll() {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    gutterInner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    updateScrollbar();
  }

  // ======================== 渲染 ========================
  function render() {
    var val = ta.value;
    var html = global.Highlighter.highlight(val, lang);
    if (val.endsWith('\n')) html += ' ';
    code.innerHTML = html;
    // 花括号高亮
    if (currentBracketMatch) {
      highlightBracketsInDom(code, currentBracketMatch);
    }
    updateGutter();
    updateScrollbar();
  }

  function updateGutter() {
    var lines = ta.value.split('\n').length;
    var s = '';
    for (var i = 1; i <= lines; i++) s += i + '\n';
    gutterInner.textContent = s;
  }

  // ======================== 文件内查找 ========================
  var currentQueryLen = 1;
  function selectMatch() {
    if (matchIdx < 0 || !matches[matchIdx]) return;
    var start = matches[matchIdx];
    var end = start + (currentQueryLen || 1);
    ta.focus();
    ta.setSelectionRange(start, end);
    var before = ta.value.slice(0, start);
    var line = before.split('\n').length - 1;
    var lh = parseInt(getComputedStyle(ta).lineHeight, 10) || 20;
    ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 2);
    syncScroll();
  }

  function syncScroll() {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    gutterInner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
    updateScrollbar();
  }

  // ======================== 复制 ========================
  function copyToClipboard(text) {
    var ok = false;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        if (global.App && global.App.toast) global.App.toast('已复制 ✓');
      }).catch(function () { fallbackCopy(text); });
      return true;
    }
    return fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    el.select();
    try { document.execCommand('copy'); if (global.App && global.App.toast) global.App.toast('已复制 ✓'); }
    catch (e) { if (global.App && global.App.toast) global.App.toast('复制失败'); return false; }
    document.body.removeChild(el);
    return true;
  }

  // ======================== Editor 对象 ========================
  var Editor = {
    mount: function (container) { buildDom(container); },
    open: function (file, content, language) {
      currentFile = file;
      lang = language || 'text';
      ta.value = content || '';
      currentBracketMatch = null;
      render();
      ta.scrollTop = 0;
      syncScroll();
      initUndo();
      updateCursorInfo();
    },
    getValue: function () { return ta.value; },
    setOnChange: function (cb) { onChangeCb = cb; },
    getFile: function () { return currentFile; },
    focus: function () { ta.focus(); },

    // 字体缩放
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    zoomReset: zoomReset,
    setFontSize: setFontSize,
    getFontSize: function () { return fontSize; },
    setOnZoom: function (cb) { onZoomCb = cb; },

    // 撤回 / 重做
    undo: undo,
    redo: redo,
    setOnUndoChanged: function (cb) { onUndoChangedCb = cb; },

    // 光标
    setOnCursor: function (cb) { onCursorCb = cb; },
    getCursorInfo: function () {
      if (!ta) return null;
      var pos = ta.selectionStart;
      var before = ta.value.substring(0, pos);
      return {
        line: before.split('\n').length,
        col: pos - (before.lastIndexOf('\n') < 0 ? -1 : before.lastIndexOf('\n')),
        totalLines: ta.value.split('\n').length
      };
    },

    // 复制
    copyAll: function () { return copyToClipboard(ta.value); },
    copySelection: function () {
      var s = ta.selectionStart, e = ta.selectionEnd;
      if (s === e) return false;
      return copyToClipboard(ta.value.substring(s, e));
    },
    copyLine: function () {
      var pos = ta.selectionStart;
      var text = ta.value;
      var lineStart = text.lastIndexOf('\n', pos - 1) + 1;
      var lineEnd = text.indexOf('\n', pos);
      if (lineEnd < 0) lineEnd = text.length;
      return copyToClipboard(text.substring(lineStart, lineEnd));
    },
    copyLines: function (startLine, endLine) {
      var lines = ta.value.split('\n');
      startLine = Math.max(1, Math.min(lines.length, startLine));
      endLine = Math.max(startLine, Math.min(lines.length, endLine));
      return copyToClipboard(lines.slice(startLine - 1, endLine).join('\n'));
    },
    getTotalLines: function () { return ta.value.split('\n').length; },

    // 查找
    find: function (q, opts) {
      opts = opts || {};
      var ci = opts.caseSensitive ? undefined : 'i';
      var text = ta.value;
      matches = [];
      if (!q) { matchIdx = -1; return 0; }
      currentQueryLen = q.length;
      var re = new RegExp(escapeReg(q), ci);
      var m;
      while ((m = re.exec(text)) !== null) {
        matches.push(m.index);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (matches.length === 0) { matchIdx = -1; return 0; }
      if (typeof opts.start === 'number') {
        var idx = matches.findIndex(function (p) { return p >= opts.start; });
        matchIdx = idx === -1 ? 0 : idx;
      } else {
        matchIdx = opts.dir === 'prev'
          ? (matchIdx - 1 + matches.length) % matches.length
          : (matchIdx + 1) % matches.length;
        if (matchIdx < 0) matchIdx = 0;
      }
      selectMatch();
      return matches.length;
    },
    findNext: function (q, opts) { return this.find(q, Object.assign({ dir: 'next' }, opts)); },
    findPrev: function (q, opts) { return this.find(q, Object.assign({ dir: 'prev' }, opts)); },
    matchInfo: function () { return { idx: matchIdx, total: matches.length }; },

    gotoLine: function (lineNo) {
      var lines = ta.value.split('\n');
      var pos = 0;
      for (var i = 0; i < lineNo - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      var len = lines[Math.min(lineNo - 1, lines.length - 1)] || '';
      ta.focus();
      ta.setSelectionRange(pos, pos + len.length);
      var lh = parseInt(getComputedStyle(ta).lineHeight, 10) || 20;
      ta.scrollTop = Math.max(0, (lineNo - 1) * lh - ta.clientHeight / 2);
      syncScroll();
      updateBracketMatch();
      updateCursorInfo();
    },
  };

  function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  global.Editor = Editor;
})(typeof window !== 'undefined' ? window : this);
