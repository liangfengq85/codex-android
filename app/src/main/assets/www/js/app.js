/* =========================================================================
 * app.js — 主控制器：项目切换 / 文件树 / 打开·保存 / 全局搜索 / 查找条
 * ========================================================================= */
(function (global) {
  'use strict';

  const $ = function (id) { return document.getElementById(id); };

  let currentProject = null;
  let pathMap = {};        // path -> node
  let currentNode = null;
  let dirty = false;

  // ---------- 工具 ----------
  function toast(msg, ms) {
    const t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.style.display = 'none'; }, ms || 2200);
  }

  // ---------- 初始化 ----------
  function init() {
    Editor.mount($('editorHost'));
    Editor.setOnChange(function (node, val) {
      dirty = true;
      $('btnSave').disabled = false;
      updateBreadcrumb();
    });

    $('btnAdd').addEventListener('click', addProject);
    $('btnAdd2').addEventListener('click', addProject);
    $('btnAdd3').addEventListener('click', addProject);
    $('btnProjects').addEventListener('click', openProjectsModal);
    $('btnSearch').addEventListener('click', toggleSearchPanel);
    $('btnSave').addEventListener('click', saveCurrent);

    $('dirInput').addEventListener('change', onDirInput);

    // 查找条
    $('findClose').addEventListener('click', function () { $('findbar').style.display = 'none'; });
    $('findPrev').addEventListener('click', function () { doFind('prev'); });
    $('findNext').addEventListener('click', function () { doFind('next'); });
    $('findInput').addEventListener('input', function () { doFind('first'); });
    $('findInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doFind(e.shiftKey ? 'prev' : 'next');
      if (e.key === 'Escape') $('findbar').style.display = 'none';
    });

    // 搜索面板
    $('searchClose').addEventListener('click', function () { $('searchPanel').style.display = 'none'; });
    $('searchInput').addEventListener('input', debounce(runSearch, 250));
    $('searchInput').addEventListener('keydown', function (e) { if (e.key === 'Escape') $('searchPanel').style.display = 'none'; });

    // 项目弹窗
    $('projectsClose').addEventListener('click', function () { $('projectsModal').style.display = 'none'; });

    // 能力提示
    let tip = '';
    if (FS.kind === 'native') tip = '✅ 已支持直接访问手机文件：点「＋ 项目」选择手机文件夹即可读写。';
    else if (FS.kind === 'fsa') tip = '✅ 当前浏览器支持直接读写文件夹（安卓 Chrome / Edge）。';
    else if (FS.kind === 'blob') tip = 'ℹ️ 当前浏览器仅支持“选择文件夹”读取，编辑内容保存在应用沙箱内。';
    else tip = '⚠️ 当前浏览器不支持文件夹访问，请用安卓 Chrome 打开。';
    $('supportTip').textContent = tip;

    global.App = { openFind: openFind, saveCurrent: saveCurrent, openExternal: openExternalFile };
  }

  // 外部文件关联打开（微信/系统「用 CodeX 打开」）
  function openExternalFile(uri, name) {
    if (!window.AndroidBridge) { toast('无法读取外部文件'); return; }
    const node = { uri: uri, name: name, path: name, type: 'file' };
    currentProject = {
      id: 'ext', name: name, kind: 'native',
      readFile: function (n) { return Promise.resolve(window.AndroidBridge.readFile(n.uri) || ''); },
      saveFile: function (n, text) { return Promise.resolve(String(window.AndroidBridge.writeFile(n.uri, text)) === 'true'); },
      walkFiles: function () { return Promise.resolve(); },
    };
    openFile(node);
  }

  function debounce(fn, ms) {
    let t;
    return function () { clearTimeout(t); const a = arguments; t = setTimeout(function () { fn.apply(null, a); }, ms); };
  }

  // ---------- 项目 ----------
  async function addProject() {
    try {
      let proj;
      if (FS.kind === 'native' || FS.kind === 'fsa') {
        proj = await FS.addViaPicker();
      } else if (FS.kind === 'blob') {
        $('dirInput').click();
        return;
      } else {
        toast('当前浏览器不支持文件夹访问');
        return;
      }
      await activateProject(proj);
      $('projectsModal').style.display = 'none';
    } catch (e) {
      if (e && e.name !== 'AbortError') toast('添加失败：' + (e.message || e));
    }
  }

  async function onDirInput() {
    const input = $('dirInput');
    if (!input.files.length) return;
    try {
      const proj = await FS.addViaInput(input.files);
      input.value = '';
      await activateProject(proj);
      $('projectsModal').style.display = 'none';
    } catch (e) { toast('添加失败：' + (e.message || e)); }
  }

  async function activateProject(proj) {
    currentProject = proj;
    $('projName').textContent = proj.name;
    $('welcome').style.display = 'none';
    $('editorHost').style.display = '';
    const root = await proj.buildTree();
    buildPathMap(root);
    renderTree(root);
    currentNode = null;
    Editor.open(null, '', 'text');
    dirty = false;
    $('btnSave').disabled = true;
    updateBreadcrumb();
  }

  function buildPathMap(root) {
    pathMap = {};
    (function walk(n) {
      if (n.type === 'file') pathMap[n.path] = n;
      else (n.children || []).forEach(walk);
    })(root);
  }

  // ---------- 文件树 ----------
  function renderTree(root) {
    const view = $('treeView');
    view.innerHTML = '';
    view.appendChild(renderNode(root, 0, true));
  }

  function renderNode(node, depth, isRoot) {
    const wrap = document.createElement('div');
    wrap.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row' + (node.type === 'dir' ? ' is-dir' : '');
    row.style.paddingLeft = (8 + depth * 14) + 'px';

    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = node.type === 'dir' ? '📂' : fileEmoji(node.name);
    row.appendChild(icon);

    const label = document.createElement('span');
    label.className = 'tree-label';
    label.textContent = node.name;
    row.appendChild(label);

    wrap.appendChild(row);

    if (node.type === 'dir') {
      const childrenBox = document.createElement('div');
      childrenBox.className = 'tree-children';
      childrenBox.style.display = (depth < 1 || isRoot) ? 'block' : 'none';
      (node.children || []).forEach(function (c) {
        childrenBox.appendChild(renderNode(c, depth + 1, false));
      });
      wrap.appendChild(childrenBox);

      row.addEventListener('click', function () {
        const open = childrenBox.style.display === 'block';
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
    const ext = (name.split('.').pop() || '').toLowerCase();
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
  async function openFile(node) {
    try {
      const content = await currentProject.readFile(node);
      const lang = Highlighter.langFromName(node.name);
      currentNode = node;
      dirty = false;
      $('btnSave').disabled = true;
      Editor.open(node, content, lang);
      // 高亮当前选中行
      document.querySelectorAll('.tree-row.active').forEach(function (r) { r.classList.remove('active'); });
      if (node._row) node._row.classList.add('active');
      updateBreadcrumb();
    } catch (e) {
      toast('读取失败：' + (e.message || e));
    }
  }

  function updateBreadcrumb() {
    const dot = dirty ? ' ●' : '';
    if (currentNode) $('breadcrumb').textContent = currentProject.name + ' / ' + currentNode.path + dot;
    else $('breadcrumb').textContent = currentProject ? (currentProject.name + dot) : '未打开文件';
  }

  async function saveCurrent() {
    if (!currentNode) { toast('没有打开的文件'); return; }
    const text = Editor.getValue();
    try {
      const toDisk = await currentProject.saveFile(currentNode, text);
      dirty = false;
      $('btnSave').disabled = true;
      updateBreadcrumb();
      if (toDisk === false) toast('已保存到应用沙箱（非磁盘）');
      else toast('已保存 ✓');
    } catch (e) {
      toast('保存失败：' + (e.message || e));
    }
  }

  // ---------- 查找条 ----------
  function openFind() {
    $('findbar').style.display = 'flex';
    $('findInput').focus();
    $('findInput').select();
  }
  function doFind(mode) {
    const q = $('findInput').value;
    if (!q) { $('findInfo').textContent = ''; return; }
    let total;
    if (mode === 'first') { total = Editor.find(q, {}); }
    else if (mode === 'prev') { total = Editor.findPrev(q, {}); }
    else { total = Editor.findNext(q, {}); }
    const info = Editor.matchInfo();
    $('findInfo').textContent = total ? (info.idx + 1) + ' / ' + total : '0 / 0';
  }

  // ---------- 全局搜索 ----------
  function toggleSearchPanel() {
    const p = $('searchPanel');
    if (p.style.display === 'none') {
      p.style.display = 'flex';
      $('searchInput').focus();
      if (!$('searchInput').value) $('searchStats').textContent = '输入关键字搜索整个项目';
    } else {
      p.style.display = 'none';
    }
  }

  async function runSearch() {
    if (!currentProject) { toast('请先添加项目'); return; }
    const q = $('searchInput').value;
    if (!q) { $('searchStats').textContent = ''; $('searchResults').innerHTML = ''; return; }
    const caseSensitive = $('searchCase').checked;
    const re = new RegExp(escapeReg(q), caseSensitive ? 'g' : 'gi');
    const results = [];
    let filesScanned = 0;
    $('searchStats').textContent = '搜索中…';
    await currentProject.walkFiles(async function (f) {
      filesScanned++;
      let content;
      try { content = await f.getContent(); } catch (e) { return; }
      if (!content) return;
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        re.lastIndex = 0;
        if (re.test(line)) {
          results.push({ path: f.path, name: f.name, lineNo: i + 1, text: line.trim() });
        }
      }
    });
    $('searchStats').textContent = '扫描 ' + filesScanned + ' 个文件，命中 ' + results.length + ' 处';
    renderSearchResults(results, q);
  }

  function renderSearchResults(results, q) {
    const box = $('searchResults');
    box.innerHTML = '';
    if (!results.length) { box.innerHTML = '<div class="sp-empty">无匹配</div>'; return; }
    results.slice(0, 500).forEach(function (r) {
      const item = document.createElement('div');
      item.className = 'sp-item';
      const head = document.createElement('div');
      head.className = 'sp-item-head';
      head.innerHTML = '<span class="sp-path">' + escapeHtml(r.path) + '</span>' +
                       '<span class="sp-ln">:' + r.lineNo + '</span>';
      const body = document.createElement('div');
      body.className = 'sp-item-body';
      body.textContent = r.text;
      item.appendChild(head);
      item.appendChild(body);
      item.addEventListener('click', function () { jumpToResult(r); });
      box.appendChild(item);
    });
    if (results.length > 500) {
      const more = document.createElement('div');
      more.className = 'sp-empty';
      more.textContent = '仅显示前 500 条，请缩小关键字';
      box.appendChild(more);
    }
  }

  async function jumpToResult(r) {
    const node = pathMap[r.path];
    if (!node) { toast('文件未在树中'); return; }
    await openFile(node);
    Editor.gotoLine(r.lineNo);
    $('searchPanel').style.display = 'none';
  }

  // ---------- 项目弹窗 ----------
  async function openProjectsModal() {
    const list = $('projectsList');
    list.innerHTML = '';
    const projects = await FS.listProjects();
    if (!projects.length) {
      list.innerHTML = '<div class="sp-empty">还没有项目，点“添加项目”</div>';
    }
    projects.forEach(function (p) {
      const row = document.createElement('div');
      row.className = 'proj-row';
      const info = document.createElement('div');
      info.className = 'proj-info';
      info.innerHTML = '<div class="proj-name">' + escapeHtml(p.name) + '</div>' +
                       '<div class="proj-kind">' + (p.kind === 'fsa' ? '可读写' : '沙箱只读') + '</div>';
      const open = document.createElement('button');
      open.className = 'mini';
      open.textContent = '打开';
      open.addEventListener('click', async function () {
        try { const proj = await FS.openProject(p.id); await activateProject(proj); }
        catch (e) { toast('打开失败：' + (e.message || e)); }
      });
      const del = document.createElement('button');
      del.className = 'mini danger';
      del.textContent = '删除';
      del.addEventListener('click', async function () {
        await FS.removeProject(p.id);
        openProjectsModal();
      });
      const acts = document.createElement('div');
      acts.className = 'proj-acts';
      acts.appendChild(open); acts.appendChild(del);
      row.appendChild(info); row.appendChild(acts);
      list.appendChild(row);
    });
    $('projectsModal').style.display = 'flex';
  }

  function escapeHtml(s) {
    return Highlighter.escapeHtml(s);
  }
  function escapeReg(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : this);
