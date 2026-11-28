# 新建会话里没有 Codex 模式

先在**你用来启动 DSH Web 的终端**运行下面两条命令。如果原来用自定义 `DSH_HOME`，检查时沿用同一个目录。

```sh
dsh --version
dsh plugin --profile web list --depth 0
```

- **版本不是 `0.2.2-rc.5`**：这是当前插件声明并验证的 DSH 版本。用匹配的 DSH 可执行文件来安装和启动，不要拿另一个终端或电脑上安装的版本当作当前服务的版本。
- **列表没有 `dsh-codex-app-server`**：检查是否装进了 `desktop` 或另一个 DSH 目录。按[源码安装说明](../README.md#安装源码版)把本仓库打出的 tarball 装进当前 Web profile，再重启这个 Web 进程。
- **列表有插件，但仍然没有入口**：从这次 `dsh web` 启动的地址打开页面，在**新建会话**的模式菜单里找 **Codex**。插件不改已有会话的模式。如果新会话仍没有，检查启动终端的插件激活报错；如果终端报 `EADDRINUSE`，这次新进程没有启动，原页面可能还在连接旧进程。先识别占用端口的服务，不要盲目终止进程。

**能选 Codex，但第一条消息失败？** 这和模式是否出现是两个阶段。在同一终端运行 `command -v codex` 和 `codex --version`，确认 DSH 能从继承的 `PATH` 找到 Codex CLI。没有登录时使用 `codex login`；不用在 DSH 侧添加 OpenAI 模型，也不用复制任何凭据。

排查时可记录 DSH 版本、profile、插件列表及精简后的报错，不要贴带登录令牌的 Web 启动地址、认证文件或完整会话日志。
