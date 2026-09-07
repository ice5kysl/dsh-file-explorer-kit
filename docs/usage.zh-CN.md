# 用法、路由契约与安全边界（dsh-file-explorer-kit）

> English version: [usage.md](./usage.md)。

本页汇总 README 中概述的运行细节：插件在 dsh Web 内的工作方式、`/dsh-files` 的
完整 HTTP 契约，以及宿主侧强制执行的权限 / 安全边界。

## 工作原理

插件是标准 Cordis **bundle**，分两侧：

- **宿主侧**（`src/host/index.ts`）：在 `apply` 里经
  `ctx.effect(() => ctx.webServer.register(...))` 注册 `/dsh-files` 前缀路由，
  随插件 fiber 卸载自动释放。目录扫描与文本读取全部在纯函数
  （`src/host/fs-server.ts`）中完成。
- **浏览器侧**（`src/client/index.ts`）：向官方 `conversation.view` 视图环注册
  会话第三个 tab「文件」（对话 | 轨迹 | 文件），order 20（chat 为 0、
  trajectory 为 10）。tab 以**当前会话的工作区目录**为根，只通过只读的
  `/dsh-files` 端点与宿主侧通信。

为什么需要宿主侧路由：官方浏览器契约里**只有目录级浏览**
（`ctx.workspaces.listDirectory` → `host.listDirectory`，
`DirectoryListing.entries` 只含目录行）——没有文件行，也没有任何读取文件内容
的 RPC。因此要预览任意工作区文件，只能走官方 `ctx.webServer.register` 路由接缝
（`dsh-host-webserver`：`WebRoute { kind, path, handler }`，named prefix 优先于
fallback）。

## 路由契约（`/dsh-files`，全部 GET）

| 端点 | 说明 |
|---|---|
| `/dsh-files/home` | 宿主账户主目录 |
| `/dsh-files/list?path=<abs>` | 单层目录：文件+目录行（`kind`/`size`/`mtimeMs`/`hidden`）+ 面包屑，镜像官方 `DirectoryListing` 语义（缺 `path` = 主目录） |
| `/dsh-files/text?path=&maxBytes=` | 文本预览头（utf-8 解码、NUL 嗅探判二进制、截断标记；服务端 300 KB 上限） |
| `/dsh-files/raw?path=` | 原字节流（按扩展名猜 Content-Type，供 `<img>`/PDF 内嵌） |

错误形态：失败返回 JSON `{ ok: false, error: { code, ... } }`——`ENOENT`
（文件不存在）、`ENOTDIR`（把目录传给文件端点）、`invalid-path`（相对路径，
HTTP 400 拒绝）。

客户端**从不自行拼接路径**：发送的每个 `path` 都来自服务端响应（列表行、面包屑、
主目录）或框架提供的工作区/会话路径。

## 权限与安全边界

- **只读设计**：没有任何写端点；插件不修改、不移动、不删除任何文件。
- **host-trust 闸门**：每个请求过一道镜像官方 `/api` 信任围栏的闸门——loopback
  `Host` 头直通；非 loopback 需要同源 `Origin` 标记。**这不是认证层**——与官方
  web server 一致（默认绑 127.0.0.1）。部署时保持 loopback 绑定；若运行在容器/
  代理后导致 `Host` 头不是 loopback，请扩展 `src/host/index.ts` 的 `trusted()`
  白名单。
- **预览 XSS 加固**：Markdown 渲染前经 marked 解析 + DOMPurify 消毒（仓库内的
  恶意 `.md` 不能向 dsh GUI 注入脚本）；预览内链接一律新标签打开。

## 开发

```bash
npm run typecheck   # tsc --noEmit（宿主 + 浏览器两侧源码）
npm run build       # esbuild：src/host → lib/index.js；src/client → lib/client.js
npm test            # 宿主 /dsh-files 端点独立冒烟测试
```

冒烟测试（`tests/smoke.test.mjs`）启动一个模拟 `ctx.webServer` 路由契约的微型
`node:http` 服务器——无需 Cordis 运行时——端到端覆盖路由注册、列表/面包屑语义、
文本预览、错误码、相对路径拒绝、raw 字节流以及 host-trust 闸门。
