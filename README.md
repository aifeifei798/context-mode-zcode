# context-mode for ZCode

把 [context-mode](https://github.com/mksglu/context-mode) 接进 ZCode 的最小方案：**一个 systemd --user 服务常驻 MCP，ZCode 通过 Streamable HTTP 连它**。

## 为什么不直接用 `context-mode-opencode-v2`

那个仓库是 **OpenCode v2 专用**包装层（`Plugin.define`、`ctx.tool.transform`、`tool.execute.before/after`）。ZCode 是另一套运行时，没有这些 API，放进去不会加载。

但上游 context-mode 本身是个标准 MCP server（stdio），所以只要在中间放一个 stdio → HTTP 的桥，就能变成"自己启动的服务"，多个 harness 共用同一个实例。

```
ZCode  ──HTTP(JSON-RPC / streamable)──▶  supergateway :8765
                                            │ stdio
                                            ▼
                                  context-mode MCP (cli.bundle.mjs)
                                            │
                                            ▼
                                  ~/.local/share/context-mode-mcp  (FTS5 知识库)
```

## 安好了怎么用

```bash
systemctl --user status context-mode-mcp     # 看状态
journalctl --user -u context-mode-mcp -f     # 看日志
systemctl --user restart context-mode-mcp    # 重启
node install.mjs --uninstall                 # 卸载（知识库保留）
```

自启已开（`enable`），开机后自动跑，不需要打开 ZCode。

## ZCode 侧

`~/.zcode/cli/config.json`：

```json
{
  "mcp": {
    "servers": {
      "context-mode": {
        "type": "http",
        "url": "http://127.0.0.1:8765/mcp"
      }
    }
  }
}
```

改完**新建 session**。ZCode 会在「设置 → MCP 服务器」里显示这个服务，工具名是 `ctx_execute`、`ctx_search` 等 11 个。

## 安装 / 重装

```bash
npm i -g supergateway          # 桥（一次）
node install.mjs               # 写 unit + enable + 启动 + 自检

# 可选参数
node install.mjs --port 8765 --workdir ~/develop/app --cli /path/to/cli.bundle.mjs
node install.mjs --dry-run     # 只打印会写的 unit
```

`install.mjs` 幂等：重跑只会覆盖 unit 并重启服务。它用 `process.execPath` 和 `command -v supergateway` 解析绝对路径，systemd 不需要知道 nvm。

## 自检

```bash
ss -ltnp | grep 8765                                  # 端口在听
node -e 'console.log(await (await fetch("http"+"://127.0.0.1:8765/healthz")).text())'   # ok
```

MCP 握手（返回 `serverInfo.name = context-mode`）：见 `install.mjs` 末尾逻辑，或直接让 ZCode 连上后问它「列出 ctx 工具」。

## 三个语义差异（重要）

1. **项目身份是固定的**。stdio 模式下 context-mode 用启动时的 cwd 当项目身份；做成常驻服务后就只有一个身份。unit 里用 `CONTEXT_MODE_PROJECT_DIR` 指定（默认 `~/develop/app`），`CONTEXT_MODE_DIR` 指定知识库根。想按项目分开，就复制一份 unit 改这两个变量 + 端口。
2. **知识库跨项目共享**。同一个服务的 `ctx_search` 会搜到所有索引过的内容。个人机器通常正好想要这个；团队/多租户场景请按项目各起一个实例。
3. **没有 hooks**。MCP-only 意味着没有 PreToolUse 强制改写（curl / 大文件 Read 不会被拦），只是把 11 个工具摆在那里，用不用靠模型自觉。要完整拦截就走下面的插件路线。

## 方案 B：整套插件（实验性，含 hooks）

`marketplace.json` 把本机 context-mode 包目录登记成一个本地插件市场（它的 `.claude-plugin/plugin.json` 里有 MCP 声明，`hooks/hooks.json` 里有 Claude 格式的 hooks，ZCode 兼容这两者）。

ZCode 里：**设置 → 插件 → 创建 → 添加插件市场**，填 `/home/feifei/develop/app/opencode/context-mode-zcode`，然后在「个人」分段安装并启用，**新建 session**。

风险：上游 hooks 的 matcher 写的是 Claude 工具名（`Bash|Read|Write|Edit|WebFetch|Grep|Skill|...`），与 ZCode 工具名的对应关系没有逐条验证。某个 hook 不触发就看 `~/.zcode/cli/log/zcode-<日期>.jsonl` 里的 `hook.run.failed`。出问题停用插件，方案 A 不受影响。

## 方案 C：每次会话 stdio（兜底）

不想常驻服务时，把 ZCode 配置改回 stdio，由 ZCode 自己拉起进程：

```json
{
  "mcp": {
    "servers": {
      "context-mode": {
        "command": "node",
        "args": ["/home/feifei/develop/app/opencode/context-mode-opencode-v2/node_modules/context-mode/cli.bundle.mjs"],
        "env": {}
      }
    }
  }
}
```

代价：每个会话一个进程、各建各的索引；好处：项目身份跟随会话的工作区，语义最"正确"。

## 注意

- 上游 context-mode 的许可是 **Elastic-2.0**（源码可见，非 OSI 开源），商用前自己确认条款。
- `install.mjs` 只写 `~/.config/systemd/user/context-mode-mcp.service`、建 `~/.local/share/context-mode-mcp`、动 systemd 用户单元；不碰 ZCode 配置文件，ZCode 那一步要自己粘上面那段 JSON。
- 包本体不在本仓库；如果 `context-mode-opencode-v2` 被删或重装，`--cli` 路径会失效，重跑 `install.mjs --cli <新路径>` 即可，或 `npm i -g context-mode` 后用全局路径。

## 文件

```
install.mjs                              写 unit / 启停 / 自检（Node，无依赖）
systemd/context-mode-mcp.service.template  unit 模板（占位符替换）
marketplace.json                          方案 B 的本地插件市场
```
