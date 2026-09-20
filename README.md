# OpenAI Usage Timer Warmup via OpenClaw

Align the 5-hour usage timer and make a small model request after the weekly quota resets.  
通过 OpenClaw 暖启动 OpenAI 用量计时：对齐 5 小时窗口，并在周额度刷新后发起一次小请求。

> [中文说明](#中文) · [English](#english)

## 中文

### 作用

OpenAI 的 5 小时额度窗口可能采用“首次使用后才真正开始计时”的惰性逻辑：没有模型调用时，状态接口可能持续显示“约 5 小时后刷新”，并随查询时间向后移动。本项目在指定时间检查窗口状态，必要时通过一次极小的真实模型请求启动窗口，使后续刷新时间尽量落在可预测的时间点。

它不会增加或绕过额度，只负责调整窗口开始时间。每次 anchor 都会产生少量 token 使用，并计入相应的 5 小时及周额度。如果周额度已耗尽，即使 5 小时窗口显示 100% 剩余，也不会尝试使用模型。

### 工作方式

1. 每天在指定时间（示例为赫尔辛基时间 06:00）运行零模型 command job。
2. 同时读取 OpenAI `5h` 和 `Week` 窗口的 `usedPercent`、`resetAt`；任一窗口数据缺失时停止，以免误触发模型。
3. 无论周额度是否已用尽，都单独安排一次性检查，在 `Week.resetAt + 5 分钟`确认周窗口已刷新，并做一次极小的 Sol 调用。周额度耗尽期间不调用模型；若刷新状态尚未更新，每 5 分钟复查。
4. 周检查时若 5 小时额度也已用尽，等其 `resetAt + 5 分钟`再尝试暖启动；若仍有余额，即使 5 小时窗口已在计时，也会执行这次周暖启动，因此不会强制重置已有的 5 小时窗口。
5. 独立的 5 小时控制器仍按原规则运行：`5h.usedPercent` 为 0 且 `resetAt` 约等于当前时间加 5 小时时，立即 anchor；若窗口仍在计时，则在其 `resetAt + 5 分钟`复查。
6. 普通 5 小时检查在 00:00–05:59 不启动新窗口；周额度刷新后的暖启动例外，允许在夜间执行。成功的周暖启动也会安排后续 5 小时检查。

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
- 周检查和 5 小时检查各自保存调度状态，彼此不会覆盖；新周刷新后需要从 `Week.resetAt` 读取到新的周窗口才能暖启动。
- 更新已有脚本时保留原来的 anchor ID 与控制器命令参数；公开仓库版本需通过 `anchor=<ANCHOR_ID>` 或 `OPENCLAW_ANCHOR_ID` 提供 ID。
- OpenAI 或 OpenClaw 的状态字段和计费逻辑可能变化；升级后请重新验证。
- 如需其他时区或静默时段，修改 controller command 中的 `timezone` 和 `quietEndHour`。
- 脚本采用 fail-closed：无法可靠读取窗口状态时不会调用 anchor。

## English

### Purpose

OpenAI's 5-hour usage window may behave lazily: until the first real model request, the reported reset time can remain approximately five hours ahead and continue moving forward. This project checks the window state and, when necessary, performs a minimal real model request to start the window at a predictable time.

It does not increase or bypass any quota. Each anchor consumes a small number of tokens and counts against the relevant 5-hour and weekly limits. An unused 5-hour window is not actionable while the weekly quota is exhausted.

### How it works

1. A zero-model command job runs daily at a chosen time (06:00 Europe/Helsinki in the example).
2. It reads `usedPercent` and `resetAt` for both OpenAI `5h` and `Week`. If either is missing, it stops without calling the model.
3. Regardless of whether the week is exhausted, it schedules a separate one-shot check at `Week.resetAt + 5 minutes`. It confirms that the weekly window rolled over, then makes a minimal Sol call. While the weekly quota is exhausted or the reset has not appeared in status yet, it waits and rechecks.
4. If the 5-hour quota is exhausted at that time, weekly warmup waits for its `resetAt + 5 minutes`. If the 5-hour window remains active with quota available, the weekly warmup still makes a small request; that request does not restart the active 5-hour window.
5. Independently, `5h.usedPercent === 0` plus a reset time approximately five hours ahead is anchored immediately; a genuinely active 5-hour window is checked at `resetAt + 5 minutes`.
6. Ordinary 5-hour checks avoid starting a window between 00:00 and 05:59. Weekly warmup can run during those hours. A successful weekly warmup also schedules the next 5-hour check.

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
- Weekly and 5-hour checks keep separate scheduling state. Weekly warmup waits until the reported `Week.resetAt` moves to the new weekly window.
- When upgrading an existing script, retain its anchor ID and controller command arguments. The public version takes `anchor=<ANCHOR_ID>` or `OPENCLAW_ANCHOR_ID`.
- OpenAI or OpenClaw may change usage semantics or JSON fields. Revalidate after upgrades.
- Change `timezone` and `quietEndHour` in the controller command for another locale or quiet period.
- The script fails closed: if window state cannot be read reliably, it will not call the anchor.

## License

MIT
