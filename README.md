# dsh-file-explorer

> 🏠 GitHub：<https://github.com/ice5kysl/dsh-file-explorer> ｜ 📦 MIT License ｜ 目标 dsh：`@deepseek-ai/dsh` ≥ 0.1.1-rc.2

按官方规范编写的 **dsh（DeepSeek Harness）插件**（bundle 形态），解决一个痛点：

> 工作区里放了很多文件，每次想看一眼目录结构或某个文件内容，都要切到 Finder / 资源管理器——很麻烦。

本插件让你**直接在会话里浏览工作区目录并预览文件**，不必离开 dsh Web：

- **会话第三个 tab「文件」**（对话 | 轨迹 | 文件）：注册进官方 `conversation.view`
  视图环，排在 chat（order 0）与 trajectory（order 10）之后（order 20），tab 条自动出现；
- 以**当前会话的工作区目录**为根打开；目录面包屑 + 目录/文件列表（目录优先、
  大小/时间、隐藏点文件开关）、快速跳转到其它工作区 / 主目录 / 任意绝对路径；
- 打开期间自动刷新（agent 在后台写文件也能看到）；**切走再切回按会话记忆上次目录**；
- 右侧预览：**Markdown 默认渲染**（`预览` / `Raw` 一键切换；渲染前经 marked 解析 +
  DOMPurify 消毒，防仓库内恶意 md 的 XSS）、**图片内联显示**、其他**文本带行号**
  （超长截断并提示）、PDF 内嵌、二进制文件提供「复制路径 / 在 Finder 中打开」
  （走官方 `ctx.workspaces.openPath`）；
- 目录/文件数据全部走宿主侧 `/dsh-files` **只读**接口，插件不修改任何文件。

## 为什么需要宿主侧路由（设计说明，均依据官方文档/源码）

官方浏览器契约里**只有目录级浏览**（`ctx.workspaces.listDirectory` → `host.listDirectory`，
`DirectoryListing.entries` 只含目录行），**没有文件行，也没有任何读取文件内容的 RPC**；
`dsh-workspace-kit` 里核查过的「client 只能消费构建期生成的 `ctx.remote.*`」结论同样成立。
因此要预览任意工作区文件，只能走官方 **`ctx.webServer.register`** 路由接缝（
`dsh-host-webserver`：`WebRoute { kind, path, handler }`，named prefix 优先于 fallback）：

| 端点（GET） | 说明 |
|---|---|
| `/dsh-files/home` | 宿主账户主目录 |
| `/dsh-files/list?path=<abs>` | 单层目录：文件+目录行（kind/size/mtimeMs/hidden）+ 面包屑，镜像官方 `DirectoryListing` 语义（缺 path = 主目录） |
| `/dsh-files/text?path=&maxBytes=` | 文本预览头（utf-8 解码、NUL 嗅探判二进制、截断标记；服务端 300 KB 上限） |
| `/dsh-files/raw?path=` | 原字节流（按扩展名猜 Content-Type，供 `<img>`/PDF 内嵌） |

- 只读、无写端点；客户端**从不自行拼接路径**（所有 path 都来自服务端响应或框架
  提供的工作区/会话路径）。
- 每个请求过一道 host-trust 闸门，镜像官方 `/api` 信任围栏的姿势：
  loopback Host 直通；非 loopback 需要同源 Origin 标记。**不是认证层**——与官方
  web server 一致（默认绑 127.0.0.1；部署时保持 loopback 绑定）。
- 路由在插件 `apply` 里经 `ctx.effect(() => ctx.webServer.register(...))` 注册，随插件
  fiber 卸载自动释放。

## 快速安装（本机个人 dsh）

前置：`dsh` 在 PATH（`@deepseek-ai/dsh` ≥ 0.1.1-rc.2），Node 20+。

```bash
# 0. 获取源码（或直接使用本地目录）
git clone https://github.com/ice5kysl/dsh-file-explorer && cd dsh-file-explorer
#    monorepo 布局则在 plugins/dsh-file-explorer 目录下执行

# 1. 构建（产出 lib/index.js + lib/client.js；npm install 的 prepare 钩子会自动构建）
npm install                # 安装构建期依赖（typescript/esbuild/@types/marked/dompurify 等）
npm run build

# 2. 安装进你的 web profile（等价于官方 dsh plugin add 组合包）
bash scripts/install-personal.sh   # 脚本自定位插件目录，独立仓库 / plugins 布局均可
#    脚本实际执行：dsh plugin --profile web add <本插件目录>
#    它会把这个包加入 ~/.dsh/profiles/web 的 dsh.profile.bundles（追加在
#    dsh-web-app 之后），包内 cordis.patch.yml 自动插入唯一 Loader 行。

# 3. 验证组合（无需重启）
dsh --profile web --dump-config | grep -n "file-explorer"

# 4. 重启 GUI 生效
#    退出当前 dsh web（Ctrl+C 或 kill 进程）后重新运行 dsh web；
#    浏览器刷新 http://127.0.0.1:3080
```

生效后：

- 打开任意会话，标题栏出现 **对话 | 轨迹 | 文件** 三个 tab；点「文件」即在正文区
  浏览该会话工作区目录（目录行单击进入、文件行单击预览，↑↓/↵/⌫ 键盘可用）。
- 顶部可跳到其它工作区 / 主目录，或直接输入绝对路径；预览面板可「复制路径 /
  在 Finder 中打开」。
- 切到别的会话再回来，「文件」tab 会记住该会话上次浏览的目录（仅内存，不跨刷新）。

> 与 dsh-workspace-kit 兼容：本插件只占用 `conversation.view` 的加法槽位（tab），
> 不做任何替换式 shadow，两个插件可同时启用。

## 打包 / 分发（可选）

```bash
npm pack          # 产出 dsh-file-explorer-0.3.1.tgz（含预构建 lib/，prepack 自动 build）
# 其他机器：dsh plugin --profile web add ./dsh-file-explorer-0.3.1.tgz
```

## 开发

```bash
npm run typecheck   # tsc --noEmit（宿主 + 浏览器两侧源码）
npm run build       # esbuild：src/host → lib/index.js；src/client → lib/client.js
node scripts/smoke.mjs   # 宿主 /dsh-files 端点独立冒烟测试
```

源码布局：

```
src/host/    宿主侧：fs-server.ts（纯目录扫描/文本读取函数）、index.ts（apply：
             ctx.effect 注册 /dsh-files 前缀路由 + host-trust 闸门）
src/client/  浏览器侧：FilesView.tsx（conversation.view tab 的文件浏览器）、
             browse-memory.ts（按会话记忆上次目录）、files-api.ts（/dsh-files
             fetch 客户端 + 类型）、actions.ts（openPath 绑定）、
             index.ts（apply：conversation.view 注册）
cordis.patch.yml   bundle 层：插入唯一 Loader 入口 dsh-file-explorer
```

## 兼容性 / 已知边界

- 目标 dsh：`@deepseek-ai/dsh` v0.1.1-rc.2（`dsh web`，profile `web`）。浏览器 face
  面向该版本的 `conversation.view` 视图环契约（tab 由 entries 自动列出、body 按
  `only: <active id>` 只渲染当前视图）与 `ctx.workspaces.openPath`；上游契约变更时需随版本校验。
- 「文件」tab 只出现在**会话内**（无会话的 hero 状态没有 tab）；这是会话级视图的固有边界。
- 样式为内联样式（浅色），未跟随系统主题——与 dsh-workspace-kit v1 相同的取舍。
- 安全边界：接口只读；`/dsh-files` 的信任姿势与官方一致（非认证层）。若部署在容器/
  代理后且 host 头不是 loopback，请保持 dsh web 服务 loopback 绑定或扩展
  `src/host/index.ts` 的 `trusted()` 白名单。
- LoopDSH 平台每用户实例的接入方式与 dsh-workspace-kit 相同：参考 LoopDSH 仓库内
  `docs/plugins/loopdsh-integration.md` 的「方案 A：harness 启动时幂等预置」。
