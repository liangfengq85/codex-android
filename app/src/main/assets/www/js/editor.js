/* =========================================================================
 * editor.js — 编辑器（textarea + pre 叠层架构）
 *
 * 核心改进：弃用 contenteditable，改用 textarea（输入）+ pre（高亮）叠层
 *   → textarea 有原生键盘支持，Android 上打字无障碍
 *   → pre 只做语法高亮显示，pointer-events:none，不影响 textarea
 *   → 两者排版完全一致（font/padding/line-height/white-space），光标完美对齐
 *   → pre.innerHTML 的重渲染不会破坏 textarea 的选区/IME
 *
 * 功能：
 *   - textarea 输入 + pre 语法高亮（输入后立即重渲染，安全）
 *   - 行号 / 同步滚动 / Tab 缩进
 *   - 文件内查找（find / findNext / findPrev）
 *   - 字体缩放（按钮 + 双指捏合 + Ctrl+/-/0）
 *   - 撤回 / 重做（按修改顺序逐步撤回，连续字符 500ms 内分组）
 *   - 花括号匹配高亮
 *   - 自定义右侧拖拽滑块
 *   - 光标位置跟踪（行:列）
 *   - IME 组合输入保护（composition 期间不 push undo）
 *   - saveState / restoreState（多标签页切换）
 * ========================================================================= */
(function (global) {
  'use strict';

  var wrap, gutter, gutterInner, scrollBox, textarea, pre;
  var scrollbar, scrollThumb;
  var lang = 'text';
  var currentFile = null;
  var onChangeCb = null;
  var matches = [];
  var matchIdx = -1;
  var currentQueryLen = 1;

  // ---- 字体缩放 ----
  var fontSize = 13;
  var FS_MIN = 9, FS_MAX = 32, FS_DEFAULT = 13;
  var onZoomCb = null;

  // ---- 撤回 / 重做 ----
  var undoStack = [];
  var redoStack = [];
  var onUndoChangedCb = null;
  var lastInputWasSimple = false;
  var lastInputTime = 0;
  var composing = false;

  // ---- 花括号匹配 ----
  var currentBracketMatch = null;

  // ---- 光标跟踪 ----
  var onCursorCb = null;

  // ---- 捏合缩放 ----
  var pinchDist = 0, pinchFs = 0;

  // ======================== 文本 Get/Set ========================
  function getText() {
    if (!textarea) return '';
    return textarea.value;
  }

  function setText(text) {
    if (!textarea) return;
    textarea.value = text || '';
    renderHighlight();
    textarea.scrollTop = 0;
    textarea.scrollLeft = 0;
    syncScroll();
  }

  function renderHighlight() {
    if (!pre || !textarea) return;
    var text = textarea.value;
    var html = Highlighter.highlight(text, lang);
    if (text.endsWith('\n')) html += '\u200b';
    pre.innerHTML = html;
    if (currentBracketMatch) highlightBracketsInDom(pre, currentBracketMatch);
    updateGutter(text);
    updateScrollbar();
  }

  // ======================== 字体缩放 ========================
  function applyFontSize() {
    if (!wrap) return;
    var lh = Math.round(fontSize * 1.5);
    wrap.style.setProperty('--fs', fontSize + 'px');
    wrap.style.setProperty('--lh', lh + 'px');
    if (onZoomCb) onZoomCb(fontSize);
    if (global.requestAnimationFrame) {
      global.requestAnimationFrame(function () { syncScroll(); updateScrollbar(); });
    }
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
    return {
      text: textarea.value,
      selStart: textarea.selectionStart,
      selEnd: textarea.selectionEnd,
      scrollTop: textarea.scrollTop
    };
  }
  function restoreSnap(s) {
    textarea.value = s.text;
    textarea.setSelectionRange(s.selStart, s.selEnd);
    textarea.scrollTop = s.scrollTop || 0;
    renderHighlight();
    syncScroll();
    updateCursorInfo();
  }
  function initUndo() {
    undoStack = [snapshot()];
    redoStack = [];
    lastInputWasSimple = false;
    notifyUndoChanged();
  }
  function notifyUndoChanged() {
    if (onUndoChangedCb) onUndoChangedCb(undoStack.length > 1, redoStack.length > 0);
  }

  function pushUndo() {
    var curText = textarea.value;
    var curSel = { start: textarea.selectionStart, end: textarea.selectionEnd };
    var last = undoStack[undoStack.length - 1];
    if (last && last.text === curText) return;

    var now = Date.now();
    var diff = curText.length - (last ? last.text.length : 0);

    // 分组：单字符插入，无选区，500ms 内
    var shouldGroup = lastInputWasSimple &&
                      diff === 1 &&
                      (now - lastInputTime) < 500 &&
                      curSel.start === curSel.end;

    var snap = { text: curText, sel: curSel, scrollTop: textarea.scrollTop };

    if (shouldGroup) {
      undoStack[undoStack.length - 1] = snap;
    } else {
      undoStack.push(snap);
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
    }

    lastInputTime = now;
    lastInputWasSimple = (diff === 1 && curSel.start === curSel.end);
    notifyUndoChanged();
  }

  function undo() {
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
    var pos = textarea.selectionStart;
    var text = textarea.value;
    // 光标前一个字符
    if (pos > 0 && BRACKETS[text[pos - 1]]) {
      var m = findMatchingBracket(text, pos - 1);
      if (m >= 0) return [pos - 1, m];
    }
    // 光标处的字符
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
    if (changed) renderHighlight();
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
    if (!onCursorCb || !textarea) return;
    var pos = textarea.selectionStart;
    var text = textarea.value;
    var before = text.substring(0, pos);
    var line = before.split('\n').length;
    var lastNl = before.lastIndexOf('\n');
    var col = pos - (lastNl < 0 ? -1 : lastNl);
    var total = text.split('\n').length;
    onCursorCb({ line: line, col: col, totalLines: total });
  }

  // ======================== 同步滚动 ========================
  function syncScroll() {
    if (!pre || !textarea) return;
    pre.scrollTop = textarea.scrollTop;
    pre.scrollLeft = textarea.scrollLeft;
    if (gutterInner) gutterInner.style.transform = 'translateY(' + (-textarea.scrollTop) + 'px)';
    updateScrollbar();
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

    var dragging = false;
    scrollThumb.addEventListener('pointerdown', function (e) {
      dragging = true;
      e.preventDefault();
      e.stopPropagation();
      var startY = e.clientY;
      var startScroll = textarea.scrollTop;
      var maxScroll = textarea.scrollHeight - textarea.clientHeight;
      var thumbH = scrollThumb.offsetHeight;
      var range = textarea.clientHeight - thumbH;
      function onMove(ev) {
        if (!dragging) return;
        ev.preventDefault();
        if (range > 0 && maxScroll > 0) {
          var dy = ev.clientY - startY;
          textarea.scrollTop = Math.max(0, Math.min(maxScroll, startScroll + (dy / range) * maxScroll));
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
    if (!scrollbar || !textarea) return;
    var maxScroll = textarea.scrollHeight - textarea.clientHeight;
    if (maxScroll <= 0) {
      scrollbar.style.display = 'none';
      return;
    }
    scrollbar.style.display = '';
    var ratio = textarea.scrollTop / maxScroll;
    var visibleRatio = textarea.clientHeight / textarea.scrollHeight;
    var thumbH = Math.max(30, visibleRatio * textarea.clientHeight);
    var thumbTop = ratio * (textarea.clientHeight - thumbH);
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

    // ★ pre — 语法高亮层（pointer-events:none，不接收触摸）
    pre = document.createElement('pre');
    pre.className = 'highlight-pre';
    pre.setAttribute('aria-hidden', 'true');

    // ★ textarea — 输入层（透明文字，白色光标，原生键盘支持）
    textarea = document.createElement('textarea');
    textarea.className = 'editor-ta';
    textarea.spellcheck = false;
    textarea.setAttribute('autocapitalize', 'off');
    textarea.setAttribute('autocorrect', 'off');
    textarea.setAttribute('autocomplete', 'off');
    textarea.setAttribute('wrap', 'off');
    textarea.setAttribute('inputmode', 'text');
    textarea.setAttribute('enterkeyhint', 'enter');

    scrollBox.appendChild(pre);
    scrollBox.appendChild(textarea);
    container.appendChild(gutter);
    container.appendChild(scrollBox);

    buildScrollbar();

    // ---- 事件 ----
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('scroll', function () { syncScroll(); });
    textarea.addEventListener('keydown', onKeydown);
    textarea.addEventListener('keyup', onKeyup);
    textarea.addEventListener('click', function () {
      setTimeout(function () { updateBracketMatch(); updateCursorInfo(); }, 0);
    });
    textarea.addEventListener('select', function () {
      setTimeout(function () { updateBracketMatch(); updateCursorInfo(); }, 0);
    });

    // IME 组合输入保护
    textarea.addEventListener('compositionstart', function () { composing = true; });
    textarea.addEventListener('compositionend', function () {
      composing = false;
      renderHighlight();
      syncScroll();
      updateBracketMatch();
      updateCursorInfo();
      if (onChangeCb) onChangeCb(currentFile, getText());
      pushUndo();
    });

    // selectionchange — 光标移动时更新括号匹配
    document.addEventListener('selectionchange', function () {
      if (document.activeElement === textarea) {
        updateBracketMatch();
        updateCursorInfo();
      }
    });

    // 捏合缩放
    container.addEventListener('touchstart', onPinchStart, { passive: false });
    container.addEventListener('touchmove', onPinchMove, { passive: false });
    container.addEventListener('touchend', onPinchEnd);
    container.addEventListener('touchcancel', onPinchEnd);

    // 恢复字号
    try {
      var saved = parseInt(localStorage.getItem('codex-font-size'), 10);
      if (saved >= FS_MIN && saved <= FS_MAX) fontSize = saved;
    } catch (e) {}
    applyFontSize();
  }

  // ======================== 事件处理 ========================
  function onInput(e) {
    // 立即重渲染高亮（安全：pre 是独立元素，不影响 textarea）
    renderHighlight();
    syncScroll();
    updateCursorInfo();
    if (onChangeCb) onChangeCb(currentFile, getText());

    if (composing) return; // IME 组合期间不 push undo

    pushUndo();
  }

  function onKeydown(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      var start = textarea.selectionStart;
      var end = textarea.selectionEnd;
      var val = textarea.value;
      textarea.value = val.substring(0, start) + '  ' + val.substring(end);
      textarea.selectionStart = textarea.selectionEnd = start + 2;
      renderHighlight();
      syncScroll();
      if (onChangeCb) onChangeCb(currentFile, getText());
      pushUndo();
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
    // Enter 键不拦截 — textarea 原生处理换行
  }

  function onKeyup(e) {
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' ||
        e.key === 'PageUp' || e.key === 'PageDown') {
      updateBracketMatch();
      updateCursorInfo();
    }
  }

  // ======================== 行号 ========================
  function updateGutter(text) {
    if (!gutterInner) return;
    var lines = text.split('\n').length;
    var s = '';
    for (var i = 1; i <= lines; i++) s += i + '\n';
    gutterInner.textContent = s;
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
      currentBracketMatch = null;
      textarea.blur();
      setText(content || '');
      initUndo();
      updateCursorInfo();
    },

    getValue: function () { return getText(); },
    setOnChange: function (cb) { onChangeCb = cb; },
    getFile: function () { return currentFile; },
    focus: function () { if (textarea) textarea.focus(); },
    blur: function () { if (textarea) textarea.blur(); },
    getPre: function () { return pre; },
    getTextarea: function () { return textarea; },

    // ---- 多标签页：保存/恢复状态 ----
    saveState: function () {
      return {
        text: textarea.value,
        lang: lang,
        scrollTop: textarea.scrollTop,
        scrollLeft: textarea.scrollLeft,
        selStart: textarea.selectionStart,
        selEnd: textarea.selectionEnd,
        undoStack: undoStack.map(function (s) { return JSON.parse(JSON.stringify(s)); }),
        redoStack: redoStack.map(function (s) { return JSON.parse(JSON.stringify(s)); }),
        bracketMatch: currentBracketMatch
      };
    },
    restoreState: function (state) {
      lang = state.lang || 'text';
      currentBracketMatch = state.bracketMatch || null;
      textarea.value = state.text || '';
      renderHighlight();
      textarea.scrollTop = state.scrollTop || 0;
      textarea.scrollLeft = state.scrollLeft || 0;
      textarea.setSelectionRange(state.selStart || 0, state.selEnd || 0);
      undoStack = state.undoStack || [snapshot()];
      redoStack = state.redoStack || [];
      syncScroll();
      updateCursorInfo();
      notifyUndoChanged();
    },

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
      if (!textarea) return null;
      var pos = textarea.selectionStart;
      var text = textarea.value;
      var before = text.substring(0, pos);
      return {
        line: before.split('\n').length,
        col: pos - (before.lastIndexOf('\n') < 0 ? -1 : before.lastIndexOf('\n')),
        totalLines: text.split('\n').length
      };
    },

    // 复制
    copyAll: function () { return copyToClipboard(getText()); },
    copySelection: function () {
      var text = textarea.value.substring(textarea.selectionStart, textarea.selectionEnd);
      if (!text) return false;
      return copyToClipboard(text);
    },
    copyLine: function () {
      var info = Editor.getCursorInfo();
      if (!info) return false;
      var lines = getText().split('\n');
      return copyToClipboard(lines[info.line - 1] || '');
    },
    copyLines: function (startLine, endLine) {
      var lines = getText().split('\n');
      startLine = Math.max(1, Math.min(lines.length, startLine));
      endLine = Math.max(startLine, Math.min(lines.length, endLine));
      return copyToClipboard(lines.slice(startLine - 1, endLine).join('\n'));
    },
    getTotalLines: function () { return getText().split('\n').length; },
    hasSelection: function () {
      return textarea && textarea.selectionStart !== textarea.selectionEnd;
    },
    isSelectionInEditor: function () {
      return document.activeElement === textarea && textarea.selectionStart !== textarea.selectionEnd;
    },

    // 查找
    find: function (q, opts) {
      opts = opts || {};
      var ci = opts.caseSensitive ? undefined : 'i';
      var text = getText();
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
      var text = getText();
      var pos = 0;
      var lineCount = 1;
      for (var i = 0; i < text.length && lineCount < lineNo; i++) {
        if (text[i] === '\n') lineCount++;
        pos++;
      }
      var lineLen = 0;
      for (var i = pos; i < text.length && text[i] !== '\n'; i++) lineLen++;

      // 不 focus → 不弹键盘
      textarea.setSelectionRange(pos, pos + lineLen);

      var lh = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
      textarea.scrollTop = Math.max(0, (lineNo - 1) * lh - textarea.clientHeight / 2);
      syncScroll();
      updateBracketMatch();
      updateCursorInfo();
    },
  };

  // ======================== 内部：搜索匹配选择 ========================
  function selectMatch() {
    if (matchIdx < 0 || !matches[matchIdx] || !textarea) return;
    var start = matches[matchIdx];
    var end = start + (currentQueryLen || 1);

    textarea.setSelectionRange(start, end);

    var text = getText();
    var before = text.slice(0, start);
    var line = before.split('\n').length - 1;
    var lh = parseFloat(getComputedStyle(textarea).lineHeight) || 20;
    textarea.scrollTop = Math.max(0, line * lh - textarea.clientHeight / 2);
    syncScroll();
  }

  function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  global.Editor = Editor;
})(typeof window !== 'undefined' ? window : this);
