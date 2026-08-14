/* =========================================================================
 * highlight.js — 轻量、零依赖的多语言语法高亮引擎
 * 输出带 <span class="tok-xxx"> 的 HTML 片段，供编辑器叠层使用。
 * 区分：关键字 / 函数名 / 变量 / 类型(大写标识符) / 字符串 / 注释 / 数字
 * ========================================================================= */
(function (global) {
  'use strict';

  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) {
      return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
    });
  }
  function span(cls, text) {
    return '<span class="tok-' + cls + '">' + escapeHtml(text) + '</span>';
  }

  // ---- 关键字集合（按语言）-----------------------------------------------
  const KW = {
    javascript: ['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','new','class','extends','super','this','typeof','instanceof','in','of','void','delete','try','catch','finally','throw','async','await','yield','import','export','from','default','null','undefined','true','false','NaN','Infinity','debugger','with','static','get','set','arguments'],
    typescript: ['const','let','var','function','return','if','else','for','while','do','switch','case','break','continue','new','class','extends','super','this','typeof','instanceof','in','of','void','delete','try','catch','finally','throw','async','await','yield','import','export','from','default','null','undefined','true','false','NaN','Infinity','debugger','with','static','get','set','interface','type','enum','namespace','public','private','protected','readonly','implements','declare','as','keyof','is','satisfies','abstract','override','string','number','boolean','any','unknown','never','void'],
    python: ['def','class','return','if','elif','else','for','while','break','continue','import','from','as','with','try','except','finally','raise','yield','lambda','pass','global','nonlocal','assert','del','in','is','not','and','or','None','True','False','async','await','print','self','cls'],
    c: ['if','else','for','while','do','switch','case','default','break','continue','return','goto','sizeof','typedef','struct','union','enum','static','const','volatile','extern','register','auto','void','char','short','int','long','float','double','unsigned','signed','inline','restrict','_Bool','_Atomic','_Alignof','_Generic','_Complex'],
    cpp: ['if','else','for','while','do','switch','case','default','break','continue','return','goto','sizeof','typedef','struct','union','enum','static','const','volatile','extern','register','auto','void','char','short','int','long','float','double','unsigned','signed','inline','class','public','private','protected','virtual','template','typename','namespace','using','new','delete','this','throw','try','catch','operator','friend','explicit','constexpr','nullptr','bool','true','false','override','final','static_cast','dynamic_cast','reinterpret_cast','const_cast','std','auto'],
    java: ['if','else','for','while','do','switch','case','default','break','continue','return','try','catch','finally','throw','throws','new','class','interface','enum','extends','implements','import','package','public','private','protected','static','final','abstract','void','int','long','short','byte','char','float','double','boolean','String','this','super','instanceof','synchronized','volatile','transient','native','strictfp','assert','var','record','sealed','permits','yield','null','true','false'],
    csharp: ['if','else','for','foreach','while','do','switch','case','default','break','continue','return','try','catch','finally','throw','new','class','interface','enum','struct','extends','public','private','protected','internal','static','readonly','const','virtual','override','abstract','void','int','long','short','byte','char','float','double','bool','string','this','base','using','namespace','var','async','await','null','true','false','get','set','partial','sealed','ref','out','in'],
    go: ['if','else','for','range','switch','case','default','break','continue','return','go','defer','func','package','import','type','struct','interface','map','chan','var','const','select','fallthrough','nil','true','false','string','int','int8','int16','int32','int64','uint','byte','rune','float32','float64','bool','error'],
    rust: ['if','else','for','while','loop','match','case','break','continue','return','fn','let','mut','pub','use','mod','struct','enum','trait','impl','where','self','Self','as','in','ref','move','async','await','dyn','const','static','type','unsafe','crate','super','true','false','Some','None','Ok','Err'],
    shell: ['if','then','else','elif','fi','for','while','do','done','case','esac','function','export','local','return','in','select','until','echo','cd','source','set','unset','alias','exit','read','printf','test','exec'],
    sql: ['select','from','where','insert','into','values','update','set','delete','create','table','drop','alter','index','view','join','left','right','inner','outer','on','group','by','order','having','limit','as','and','or','not','null','distinct','count','sum','avg','min','max','primary','key','foreign','references','default','union','all','case','when','then','else','end'],
    yaml: ['true','false','null','yes','no','on','off'],
  };

  // 语言配置：lineComment 行注释符；block 是否支持 /* */；html 是否支持 <!-- -->
  const LANGS = {
    javascript: { kw: KW.javascript, line: '//', block: true },
    typescript: { kw: KW.typescript, line: '//', block: true },
    tsx:        { kw: KW.typescript, line: '//', block: true, jsx: true },
    jsx:        { kw: KW.javascript, line: '//', block: true, jsx: true },
    python:     { kw: KW.python, line: '#', block: false },
    c:          { kw: KW.c, line: '//', block: true },
    cpp:        { kw: KW.cpp, line: '//', block: true },
    java:       { kw: KW.java, line: '//', block: true },
    csharp:     { kw: KW.csharp, line: '//', block: true },
    go:         { kw: KW.go, line: '//', block: true },
    rust:       { kw: KW.rust, line: '//', block: true },
    json:       { kw: [], line: null, block: false },
    html:       { kw: [], line: null, block: false, html: true },
    xml:        { kw: [], line: null, block: false, html: true },
    css:        { kw: [], line: null, block: true },
    shell:      { kw: KW.shell, line: '#', block: false },
    bash:       { kw: KW.shell, line: '#', block: false },
    sql:        { kw: KW.sql, line: '--', block: true },
    yaml:       { kw: KW.yaml, line: '#', block: false },
    yml:        { kw: KW.yaml, line: '#', block: false },
    markdown:   { kw: [], line: null, block: false, markdown: true },
    text:       { kw: [], line: null, block: false },
  };

  const DEFAULT_CFG = { kw: [], line: null, block: false };

  // 文件扩展名 -> 语言键
  const EXT_MAP = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
    ts: 'typescript', tsx: 'tsx',
    py: 'python', pyw: 'python',
    c: 'c', h: 'c',
    cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
    java: 'java',
    cs: 'csharp',
    go: 'go',
    rs: 'rust',
    json: 'json',
    html: 'html', htm: 'html',
    xml: 'xml', svg: 'xml',
    css: 'css', scss: 'css', less: 'css',
    sh: 'shell', bash: 'bash', zsh: 'shell',
    sql: 'sql',
    yml: 'yaml', yaml: 'yaml',
    md: 'markdown', markdown: 'markdown',
    txt: 'text', log: 'text',
  };

  function langFromName(name) {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return 'text';
    const ext = name.slice(dot + 1).toLowerCase();
    return EXT_MAP[ext] || 'text';
  }

  function cfgFor(lang) {
    return LANGS[lang] || DEFAULT_CFG;
  }

  // ---- 主高亮函数 ---------------------------------------------------------
  function highlight(code, lang) {
    const cfg = cfgFor(lang);
    const kw = cfg.kw || [];
    const line = cfg.line;
    const block = cfg.block !== false;
    const html = !!cfg.html;
    const md = !!cfg.markdown;
    const n = code.length;
    let out = '';
    let i = 0;

    // 简易 Markdown 处理：标题 / 围栏代码块 / 行内代码
    if (md) return highlightMarkdown(code);

    while (i < n) {
      const c = code[i];

      // 空白（原样保留，保证排版）
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        let j = i;
        while (j < n && (code[j] === ' ' || code[j] === '\t' || code[j] === '\n' || code[j] === '\r')) j++;
        out += escapeHtml(code.slice(i, j));
        i = j;
        continue;
      }

      // HTML 注释
      if (html && c === '<' && code.substr(i, 4) === '<!--') {
        let j = code.indexOf('-->', i + 4);
        j = j < 0 ? n : j + 3;
        out += span('comment', code.slice(i, j));
        i = j;
        continue;
      }

      // 行注释
      if (line && code.substr(i, line.length) === line &&
          (lang !== 'python' || i === 0 || /[\s(\[]/.test(code[i - 1]))) {
        let j = code.indexOf('\n', i);
        if (j < 0) j = n;
        out += span('comment', code.slice(i, j));
        i = j;
        continue;
      }

      // 块注释
      if (block && c === '/' && code[i + 1] === '*') {
        let j = code.indexOf('*/', i + 2);
        j = j < 0 ? n : j + 2;
        out += span('comment', code.slice(i, j));
        i = j;
        continue;
      }

      // Python 三引号字符串
      if (lang === 'python' && (c === '"' || c === "'") && code.substr(i, 3) === c + c + c) {
        const q = c + c + c;
        let j = code.indexOf(q, i + 3);
        j = j < 0 ? n : j + 3;
        out += span('string', code.slice(i, j));
        i = j;
        continue;
      }

      // 字符串
      if (c === '"' || c === "'" || c === '`') {
        const q = c;
        let j = i + 1;
        let esc = false;
        while (j < n) {
          if (esc) { esc = false; j++; continue; }
          if (code[j] === '\\') { esc = true; j++; continue; }
          if (code[j] === q) { j++; break; }
          if (q !== '`' && code[j] === '\n') break; // 单行字符串未闭合
          j++;
        }
        out += span('string', code.slice(i, j));
        i = j;
        continue;
      }

      // 数字
      if ((c >= '0' && c <= '9') || (c === '.' && code[i + 1] >= '0' && code[i + 1] <= '9')) {
        let j = i;
        while (j < n && /[0-9a-fA-FxXoObB._]/.test(code[j])) j++;
        out += span('number', code.slice(i, j));
        i = j;
        continue;
      }

      // 标识符
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(code[j])) j++;
        const word = code.slice(i, j);
        let k = j;
        while (k < n && (code[k] === ' ' || code[k] === '\t')) k++;
        let cls = 'var';
        if (kw.indexOf(word) !== -1) cls = 'keyword';
        else if (code[k] === '(') cls = 'function';
        else if (/^[A-Z]/.test(word)) cls = 'type';
        out += span(cls, word);
        i = j;
        continue;
      }

      // 其它字符
      out += escapeHtml(c);
      i++;
    }
    return out;
  }

  // Markdown：标题、围栏代码、行内代码（轻量）
  function highlightMarkdown(code) {
    const lines = code.split('\n');
    let out = '';
    let inFence = false;
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      const fence = line.match(/^(\s*)(```|~~~)/);
      if (fence) {
        if (inFence) {
          out += span('comment', line) + '\n';
          inFence = false;
        } else {
          out += span('keyword', line) + '\n';
          inFence = true;
        }
        continue;
      }
      if (inFence) {
        out += escapeHtml(line) + '\n';
        continue;
      }
      // 标题
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        out += span('keyword', h[1]) + ' ' + span('type', h[2]) + '\n';
        continue;
      }
      // 行内代码 `code`
      let safe = escapeHtml(line);
      safe = safe.replace(/`([^`]+)`/g, function (m, g) {
        return '<span class="tok-string">' + g + '</span>';
      });
      // 加粗 **text**
      safe = safe.replace(/(\*\*|__)([^*_]+)\1/g, function (m, s, g) {
        return '<span class="tok-function">' + g + '</span>';
      });
      out += safe + '\n';
    }
    return out;
  }

  global.Highlighter = {
    highlight: highlight,
    langFromName: langFromName,
    escapeHtml: escapeHtml,
  };
})(typeof window !== 'undefined' ? window : this);
