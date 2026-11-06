/*
 * Whale Bridge —— 让本机的其他程序（脚本、AI 助手）通过 HTTP 操作这个 Obsidian 库。
 * 无构建：本文件就是 Obsidian 直接加载的 main.js。
 * 只监听 127.0.0.1，必须带 x-bridge-token 才能读写。
 */
const { Plugin, PluginSettingTab, Setting, Notice } = require('obsidian');
const http = require('http');
const crypto = require('crypto');

const DEFAULTS = { port: 9787, token: '' };

function randomToken() {
  return crypto.randomBytes(16).toString('hex');
}

module.exports = class WhaleBridge extends Plugin {
  async onload() {
    // 用 Obsidian 自己的 loadData/saveData 读写 data.json，不自己拼路径（manifest.dir 可能是 undefined）
    let saved = null;
    try { saved = await this.loadData(); } catch (e) { saved = null; }
    this.cfg = Object.assign({}, DEFAULTS, saved || {});

    if (!this.cfg.token) {
      this.cfg.token = randomToken();
      await this.saveCfg();
      new Notice('Whale Bridge 已生成本机访问 token，见 设置 → 第三方插件 → Whale Bridge');
    }

    this.startServer();
    this.addSettingTab(new WhaleBridgeSettingsTab(this.app, this));
  }

  async saveCfg() {
    try {
      await this.saveData(this.cfg);
    } catch (e) { console.error('[whale-bridge] 写配置失败', e); }
  }

  stopServer() {
    const s = this.server;
    this.server = null;
    if (!s) return;
    try { if (typeof s.closeAllConnections === 'function') s.closeAllConnections(); } catch (e) { /* ignore */ }
    try { s.close(); } catch (e) { /* ignore */ }
  }

  async restartServer() {
    this.stopServer();
    await new Promise((r) => setTimeout(r, 50));
    this.startServer();
  }

  startServer() {
    const app = this.app;
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
    const token = this.cfg.token;
    const port = Number(this.cfg.port) || 9787;

    const server = http.createServer(async (req, res) => {
      let u;
      try { u = new URL(req.url, 'http://127.0.0.1'); } catch (e) { return json(res, 400, { ok: false, error: 'bad url' }); }
      const q = u.searchParams;
      try {
        // 浏览器发起的请求一定带 Origin；一律拒绝，防止网页借道本机端口。
        if (req.headers.origin || req.headers.referer) {
          return json(res, 403, { ok: false, error: 'browser-origin-blocked' });
        }
        if (u.pathname === '/ping') {
          return json(res, 200, { ok: true, vault: app.vault.getName(), port: port, version: this.manifest.version });
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

    server.on('error', (e) => {
      console.error('[whale-bridge]', e);
      new Notice('Whale Bridge 启动失败：端口 ' + port + ' 可能被占用');
    });
    server.listen(port, '127.0.0.1', () => {
      console.log('[whale-bridge] listening on http://127.0.0.1:' + port);
    });
    this.server = server;
  }

  onunload() {
    this.stopServer();
  }
};

class WhaleBridgeSettingsTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();

    new Setting(containerEl).setName('端口').setDesc('本地监听端口，改完立即重启服务').addText((t) =>
      t.setValue(String(plugin.cfg.port)).onChange(async (v) => {
        const n = parseInt(v, 10);
        if (n > 0 && n < 65536) {
          plugin.cfg.port = n;
          plugin.saveCfg();
          await plugin.restartServer();
        }
      })
    );

    new Setting(containerEl)
      .setName('Token')
      .setDesc('其他程序访问时要在请求头带 x-bridge-token: 这个值')
      .addText((t) => {
        t.setValue(plugin.cfg.token);
        t.inputEl.style.width = '320px';
        t.onChange((v) => {
          const val = v.trim();
          if (val) {
            plugin.cfg.token = val;
            plugin.saveCfg();
          }
        });
      })
      .addButton((b) =>
        b.setButtonText('重新生成').onClick(async () => {
          plugin.cfg.token = randomToken();
          plugin.saveCfg();
          this.display();
          new Notice('已重新生成 token，记得更新调用方');
        })
      )
      .addButton((b) =>
        b.setButtonText('复制').onClick(async () => {
          try {
            await navigator.clipboard.writeText(plugin.cfg.token);
            new Notice('token 已复制');
          } catch (e) {
            new Notice('复制失败，请手动选中');
          }
        })
      );

    containerEl.createEl('p', {
      text: '只监听 127.0.0.1，浏览器发起的请求会被拒绝。',
      attr: { style: 'opacity:.7;font-size:12px' },
    });
  }
}
