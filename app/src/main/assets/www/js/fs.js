/* =========================================================================
 * fs.js — 项目管理 / 文件系统抽象
 *
 * 后端优先级：
 *   1) 原生桥 (window.AndroidBridge) —— 安卓 App 内，用 SAF 访问手机任意目录
 *   2) File System Access API —— 桌面 Chrome/Edge
 *   3) <input webkitdirectory> + IndexedDB 沙箱 —— 仅读取兜底
 *
 * 关键改进：
 *   - getNative() 在调用时检测 AndroidBridge（非加载时），避免时序问题
 *   - buildTree() 一次性返回完整目录树（单次 IPC，不再递归往返）
 *   - 回调机制简化为 __codexFolderCb(uri, name)，不再 JSON.parse
 * ========================================================================= */
(function (global) {
  'use strict';

  const DB_NAME = 'codex-editor';
  const STORE = 'projects';
  const SKIP_DIRS = new Set([
    'node_modules', '.git', '.idea', '.vscode', 'dist', 'build',
    '__pycache__', '.next', 'vendor', '.gradle', 'target', 'bin', 'obj', '.turbo',
    '.cxx', 'Release', 'Debug', '.externalNativeBuild',
  ]);
  const TEXT_EXT = new Set([
    'js','mjs','cjs','jsx','ts','tsx','py','pyw','c','h','cpp','cc','cxx','hpp','hh','hxx',
    'java','cs','go','rs','json','html','htm','xml','svg','css','scss','less','sh','bash',
    'zsh','sql','yml','yaml','md','markdown','txt','log','ini','toml','cfg','conf','env',
    'gradle','kt','kts','swift','rb','php','vue','svelte','dart','lua','r','pl','scala','groovy',
  ]);
  const MAX_FILE_BYTES = 3 * 1024 * 1024;

  // ---------- IndexedDB ----------
  function openDB() {
    return new Promise(function (res, rej) {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () {
        const db = r.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  async function dbPut(obj) {
    const db = await openDB();
    return new Promise(function (res, rej) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(obj);
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  }
  async function dbGetAll() {
    const db = await openDB();
    return new Promise(function (res, rej) {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).getAll();
      req.onsuccess = function () { res(req.result || []); };
      req.onerror = function () { rej(req.error); };
    });
  }
  async function dbDelete(id) {
    const db = await openDB();
    return new Promise(function (res, rej) {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(id);
      tx.oncomplete = function () { res(); };
      tx.onerror = function () { rej(tx.error); };
    });
  }

  function uid() { return 'p_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function isTextFile(name) {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return false;
    return TEXT_EXT.has(name.slice(dot + 1).toLowerCase());
  }
  function sortChildren(children) {
    children.sort(function (a, b) {
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  // ==========================================================================
  //  原生桥（安卓 SAF）—— 延迟检测，调用时才检查 AndroidBridge 是否存在
  // ==========================================================================

  let _nativeChecked = false;
  let _native = null;

  /**
   * 检测原生桥是否可用。
   * 关键：在调用时检查（非脚本加载时），避免 AndroidBridge 注入时序问题。
   * 首次调用会执行 testBridge() 验证桥是否真正可用，结果缓存。
   */
  function getNative() {
    if (_nativeChecked) return _native;
    _nativeChecked = true;
    try {
      if (typeof window.AndroidBridge !== 'undefined' && window.AndroidBridge) {
        // 验证桥是否真正可用
        if (window.AndroidBridge.testBridge() === 'OK') {
          _native = createNativeBridge();
          console.log('[CodeX] Native bridge OK');
        } else {
          console.warn('[CodeX] Native bridge testBridge returned unexpected value');
        }
      }
    } catch (e) {
      console.error('[CodeX] Native bridge check failed:', e);
    }
    return _native;
  }

  function createNativeBridge() {
    const NB = window.AndroidBridge;

    return {
      pickFolder: function () {
        return new Promise(function (resolve) {
          var resolved = false;
          // 60 秒超时（SAF 可能在某些设备上卡住）
          var timer = setTimeout(function () {
            if (!resolved) {
              resolved = true;
              console.warn('[CodeX] folder picker timeout');
              resolve(null);
            }
          }, 60000);
          window.__codexFolderCb = function (uri, name) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            if (uri) resolve({ uri: uri, name: name || '项目' });
            else resolve(null);
          };
          NB.pickFolder();
        });
      },

      pickFile: function () {
        return new Promise(function (resolve) {
          var resolved = false;
          var timer = setTimeout(function () {
            if (!resolved) {
              resolved = true;
              console.warn('[CodeX] file picker timeout');
              resolve(null);
            }
          }, 60000);
          window.__codexFileCb = function (uri, name) {
            if (resolved) return;
            resolved = true;
            clearTimeout(timer);
            if (uri) resolve({ uri: uri, name: name || 'file' });
            else resolve(null);
          };
          NB.pickFile();
        });
      },

      /**
       * 一次性构建完整目录树（比递归 listChildren 快 10 倍+）。
       * 返回: { name, type:'dir', uri, children: [...] }
       */
      buildTree: function (uri) {
        var raw = NB.buildTree(uri);
        var json = JSON.parse(raw);
        if (json && json.error) throw new Error(json.error);
        return json;
      },

      /**
       * 返回所有文件的扁平列表（供全局搜索用）。
       * 返回: [{ path, name, uri }, ...]
       */
      listAllFiles: function (uri) {
        try { return JSON.parse(NB.listAllFiles(uri) || '[]'); }
        catch (e) { return []; }
      },

      /** 列出单个目录的子项（兼容保留） */
      listChildren: function (uri) {
        var arr = JSON.parse(NB.listChildren(uri));
        if (arr && arr.error) throw new Error(arr.error);
        return arr || [];
      },

      readFile: function (uri) { return NB.readFile(uri); },
      writeFile: function (uri, content) {
        return String(NB.writeFile(uri, content)) === 'true';
      },
    };
  }

  // ==========================================================================
  //  FS 对象
  // ==========================================================================

  var FS = {};
  // kind 作为 getter，调用时才检测（避免加载时 AndroidBridge 未注入）
  Object.defineProperty(FS, 'kind', {
    get: function () {
      if (getNative()) return 'native';
      if (typeof window.showDirectoryPicker === 'function') return 'fsa';
      var inp = document.createElement('input');
      if ('webkitdirectory' in inp) return 'blob';
      return 'none';
    },
    enumerable: true,
  });

  // ---------- 添加项目 ----------
  FS.addViaPicker = async function () {
    var N = getNative();
    if (N) {
      var picked = await N.pickFolder();
      if (!picked) return null;
      var id = uid();
      var meta = { id: id, name: picked.name || '项目', kind: 'native', rootUri: picked.uri };
      await dbPut(meta);
      return new NativeProject(meta);
    }
    // FSA
    var handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    var id2 = uid();
    var meta2 = { id: id2, name: handle.name, kind: 'fsa', handle: handle };
    await dbPut(meta2);
    return new Project(meta2);
  };

  FS.addViaInput = async function (fileList) {
    var id = uid();
    var name = (fileList[0] && fileList[0].webkitRelativePath.split('/')[0]) || '项目';
    var map = {};
    for (var i = 0; i < fileList.length; i++) {
      var f = fileList[i];
      var rel = f.webkitRelativePath || f.name;
      if (rel.split('/').some(function (p) { return SKIP_DIRS.has(p); })) continue;
      map[rel] = { name: f.name, content: null, blob: f };
    }
    var meta = { id: id, name: name, kind: 'blob', map: map };
    await dbPut(meta);
    return new Project(meta);
  };

  FS.listProjects = async function () {
    var all = await dbGetAll();
    return all.map(function (m) { return { id: m.id, name: m.name, kind: m.kind }; });
  };

  FS.openProject = async function (id) {
    var all = await dbGetAll();
    var meta = all.find(function (m) { return m.id === id; });
    if (!meta) throw new Error('项目不存在');
    if (meta.kind === 'native') return new NativeProject(meta);
    if (meta.kind === 'fsa') {
      try {
        var st = await meta.handle.queryPermission({ mode: 'readwrite' });
        if (st !== 'granted') await meta.handle.requestPermission({ mode: 'readwrite' });
      } catch (e) {}
    }
    return new Project(meta);
  };

  FS.removeProject = function (id) { return dbDelete(id); };

  FS.openExternalFile = async function (uri, name) {
    name = name || (uri ? uri.split('/').pop().split('?')[0] : '文件');
    return { uri: uri, name: name, type: 'file' };
  };

  // ==========================================================================
  //  原生 Project（安卓 SAF）
  // ==========================================================================

  class NativeProject {
    constructor(meta) {
      this.id = meta.id;
      this.name = meta.name;
      this.kind = 'native';
      this.rootUri = meta.rootUri;
      this.root = null;
    }

    async buildTree() {
      var N = getNative();
      // 让出线程一帧，让 UI 能显示加载提示
      await new Promise(function (r) { setTimeout(r, 30); });
      this.root = N.buildTree(this.rootUri);
      this._addPaths(this.root, this.name);
      return this.root;
    }

    _addPaths(node, prefix) {
      node.path = prefix;
      if (node.children) {
        for (var i = 0; i < node.children.length; i++) {
          this._addPaths(node.children[i], prefix + '/' + node.children[i].name);
        }
      }
    }

    async readFile(node) {
      var N = getNative();
      var c = N.readFile(node.uri);
      if (c && c.indexOf('__CODEX_ERR__') === 0) throw new Error(c.slice(13));
      return c || '';
    }

    async saveFile(node, text) {
      var N = getNative();
      return N.writeFile(node.uri, text);
    }

    async walkFiles(cb) {
      var N = getNative();
      var files = N.listAllFiles(this.rootUri);
      for (var i = 0; i < files.length; i++) {
        var f = files[i];
        await cb({
          path: f.path,
          name: f.name,
          getContent: (function (uri) {
            return function () { return N.readFile(uri); };
          })(f.uri),
        });
      }
    }
  }

  // ==========================================================================
  //  通用 Project（FSA / blob）
  // ==========================================================================

  class Project {
    constructor(meta) {
      this.id = meta.id;
      this.name = meta.name;
      this.kind = meta.kind;
      this.handle = meta.handle || null;
      this.map = meta.map || null;
      this.root = null;
    }
    async buildTree() {
      if (this.kind === 'fsa') this.root = await readDir(this.handle, this.handle.name, 0);
      else this.root = buildTreeFromMap(this.map, this.name);
      return this.root;
    }
    async readFile(node) {
      if (this.kind === 'fsa') {
        var file = await node.handle.getFile();
        if (file.size > MAX_FILE_BYTES) return '/* 文件过大 (' + (file.size >> 10) + ' KB)，已跳过显示 */';
        return await file.text();
      } else {
        var entry = this.map[node.path];
        if (!entry) return '';
        if (entry.content == null) {
          if (entry.blob.size > MAX_FILE_BYTES) return '/* 文件过大，已跳过显示 */';
          entry.content = await entry.blob.text();
        }
        return entry.content;
      }
    }
    async saveFile(node, text) {
      if (this.kind === 'fsa') {
        var writable = await node.handle.createWritable();
        await writable.write(text);
        await writable.close();
        node._dirty = false;
        return true;
      } else {
        var entry = this.map[node.path];
        if (entry) { entry.content = text; entry.blob = new Blob([text], { type: 'text/plain' }); }
        var meta = { id: this.id, name: this.name, kind: 'blob', map: this.map };
        await dbPut(meta);
        return false;
      }
    }
    async walkFiles(cb) {
      if (this.kind === 'fsa') {
        await walkFsa(this.handle, this.handle.name, cb, 0);
      } else {
        var paths = Object.keys(this.map);
        for (var i = 0; i < paths.length; i++) {
          var p = paths[i];
          var entry = this.map[p];
          if (!isTextFile(p)) continue;
          await cb({ path: p, name: entry.name, getContent: (function (self, node) {
            return function () { return self.readFile(node); };
          })(this, { path: p, handle: null }) });
        }
      }
    }
  }

  // ---------- FSA 辅助 ----------

  async function readDir(dirHandle, fullPath, depth) {
    var node = { name: dirHandle.name, path: fullPath, type: 'dir', children: [], handle: dirHandle };
    if (depth > 16) return node;
    for await (var entry of dirHandle.values()) {
      if (entry.kind === 'directory') {
        if (SKIP_DIRS.has(entry.name)) continue;
        node.children.push(await readDir(entry, fullPath + '/' + entry.name, depth + 1));
      } else {
        node.children.push({ name: entry.name, path: fullPath + '/' + entry.name, type: 'file', handle: entry });
      }
    }
    sortChildren(node.children);
    return node;
  }

  async function walkFsa(dirHandle, fullPath, cb, depth) {
    if (depth > 16) return;
    for await (var entry of dirHandle.values()) {
      if (entry.kind === 'directory') {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walkFsa(entry, fullPath + '/' + entry.name, cb, depth + 1);
      } else {
        var path = fullPath + '/' + entry.name;
        if (!isTextFile(entry.name)) continue;
        await cb({ path: path, name: entry.name, getContent: (function (h) {
          return async function () {
            var f = await h.getFile();
            if (f.size > MAX_FILE_BYTES) return '';
            return await f.text();
          };
        })(entry) });
      }
    }
  }

  function buildTreeFromMap(map, rootName) {
    var root = { name: rootName, path: rootName, type: 'dir', children: [] };
    var dirNodes = { '': root };
    var paths = Object.keys(map);
    for (var i = 0; i < paths.length; i++) {
      var p = paths[i];
      var parts = p.split('/');
      var cur = '';
      var parent = root;
      for (var j = 0; j < parts.length; j++) {
        var part = parts[j];
        var key = cur ? cur + '/' + part : part;
        var isLast = j === parts.length - 1;
        if (isLast) {
          parent.children.push({ name: part, path: p, type: 'file', handle: null });
        } else {
          if (!dirNodes[key]) {
            var dir = { name: part, path: key, type: 'dir', children: [] };
            dirNodes[key] = dir;
            parent.children.push(dir);
          }
          parent = dirNodes[key];
        }
        cur = key;
      }
    }
    sortChildren(root.children);
    (function sortDeep(n) {
      if (n.type === 'dir') { sortChildren(n.children); n.children.forEach(sortDeep); }
    })(root);
    return root;
  }

  FS.isTextFile = isTextFile;
  FS.SKIP_DIRS = SKIP_DIRS;
  global.FS = FS;
})(typeof window !== 'undefined' ? window : this);
