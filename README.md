# Whale Bridge

在 Obsidian 里开一个只在本机跑的 HTTP 小服务，让别的程序（自己的脚本、AI 助手）能读、写、搜这个库。

只监听 `127.0.0.1`，每个请求都要带 token；浏览器发起的请求直接拒绝。

## 安装

**从社区市场装（已上架后）**
设置 → 第三方插件 → 关闭「安全模式」→ 浏览 → 搜 Whale Bridge → 安装并启用。

**手动装**
1. 下载本仓库最新 Release 里的 `main.js`、`manifest.json`。
2. 放进 `<你的库>/.obsidian/plugins/whale-obsidian-bridge/`。
3. Obsidian 里 设置 → 第三方插件 → 重新加载插件 → 启用 Whale Bridge。

## 拿到 token

设置 → 第三方插件 → Whale Bridge，能看到端口（默认 9787）和 token。
首次启用会自动生成，点「复制」按钮即可。token 换掉后，所有调用方都要同步更新。

## 怎么调

```bash
# 探活（不需要 token）
curl http://127.0.0.1:9787/ping

# 读一页
curl -H "x-bridge-token: 你的token" "http://127.0.0.1:9787/file?path=目录/笔记.md"

# 写一页（不存在则新建，自动建目录）
curl -X PUT -H "x-bridge-token: 你的token" \
  --data-binary @内容.md "http://127.0.0.1:9787/file?path=目录/笔记.md"

# 全库搜索
curl -H "x-bridge-token: 你的token" "http://127.0.0.1:9787/search?q=关键词"

# 打开某页
curl -X POST -H "x-bridge-token: 你的token" \
  -d '{"path":"目录/笔记.md"}' http://127.0.0.1:9787/open
```

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/ping` | GET | 探活，返回库名与版本，不需要 token |
| `/files?prefix=` | GET | 列出所有 md 路径 |
| `/file?path=` | GET / PUT | 读 / 写一页 |
| `/active` | GET | 当前打开的页 |
| `/open` | POST | `{"path": "..."}` 打开一页 |
| `/search?q=` | GET | 全库搜索，最多 50 条 |
| `/commands` | GET | 所有命令 id |
| `/command` | POST | `{"id": "..."}` 执行命令 |
| `/eval` | POST | `{"code": "..."}` 在 Obsidian 内执行 JS（危险，仅自用） |

## 安全说明

- 只绑定 `127.0.0.1`，局域网和互联网访问不到。
- 所有数据都留在本机，插件不联网、不上传任何内容。
- `/eval` 能执行任意 JS，等于把 Obsidian 的完全控制权交给拿到 token 的程序。token 别外泄。

## 许可

MIT
