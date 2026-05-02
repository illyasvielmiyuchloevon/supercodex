# SuperCodex 中文说明

SuperCodex 是一个 TypeScript/Node.js 编写的 Codex CLI 外部监督器。它通过正式的 `codex app-server --listen stdio://` JSON-RPC 接口控制 Codex 的 thread/turn 生命周期，把项目运行状态保存到 `.supercodex/`，并提供 OpenTUI/Solid 终端界面，用于长时间、可恢复、可干预的软件开发流程。

当前版本：`0.1.0`（0.1 版本）。

当前 0.1 版本的正式运行架构只有 `codex app-server`。旧的一次性 runner 和手写 raw-mode TUI 只保留为兼容/降级路径，不再是正式主路径。

## 核心能力

- 启动并控制 `codex app-server`，执行 `initialize`、`thread/start` 或 `thread/resume`、`turn/start`。
- 在 `.supercodex/` 下保存项目状态、run 状态、session、runtime、日志、交互请求和 checkpoint。
- 使用 OpenTUI/Solid 全屏 TUI，包含精简 transcript、状态侧栏、slash command、统一选择面板、toast 和 textarea 输入框。
- 从 SuperCodex app-server 日志和匹配当前项目的 Codex 原生 session JSONL 重建可见历史。
- 主界面不再铺满原始命令输出、文件读取输出或大型 tool output；这些内容会压缩显示，完整内容保留在日志里。
- Codex 发出的审批、权限、用户输入和 MCP elicitation 请求可直接在 TUI 中处理。
- 支持按 run 隔离模型、思考强度、权限、auth、pause/resume 和 fresh-thread 设置。
- 默认 Codex 权限是 `danger-full-access` + `approvalPolicy=never`。

## 环境要求

- Node.js 20 或更新版本。
- Bun，用于启动 OpenTUI/Solid 前端。
- 已安装支持 `app-server` 的 Codex CLI，并能通过 `codex` 命令调用。
- 目标项目中可用 Git。

检查命令：

```powershell
node --version
bun --version
codex app-server --help
git --version
```

## 安装

在 SuperCodex 仓库中执行：

```powershell
cd C:\supercodex
npm install
npm run build
npm link
```

验证：

```powershell
supercodex doctor --project C:\supercodex
supercodex status --project C:\supercodex
```

## 启动 TUI

进入你希望 SuperCodex 处理的项目目录：

```powershell
cd C:\path\to\project
supercodex
```

不带子命令的 `supercodex` 会启动 managed TUI。这是正常使用入口：可以输入需求、使用 slash command、查看历史、响应 Codex 交互请求，以及续跑保存的任务。

## `/start` 的真实行为

`/start` 是“继续保存的工作”的命令。它不会新建 SuperCodex run。

- `/start`：启动并续跑 `default` run。
- `/start <run-id>`：启动并续跑指定的保存 run。
- 它会立即启动 supervisor。
- 它会读取 `.supercodex` 状态、`session.json`，以及本版本新增支持的、意外关闭时留下的 active `runtime.json`。
- 如果存在可用 Codex thread，SuperCodex 会调用 `thread/resume`。
- 如果旧 thread 不安全或不存在，SuperCodex 会保持同一个 run，但在这个 run 内调用 `thread/start` 新开 Codex thread。

因此，实际结论是：

```text
/start 会打开之前的 SuperCodex run 并继续。
对于意外停止或意外关闭 SuperCodex 的情况，只要保存过 session 或运行中 runtime 里有 thread，就会优先恢复该 thread。
它不会创建新的 SuperCodex session/run。
```

但要区分 SuperCodex run 和 Codex thread：

- 没有保存 thread 时，Codex 只能新开 thread。
- 执行过 `/fresh-next` 时，下一轮强制新开 thread。
- 保存的 stage 和下一项工作 stage 不一致时，会新开 thread，避免旧上下文污染新阶段。
- 同一个 thread 连续失败达到限制时，会新开 thread。
- dry-run 或不可恢复失败不会被当作可续跑 thread。

也就是说，`/start` 不会新建 SuperCodex run；但当恢复旧 Codex thread 不安全时，它会在同一个 run 中安全地新开 Codex thread。

## `/resume` 和 `/new`

`/resume` 是被动选择：

- `/resume` 打开保存 session 列表。
- `/resume <编号|run-id>` 选择某个 SuperCodex run 或匹配当前项目的 Codex 原生 session。
- 只加载历史并切换当前 run。
- 不会自动开跑。

选择后，你可以直接输入普通消息继续这个 session；如果想立即让它自动执行保存的工作，用 `/start <run-id>`。

`/new` 是明确新建：

- `/new` 创建新的 run 和新的 Codex thread。
- `/new <prompt>` 创建新的 run 并立刻发送 prompt。
- `/clear` 是 `/new` 的别名。

## 常用 TUI 命令

```text
/start [run-id]       启动/续跑 default 或指定保存 run
/resume [id|current]  选择保存 session 但不自动运行，或解除当前 run 暂停
/new [prompt]         新建 session
/model <name>         设置下一轮模型
/reasoning <effort>   设置下一轮思考强度
/permissions          选择 Default permissions / Auto-review / Full access
/sandbox <mode>       高级 sandbox 设置
/approval <policy>    高级审批策略设置
/auth <name>          空闲时立即切换 auth，运行中排队到下一轮
/fresh-next           下一轮强制使用 fresh Codex thread
/interrupt [prompt]   停止或引导当前 turn
/interactions         查看待处理 Codex 请求
/approve              同意第一个待处理请求
/approve-session      在支持时按 session 同意
/deny                 拒绝第一个待处理请求
/cancel               取消第一个待处理请求
/answer <text|json>   回答 Codex 输入请求或 MCP elicitation
/pause                下一轮前暂停
/status               显示运行状态
/runs                 列出保存的 SuperCodex/Codex sessions
/help                 显示命令帮助
/exit                 退出 TUI
```

键盘行为：

- `Enter` 提交。
- `Shift+Enter`、`Alt+Enter`、`Ctrl+Enter` 或 `Ctrl+J` 插入换行。
- `Ctrl+C` 只复制终端选区，不退出 SuperCodex。
- 退出必须输入 `/exit`。
- 运行中按 `Esc` 会打开停止确认选择面板。

## 权限

TUI 主权限只有三档：

- `Default permissions`：清除 run 级覆盖，回到正常默认值 `danger-full-access` + `approvalPolicy=never`。
- `Auto-review`：偏审核的相对保守模式。
- `Full access`：明确设置 `danger-full-access` + `approvalPolicy=never`。

高级设置仍可使用：

```text
/sandbox read-only
/sandbox workspace-write
/sandbox danger-full-access
/approval never
/approval on-failure
/approval on-request
/approval untrusted
```

## Auth

SuperCodex 的全局 auth/config 根目录是：

```text
C:\Users\<you>\.supercodex\codex-auth
```

常用命令：

```powershell
supercodex auth list
supercodex auth add --name account-1 --login
supercodex auth use --name account-1
supercodex auth snapshot-config
supercodex auth reset-limits
```

TUI 内 `/auth <name>` 在空闲时立即切换；当前 Codex turn 正在运行时会排队到下一轮，避免破坏正在运行的 app-server。

## 非 TUI 命令

```powershell
supercodex init --project C:\path\to\project
supercodex status --project C:\path\to\project
supercodex doctor --project C:\path\to\project
supercodex run --project C:\path\to\project
supercodex once --project C:\path\to\project
supercodex attach --project C:\path\to\project
supercodex interrupt --project C:\path\to\project --message "停止当前方向，检查问题。"
```

`run` 默认持续运行，直到项目完成或遇到不可恢复错误；需要限制轮数时显式传 `--max-cycles`。网络断开、上下文窗口错误、timeout、session 丢失这类可恢复 Codex app-server 错误会退避重试。`--max-retries` 对普通可恢复错误表示“达到阈值后升级恢复策略”，例如强制 fresh Codex thread 并继续运行；它只对不可恢复错误表示停止阈值。

remote pre-sampling compaction 失败更严格：默认最多在同一个 Codex thread 内重试 20 次，达到阈值后才在同一个 SuperCodex run 内强制 fresh Codex thread 继续。

```powershell
supercodex run --project C:\path\to\project --max-cycles 1
supercodex run --project C:\path\to\project --max-retries 3
supercodex run --project C:\path\to\project --remote-compaction-max-retries 20
supercodex run --project C:\path\to\project --idle-timeout-seconds 1200
supercodex run --project C:\path\to\project --run-id main
```

## SuperCodex 写入的文件

项目内运行态：

```text
.supercodex/
  state.json
  backlog.json
  progress.md
  checkpoints.md
  last-action.md
  runtime/
    session.json
    runtime.json
    runs/<run-id>/
  logs/
  docs/
```

`.supercodex/` 是运行态目录，默认写入 `.gitignore`。

## 开发与验证

```powershell
cd C:\supercodex
npm run build
npm test
npm run test:node
npm run test:opentui
git diff --check
```

聚焦验证 `/start` 续跑：

```powershell
node --test dist\tests\supervisor.test.js dist\tests\app-server.test.js
bun test tests\opentui-smoke.test.tsx --test-name-pattern "routes /start|resume session picker"
```

## 更多文档

- 英文 README：`README.md`
- 英文使用指南：`dosc/USAGE_GUIDE.md`
- 中文使用指南：`dosc/USAGE_GUIDE.zh-CN.md`

## 许可证

MIT。见 `LICENSE`。
