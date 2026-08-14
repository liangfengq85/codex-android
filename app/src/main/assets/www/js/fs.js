/* =========================================================================
 * fs.js — 项目管理 / 文件系统抽象
 * 后端优先级：
 *   1) 原生桥 (window.AndroidBridge) —— 安卓 App 内，用 Storage Access
 *      Framework 访问手机任意目录/文件，可真正读写；并能关联微信文件。
 *   2) File System Access API —— 桌面 Chrome/Edge，可真正读写。
 *   3) <input webkitdirectory> + IndexedDB 沙箱 —— 仅读取兜底。
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

  // ---------- 原生桥（安卓 SAF） ----------
  // Kotlin 端通过 addJavascriptInterface 暴露 window.AndroidBridge，并提供：
  //   pickFolder() / pickFile()  —— 启动系统选择器，结果经 CodeXNative.onPick* 回调
  //   listChildren(uri) -> JSON '[{name,type,uri}]'
  //   readFile(uri)     -> 文件文本
  //   writeFile(uri,c)  -> 'true'|'false'
  const NB = (typeof window !== 'undefined' && window.AndroidBridge) ? window.AndroidBridge : null;

  const Native = NB ? {
    _pick: function (kind) {
      return new Promise(function (resolve) {
        window.CodeXNative = window.CodeXNative || {};
        if (kind === 'folder') window.CodeXNative.onPickFolder = function (payload) {
          try { payload = JSON.parse(payload); } catch (e) {}
          resolve(payload && payload.uri ? payload : null);
        };
        else window.CodeXNative.onPickFile = function (payload) {
          try { payload = JSON.parse(payload); } catch (e) {}
          resolve(payload && payload.uri ? payload : null);
        };
        if (kind === 'folder') NB.pickFolder(); else NB.pickFile();
      });
    },
    pickFolder: function () { return this._pick('folder'); },
    pickFile: function () { return this._pick('file'); },
    listChildren: function (uri) {
      try { return JSON.parse(NB.listChildren(uri)) || []; } catch (e) { return []; }
    },
    readFile: function (uri) { return NB.readFile(uri); },
    writeFile: function (uri, content) { return String(NB.writeFile(uri, content)) === 'true'; },
  } : null;

  const FS = {
    kind: Native ? 'native' : ('showDirectoryPicker' in window) ? 'fsa'
      : ('webkitdirectory' in document.createElement('input') ? 'blob' : 'none'),
  };

  // ---------- 添加项目 ----------
  FS.addViaPicker = async function () {
    if (Native) {
      const picked = await Native.pickFolder();
      if (!picked) return null;
      const id = uid();
      const meta = { id: id, name: picked.name || '项目', kind: 'native', rootUri: picked.uri };
      await dbPut(meta);
      return new NativeProject(meta);
    }
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    const id = uid();
    const meta = { id: id, name: handle.name, kind: 'fsa', handle: handle };
    await dbPut(meta);
    return new Project(meta);
  };

  FS.addViaInput = async function (fileList) {
    const id = uid();
    const name = (fileList[0] && fileList[0].webkitRelativePath.split('/')[0]) || '项目';
    const map = {};
    for (const f of fileList) {
      const rel = f.webkitRelativePath || f.name;
      if (rel.split('/').some(function (p) { return SKIP_DIRS.has(p); })) continue;
      map[rel] = { name: f.name, content: null, blob: f };
    }
    const meta = { id: id, name: name, kind: 'blob', map: map };
    await dbPut(meta);
    return new Project(meta);
  };

  FS.listProjects = async function () {
    const all = await dbGetAll();
    return all.map(function (m) { return { id: m.id, name: m.name, kind: m.kind }; });
  };

  FS.openProject = async function (id) {
    const all = await dbGetAll();
    const meta = all.find(function (m) { return m.id === id; });
    if (!meta) throw new Error('项目不存在');
    if (meta.kind === 'native') return new NativeProject(meta);
    if (meta.kind === 'fsa') {
      try {
        const st = await meta.handle.queryPermission({ mode: 'readwrite' });
        if (st !== 'granted') await meta.handle.requestPermission({ mode: 'readwrite' });
      } catch (e) {}
    }
    return new Project(meta);
  };

  FS.removeProject = function (id) { return dbDelete(id); };

  // 微信文件关联：打开一个来自外部 Intent 的 Uri（单文件）
  FS.openExternalFile = async function (uri, name) {
    name = name || (uri ? uri.split('/').pop().split('?')[0] : '文件');
    return { uri: uri, name: name, type: 'file' };
  };

  // ---------- 原生 Project ----------
  class NativeProject {
    constructor(meta) {
      this.id = meta.id;
      this.name = meta.name;
      this.kind = 'native';
      this.rootUri = meta.rootUri;
      this.root = null;
    }
    async buildTree() {
      this.root = await this._readDir(this.rootUri, this.name);
      return this.root;
    }
    async _readDir(uri, name) {
      const node = { name: name, uri: uri, type: 'dir', children: [] };
      const kids = Native.listChildren(uri);
      for (const k of kids) {
        if (k.type === 'dir') {
          if (SKIP_DIRS.has(k.name)) continue;
          node.children.push(await this._readDir(k.uri, k.name));
        } else {
          node.children.push({ name: k.name, uri: k.uri, type: 'file' });
        }
      }
      sortChildren(node.children);
      return node;
    }
    async readFile(node) {
      const c = Native.readFile(node.uri);
      if (c && c.indexOf('__CODEX_ERR__') === 0) throw new Error(c.slice(13));
      return c || '';
    }
    async saveFile(node, text) {
      return Native.writeFile(node.uri, text);
    }
    async walkFiles(cb) {
      await this._walk(this.root, '', cb);
    }
    async _walk(node, prefix, cb) {
      if (node.type === 'dir') {
        const pre = prefix ? prefix + '/' + node.name : node.name;
        for (const c of node.children) await this._walk(c, pre, cb);
      } else {
        const path = prefix ? prefix + '/' + node.name : node.name;
        if (!isTextFile(node.name)) return;
        await cb({ path: path, name: node.name, getContent: (function (u) {
          return function () { return Native.readFile(u); };
        })(node.uri) });
      }
    }
  }

  // ---------- 通用 Project（FSA / blob） ----------
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
        const file = await node.handle.getFile();
        if (file.size > MAX_FILE_BYTES) return '/* 文件过大 (' + (file.size >> 10) + ' KB)，已跳过显示 */';
        return await file.text();
      } else {
        const entry = this.map[node.path];
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
        const writable = await node.handle.createWritable();
        await writable.write(text);
        await writable.close();
        node._dirty = false;
        return true;
      } else {
        const entry = this.map[node.path];
        if (entry) { entry.content = text; entry.blob = new Blob([text], { type: 'text/plain' }); }
        const meta = { id: this.id, name: this.name, kind: 'blob', map: this.map };
        await dbPut(meta);
        return false;
      }
    }
    async walkFiles(cb) {
      if (this.kind === 'fsa') {
        await walkFsa(this.handle, this.handle.name, cb, 0);
      } else {
        const paths = Object.keys(this.map);
        for (const p of paths) {
          const entry = this.map[p];
          if (!isTextFile(p)) continue;
          await cb({ path: p, name: entry.name, getContent: (function (self, node) {
            return function () { return self.readFile(node); };
          })(this, { path: p, handle: null }) });
        }
      }
    }
  }

  async function readDir(dirHandle, fullPath, depth) {
    const node = { name: dirHandle.name, path: fullPath, type: 'dir', children: [], handle: dirHandle };
    if (depth > 16) return node;
    for await (const entry of dirHandle.values()) {
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
    for await (const entry of dirHandle.values()) {
      if (entry.kind === 'directory') {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walkFsa(entry, fullPath + '/' + entry.name, cb, depth + 1);
      } else {
        const path = fullPath + '/' + entry.name;
        if (!isTextFile(entry.name)) continue;
        await cb({ path: path, name: entry.name, getContent: (function (h) {
          return async function () {
            const f = await h.getFile();
            if (f.size > MAX_FILE_BYTES) return '';
            return await f.text();
          };
        })(entry) });
      }
    }
  }

  function buildTreeFromMap(map, rootName) {
    const root = { name: rootName, path: rootName, type: 'dir', children: [] };
    const dirNodes = { '': root };
    const paths = Object.keys(map);
    for (const p of paths) {
      const parts = p.split('/');
      let cur = '';
      let parent = root;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        const key = cur ? cur + '/' + part : part;
        const isLast = i === parts.length - 1;
        if (isLast) {
          parent.children.push({ name: part, path: p, type: 'file', handle: null });
        } else {
          if (!dirNodes[key]) {
            const dir = { name: part, path: key, type: 'dir', children: [] };
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
