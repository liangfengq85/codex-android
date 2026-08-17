/* =========================================================================
 * app.js — 主控制器
 *
 * 功能：
 *   - 项目切换 / 文件树 / 打开·保存
 *   - 统一搜索（当前文件 / 整个项目）+ 跳转
 *   - 侧栏开关 / 拖拽调宽 / 字体缩放
 *   - 撤回 / 重做状态管理
 *   - 长按复制（全部 / 选中 / 当前行 / 按行范围）
 *   - 未保存提示弹窗
 *   - 光标位置显示
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
  var pendingFileNode = null;
  var pendingLineNo = null;

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
    Editor.setOnChange(function () { updateDirtyState(); });
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
      pendingFileNode = null;
      pendingLineNo = null;
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
    if (FS.kind === 'native') tip = '✅ 点「＋」选择手机文件夹即可读写。长按代码可复制。';
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

  // ---------- 复制弹窗 ----------
  function initCopyPopup() {
    var popup = $('copyPopup');
    popup.querySelectorAll('.copy-btn[data-action]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-action');
        if (action === 'all') { Editor.copyAll(); closeCopyPopup(); }
        else if (action === 'selection') { Editor.copySelection(); closeCopyPopup(); }
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

    // 定位 — 确保不超出屏幕
    var pw = popup.offsetWidth || 200;
    var ph = popup.offsetHeight || 180;
    var px = Math.max(4, Math.min(x - appRect.left, appRect.width - pw - 4));
    var py = Math.max(4, Math.min(y - appRect.top, appRect.height - ph - 4));
    popup.style.left = px + 'px';
    popup.style.top = py + 'px';

    // 添加遮罩 — 点击外部关闭
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
      item.addEventListener('click', function () {
        if (mode === 'project') jumpToProjectResult(r);
        else Editor.gotoLine(r.lineNo);
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

  async function jumpToProjectResult(r) {
    var node = pathMap[r.path];
    if (!node) { toast('文件未在树中'); return; }
    await openFile(node, r.lineNo);
    $('searchPanel').style.display = 'none';
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
    if (!pendingFileNode) return;
    var n = pendingFileNode, ln = pendingLineNo;
    pendingFileNode = null; pendingLineNo = null;
    doOpenFile(n).then(function () { if (ln) Editor.gotoLine(ln); });
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
    doOpenFile(node);
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
    } catch (e) {
      toast('加载目录失败：' + (e.message || e));
      renderTree({ name: proj.name, type: 'dir', children: [] });
    }
    currentNode = null;
    savedValue = '';
    Editor.open(null, '', 'text');
    dirty = false;
    $('btnSaveEditor').disabled = true;
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

  // ---------- 打开 / 保存 ----------
  async function openFile(node, lineNo) {
    if (dirty && currentNode && node !== currentNode) {
      pendingFileNode = node;
      pendingLineNo = lineNo;
      $('unsavedFileName').textContent = currentNode.name || '当前文件';
      $('unsavedModal').style.display = 'flex';
      return;
    }
    await doOpenFile(node);
    if (lineNo) Editor.gotoLine(lineNo);
  }

  async function doOpenFile(node) {
    try {
      var content = await currentProject.readFile(node);
      var lang = Highlighter.langFromName(node.name);
      currentNode = node;
      savedValue = content;
      dirty = false;
      $('btnSaveEditor').disabled = true;
      Editor.open(node, content, lang);
      document.querySelectorAll('.tree-row.active').forEach(function (r) { r.classList.remove('active'); });
      if (node._row) node._row.classList.add('active');
      updateBreadcrumb();
    } catch (e) {
      toast('读取失败：' + (e.message || e));
    }
  }

  function updateBreadcrumb() {
    var dot = dirty ? ' ●' : '';
    if (currentNode) $('breadcrumb').textContent = currentProject.name + ' / ' + currentNode.path + dot;
    else $('breadcrumb').textContent = currentProject ? (currentProject.name + dot) : '未打开文件';
  }

  async function saveCurrent() {
    if (!currentNode) { toast('没有打开的文件'); return; }
    var text = Editor.getValue();
    try {
      var toDisk = await currentProject.saveFile(currentNode, text);
      savedValue = text;
      dirty = false;
      $('btnSaveEditor').disabled = true;
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
