/* =========================================================================
 * app.js — 主控制器
 *
 * 改进：
 *   - 多标签页（VS Code 式）：openTabs / switchToTab / closeTab / renderTabBar
 *   - 适配 textarea+pre 叠层编辑器（Editor.saveState/restoreState 用于切换标签）
 *   - 搜索结果点击 → 先关闭面板再跳转
 *   - 选择浮动条：拖选文本后自动出现"复制"按钮
 *   - 未保存提示支持「切换文件」和「关闭标签」两种场景
 * ========================================================================= */
(function (global) {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var currentProject = null;
  var pathMap = {};
  var currentNode = null;
  var dirty = false;
  var savedValue = '';
  var searchMode = 'file';
  var selBar = null;
  var selTimer = null;

  // ---- 多标签页 ----
  var openTabs = [];      // [{ id, node, content, lang, savedValue, dirty, editorState }]
  var activeTabId = null;
  var pendingAction = null; // { type: 'open'|'close', node?, lineNo?, tabId? }

  // ---- 自动补全：项目标识符 ----
  var projectIdentifiers = {};   // { name: true }
  var identifierCache = {};      // { path: { name: true } }
  var identifierCollecting = false;

  // 从文本中提取标识符
  function extractIdentifiers(text) {
    var set = {};
    if (!text) return set;
    // 声明模式
    var patterns = [
      /\b(?:var|let|const)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /\bfunction\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /\bclass\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /\bstruct\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /\btypedef\s+(?:.*?\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:;|\{)/g,
      /#define\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /\b(?:int|char|void|float|double|long|short|unsigned|signed|bool|auto|static|extern)\s+\*?\s*([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /\b(?:def|import|from)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /\benum\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/g,
      /\b(?:public|private|protected)?\s*(?:static\s+)?(?:final\s+)?(?:void|int|String|boolean|double|float|long|short|byte|char)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*\(/g,
    ];
    patterns.forEach(function (re) {
      var m;
      while ((m = re.exec(text)) !== null) {
        if (m[1] && m[1].length >= 2) set[m[1]] = true;
      }
    });
    // 提取所有 3+ 字符的标识符（兜底）
    var wordRe = /\b[a-zA-Z_$][a-zA-Z0-9_$]{2,}\b/g;
    var wm;
    while ((wm = wordRe.exec(text)) !== null) {
      set[wm[0]] = true;
    }
    return set;
  }

  // 从当前已打开的标签中收集标识符（同步，快速）
  function collectOpenTabIdentifiers() {
    openTabs.forEach(function (tab) {
      var text = (tab.editorState && tab.editorState.text) || tab.content || '';
      var ids = extractIdentifiers(text);
      Object.keys(ids).forEach(function (k) { projectIdentifiers[k] = true; });
    });
  }

  // 异步从整个项目收集标识符
  function collectProjectIdentifiers() {
    if (!currentProject || identifierCollecting) return;
    identifierCollecting = true;
    projectIdentifiers = {};
    identifierCache = {};

    // 先从已打开标签同步收集
    collectOpenTabIdentifiers();

    // 异步遍历项目文件
    currentProject.walkFiles(function (f) {
      if (identifierCache[f.path]) {
        Object.keys(identifierCache[f.path]).forEach(function (k) { projectIdentifiers[k] = true; });
        return Promise.resolve();
      }
      try {
        var c = f.getContent();
        if (c && typeof c.then === 'function') {
          return c.then(function (text) {
            if (text) {
              var ids = extractIdentifiers(text);
              identifierCache[f.path] = ids;
              Object.keys(ids).forEach(function (k) { projectIdentifiers[k] = true; });
            }
          }).catch(function () {});
        } else if (c) {
          var ids = extractIdentifiers(c);
          identifierCache[f.path] = ids;
          Object.keys(ids).forEach(function (k) { projectIdentifiers[k] = true; });
        }
      } catch (e) {}
      return Promise.resolve();
    }).then(function () {
      identifierCollecting = false;
    }).catch(function () {
      identifierCollecting = false;
    });
  }

  // 获取补全建议
  function getSuggestions(prefix) {
    if (!prefix || prefix.length < 2) return [];
    var lower = prefix.toLowerCase();
    var exact = [], prefixMatch = [], contains = [];
    Object.keys(projectIdentifiers).forEach(function (name) {
      if (name === prefix) { exact.push(name); return; }
      if (name.startsWith(prefix)) { prefixMatch.push(name); return; }
      if (name.toLowerCase().startsWith(lower)) { contains.push(name); return; }
    });
    // 排序：精确 > 前缀匹配 > 大小写不敏感匹配
    prefixMatch.sort(function (a, b) { return a.length - b.length; });
    contains.sort(function (a, b) { return a.length - b.length; });
    return exact.concat(prefixMatch).concat(contains).slice(0, 12);
  }

  // 从当前编辑器内容更新标识符（编辑时调用）
  function updateCurrentFileIdentifiers() {
    var text = Editor.getValue();
    var ids = extractIdentifiers(text);
    if (currentNode && currentNode.path) {
      identifierCache[currentNode.path] = ids;
    }
    Object.keys(ids).forEach(function (k) { projectIdentifiers[k] = true; });
  }

  // 防抖更新标识符（避免每次输入都重新提取）
  var debouncedUpdateIdentifiers = debounce(updateCurrentFileIdentifiers, 800);

  // ---------- 工具 ----------
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.style.display = 'none'; }, ms || 2200);
  }

  function debounce(fn, ms) {
    var t;
    return function () { clearTimeout(t); var a = arguments; t = setTimeout(function () { fn.apply(null, a); }, ms); };
  }

  // ---------- 初始化 ----------
  function init() {
    Editor.mount($('editorHost'));
    Editor.setOnChange(function () { updateDirtyState(); debouncedUpdateIdentifiers(); });
    Editor.setSuggestProvider(getSuggestions);
    Editor.setOnZoom(function (fs) { $('zoomSize').textContent = fs; });
    Editor.setOnUndoChanged(function (canUndo, canRedo) {
      $('btnUndo').disabled = !canUndo;
      $('btnRedo').disabled = !canRedo;
      updateDirtyState();
    });
    Editor.setOnCursor(function (info) {
      $('editorInfo').textContent = '行 ' + info.line + ':' + info.col + ' / ' + info.totalLines;
    });

    // 顶栏按钮
    $('btnAdd').addEventListener('click', addProject);
    $('btnAdd2').addEventListener('click', addProject);
    $('btnAdd3').addEventListener('click', addProject);
    $('btnProjects').addEventListener('click', openProjectsModal);
    $('btnSearch').addEventListener('click', openSearch);
    $('dirInput').addEventListener('change', onDirInput);

    // 侧栏
    $('btnToggleSidebar').addEventListener('click', toggleSidebar);
    $('btnHideSidebar').addEventListener('click', toggleSidebar);
    initSidebarState();
    initResizer();

    // 字体缩放
    $('zoomIn').addEventListener('click', function () { Editor.zoomIn(); });
    $('zoomOut').addEventListener('click', function () { Editor.zoomOut(); });
    $('zoomSize').addEventListener('click', function () { Editor.zoomReset(); });
    $('zoomSize').textContent = Editor.getFontSize();

    // 编辑器工具条
    $('btnUndo').addEventListener('click', function () { Editor.undo(); });
    $('btnRedo').addEventListener('click', function () { Editor.redo(); });
    $('btnSaveEditor').addEventListener('click', saveCurrent);
    $('btnCopyMenu').addEventListener('click', function () {
      var rect = $('btnCopyMenu').getBoundingClientRect();
      showCopyPopup(rect.left, rect.bottom + 4);
    });

    // 复制弹窗
    initCopyPopup();

    // 选择浮动条
    initSelectionBar();

    // 未保存弹窗
    $('btnUnsavedSave').addEventListener('click', async function () {
      $('unsavedModal').style.display = 'none';
      await saveCurrent();
      resolvePending();
    });
    $('btnUnsavedDiscard').addEventListener('click', function () {
      $('unsavedModal').style.display = 'none';
      resolvePending();
    });
    $('btnUnsavedCancel').addEventListener('click', function () {
      $('unsavedModal').style.display = 'none';
      pendingAction = null;
    });

    // 搜索面板
    $('searchClose').addEventListener('click', function () { $('searchPanel').style.display = 'none'; });
    $('spModeFile').addEventListener('click', function () { setSearchMode('file'); });
    $('spModeProject').addEventListener('click', function () { setSearchMode('project'); });
    $('searchInput').addEventListener('input', debounce(runSearch, 200));
    $('searchInput').addEventListener('keydown', function (e) {
      if (e.key === 'Escape') $('searchPanel').style.display = 'none';
      if (e.key === 'Enter') { e.shiftKey ? searchPrev() : searchNext(); }
    });
    $('searchCase').addEventListener('change', runSearch);
    $('searchPrev').addEventListener('click', searchPrev);
    $('searchNext').addEventListener('click', searchNext);

    // 项目弹窗
    $('projectsClose').addEventListener('click', function () { $('projectsModal').style.display = 'none'; });

    // 能力提示
    var tip = '';
    if (FS.kind === 'native') tip = '✅ 点「＋」选择手机文件夹即可读写。长按拖动可选择复制。';
    else if (FS.kind === 'fsa') tip = '✅ 当前浏览器支持直接读写文件夹。';
    else if (FS.kind === 'blob') tip = 'ℹ️ 仅支持选择文件夹读取，编辑保存在应用沙箱内。';
    else tip = '⚠️ 请用安卓 Chrome 打开。';
    $('supportTip').textContent = tip;

    global.App = {
      openSearch: openSearch,
      saveCurrent: saveCurrent,
      openExternal: openExternalFile,
      toast: toast,
      showCopyPopup: showCopyPopup
    };
  }

  // ---------- Dirty 状态 ----------
  function updateDirtyState() {
    dirty = Editor.getValue() !== savedValue;
    $('btnSaveEditor').disabled = !dirty;
    // 同步到当前标签
    if (activeTabId) {
      var tab = getTab(activeTabId);
      if (tab) tab.dirty = dirty;
    }
    renderTabBar();
    updateBreadcrumb();
  }

  // ---------- 侧栏开关 ----------
  function toggleSidebar() {
    var body = $('bodyContainer');
    var btn = $('btnToggleSidebar');
    var hidden = body.classList.toggle('sidebar-hidden');
    btn.classList.toggle('active', !hidden);
    if (!hidden) restoreSidebarWidth();
    try { localStorage.setItem('codex-sidebar-hidden', hidden ? '1' : '0'); } catch (e) {}
  }

  function initSidebarState() {
    var hidden = false;
    try { hidden = localStorage.getItem('codex-sidebar-hidden') === '1'; } catch (e) {}
    if (hidden) {
      $('bodyContainer').classList.add('sidebar-hidden');
    } else {
      restoreSidebarWidth();
    }
  }

  function restoreSidebarWidth() {
    try {
      var w = parseInt(localStorage.getItem('codex-sidebar-w'), 10);
      if (w >= 80 && w <= window.innerWidth * 0.75) {
        document.documentElement.style.setProperty('--sidebar-w', w + 'px');
      }
    } catch (e) {}
  }

  // ---------- 拖拽调宽 ----------
  function initResizer() {
    var resizer = $('resizer');
    var sidebar = $('sidebar');
    var isResizing = false;

    function onStart(e) {
      isResizing = true; e.preventDefault();
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onEnd);
      document.addEventListener('pointercancel', onEnd);
    }
    function onMove(e) {
      if (!isResizing) return;
      e.preventDefault();
      var rect = $('bodyContainer').getBoundingClientRect();
      var w = Math.max(80, Math.min(window.innerWidth * 0.75, e.clientX - rect.left));
      document.documentElement.style.setProperty('--sidebar-w', w + 'px');
    }
    function onEnd() {
      isResizing = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onEnd);
      document.removeEventListener('pointercancel', onEnd);
      try { localStorage.setItem('codex-sidebar-w', String(sidebar.offsetWidth)); } catch (e) {}
    }
    resizer.addEventListener('pointerdown', onStart);
  }

  // ---------- 选择浮动条 ----------
  function initSelectionBar() {
    selBar = document.createElement('div');
    selBar.className = 'selection-bar';
    selBar.id = 'selectionBar';
    selBar.style.display = 'none';
    selBar.innerHTML = '<button id="selBarCopy">📋 复制</button><button id="selBarAll">全选</button>';
    $('app').appendChild(selBar);

    $('selBarCopy').addEventListener('click', function () {
      if (Editor.copySelection()) selBar.style.display = 'none';
      else toast('请先选择文本');
    });
    $('selBarAll').addEventListener('click', function () {
      Editor.focus();
      var ta = Editor.getTextarea();
      if (ta) { ta.setSelectionRange(0, ta.value.length); }
    });

    // 监听选区变化
    document.addEventListener('selectionchange', function () {
      if (selTimer) clearTimeout(selTimer);
      selTimer = setTimeout(checkSelectionBar, 100);
    });

    // 滚动/点击时隐藏
    var editorHost = $('editorHost');
    if (editorHost) {
      editorHost.addEventListener('scroll', hideSelectionBar, true);
    }
  }

  function checkSelectionBar() {
    if (!selBar) return;
    if (!Editor.hasSelection()) {
      hideSelectionBar();
      return;
    }
    var ta = Editor.getTextarea();
    if (!ta || document.activeElement !== ta) {
      hideSelectionBar();
      return;
    }
    var text = ta.value.substring(ta.selectionStart, ta.selectionEnd);
    if (!text || text.length === 0) {
      hideSelectionBar();
      return;
    }
    // 定位浮动条到选区上方
    var taRect = ta.getBoundingClientRect();
    var appRect = $('app').getBoundingClientRect();
    var barW = selBar.offsetWidth || 120;
    var barH = selBar.offsetHeight || 36;
    // 简单定位到编辑器区域中间偏上
    var left = taRect.left - appRect.left + taRect.width / 2 - barW / 2;
    var top = taRect.top - appRect.top + 10;
    left = Math.max(4, Math.min(left, appRect.width - barW - 4));
    if (top < 4) top = taRect.bottom - appRect.top - barH - 10;
    selBar.style.left = left + 'px';
    selBar.style.top = top + 'px';
    selBar.style.display = 'flex';
  }

  function hideSelectionBar() {
    if (selBar) selBar.style.display = 'none';
  }

  // ---------- 复制弹窗 ----------
  function initCopyPopup() {
    var popup = $('copyPopup');
    popup.querySelectorAll('.copy-btn[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-action');
        if (action === 'all') { Editor.copyAll(); closeCopyPopup(); }
        else if (action === 'selection') {
          if (!Editor.hasSelection()) {
            toast('请先长按拖动选择文本');
            return;
          }
          Editor.copySelection(); closeCopyPopup();
        }
        else if (action === 'line') { Editor.copyLine(); closeCopyPopup(); }
        else if (action === 'range') {
          $('copyPopupMain').style.display = 'none';
          $('copyPopupRange').style.display = '';
          var info = Editor.getCursorInfo();
          if (info) { $('copyStartLine').value = info.line; $('copyEndLine').value = info.line; }
        }
      });
    });
    $('copyRangeDo').addEventListener('click', function () {
      var s = parseInt($('copyStartLine').value, 10) || 1;
      var e = parseInt($('copyEndLine').value, 10) || s;
      Editor.copyLines(s, e);
      closeCopyPopup();
    });
  }

  function showCopyPopup(x, y) {
    var popup = $('copyPopup');
    var app = $('app');
    var appRect = app.getBoundingClientRect();
    $('copyPopupMain').style.display = '';
    $('copyPopupRange').style.display = 'none';
    popup.style.display = 'flex';

    var pw = popup.offsetWidth || 200;
    var ph = popup.offsetHeight || 180;
    var px = Math.max(4, Math.min(x - appRect.left, appRect.width - pw - 4));
    var py = Math.max(4, Math.min(y - appRect.top, appRect.height - ph - 4));
    popup.style.left = px + 'px';
    popup.style.top = py + 'px';

    var old = $('copyOverlay');
    if (old) old.remove();
    var overlay = document.createElement('div');
    overlay.id = 'copyOverlay';
    overlay.style.cssText = 'position:absolute;inset:0;z-index:54;';
    overlay.addEventListener('click', closeCopyPopup);
    app.appendChild(overlay);
  }

  function closeCopyPopup() {
    $('copyPopup').style.display = 'none';
    var overlay = $('copyOverlay');
    if (overlay) overlay.remove();
  }

  // ---------- 搜索面板 ----------
  function openSearch() {
    var panel = $('searchPanel');
    if (panel.style.display === 'flex') { panel.style.display = 'none'; return; }
    if (currentNode) setSearchMode('file');
    else if (currentProject) setSearchMode('project');
    panel.style.display = 'flex';
    $('searchInput').focus();
    $('searchInput').select();
  }

  function setSearchMode(mode) {
    searchMode = mode;
    $('spModeFile').classList.toggle('active', mode === 'file');
    $('spModeProject').classList.toggle('active', mode === 'project');
    $('searchPrev').style.display = mode === 'file' ? '' : 'none';
    $('searchNext').style.display = mode === 'file' ? '' : 'none';
    $('searchResults').innerHTML = '';
    $('searchStats').textContent = '';
    if ($('searchInput').value) runSearch();
  }

  function runSearch() {
    var q = $('searchInput').value;
    if (!q) { $('searchStats').textContent = ''; $('searchResults').innerHTML = ''; return; }
    Editor.clearSearchHit(); // 清除上次搜索高亮
    if (searchMode === 'file') searchInFile(q);
    else searchInProject(q);
  }

  function searchInFile(q) {
    if (!currentNode) { $('searchStats').textContent = '请先打开文件'; $('searchResults').innerHTML = ''; return; }
    var content = Editor.getValue();
    var lines = content.split('\n');
    var caseSensitive = $('searchCase').checked;
    var re = new RegExp(escapeReg(q), caseSensitive ? 'g' : 'gi');
    var results = [];
    for (var i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      if (re.test(lines[i])) results.push({ lineNo: i + 1, text: lines[i].trim() });
    }
    $('searchStats').textContent = '命中 ' + results.length + ' 处';
    renderSearchResults(results, 'file');
  }

  async function searchInProject(q) {
    if (!currentProject) { $('searchStats').textContent = '请先添加项目'; $('searchResults').innerHTML = ''; return; }
    var caseSensitive = $('searchCase').checked;
    var re = new RegExp(escapeReg(q), caseSensitive ? 'g' : 'gi');
    var results = [];
    var filesScanned = 0;
    $('searchStats').textContent = '搜索中…';
    await currentProject.walkFiles(async function (f) {
      filesScanned++;
      var content;
      try { var c = f.getContent(); content = (c && typeof c.then === 'function') ? await c : c; }
      catch (e) { return; }
      if (!content) return;
      var lines = content.split('\n');
      for (var i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        if (re.test(lines[i])) results.push({ path: f.path, name: f.name, lineNo: i + 1, text: lines[i].trim() });
      }
    });
    $('searchStats').textContent = '扫描 ' + filesScanned + ' 文件，命中 ' + results.length + ' 处';
    renderSearchResults(results, 'project');
  }

  function renderSearchResults(results, mode) {
    var box = $('searchResults');
    box.innerHTML = '';
    if (!results.length) { box.innerHTML = '<div class="sp-empty">无匹配</div>'; return; }
    results.slice(0, 500).forEach(function (r) {
      var item = document.createElement('div');
      item.className = 'sp-item';
      var head = document.createElement('div');
      head.className = 'sp-item-head';
      if (mode === 'project') {
        head.innerHTML = '<span class="sp-path">' + escapeHtml(r.path) + '</span><span class="sp-ln">:' + r.lineNo + '</span>';
      } else {
        head.innerHTML = '<span class="sp-ln">行 ' + r.lineNo + '</span>';
      }
      var body = document.createElement('div');
      body.className = 'sp-item-body';
      body.textContent = r.text;
      item.appendChild(head);
      item.appendChild(body);
      // ★ 先关闭面板再跳转，rAF 延迟避免卡顿，传搜索词用于高亮
      var searchQuery = $('searchInput').value;
      item.addEventListener('click', function () {
        $('searchPanel').style.display = 'none';
        if (mode === 'project') {
          jumpToProjectResult(r, searchQuery);
        } else {
          if (global.requestAnimationFrame) {
            global.requestAnimationFrame(function () { Editor.gotoLine(r.lineNo, { highlight: searchQuery, caseSensitive: $('searchCase').checked }); });
          } else {
            Editor.gotoLine(r.lineNo, { highlight: searchQuery, caseSensitive: $('searchCase').checked });
          }
        }
      });
      box.appendChild(item);
    });
    if (results.length > 500) {
      var more = document.createElement('div');
      more.className = 'sp-empty';
      more.textContent = '仅显示前 500 条';
      box.appendChild(more);
    }
  }

  async function jumpToProjectResult(r, searchQuery) {
    var node = pathMap[r.path];
    if (!node) { toast('文件未在树中：' + r.path); return; }
    toast('正在打开 ' + r.name + '…', 1500);
    try {
      await openFile(node, r.lineNo, searchQuery);
    } catch (e) {
      toast('打开失败：' + (e.message || e));
    }
  }

  function searchPrev() {
    var q = $('searchInput').value;
    if (!q) return;
    var total = Editor.findPrev(q, { caseSensitive: $('searchCase').checked });
    var info = Editor.matchInfo();
    $('searchStats').textContent = total ? (info.idx + 1) + ' / ' + total + ' 处' : '0 / 0';
  }

  function searchNext() {
    var q = $('searchInput').value;
    if (!q) return;
    var total = Editor.findNext(q, { caseSensitive: $('searchCase').checked });
    var info = Editor.matchInfo();
    $('searchStats').textContent = total ? (info.idx + 1) + ' / ' + total + ' 处' : '0 / 0';
  }

  // ---------- 未保存提示 ----------
  function resolvePending() {
    if (!pendingAction) return;
    var action = pendingAction;
    pendingAction = null;
    if (action.type === 'close') {
      doCloseTab(action.tabId);
    } else if (action.type === 'open') {
      if (action.node) doOpenFile(action.node, action.lineNo);
    }
  }

  // ---------- 外部文件 ----------
  function openExternalFile(uri, name) {
    if (!window.AndroidBridge) { toast('无法读取外部文件'); return; }
    var node = { uri: uri, name: name, path: name, type: 'file', _external: true };
    currentProject = {
      id: 'ext', name: name, kind: 'native',
      readFile: function (n) {
        var c = window.AndroidBridge.readFile(n.uri) || '';
        if (c.indexOf('__CODEX_ERR__') === 0) return Promise.reject(new Error(c.slice(13)));
        return Promise.resolve(c);
      },
      saveFile: function (n, text) {
        return Promise.resolve(String(window.AndroidBridge.writeFile(n.uri, text)) === 'true');
      },
      walkFiles: function () { return Promise.resolve(); },
    };
    openFile(node);
  }

  // ---------- 项目 ----------
  async function addProject() {
    try {
      var proj;
      if (FS.kind === 'native' || FS.kind === 'fsa') {
        proj = await FS.addViaPicker();
        if (!proj) return;
      } else if (FS.kind === 'blob') {
        $('dirInput').click(); return;
      } else { toast('不支持文件夹访问'); return; }
      await activateProject(proj);
      $('projectsModal').style.display = 'none';
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('添加失败：' + (e.message || e));
    }
  }

  async function onDirInput() {
    var input = $('dirInput');
    if (!input.files.length) return;
    try {
      var proj = await FS.addViaInput(input.files);
      input.value = '';
      await activateProject(proj);
      $('projectsModal').style.display = 'none';
    } catch (e) { toast('添加失败：' + (e.message || e)); }
  }

  async function activateProject(proj) {
    currentProject = proj;
    $('projName').textContent = proj.name;
    $('welcome').style.display = 'none';
    $('editorWrap').style.display = 'flex';
    $('zoomBar').style.display = 'flex';

    var treeView = $('treeView');
    treeView.innerHTML = '<div style="padding:20px;color:#888;text-align:center;font-size:13px">⏳ 正在扫描目录…</div>';

    try {
      var root = await proj.buildTree();
      buildPathMap(root);
      renderTree(root);
      // 异步收集项目标识符用于自动补全
      collectProjectIdentifiers();
    } catch (e) {
      toast('加载目录失败：' + (e.message || e));
      renderTree({ name: proj.name, type: 'dir', children: [] });
    }

    // 关闭所有标签
    openTabs = [];
    activeTabId = null;
    currentNode = null;
    savedValue = '';
    Editor.open(null, '', 'text');
    dirty = false;
    $('btnSaveEditor').disabled = true;
    renderTabBar();
    updateBreadcrumb();
  }

  function buildPathMap(root) {
    pathMap = {};
    (function walk(n) {
      if (n.type === 'file') pathMap[n.path] = n;
      else if (n.children) n.children.forEach(walk);
    })(root);
  }

  // ---------- 文件树 ----------
  function renderTree(root) {
    var view = $('treeView');
    view.innerHTML = '';
    view.appendChild(renderNode(root, 0, true));
  }

  function renderNode(node, depth, isRoot) {
    var wrap = document.createElement('div');
    wrap.className = 'tree-node';
    var row = document.createElement('div');
    row.className = 'tree-row' + (node.type === 'dir' ? ' is-dir' : '');
    row.style.paddingLeft = (8 + depth * 14) + 'px';

    var icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = node.type === 'dir' ? '📂' : fileEmoji(node.name);
    row.appendChild(icon);

    var label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name;
    row.appendChild(label);
    wrap.appendChild(row);

    if (node.type === 'dir') {
      var childrenBox = document.createElement('div');
      childrenBox.className = 'tree-children';
      childrenBox.style.display = (depth < 1 || isRoot) ? 'block' : 'none';
      (node.children || []).forEach(function (c) {
        childrenBox.appendChild(renderNode(c, depth + 1, false));
      });
      wrap.appendChild(childrenBox);
      row.addEventListener('click', function () {
        var open = childrenBox.style.display === 'block';
        childrenBox.style.display = open ? 'none' : 'block';
        icon.textContent = open ? '📁' : '📂';
      });
    } else {
      node._row = row;
      row.addEventListener('click', function () { openFile(node); });
    }
    return wrap;
  }

  function fileEmoji(name) {
    var ext = (name.split('.').pop() || '').toLowerCase();
    if (['js','ts','jsx','tsx','mjs','cjs'].includes(ext)) return '🟨';
    if (['py'].includes(ext)) return '🐍';
    if (['c','h','cpp','cc','hpp'].includes(ext)) return '🇨';
    if (['java'].includes(ext)) return '☕';
    if (['json','xml','yaml','yml','toml'].includes(ext)) return '📄';
    if (['md','markdown','txt','log'].includes(ext)) return '📝';
    if (['html','htm','css','scss','less'].includes(ext)) return '🌐';
    if (['sh','bash'].includes(ext)) return '🔧';
    if (['go'].includes(ext)) return '🐹';
    if (['rs'].includes(ext)) return '🦀';
    return '📄';
  }

  // ======================== 多标签页 ========================

  function getTab(id) {
    return openTabs.find(function (t) { return t.id === id; });
  }

  function saveCurrentTabState() {
    if (!activeTabId) return;
    var tab = getTab(activeTabId);
    if (tab) {
      tab.editorState = Editor.saveState();
      tab.dirty = dirty;
    }
  }

  function openFile(node, lineNo, searchQuery) {
    // 已打开 → 直接切换
    var existing = openTabs.find(function (t) {
      return t.node && t.node.path === node.path;
    });
    if (existing) {
      switchToTab(existing.id, lineNo, searchQuery);
      return;
    }

    // ★ 不再提醒保存 — 打开新文件时自动保留当前文件的修改状态
    // saveCurrentTabState() 会在 doOpenFile 中保存当前标签的 dirty 状态
    doOpenFile(node, lineNo, searchQuery);
  }

  async function doOpenFile(node, lineNo, searchQuery) {
    try {
      var content = await currentProject.readFile(node);
      var lang = Highlighter.langFromName(node.name);

      // 保存当前标签状态
      saveCurrentTabState();

      // 创建新标签
      var tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
      var newTab = {
        id: tabId,
        node: node,
        content: content,
        lang: lang,
        savedValue: content,
        dirty: false,
        editorState: null
      };
      openTabs.push(newTab);

      // 切换到新标签
      activeTabId = tabId;
      currentNode = node;
      savedValue = content;
      dirty = false;

      // 显示编辑器
      $('welcome').style.display = 'none';
      $('editorWrap').style.display = 'flex';
      $('zoomBar').style.display = 'flex';

      Editor.open(node, content, lang);
      $('btnSaveEditor').disabled = true;

      // 收集此文件的标识符用于自动补全
      var ids = extractIdentifiers(content);
      identifierCache[node.path] = ids;
      Object.keys(ids).forEach(function (k) { projectIdentifiers[k] = true; });

      // 更新树高亮
      document.querySelectorAll('.tree-row.active').forEach(function (r) { r.classList.remove('active'); });
      if (node._row) node._row.classList.add('active');

      renderTabBar();
      updateBreadcrumb();

      // 跳转到行
      if (lineNo) {
        var gotoOpts = searchQuery ? { highlight: searchQuery, caseSensitive: $('searchCase').checked } : undefined;
        if (global.requestAnimationFrame) {
          global.requestAnimationFrame(function () { Editor.gotoLine(lineNo, gotoOpts); });
        } else {
          Editor.gotoLine(lineNo, gotoOpts);
        }
      }
    } catch (e) {
      toast('读取失败：' + (e.message || e));
    }
  }

  function switchToTab(tabId, lineNo, searchQuery) {
    if (tabId === activeTabId && !lineNo) return;

    // 保存当前标签状态
    saveCurrentTabState();

    var tab = getTab(tabId);
    if (!tab) return;

    activeTabId = tabId;
    currentNode = tab.node;
    savedValue = tab.savedValue;
    dirty = tab.dirty;

    // 恢复编辑器状态
    if (tab.editorState) {
      Editor.restoreState(tab.editorState);
    } else {
      Editor.open(tab.node, tab.content, tab.lang);
    }

    $('btnSaveEditor').disabled = !dirty;

    // 更新树高亮
    document.querySelectorAll('.tree-row.active').forEach(function (r) { r.classList.remove('active'); });
    if (tab.node._row) tab.node._row.classList.add('active');

    renderTabBar();
    updateBreadcrumb();
    updateDirtyState();

    if (lineNo) {
      var gotoOpts = searchQuery ? { highlight: searchQuery, caseSensitive: $('searchCase').checked } : undefined;
      if (global.requestAnimationFrame) {
        global.requestAnimationFrame(function () { Editor.gotoLine(lineNo, gotoOpts); });
      } else {
        Editor.gotoLine(lineNo, gotoOpts);
      }
    }
  }

  function closeTab(tabId) {
    var tab = getTab(tabId);
    if (!tab) return;

    // 如果要关闭的是当前标签且有未保存修改 → 弹窗
    if (tabId === activeTabId && tab.dirty) {
      pendingAction = { type: 'close', tabId: tabId };
      $('unsavedFileName').textContent = tab.node.name || '当前文件';
      $('unsavedModal').style.display = 'flex';
      return;
    }

    // 如果要关闭的不是当前标签但该标签有未保存修改
    if (tabId !== activeTabId && tab.dirty) {
      // 先切换过去再弹窗
      switchToTab(tabId);
      pendingAction = { type: 'close', tabId: tabId };
      $('unsavedFileName').textContent = tab.node.name || '当前文件';
      $('unsavedModal').style.display = 'flex';
      return;
    }

    doCloseTab(tabId);
  }

  function doCloseTab(tabId) {
    var idx = openTabs.findIndex(function (t) { return t.id === tabId; });
    if (idx === -1) return;

    openTabs.splice(idx, 1);

    if (activeTabId === tabId) {
      if (openTabs.length > 0) {
        var newIdx = Math.min(idx, openTabs.length - 1);
        switchToTab(openTabs[newIdx].id);
      } else {
        // 没有标签了
        activeTabId = null;
        currentNode = null;
        savedValue = '';
        dirty = false;
        $('welcome').style.display = 'flex';
        $('editorWrap').style.display = 'none';
        $('zoomBar').style.display = 'none';
        Editor.open(null, '', 'text');
        $('btnSaveEditor').disabled = true;
      }
    }

    renderTabBar();
    updateBreadcrumb();
  }

  function renderTabBar() {
    var bar = $('tabBar');
    if (!bar) return;
    bar.innerHTML = '';

    openTabs.forEach(function (tab) {
      var el = document.createElement('div');
      el.className = 'tab' + (tab.id === activeTabId ? ' active' : '');

      var icon = document.createElement('span');
      icon.className = 'tab-icon';
      icon.textContent = fileEmoji(tab.node.name);
      el.appendChild(icon);

      var name = document.createElement('span');
      name.className = 'tab-name';
      name.textContent = tab.node.name;
      el.appendChild(name);

      // 未保存标记
      if (tab.dirty) {
        var dot = document.createElement('span');
        dot.className = 'tab-dirty';
        dot.textContent = '●';
        el.appendChild(dot);
      }

      // 关闭按钮
      var closeBtn = document.createElement('button');
      closeBtn.className = 'tab-close';
      closeBtn.textContent = '✕';
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        closeTab(tab.id);
      });
      el.appendChild(closeBtn);

      // 点击切换
      el.addEventListener('click', function () { switchToTab(tab.id); });

      bar.appendChild(el);
    });

    // 填充剩余空间
    var spacer = document.createElement('div');
    spacer.className = 'tab-spacer';
    bar.appendChild(spacer);
  }

  // ---------- 打开 / 保存 ----------
  function updateBreadcrumb() {
    var dot = dirty ? ' ●' : '';
    if (currentNode) {
      $('breadcrumb').textContent = currentProject.name + ' / ' + currentNode.path + dot;
    } else {
      $('breadcrumb').textContent = currentProject ? (currentProject.name + dot) : '未打开文件';
    }
  }

  async function saveCurrent() {
    if (!currentNode) { toast('没有打开的文件'); return; }
    var text = Editor.getValue();
    try {
      var toDisk = await currentProject.saveFile(currentNode, text);
      savedValue = text;
      dirty = false;
      $('btnSaveEditor').disabled = true;
      // 更新标签状态
      if (activeTabId) {
        var tab = getTab(activeTabId);
        if (tab) {
          tab.savedValue = text;
          tab.dirty = false;
        }
      }
      renderTabBar();
      updateBreadcrumb();
      toast(toDisk === false ? '已保存到沙箱' : '已保存 ✓');
    } catch (e) {
      toast('保存失败：' + (e.message || e));
    }
  }

  // ---------- 项目弹窗 ----------
  async function openProjectsModal() {
    var list = $('projectsList');
    list.innerHTML = '';
    var projects = await FS.listProjects();
    if (!projects.length) list.innerHTML = '<div class="sp-empty">还没有项目</div>';
    projects.forEach(function (p) {
      var row = document.createElement('div');
      row.className = 'proj-row';
      var info = document.createElement('div');
      info.className = 'proj-info';
      var kindLabel = p.kind === 'native' ? '原生读写' : (p.kind === 'fsa' ? '可读写' : '沙箱只读');
      info.innerHTML = '<div class="proj-name">' + escapeHtml(p.name) + '</div><div class="proj-kind">' + kindLabel + '</div>';
      var open = document.createElement('button');
      open.className = 'mini'; open.textContent = '打开';
      open.addEventListener('click', async function () {
        try { var proj = await FS.openProject(p.id); await activateProject(proj); }
        catch (e) { toast('打开失败：' + (e.message || e)); }
      });
      var del = document.createElement('button');
      del.className = 'mini danger'; del.textContent = '删除';
      del.addEventListener('click', async function () { await FS.removeProject(p.id); openProjectsModal(); });
      var acts = document.createElement('div');
      acts.className = 'proj-acts';
      acts.appendChild(open); acts.appendChild(del);
      row.appendChild(info); row.appendChild(acts);
      list.appendChild(row);
    });
    $('projectsModal').style.display = 'flex';
  }

  function escapeHtml(s) { return Highlighter.escapeHtml(s); }
  function escapeReg(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : this);
