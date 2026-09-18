# OpenClaw OpenAI Window Alignment

Adaptive alignment for OpenAI's rolling 5-hour usage window in OpenClaw.  
用于 OpenClaw 的 OpenAI 5 小时滚动额度窗口自适应对齐方案。

> [中文说明](#中文) · [English](#english)

## 中文

### 作用

OpenAI 的 5 小时额度窗口可能采用“首次使用后才真正开始计时”的惰性逻辑：没有模型调用时，状态接口可能持续显示“约 5 小时后刷新”，并随查询时间向后移动。本项目在指定时间检查窗口状态，必要时通过一次极小的真实模型请求启动窗口，使后续刷新时间尽量落在可预测的时间点。

它不会增加或绕过额度，只负责调整窗口开始时间。每次 anchor 都会产生少量 token 使用，并计入相应的 5 小时及周额度。

### 工作方式

1. 每天在指定时间（示例为赫尔辛基时间 06:00）运行零模型 command job。
2. 读取 `openclaw status --usage --json` 中的 `usedPercent` 和 `resetAt`。
3. 当 `usedPercent` 为 0，且 `resetAt` 几乎等于“当前时间 + 5 小时”时，将其视为未启动的浮动窗口并立即 anchor。
4. 若是真正活动的固定窗口，则在 `resetAt + 5 分钟`创建一次性检查。
5. anchor 成功后，继续按约 5 小时 5 分钟自调度。
6. 默认在 00:00–05:59 不启动新窗口，以保护次日 06:00 的对齐点。

### 要求

- OpenClaw 版本支持 `automations` command job、`--at` 和 `--command-argv`
- Node.js 24 或更高版本
- 已配置可用的 OpenAI 模型与认证
- 能够运行 `openclaw status --usage --agent <id> --json`

### 安装

将脚本保存到 OpenClaw 容器内可持久化的位置，例如：

```text
/home/node/.openclaw/workspace/scripts/openai-window-controller.mjs
```

先创建一个最小 Sol anchor：

```bash
openclaw automations create \
  "0 6 * * *" \
  "Reply exactly: 1. Do not call tools." \
  --name "openai-window-anchor" \
  --agent main \
  --session isolated \
  --light-context \
  --model "openai/gpt-5.6-sol" \
  --fallbacks "" \
  --thinking off \
  --tools session_status \
  --no-deliver \
  --timeout-seconds 60 \
  --tz "Europe/Helsinki" \
  --exact
```

记录返回的 anchor ID，然后禁用它。禁用只阻止 cron schedule；控制器仍可手动调用：

```bash
openclaw automations disable <ANCHOR_ID>
```

创建每日控制器，把 `<ANCHOR_ID>` 和脚本路径替换成实际值：

```bash
openclaw automations create \
  "0 6 * * *" \
  --name "openai-window-controller-0600" \
  --command-argv '["node","/home/node/.openclaw/workspace/scripts/openai-window-controller.mjs","anchor=<ANCHOR_ID>","agent=main","timezone=Europe/Helsinki","quietEndHour=6"]' \
  --no-deliver \
  --timeout-seconds 240 \
  --tz "Europe/Helsinki" \
  --exact
```

只读测试，不会调用 anchor 或创建任务：

```bash
node openai-window-controller.mjs --probe agent=main timezone=Europe/Helsinki
```

### 重要说明

- `openai-window-anchor` 必须保持存在；不能删除，只需保持 disabled。
- one-shot 检查任务成功后会自动删除。
- OpenAI 或 OpenClaw 的状态字段和计费逻辑可能变化；升级后请重新验证。
- 如需其他时区或静默时段，修改 controller command 中的 `timezone` 和 `quietEndHour`。
- 脚本采用 fail-closed：无法可靠读取窗口状态时不会调用 anchor。

## English

### Purpose

OpenAI's 5-hour usage window may behave lazily: until the first real model request, the reported reset time can remain approximately five hours ahead and continue moving forward. This project checks the window state and, when necessary, performs a minimal real model request to start the window at a predictable time.

It does not increase or bypass any quota. Each anchor consumes a small number of tokens and counts against the relevant 5-hour and weekly limits.

### How it works

1. A zero-model command job runs daily at a chosen time (06:00 Europe/Helsinki in the example).
2. It reads `usedPercent` and `resetAt` from `openclaw status --usage --json`.
3. `usedPercent === 0` plus a reset time approximately five hours ahead is treated as an unused, floating window and anchored immediately.
4. A genuinely active window is checked again at `resetAt + 5 minutes` through a one-shot job.
5. After a successful anchor, the controller continues self-scheduling at roughly 5 hours 5 minutes.
6. By default, it never starts a new window between 00:00 and 05:59, preserving the next 06:00 alignment point.

### Requirements

- An OpenClaw release supporting automation command jobs, `--at`, and `--command-argv`
- Node.js 24+
- Working OpenAI model authentication
- A working `openclaw status --usage --agent <id> --json` command

### Installation

Store the script in a persistent path visible inside the OpenClaw container, for example:

```text
/home/node/.openclaw/workspace/scripts/openai-window-controller.mjs
```

Create a minimal Sol anchor job:

```bash
openclaw automations create \
  "0 6 * * *" \
  "Reply exactly: 1. Do not call tools." \
  --name "openai-window-anchor" \
  --agent main \
  --session isolated \
  --light-context \
  --model "openai/gpt-5.6-sol" \
  --fallbacks "" \
  --thinking off \
  --tools session_status \
  --no-deliver \
  --timeout-seconds 60 \
  --tz "Europe/Helsinki" \
  --exact
```

Save the returned anchor ID, then disable the job. Disabling prevents its cron schedule while preserving manual controller runs:

```bash
openclaw automations disable <ANCHOR_ID>
```

Create the daily controller, replacing `<ANCHOR_ID>` and the script path:

```bash
openclaw automations create \
  "0 6 * * *" \
  --name "openai-window-controller-0600" \
  --command-argv '["node","/home/node/.openclaw/workspace/scripts/openai-window-controller.mjs","anchor=<ANCHOR_ID>","agent=main","timezone=Europe/Helsinki","quietEndHour=6"]' \
  --no-deliver \
  --timeout-seconds 240 \
  --tz "Europe/Helsinki" \
  --exact
```

Run a read-only probe. It does not call the anchor or create jobs:

```bash
node openai-window-controller.mjs --probe agent=main timezone=Europe/Helsinki
```

### Notes

- Keep `openai-window-anchor`; leave it disabled, but do not delete it.
- Successful one-shot checks delete themselves.
- OpenAI or OpenClaw may change usage semantics or JSON fields. Revalidate after upgrades.
- Change `timezone` and `quietEndHour` in the controller command for another locale or quiet period.
- The script fails closed: if window state cannot be read reliably, it will not call the anchor.

## License

MIT
