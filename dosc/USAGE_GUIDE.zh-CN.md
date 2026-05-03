# SuperCodex 使用指南

这份指南面向实际使用，不是 `.supercodex` 内部交付记录。它只说明当前版本怎么安装、启动、续跑、切 session、切权限、处理交互请求和排查常见问题。

当前版本：`0.13.5`（0.13 补丁版本）。许可证：MIT。

## 1. 先确认你装的是当前版本

安装公开 npm 包：

```powershell
npm install -g @eirui/supercodex
```

如果要从 SuperCodex 仓库进行本地开发安装：

```powershell
cd C:\supercodex
npm install
npm run build
npm link
```

确认命令可用：

```powershell
supercodex doctor --project C:\supercodex
```

正常情况下你应该看到：

- `runner` 是 `codex-app-server`
- `codexAppServerAvailable` 是 `true`
- Bun 可用
- OpenTUI packages 可用
- 当前项目 Git 可用

如果 `codexAppServerAvailable=false`，先确认 Codex CLI 已安装并且下面命令能成功：

```powershell
codex app-server --help
```

## 2. 卸载

如果你是通过本仓库 `npm link` 安装的，移除全局命令：

```powershell
npm unlink -g @eirui/supercodex
```

如果你安装的是公开 npm 包，使用：

```powershell
npm uninstall -g @eirui/supercodex
```

可选：清理 SuperCodex 仓库里的本地构建和依赖：

```powershell
cd C:\supercodex
Remove-Item -Recurse -Force .\dist, .\node_modules
```

目标项目中的运行状态位于 `.supercodex/`。只有在不再需要续跑状态或日志时再删除：

```powershell
Remove-Item -Recurse -Force .\.supercodex
```

## 3. 在目标项目中启动

进入目标项目目录：

```powershell
cd C:\path\to\project
supercodex
```

启动后你会进入 OpenTUI 全屏界面。普通文本是普通指令，会作为原始用户消息直接发送给 Codex。它不会创建 `FINAL_GOAL.md`，不会注入 SuperCodex External Supervisor Prompt，也不会运行 Phase 6 或 Phase 7。

只有需要重置 `.supercodex`、保存新的最终目标，并进入完整的 SuperCodex PRD / 架构 / PLAN / 验收 / 交付循环时，才使用 `/goal <prompt>`。已有 `.supercodex` 状态的项目，建议先用 `/status` 看当前状态，再用 `/start` 续跑。

### 普通输入和 `/goal` 的区别

| 输入 | 行为 |
|---|---|
| 普通文本 | 当前或 fresh session 中的直接 Codex 消息。适合一次性工作、小修改、检查、审查。 |
| `/goal <prompt>` | 明确的最终目标指令。重置 `.supercodex`，写入 `FINAL_GOAL.md`，在 `AUTO_DEV_STATE.json` 标记 goal mode，并注入 SuperCodex supervisor prompt。 |

从命令面板选择 `/goal` 会把 `/goal ` 插入输入框；在后面输入最终目标并提交即可。

## 4. 最重要的 session 规则

### `/start` 是续跑

`/start` 会启动保存的 SuperCodex run，而不是新建 run。

```text
/start
```

等价于启动 `default` run。

```text
/start main
```

会启动 `main` run。

当上次 SuperCodex 因为终端关闭、进程退出、机器重启或意外中断停止时，本版本会按这个顺序恢复：

1. 读取当前项目 `.supercodex/AUTO_DEV_STATE.json`、`FINAL_GOAL.md` 和 `PLAN.md`。
2. 读取对应 run 的 `session.json`。
3. 如果进程是在 Codex turn 运行中被关掉，读取 `runtime.json` 里保存的 active thread。
4. 如果找到可恢复 thread，调用 Codex app-server 的 `thread/resume`。
5. 如果 thread 不存在或不安全，保持同一个 SuperCodex run，但使用 `thread/start` 新开 Codex thread。

所以答案是：`/start` 可以恢复之前因为意外停止或意外关闭留下的 SuperCodex session/run，并优先续跑已保存的 Codex thread；它不会新开一个 SuperCodex session。

### 什么时候会在同一个 run 里新开 Codex thread？

这些情况会新开 Codex thread，但仍然不是新建 SuperCodex run：

- 没有保存过 thread。
- 上次是 dry-run。
- 上次失败类型不可恢复。
- 你执行过 `/fresh-next`。
- 当前 PLAN 已全部完成，下一步是全项目 Final Acceptance / PRD / Architecture / PLAN 审查，并在需要时创建下一 Cycle。
- 同一个 thread 连续失败次数达到限制。

active PLAN 内部的 Stage 或 phase 变化会复用同一个 Codex thread；Milestone 完成可以创建阶段性 commit/push，但仍然留在同一个 plan-cycle thread，也不能替代 Phase 7 的最终 PR 闭环。fresh thread 的正常边界是 PLAN 完成后的全局审查，而不是 Stage Gate。这不是 session 丢失。

`--max-retries` 不再表示普通可恢复错误失败几次就停。对上下文窗口错误等普通可恢复 app-server 错误，它表示达到阈值后升级恢复策略，默认 10 次，强制 fresh Codex thread 并继续运行；只有不可恢复错误才会按这个阈值停止。

网络波动和 remote pre-sampling compaction 失败使用单独的同 thread 阈值。网络波动默认最多在同一个 Codex thread 内重试 10 次；remote pre-sampling compaction 默认最多在同一个 Codex thread 内重试 20 次。任一阈值达到后，SuperCodex 保持同一个 run，并用 fresh Codex thread 继续。

### `/resume` 是只选不跑

`/resume` 用来查看和选择历史：

```text
/resume
/resume 2
/resume codex-019de35e...
```

它会加载历史并切换当前 run，但不会自动开始执行。选择后：

- 想手动给一句话继续：直接输入普通文本。
- 想让保存的工作自动续跑：输入 `/start <run-id>`。

### `/new` 是新建

```text
/new
/new 重新检查这个项目的测试体系
```

`/new` 会创建新的 SuperCodex run 和新的 Codex thread。`/clear` 是 `/new` 的别名。

`/new <prompt>` 仍然是普通输入。它不会创建 `FINAL_GOAL.md`，也不会进入最终目标循环。

### `/goal` 是最终目标循环入口

```text
/goal 把这个项目改造成可恢复、可测试、可发布的 CLI 工具，直到测试和构建通过。
```

`/goal <prompt>` 会清理当前项目过时的 `.supercodex` 状态，把 prompt 写入 `.supercodex/FINAL_GOAL.md`，在 `AUTO_DEV_STATE.json` 标记 goal mode，并启动 SuperCodex supervisor 工作流。

## 5. 推荐日常流程

### 新项目

```powershell
cd C:\path\to\project
supercodex
```

如果是长期自动交付目标，进入 TUI 后使用 `/goal`：

```text
/goal 把这个项目改造成可恢复、可测试、可发布的 CLI 工具，直到测试和构建通过。
```

SuperCodex 会补齐 `.supercodex/` 运行态，然后按项目状态推进。

如果只是普通一次性任务，直接输入普通文本：

```text
检查 README 是否和当前实现一致。
```

这条消息会直接发送给 Codex，不会创建最终目标状态。

### 继续上次工作

```powershell
cd C:\path\to\project
supercodex
```

进入 TUI：

```text
/status
/start
```

如果你维护多个 run：

```text
/runs
/start main
```

### 查看历史但不自动运行

```text
/resume
```

用上下键选择，按 Enter。此时只是加载历史。确认要跑再输入：

```text
/start <run-id>
```

### 明确新开一次会话

```text
/new
```

或者：

```text
/new 只检查 README 是否和当前实现一致
```

## 6. TUI 操作

常用键：

- `Enter`：提交。
- `Shift+Enter`、`Alt+Enter`、`Ctrl+Enter`、`Ctrl+J`：输入换行。
- `Ctrl+C`：只复制终端选区，不退出。
- `Esc`：运行中打开停止确认选择面板。
- `/exit`：退出 TUI。
- 输入 `/`：打开命令面板。

主界面会显示：

- 当前 run/thread/turn。
- supervisor 和 Codex app-server 是否在运行。
- 当前模型、思考强度、权限、auth。
- 精简 transcript。
- pending interactions。

命令输出和文件读取不会把整个屏幕刷满；完整原文可以去 `.supercodex/logs/supercodex/` 或 Codex session JSONL 查看。

## 7. 权限设置

TUI 主权限只有三档：

```text
/permissions default
/permissions auto-review
/permissions full-access
```

含义：

- `Default permissions`：默认权限，回到正常默认值 `danger-full-access` + `approvalPolicy=never`。
- `Auto-review`：自动审核/更保守的权限模式。
- `Full access`：完全权限，明确设置 `danger-full-access` + `approvalPolicy=never`。

高级用户可以直接设置底层 Codex 参数：

```text
/sandbox read-only
/sandbox workspace-write
/sandbox danger-full-access
/approval never
/approval on-failure
/approval on-request
/approval untrusted
```

`/permissions`、`/sandbox` 和 `/approval` 的选择面板支持 `Up` / `Down` 和 `Enter` 键盘操作。

## 8. 模型、思考强度和 auth

```text
/model gpt-5.5
/reasoning xhigh
/auth account-2
```

规则：

- `/model` 和 `/reasoning` 写入下一轮设置，不会打断当前 turn。
- `/auth <name>` 在空闲时立即切换。
- 当前 Codex turn 正在运行时，auth 切换会排队到下一轮。

管理保存账号：

```powershell
supercodex auth list
supercodex auth add --name account-1 --login
supercodex auth use --name account-1
supercodex auth snapshot-config
supercodex auth reset-limits
```

全局 SuperCodex auth 根目录是：

```text
C:\Users\<you>\.supercodex\codex-auth
```

## 9. 处理 Codex 请求

当 Codex CLI 通过 app-server 请求命令执行审批、文件修改审批、权限提升、用户输入或 MCP elicitation 时，SuperCodex 会捕获这个请求，并用和命令面板、Esc 停止确认相同的 `PickerOverlay` 选择面板显示。

键盘支持：

- `Up` / `Left` 或 `Ctrl+P`：上一个选项。
- `Down` / `Right` 或 `Ctrl+N`：下一个选项。
- `Home` / `End`：第一个或最后一个选项。
- `Enter`：确认当前高亮选项。
- 数字键 `1` 到 `9`：直接选择对应选项。
- `Esc`：当请求提供 cancel / decline 时执行取消或拒绝。

你可以用：

```text
/interactions
/approve
/approve-session
/deny
/cancel
/answer <text-or-json>
```

自由文本类 Codex 询问和 MCP 表单仍可用 `/answer <text-or-json>` 回答。

## 10. 非 TUI 用法

检查状态：

```powershell
supercodex status --project C:\path\to\project
```

诊断环境：

```powershell
supercodex doctor --project C:\path\to\project
```

无界面运行：

```powershell
supercodex run --project C:\path\to\project
```

限制运行轮数：

```powershell
supercodex run --project C:\path\to\project --max-cycles 1
```

附加到已有运行：

```powershell
supercodex attach --project C:\path\to\project
```

运行中干预：

```powershell
supercodex interrupt --project C:\path\to\project --message "停止当前方向，先检查测试失败原因。"
```

## 11. 常见问题

### `/start` 是不是新建 session？

不是。`/start` 使用 `default` 或指定 run-id 的保存 run。它只在旧 Codex thread 不可用或不安全时，在同一个 run 内新开 Codex thread。

### SuperCodex 意外关闭后怎么办？

重新进入项目：

```powershell
cd C:\path\to\project
supercodex
```

然后：

```text
/status
/start
```

本版本会优先用保存的 `session.json` 或 active `runtime.json` 继续。

### `/resume` 为什么不自动跑？

这是故意的。`/resume` 用来安全查看和选择历史，避免只是浏览 session 时误触执行。想自动跑请用 `/start <run-id>`。

### 为什么按 `Ctrl+C` 不退出？

SuperCodex TUI 中 `Ctrl+C` 是复制功能，防止误关长时间运行任务。退出请用：

```text
/exit
```

### `/model` 后看到模型刷新 timeout 怎么办？

当前版本已经过滤已知的非致命 Codex 后台模型列表刷新 timeout。原始 stderr 仍保留在日志里，但不应再铺到 TUI 主 transcript。

### 如何确认下一轮会 resume 还是 fresh？

运行：

```powershell
supercodex status --project C:\path\to\project
```

看输出中的：

```json
"nextDefaultThreadAction": "thread/resume ..."
```

或：

```json
"nextDefaultThreadAction": "thread/start"
```

## 12. 验证当前仓库

在 `C:\supercodex`：

```powershell
npm run build
node --test dist\tests\supervisor.test.js dist\tests\app-server.test.js
bun test tests\opentui-smoke.test.tsx --test-name-pattern "routes /start|resume session picker"
npm test
git diff --check
```

其中 supervisor/app-server 聚焦测试会验证：

- 保存的 active PLAN session 会用 `resume=true` 和原 thread，即使下一项工作进入不同 Stage。
- 意外关闭留下的 active runtime thread 可以被恢复。
- app-server resume 参数会发送 `threadId`。
- OpenTUI `/start` 走主动启动路径，不会误走被动 `/resume` 或 `/new`。
