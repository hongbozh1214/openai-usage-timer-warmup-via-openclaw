import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const FIVE_HOURS = 5 * 60 * 60 * 1000;
const GRACE = 5 * 60 * 1000;
const WEEK_ROLLOVER_MIN = 24 * 60 * 60 * 1000;
const FLOATING_SKEW = 2 * 60 * 1000;
const LOCK_MAX_AGE = 15 * 60 * 1000;

function arg(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

const probe = process.argv.includes("--probe");
const token = arg("token") ?? "";
const weeklyToken = arg("weeklyToken") ?? "";
const weeklyResetAt = Number(arg("weeklyResetAt") ?? 0);
const anchorId = arg("anchor") ?? process.env.OPENCLAW_ANCHOR_ID ?? "";
const agentId = arg("agent") ?? process.env.OPENCLAW_AGENT_ID ?? "main";
const timezone = arg("timezone") ?? process.env.OPENCLAW_TIMEZONE ?? "Europe/Helsinki";
const quietEndHour = Number(arg("quietEndHour") ?? process.env.OPENCLAW_QUIET_END_HOUR ?? 6);
const openclawBin = process.env.OPENCLAW_BIN ?? "openclaw";
const scriptPath = fileURLToPath(import.meta.url);
const dataDir = process.env.OPENCLAW_WINDOW_STATE_DIR
  ?? `${homedir()}/.openclaw/state/openai-window-controller`;
const stateFile = `${dataDir}/state.json`;
const weeklyStateFile = `${dataDir}/weekly-state.json`;
const lockFile = `${dataDir}/lock`;

if (!probe && !anchorId) {
  throw new Error("Missing anchor job ID. Pass anchor=<job-id> or set OPENCLAW_ANCHOR_ID.");
}
if (!Number.isInteger(quietEndHour) || quietEndHour < 0 || quietEndHour > 23) {
  throw new Error("quietEndHour must be an integer from 0 to 23");
}

function log(event, details = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...details }));
}

function openclaw(args, timeout = 240_000) {
  try {
    return execFileSync(openclawBin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
    });
  } catch (error) {
    const stderr = String(error.stderr ?? "").trim();
    const stdout = String(error.stdout ?? "").trim();
    throw new Error(
      `${openclawBin} ${args.join(" ")} failed: ${stderr || stdout || error.message}`,
    );
  }
}

function readWindows() {
  const status = JSON.parse(
    openclaw(["status", "--usage", "--agent", agentId, "--json"], 60_000),
  );
  const provider = status.usage?.providers?.find((item) => item.provider === "openai");
  function parseWindow(label) {
    const window = provider?.windows?.find((item) => item.label === label);
    const resetAt = window?.resetAt;
    const usedPercent = window?.usedPercent;
    if (!Number.isFinite(resetAt) || resetAt <= 0
      || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) {
      throw new Error(`OpenAI ${label} window data is missing or invalid; refusing to anchor`);
    }
    return { resetAt, usedPercent };
  }
  return { fiveHour: parseWindow("5h"), week: parseWindow("Week") };
}

function localHour(ms) {
  return Number(
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "2-digit",
      hourCycle: "h23",
    }).format(new Date(ms)),
  );
}

function localTime(ms) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "medium",
    hourCycle: "h23",
  }).format(new Date(ms));
}

function mayAnchorAt(ms) {
  return localHour(ms) >= quietEndHour;
}

function isFloatingWindow(window, now) {
  return (
    window.usedPercent === 0
    && window.resetAt - now >= FIVE_HOURS - FLOATING_SKEW
  );
}

function loadState(file = stateFile) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function saveState(state, file = stateFile) {
  const temporaryFile = `${file}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryFile, file);
}

function scheduleCheck(atMs, reason) {
  if (!mayAnchorAt(atMs)) {
    saveState({ expectedToken: null, nextCheckAt: atMs, reason: `quiet-hours: ${reason}` });
    log("quiet-hours", {
      nextDailyCheck: `${String(quietEndHour).padStart(2, "0")}:00`,
      skipped: localTime(atMs),
      reason,
    });
    return;
  }

  const nextToken = `${atMs}-${randomUUID()}`;
  const stamp = new Date(atMs).toISOString().replace(/\D/g, "").slice(0, 14);
  const suffix = nextToken.slice(-6);
  const commandArgs = [
    "node",
    scriptPath,
    `anchor=${anchorId}`,
    `agent=${agentId}`,
    `timezone=${timezone}`,
    `quietEndHour=${quietEndHour}`,
    `token=${nextToken}`,
  ];
  const result = JSON.parse(
    openclaw([
      "automations",
      "create",
      "--at",
      new Date(atMs).toISOString(),
      "--name",
      `openai-window-check-${stamp}-${suffix}`,
      "--command-argv",
      JSON.stringify(commandArgs),
      "--no-deliver",
      "--timeout-seconds",
      "240",
    ]),
  );

  saveState({
    expectedToken: nextToken,
    nextCheckAt: atMs,
    scheduledJobId: result.id,
    reason,
  });
  log("scheduled", { jobId: result.id, checkAt: localTime(atMs), reason });
}

function scheduleWeeklyCheck(atMs, targetResetAt, reason) {
  const nextToken = `${atMs}-${randomUUID()}`;
  const stamp = new Date(atMs).toISOString().replace(/\D/g, "").slice(0, 14);
  const argv = [
    "node", scriptPath, `anchor=${anchorId}`, `agent=${agentId}`,
    `timezone=${timezone}`, `quietEndHour=${quietEndHour}`,
    `weeklyToken=${nextToken}`, `weeklyResetAt=${targetResetAt}`,
  ];
  const result = JSON.parse(openclaw([
    "automations", "create", "--at", new Date(atMs).toISOString(),
    "--name", `openai-weekly-check-${stamp}-${nextToken.slice(-6)}`,
    "--command-argv", JSON.stringify(argv),
    "--no-deliver", "--timeout-seconds", "240",
  ]));
  saveState({ expectedToken: nextToken, targetResetAt, nextCheckAt: atMs,
    scheduledJobId: result.id, reason }, weeklyStateFile);
  log("weekly-scheduled", { jobId: result.id, checkAt: localTime(atMs), reason });
}

function ensureWeeklyCheck(week, now) {
  const state = loadState(weeklyStateFile);
  if (state.lastCompletedResetAt === week.resetAt) return;
  if (state.expectedToken) {
    if (state.nextCheckAt > now - 15 * 60 * 1000) return;
    if (state.targetResetAt === week.resetAt
      || (week.resetAt - state.targetResetAt >= WEEK_ROLLOVER_MIN
        && now - state.targetResetAt < WEEK_ROLLOVER_MIN)) {
      scheduleWeeklyCheck(now + GRACE, state.targetResetAt,
        "retry missed weekly check");
      return;
    }
  }
  scheduleWeeklyCheck(Math.max(week.resetAt + GRACE, now + GRACE),
    week.resetAt, "weekly reset plus 5 minutes");
}

function runAnchor(fiveHour, week, weeklyTarget = null) {
  log("anchor-start", {
    previousResetAt: localTime(fiveHour.resetAt),
    source: weeklyTarget === null ? "5h" : "Week",
  });
  const result = JSON.parse(openclaw([
    "automations", "run", anchorId,
    "--wait", "--wait-timeout", "3m", "--poll-interval", "2s",
  ]));
  if (!result.completed || result.completionStatus !== "succeeded") {
    throw new Error(`anchor did not succeed: ${JSON.stringify(result)}`);
  }

  const completedAt = Date.now();
  if (weeklyTarget !== null) {
    saveState({ expectedToken: null, lastCompletedResetAt: weeklyTarget,
      completedAt }, weeklyStateFile);
  }

  let nextAt = completedAt + FIVE_HOURS + GRACE;
  let reason = "anchor completion plus 5h05m (fallback)";
  let weekExhaustedAfter = false;
  try {
    const after = readWindows();
    ensureWeeklyCheck(after.week, completedAt);
    if (after.week.usedPercent >= 100) {
      log("weekly-exhausted", { nextCheck: localTime(after.week.resetAt + GRACE) });
      weekExhaustedAfter = true;
    } else if (after.fiveHour.resetAt > completedAt) {
      nextAt = after.fiveHour.resetAt + GRACE;
      reason = "new resetAt plus 5 minutes";
    }
  } catch (error) {
    log("post-anchor-status-warning", { error: error.message });
    if (weeklyTarget !== null) ensureWeeklyCheck(week, completedAt);
  }

  log("anchor-succeeded", {
    tokens: result.run?.usage?.total_tokens ?? null,
    nextCheck: weekExhaustedAfter ? "weekly check" : localTime(nextAt),
  });
  if (!weekExhaustedAfter) scheduleCheck(nextAt, reason);
}

function runWeeklyCheck(now, fiveHour, week) {
  const state = loadState(weeklyStateFile);
  if (state.expectedToken !== weeklyToken || state.targetResetAt !== weeklyResetAt) {
    log("stale-weekly-one-shot");
    return;
  }
  if (now < weeklyResetAt + GRACE
    || week.resetAt - weeklyResetAt < WEEK_ROLLOVER_MIN) {
    scheduleWeeklyCheck(Math.max(weeklyResetAt + GRACE, now + GRACE),
      weeklyResetAt, "waiting for weekly reset to appear in quota status");
    return;
  }
  if (week.usedPercent >= 100) {
    log("weekly-exhausted", { nextCheck: localTime(week.resetAt + GRACE) });
    saveState({ expectedToken: null, lastCompletedResetAt: weeklyResetAt,
      skipped: "new weekly quota already exhausted" }, weeklyStateFile);
    ensureWeeklyCheck(week, now);
    return;
  }
  if (fiveHour.usedPercent >= 100) {
    const nextAt = Math.max(fiveHour.resetAt + GRACE, now + GRACE);
    scheduleWeeklyCheck(nextAt, weeklyResetAt,
      "weekly quota refreshed; waiting for 5h quota");
    return;
  }
  try {
    runAnchor(fiveHour, week, weeklyResetAt);
  } catch (error) {
    if (loadState(weeklyStateFile).lastCompletedResetAt !== weeklyResetAt) {
      scheduleWeeklyCheck(Date.now() + GRACE, weeklyResetAt,
        "weekly warmup failed; retry in 5 minutes");
    }
    throw error;
  }
}

function acquireLock() {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try {
    return openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (Date.now() - statSync(lockFile).mtimeMs <= LOCK_MAX_AGE) return null;
    rmSync(lockFile);
    return openSync(lockFile, "wx", 0o600);
  }
}

const lockFd = acquireLock();
if (lockFd === null) {
  log("already-running");
  process.exit(0);
}

function main() {
  const now = Date.now();
  if (weeklyToken && (!Number.isFinite(weeklyResetAt) || weeklyResetAt <= 0)) {
    throw new Error("Invalid weeklyResetAt; refusing to anchor");
  }
  if (token && loadState().expectedToken !== token) {
    log("stale-one-shot");
    return;
  }

  const { fiveHour, week } = readWindows();
  const readyAt = fiveHour.resetAt + GRACE;
  const floatingWindow = isFloatingWindow(fiveHour, now);
  const weekExhausted = week.usedPercent >= 100;

  if (probe) {
    log("probe", {
      usedPercent: fiveHour.usedPercent,
      resetAt: localTime(fiveHour.resetAt),
      weeklyUsedPercent: week.usedPercent,
      weeklyResetAt: localTime(week.resetAt),
      weeklyCheck: localTime(Math.max(week.resetAt + GRACE, now + GRACE)),
      action: weekExhausted
        ? "weekly quota exhausted; wait for weekly reset check"
        : !mayAnchorAt(now)
          ? "quiet hours; wait for daily check"
          : floatingWindow
            ? "anchor now (unused/floating window)"
            : readyAt > now
              ? `check at ${localTime(readyAt)}`
              : "anchor now (expired window)",
    });
    return;
  }

  if (weeklyToken) {
    runWeeklyCheck(now, fiveHour, week);
    return;
  }

  ensureWeeklyCheck(week, now);

  if (weekExhausted) {
    log("weekly-exhausted", {
      weeklyResetAt: localTime(week.resetAt),
      nextCheck: localTime(Math.max(week.resetAt + GRACE, now + GRACE)),
    });
    return;
  }

  if (!mayAnchorAt(now)) {
    log("quiet-hours", {
      nextDailyCheck: `${String(quietEndHour).padStart(2, "0")}:00`,
    });
    return;
  }

  if (!floatingWindow && readyAt > now) {
    scheduleCheck(readyAt, "current window plus 5 minutes");
    return;
  }

  if (floatingWindow) {
    log("unused-floating-window", {
      reportedResetAt: localTime(fiveHour.resetAt),
      action: "anchor now",
    });
  }

  runAnchor(fiveHour, week);
}

try {
  main();
} finally {
  closeSync(lockFd);
  rmSync(lockFile, { force: true });
}
