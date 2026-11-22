# DSH Codex App Server

给 DeepSeek Harness 增加一个 **Codex** 会话模式，与 Standard、Creator、PTC、Minimal 并存。不改默认模式，不替换 DSH 前端。

选中 **Codex** 后，DSH 仍负责原生会话界面、输入队列、消息展示和本地记录；**Codex app-server 负责实际执行**：模型、上下文、工具、MCP、指令和历史都由 Codex 管理。插件不会把 Codex 当成一个补全文本 API 后再让 DSH 执行它的工具，也不会把 DSH 的系统提示词和旧对话重放给 Codex。

## 安装（源码版）

需要 Node.js ≥24.9、**DSH 0.2.2-rc.5**，以及可从 DSH 进程的 `PATH` 找到的官方 Codex CLI。已登录的 Codex CLI 会使用自己的账号和配置；未登录请先运行 `codex login`。插件不会读取或复制 Codex 的登录文件。

```sh
git clone https://github.com/MMMarcinho/dsh-codex-app-server.git
cd dsh-codex-app-server
npm test
npm pack
dsh plugin --profile web add "$(pwd)/dsh-codex-app-server-0.1.0.tgz"
dsh web
```

如果已有 DSH Web 在运行，先在你的终端停止它，再由你运行 `dsh web`。插件装在指定 profile：桌面版用 `--profile desktop`，然后重启应用。新建会话，在模式选择里点 **Codex**，再发送第一条消息；已开始的会话不能换模式。Codex 的实际模型沿用自身配置，DSH 界面显示 `Codex default`。不需要 DSH 侧额外配置 OpenAI 模型。

卸载：`dsh plugin --profile web remove dsh-codex-app-server`（Desktop 换成 `desktop`）。卸载不会删除 Codex 历史。

### 在独立 Web profile 试用

如果只想验证插件，不必停止正在运行的 DSH，也不必改默认 profile。先在源码目录运行上面的 `npm test` 和 `npm pack`，然后用本地生成的 tarball（不要安装 npm 上的同名包）：

```sh
(
  set -e
  export DSH_HOME="$HOME/.dsh-codex-rc5-preview"
  npx --yes --package=@deepseek-ai/dsh@0.2.2-rc.5 --package=pnpm@11.28.5 \
    dsh plugin --profile web add "$PWD/dsh-codex-app-server-0.1.0.tgz"
  npx --yes --package=@deepseek-ai/dsh@0.2.2-rc.5 \
    dsh web --host 127.0.0.1 --port 3081 --no-open
)
```

如果 3081 已被占用，换一个空闲端口即可。用浏览器打开本次启动时终端打印的完整链接（含 `?token=…`）；没有该服务会话 Cookie 的浏览器直接打开裸地址会收到 401，不代表插件没加载。不要分享含 token 的链接。新建会话并确认能选择 **Codex**，不用发送消息。用当前终端的 Ctrl+C 停止预览。

## 目前支持

| 能力 | 当前行为 |
| --- | --- |
| 新会话、连续聊天 | 一个 DSH 会话对应一个持久化 Codex 线程。重启后从原线程恢复，不把旧消息再发送一遍。绑定不匹配或恢复失败时不另开线程。 |
| 流式展示 | 助手文本、Codex 公开推理摘要和简要工具进度映射到 DSH 原生聊天流。实际工具运行仍归 Codex，尚不展示逐条原生工具卡片、diff 或子线程详情。 |
| 输入 | 支持文本和图片。通用文件请放在当前工作区内并在提示词里引用路径。 |
| 停止与排队 | 停止使用 `turn/interrupt`；不把 RPC 确认当作已停止。运行中排队的输入后续交给 Codex；DSH 的「插话」目前不会注入正在运行的 Codex turn。 |
| 审批与问答 | 可明确展示的命令审批、匹配到具体文件变更的单次审批、普通阻塞式问答走 DSH 的交互控件。未知请求、凭据问答、权限扩张、无法核对的变更默认拒绝，不接受持久授权。 |
| 不支持 | DSH 分叉、自动重放失败轮次、跨主机工作区、任意远端 Codex URL。 |

插件面向你信任的**本地 DSH 服务**。启动 Codex 子进程时使用会话工作目录，向 thread/start 和 thread/resume 显式传入 `workspace-write`、`on-request`，由用户审批，不启用自动审批。Codex 使用当前系统用户的本地配置。不要把该 profile 暴露给不信任的远程用户。

## 验证

```sh
npm test
npm pack --dry-run
DSH_CLI=/path/to/dsh npm run test:host
```

单测不需要模型账号，覆盖 stdio RPC、会话绑定和恢复、消息与权限桥接、取消以及请求乱序。真实 DSH 宿主 smoke test 使用隔离目录和模拟 Codex 子进程，不读个人账户；验证原生界面背后的会话接口、聊天记录和重启续聊。协议与设计细节见 [protocol-notes](docs/protocol-notes.md)。

**兼容基线**：[DeepSeek Harness rc.5](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.5) · [Codex app-server 协议](https://developers.openai.com/codex/app-server)
