/*
 * Whale Bridge —— 让外部程序（DSH/鲸鲸）通过本机 HTTP 完全操作 Obsidian。
 * 无需构建：本文件即 Obsidian 直接加载的 main.js。
 */
const { Plugin } = require('obsidian');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DEFAULTS = { port: 9787, token: 'whale-7f3a9c-4b21' };

module.exports = class WhaleBridge extends Plugin {
  async onload() {
    let cfg = Object.assign({}, DEFAULTS);
    try {
      const p = path.join(this.manifest.dir || '', 'data.json');
      cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(p, 'utf8')));
    } catch (e) { /* 用默认配置 */ }

    const app = this.app;
    const token = cfg.token;
    const json = (res, code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    const readBody = (req) => new Promise((ok, bad) => {
      const b = [];
      req.on('data', (c) => b.push(c));
      req.on('end', () => ok(Buffer.concat(b).toString('utf8')));
      req.on('error', bad);
    });

    const server = http.createServer(async (req, res) => {
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return json(res, 400, { ok: false, error: 'bad url' }); }
      const q = u.searchParams;
      try {
        if (u.pathname === '/ping') {
          return json(res, 200, { ok: true, vault: app.vault.getName(), port: cfg.port, version: this.manifest.version });
        }
        if (req.headers['x-bridge-token'] !== token) {
          return json(res, 401, { ok: false, error: 'bad token' });
        }

        // 列出笔记路径
        if (u.pathname === '/files') {
          const prefix = (q.get('prefix') || '').toLowerCase();
          let files = app.vault.getMarkdownFiles().map((f) => f.path);
          if (prefix) files = files.filter((f) => f.toLowerCase().includes(prefix));
          return json(res, 200, { ok: true, count: files.length, files });
        }

        // 读笔记
        if (u.pathname === '/file' && req.method === 'GET') {
          const p = q.get('path') || '';
          const f = app.vault.getAbstractFileByPath(p);
          if (!f) return json(res, 404, { ok: false, error: 'not found: ' + p });
          const content = await app.vault.read(f);
          return json(res, 200, { ok: true, path: p, content });
        }

        // 写笔记（存在则改，不存在则建）
        if (u.pathname === '/file' && req.method === 'PUT') {
          const p = q.get('path') || '';
          const content = await readBody(req);
          const existing = app.vault.getAbstractFileByPath(p);
          if (existing) {
            await app.vault.modify(existing, content);
          } else {
            const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
            if (dir && !app.vault.getAbstractFileByPath(dir)) await app.vault.createFolder(dir).catch(() => {});
            await app.vault.create(p, content);
          }
          return json(res, 200, { ok: true, path: p, written: content.length });
        }

        // 当前打开的笔记
        if (u.pathname === '/active') {
          const f = app.workspace.getActiveFile();
          if (!f) return json(res, 200, { ok: true, path: null });
          const content = await app.vault.read(f);
          return json(res, 200, { ok: true, path: f.path, content });
        }

        // 打开笔记
        if (u.pathname === '/open' && req.method === 'POST') {
          const b = JSON.parse((await readBody(req)) || '{}');
          const f = app.vault.getAbstractFileByPath(b.path || '');
          if (!f) return json(res, 404, { ok: false, error: 'not found: ' + b.path });
          await app.workspace.getLeaf(b.leaf === false ? false : true).openFile(f);
          return json(res, 200, { ok: true, opened: b.path });
        }

        // 执行任意 Obsidian 命令
        if (u.pathname === '/command' && req.method === 'POST') {
          const b = JSON.parse((await readBody(req)) || '{}');
          const ok = app.commands.executeCommandById(b.id || '');
          return json(res, 200, { ok: !!ok, id: b.id });
        }

        // 所有可用命令 id
        if (u.pathname === '/commands') {
          const ids = Object.keys(app.commands.commands || {});
          return json(res, 200, { ok: true, count: ids.length, ids });
        }

        // 全库搜索
        if (u.pathname === '/search') {
          const kw = (q.get('q') || '').toLowerCase();
          const hits = [];
          for (const f of app.vault.getMarkdownFiles()) {
            const c = await app.vault.cachedRead(f);
            if (c.toLowerCase().includes(kw)) {
              const i = c.toLowerCase().indexOf(kw);
              hits.push({ path: f.path, snippet: c.slice(Math.max(0, i - 60), i + 120).replace(/\n/g, ' ') });
              if (hits.length >= 50) break;
            }
          }
          return json(res, 200, { ok: true, count: hits.length, hits });
        }

        // 逃生舱：在 Obsidian 内部执行任意 JS，能拿到 app / plugin
        if (u.pathname === '/eval' && req.method === 'POST') {
          const b = JSON.parse((await readBody(req)) || '{}');
          const fn = new Function('app', 'plugin', 'return (async () => {\n' + (b.code || '') + '\n})()');
          const value = await fn(app, this);
          return json(res, 200, { ok: true, value });
        }

        return json(res, 404, { ok: false, error: 'no route: ' + u.pathname });
      } catch (e) {
        return json(res, 500, { ok: false, error: String((e && e.stack) || e) });
      }
    });

    server.on('error', (e) => { console.error('[whale-bridge]', e); });
    server.listen(cfg.port, '127.0.0.1', () => {
      console.log('[whale-bridge] listening on http://127.0.0.1:' + cfg.port);
    });
    this.server = server;
  }

  onunload() {
    try { if (this.server) this.server.close(); } catch (e) { /* ignore */ }
  }
};
