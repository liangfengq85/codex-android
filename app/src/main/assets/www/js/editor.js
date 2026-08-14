/* =========================================================================
 * editor.js — 编辑器（高亮叠层方案）
 * textarea 透明文字 + <pre> 彩色高亮叠层；行号; 同步滚动; Tab 缩进; 文件内查找
 * ========================================================================= */
(function (global) {
  'use strict';

  let wrap, gutter, gutterInner, scrollBox, pre, code, ta;
  let lang = 'text';
  let currentFile = null;
  let onChangeCb = null;
  let matches = [];
  let matchIdx = -1;

  function buildDom(container) {
    container.innerHTML = '';
    container.classList.add('editor-host');

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
    if (val.endsWith('\n')) html += ' '; // 末尾空行占位，保证高度一致
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
        // 从当前位置向下找
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

    // 跳转到指定行（搜索结果用）
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
    // 滚动到匹配行
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
