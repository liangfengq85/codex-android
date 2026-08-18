/* =========================================================================
 * editor.js — 编辑器（contenteditable 单层架构）
 *
 * 核心改进：弃用 textarea+pre 双层叠层，改为单一 contenteditable pre 元素
 *   → 光标与代码完美对齐（同一层）
 *   → 原生拖拽选择（水滴手柄）+ 选择高亮可见
 *   → 花括号匹配高亮在同一层生效
 *
 * 功能：
 *   - contenteditable pre + 语法高亮（输入后重渲染，保存/恢复光标偏移）
 *   - 行号 / 同步滚动 / Tab 缩进
 *   - 文件内查找（find / findNext / findPrev）
 *   - 字体缩放（按钮 + 双指捏合 + Ctrl+/-/0）
 *   - 撤回 / 重做（按修改顺序逐步撤回，连续字符 500ms 内分组）
 *   - 花括号匹配高亮
 *   - 自定义右侧拖拽滑块
 *   - 光标位置跟踪（行:列）
 *   - IME 组合输入保护（composition 期间不重渲染）
 * ========================================================================= */
(function (global) {
  'use strict';

  var wrap, gutter, gutterInner, scrollBox, pre;
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

  // ---- 渲染调度 ----
  var renderPending = false;

  // ======================== 选择保存/恢复 ========================
  function saveSelection(el) {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { start: 0, end: 0 };
    var range = sel.getRangeAt(0);
    var preRange = document.createRange();
    preRange.selectNodeContents(el);
    preRange.setEnd(range.startContainer, range.startOffset);
    var start = preRange.toString().length;
    preRange.setEnd(range.endContainer, range.endOffset);
    var end = preRange.toString().length;
    return { start: start, end: end };
  }

  function restoreSelection(el, saved) {
    try {
      var range = document.createRange();
      var startNode = findNodeAndOffset(el, saved.start);
      var endNode = findNodeAndOffset(el, saved.end);
      if (startNode) {
        range.setStart(startNode.node, startNode.offset);
        if (endNode && saved.end > saved.start) {
          range.setEnd(endNode.node, endNode.offset);
        } else {
          range.collapse(true);
        }
      } else {
        range.selectNodeContents(el);
        range.collapse(false);
      }
      var selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (e) { /* 静默失败 */ }
  }

  function findNodeAndOffset(root, offset) {
    var charCount = 0;
    function walk(node) {
      if (node.nodeType === 3) {
        var next = charCount + node.length;
        if (offset <= next) {
          return { node: node, offset: Math.max(0, offset - charCount) };
        }
        charCount = next;
      } else if (node.nodeType === 1) {
        // 跳过 bracket-match span 内部但仍计入字符
        for (var i = 0; i < node.childNodes.length; i++) {
          var result = walk(node.childNodes[i]);
          if (result) return result;
        }
      }
      return null;
    }
    return walk(root);
  }

  // ======================== 文本 Get/Set ========================
  function getText() {
    if (!pre) return '';
    var text = pre.textContent || '';
    return text.replace(/\u200b/g, ''); // 去除尾部零宽空格
  }

  function setText(text) {
    if (!pre) return;
    var html = Highlighter.highlight(text, lang);
    if (text.endsWith('\n')) html += '\u200b'; // 尾部空行可编辑
    pre.innerHTML = html;
    if (currentBracketMatch) highlightBracketsInDom(pre, currentBracketMatch);
    updateGutter(text);
    updateScrollbar();
  }

  // ======================== 渲染 ========================
  function render() {
    if (!pre) return;
    var text = getText();
    var html = Highlighter.highlight(text, lang);
    if (text.endsWith('\n')) html += '\u200b';

    var savedSel = saveSelection(pre);
    pre.innerHTML = html;

    if (currentBracketMatch) {
      highlightBracketsInDom(pre, currentBracketMatch);
    }

    restoreSelection(pre, savedSel);
    updateGutter(text);
    updateScrollbar();
  }

  function scheduleRender() {
    if (renderPending) return;
    renderPending = true;
    if (global.requestAnimationFrame) {
      global.requestAnimationFrame(function () {
        renderPending = false;
        render();
      });
    } else {
      setTimeout(function () { renderPending = false; render(); }, 16);
    }
  }

  // ======================== 字体缩放 ========================
  function applyFontSize() {
    if (!wrap) return;
    var lh = Math.round(fontSize * 1.5);
    wrap.style.setProperty('--fs', fontSize + 'px');
    wrap.style.setProperty('--lh', lh + 'px');
    if (onZoomCb) onZoomCb(fontSize);
    // 字号变化后重新同步滚动条
    if (global.requestAnimationFrame) {
      global.requestAnimationFrame(function () { updateScrollbar(); });
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
    return { text: getText(), sel: saveSelection(pre) };
  }
  function restoreSnap(s) {
    setText(s.text);
    restoreSelection(pre, s.sel);
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

  function pushUndo(isSimpleInsert) {
    var cur = snapshot();
    var last = undoStack[undoStack.length - 1];
    if (!last || last.text === cur.text) return;

    var now = Date.now();
    var shouldGroup = isSimpleInsert &&
                      lastInputWasSimple &&
                      (now - lastInputTime) < 500;

    if (shouldGroup && last) {
      // 分组：替换栈顶快照（连续字符输入合并为一个撤回步）
      undoStack[undoStack.length - 1] = cur;
    } else {
      // 新建撤回步
      undoStack.push(cur);
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
    }

    lastInputTime = now;
    lastInputWasSimple = isSimpleInsert;
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
    var sel = saveSelection(pre);
    var pos = sel.start;
    var text = getText();
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
    if (!onCursorCb || !pre) return;
    var sel = saveSelection(pre);
    var pos = sel.start;
    var text = getText();
    var before = text.substring(0, pos);
    var line = before.split('\n').length;
    var lastNl = before.lastIndexOf('\n');
    var col = pos - (lastNl < 0 ? -1 : lastNl);
    var total = text.split('\n').length;
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

    var dragging = false;
    scrollThumb.addEventListener('pointerdown', function (e) {
      dragging = true;
      e.preventDefault();
      e.stopPropagation();
      var startY = e.clientY;
      var startScroll = pre.scrollTop;
      var maxScroll = pre.scrollHeight - pre.clientHeight;
      var thumbH = scrollThumb.offsetHeight;
      var range = pre.clientHeight - thumbH;
      function onMove(ev) {
        if (!dragging) return;
        ev.preventDefault();
        if (range > 0 && maxScroll > 0) {
          var dy = ev.clientY - startY;
          pre.scrollTop = Math.max(0, Math.min(maxScroll, startScroll + (dy / range) * maxScroll));
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
    if (!scrollbar || !pre) return;
    var maxScroll = pre.scrollHeight - pre.clientHeight;
    if (maxScroll <= 0) {
      scrollbar.style.display = 'none';
      return;
    }
    scrollbar.style.display = '';
    var ratio = pre.scrollTop / maxScroll;
    var visibleRatio = pre.clientHeight / pre.scrollHeight;
    var thumbH = Math.max(30, visibleRatio * pre.clientHeight);
    var thumbTop = ratio * (pre.clientHeight - thumbH);
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

    // ★ 单层 contenteditable pre — 光标与高亮代码在同一元素
    pre = document.createElement('pre');
    pre.className = 'editor-pre';
    pre.contentEditable = 'true';
    pre.spellcheck = false;
    pre.setAttribute('autocapitalize', 'off');
    pre.setAttribute('autocorrect', 'off');
    pre.setAttribute('autocomplete', 'off');

    scrollBox.appendChild(pre);
    container.appendChild(gutter);
    container.appendChild(scrollBox);

    buildScrollbar();

    // ---- 事件 ----
    pre.addEventListener('input', onInput);
    pre.addEventListener('scroll', onScroll);
    pre.addEventListener('keydown', onKeydown);
    pre.addEventListener('keyup', onKeyup);
    pre.addEventListener('click', function () {
      setTimeout(function () { updateBracketMatch(); updateCursorInfo(); }, 0);
    });

    // IME 组合输入保护
    pre.addEventListener('compositionstart', function () { composing = true; });
    pre.addEventListener('compositionend', function () {
      composing = false;
      render();
      updateBracketMatch();
      updateCursorInfo();
      if (onChangeCb) onChangeCb(currentFile, getText());
      pushUndo(false);
    });

    // 粘贴 → 纯文本
    pre.addEventListener('paste', onPaste);

    // 拖拽 → 阻止（防止 DOM 混乱）
    pre.addEventListener('dragstart', function (e) { e.preventDefault(); });
    pre.addEventListener('drop', function (e) { e.preventDefault(); });

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
    if (composing) {
      // 组合输入期间：仅更新光标，不重渲染
      updateCursorInfo();
      if (onChangeCb) onChangeCb(currentFile, getText());
      return;
    }

    scheduleRender();
    updateBracketMatch();
    updateCursorInfo();
    if (onChangeCb) onChangeCb(currentFile, getText());

    // 判断是否为简单单字符插入（用于撤回分组）
    var inputType = (e && e.inputType) || '';
    var data = (e && e.data) || '';
    var isSimpleInsert = inputType === 'insertText' && data.length === 1 && data !== '\n';

    // inputType 不可用时的 fallback
    if (!inputType) {
      var last = undoStack[undoStack.length - 1];
      if (last) {
        var diff = getText().length - last.text.length;
        if (diff === 1) {
          // 可能是单字符插入，检查是否为换行
          var inserted = getText().charAt(last.sel ? last.sel.start : 0);
          isSimpleInsert = inserted !== '\n';
        }
      }
    }

    pushUndo(isSimpleInsert);
  }

  function onKeydown(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand('insertText', false, '  ');
    } else if (e.key === 'Enter') {
      // 拦截 → 插入 \n 而非 <div>/<br>
      e.preventDefault();
      document.execCommand('insertText', false, '\n');
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

  function onKeyup(e) {
    if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End' ||
        e.key === 'PageUp' || e.key === 'PageDown') {
      updateBracketMatch();
      updateCursorInfo();
    }
  }

  function onPaste(e) {
    e.preventDefault();
    var cd = e.clipboardData || global.clipboardData;
    var text = cd ? cd.getData('text/plain') : '';
    if (text) document.execCommand('insertText', false, text);
  }

  function onScroll() {
    if (gutterInner) gutterInner.style.transform = 'translateY(' + (-pre.scrollTop) + 'px)';
    updateScrollbar();
  }

  // ======================== 行号 ========================
  function updateGutter(text) {
    if (!gutterInner) return;
    var lines = text.split('\n').length;
    var s = '';
    for (var i = 1; i <= lines; i++) s += i + '\n';
    gutterInner.textContent = s;
  }

  function syncGutter() {
    if (gutterInner) gutterInner.style.transform = 'translateY(' + (-pre.scrollTop) + 'px)';
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
      currentBracketMatch = null;
      pre.blur(); // 先失焦避免键盘弹出
      setText(content || '');
      pre.scrollTop = 0;
      syncGutter();
      initUndo();
      updateCursorInfo();
    },

    getValue: function () { return getText(); },
    setOnChange: function (cb) { onChangeCb = cb; },
    getFile: function () { return currentFile; },
    focus: function () { if (pre) pre.focus(); },
    getPre: function () { return pre; },

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
      if (!pre) return null;
      var sel = saveSelection(pre);
      var pos = sel.start;
      var text = getText();
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
      var sel = window.getSelection();
      var text = sel ? sel.toString() : '';
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
      var sel = window.getSelection();
      return sel && sel.rangeCount > 0 && !sel.isCollapsed;
    },
    isSelectionInEditor: function () {
      var sel = window.getSelection();
      if (!sel || !sel.rangeCount) return false;
      var node = sel.getRangeAt(0).commonAncestorContainer;
      return pre && pre.contains(node);
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
      var lines = text.split('\n');
      var pos = 0;
      for (var i = 0; i < lineNo - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      var lineLen = (lines[Math.min(lineNo - 1, lines.length - 1)] || '').length;

      // 不 focus → 不弹键盘 → 不卡顿
      var startNode = findNodeAndOffset(pre, pos);
      var endNode = findNodeAndOffset(pre, pos + lineLen);
      if (startNode) {
        var range = document.createRange();
        range.setStart(startNode.node, startNode.offset);
        if (endNode && lineLen > 0) {
          range.setEnd(endNode.node, endNode.offset);
        } else {
          range.collapse(true);
        }
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }

      var lh = parseFloat(getComputedStyle(pre).lineHeight) || 20;
      pre.scrollTop = Math.max(0, (lineNo - 1) * lh - pre.clientHeight / 2);
      syncGutter();
      updateBracketMatch();
      updateCursorInfo();
    },
  };

  // ======================== 内部：搜索匹配选择 ========================
  function selectMatch() {
    if (matchIdx < 0 || !matches[matchIdx]) return;
    var start = matches[matchIdx];
    var end = start + (currentQueryLen || 1);

    var startNode = findNodeAndOffset(pre, start);
    var endNode = findNodeAndOffset(pre, end);
    if (startNode) {
      var range = document.createRange();
      range.setStart(startNode.node, startNode.offset);
      if (endNode) {
        range.setEnd(endNode.node, endNode.offset);
      } else {
        range.collapse(true);
      }
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }

    var text = getText();
    var before = text.slice(0, start);
    var line = before.split('\n').length - 1;
    var lh = parseFloat(getComputedStyle(pre).lineHeight) || 20;
    pre.scrollTop = Math.max(0, line * lh - pre.clientHeight / 2);
    syncGutter();
  }

  function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  global.Editor = Editor;
})(typeof window !== 'undefined' ? window : this);
