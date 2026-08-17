/* =========================================================================
 * editor.js — 编辑器（高亮叠层方案）
 * textarea 透明文字 + <pre> 彩色高亮叠层；行号; 同步滚动; Tab 缩进; 文件内查找
 * 新增：字体缩放（按钮 + 双指捏合）
 * ========================================================================= */
(function (global) {
  'use strict';

  let wrap, gutter, gutterInner, scrollBox, pre, code, ta;
  let lang = 'text';
  let currentFile = null;
  let onChangeCb = null;
  let matches = [];
  let matchIdx = -1;

  // ---- 字体缩放状态 ----
  let fontSize = 13;
  const FS_MIN = 9;
  const FS_MAX = 32;
  const FS_DEFAULT = 13;
  let onZoomCb = null;

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

  // ---- 双指捏合缩放 ----
  let pinchDist = 0;
  let pinchFs = 0;

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
      var d = touchDist(e);
      var scale = d / pinchDist;
      setFontSize(pinchFs * scale);
      e.preventDefault();
    }
  }

  function onPinchEnd(e) {
    if (e.touches.length < 2) pinchDist = 0;
  }

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

    ta.addEventListener('input', onInput);
    ta.addEventListener('scroll', syncScroll);
    ta.addEventListener('keydown', onKeydown);

    // 双指捏合缩放 — 监听整个编辑器区域
    container.addEventListener('touchstart', onPinchStart, { passive: false });
    container.addEventListener('touchmove', onPinchMove, { passive: false });
    container.addEventListener('touchend', onPinchEnd);
    container.addEventListener('touchcancel', onPinchEnd);

    // 恢复保存的字体大小
    try {
      var saved = parseInt(localStorage.getItem('codex-font-size'), 10);
      if (saved >= FS_MIN && saved <= FS_MAX) fontSize = saved;
    } catch (e) {}
    applyFontSize();
  }

  function onInput() {
    render();
    if (onChangeCb) onChangeCb(currentFile, ta.value);
  }

  function onKeydown(e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = ta.selectionStart, en = ta.selectionEnd;
      const pad = '  ';
      ta.value = ta.value.slice(0, s) + pad + ta.value.slice(en);
      ta.selectionStart = ta.selectionEnd = s + pad.length;
      render();
      if (onChangeCb) onChangeCb(currentFile, ta.value);
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      global.App && global.App.openFind();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      global.App && global.App.saveCurrent();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      zoomIn();
    } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
      e.preventDefault();
      zoomOut();
    } else if ((e.ctrlKey || e.metaKey) && e.key === '0') {
      e.preventDefault();
      zoomReset();
    }
  }

  function syncScroll() {
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
    gutterInner.style.transform = 'translateY(' + (-ta.scrollTop) + 'px)';
  }

  function render() {
    const val = ta.value;
    let html = global.Highlighter.highlight(val, lang);
    if (val.endsWith('\n')) html += ' ';
    code.innerHTML = html;
    updateGutter();
  }

  function updateGutter() {
    const lines = ta.value.split('\n').length;
    let s = '';
    for (let i = 1; i <= lines; i++) s += i + '\n';
    gutterInner.textContent = s;
  }

  const Editor = {
    mount: function (container) {
      buildDom(container);
    },
    open: function (file, content, language) {
      currentFile = file;
      lang = language || 'text';
      ta.value = content || '';
      render();
      ta.scrollTop = 0;
      syncScroll();
    },
    getValue: function () { return ta.value; },
    setOnChange: function (cb) { onChangeCb = cb; },
    getFile: function () { return currentFile; },
    focus: function () { ta.focus(); },

    // ---- 字体缩放 ----
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    zoomReset: zoomReset,
    setFontSize: setFontSize,
    getFontSize: function () { return fontSize; },
    setOnZoom: function (cb) { onZoomCb = cb; },

    // ---- 文件内查找 ----
    find: function (q, opts) {
      opts = opts || {};
      const ci = opts.caseSensitive ? undefined : 'i';
      const text = ta.value;
      matches = [];
      if (!q) { matchIdx = -1; return 0; }
      currentQueryLen = q.length;
      const re = new RegExp(escapeReg(q), ci);
      let m;
      while ((m = re.exec(text)) !== null) {
        matches.push(m.index);
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      if (matches.length === 0) { matchIdx = -1; return 0; }
      if (typeof opts.start === 'number') {
        let idx = matches.findIndex(function (p) { return p >= opts.start; });
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
      const lines = ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < lineNo - 1 && i < lines.length; i++) pos += lines[i].length + 1;
      const len = lines[Math.min(lineNo - 1, lines.length - 1)] || '';
      ta.focus();
      ta.setSelectionRange(pos, pos + len.length);
      const lh = parseInt(getComputedStyle(ta).lineHeight, 10) || 20;
      ta.scrollTop = Math.max(0, (lineNo - 1) * lh - ta.clientHeight / 2);
      syncScroll();
    },
  };

  function selectMatch() {
    if (matchIdx < 0 || !matches[matchIdx]) return;
    const start = matches[matchIdx];
    const end = start + (currentQueryLen || 1);
    ta.focus();
    ta.setSelectionRange(start, end);
    const before = ta.value.slice(0, start);
    const line = before.split('\n').length - 1;
    const lh = parseInt(getComputedStyle(ta).lineHeight, 10) || 20;
    ta.scrollTop = Math.max(0, line * lh - ta.clientHeight / 2);
    syncScroll();
  }
  let currentQueryLen = 1;

  function escapeReg(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  global.Editor = Editor;
})(typeof window !== 'undefined' ? window : this);
