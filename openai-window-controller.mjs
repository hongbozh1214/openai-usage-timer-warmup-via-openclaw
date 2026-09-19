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
const FLOATING_SKEW = 2 * 60 * 1000;
const LOCK_MAX_AGE = 15 * 60 * 1000;

function arg(name) {
  return process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
}

const probe = process.argv.includes("--probe");
const token = arg("token") ?? "";
const weeklyResume = arg("weeklyResume") === "1";
const anchorId = arg("anchor") ?? process.env.OPENCLAW_ANCHOR_ID ?? "";
const agentId = arg("agent") ?? process.env.OPENCLAW_AGENT_ID ?? "main";
const timezone = arg("timezone") ?? process.env.OPENCLAW_TIMEZONE ?? "Europe/Helsinki";
const quietEndHour = Number(arg("quietEndHour") ?? process.env.OPENCLAW_QUIET_END_HOUR ?? 6);
const openclawBin = process.env.OPENCLAW_BIN ?? "openclaw";
const scriptPath = fileURLToPath(import.meta.url);
const dataDir = process.env.OPENCLAW_WINDOW_STATE_DIR
  ?? `${homedir()}/.openclaw/state/openai-window-controller`;
const stateFile = `${dataDir}/state.json`;
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

function loadState() {
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function saveState(state) {
  const temporaryFile = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporaryFile, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryFile, stateFile);
}

function scheduleCheck(atMs, reason, { weeklyResume: resume = false } = {}) {
  if (!resume && !mayAnchorAt(atMs)) {
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
    ...(resume ? ["weeklyResume=1"] : []),
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
    weeklyResume: resume,
  });
  log("scheduled", { jobId: result.id, checkAt: localTime(atMs), reason });
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
  const state = loadState();
  if (token && state.expectedToken !== token) {
    log("stale-one-shot", { expected: state.expectedToken ?? null });
    return;
  }

  const { fiveHour, week } = readWindows();
  const readyAt = fiveHour.resetAt + GRACE;
  const floatingWindow = isFloatingWindow(fiveHour, now);
  const weekExhausted = week.usedPercent >= 100;
  const weeklyCheckAt = Math.max(week.resetAt + GRACE, now + GRACE);

  if (probe) {
    log("probe", {
      usedPercent: fiveHour.usedPercent,
      resetAt: localTime(fiveHour.resetAt),
      weeklyUsedPercent: week.usedPercent,
      weeklyResetAt: localTime(week.resetAt),
      action: weekExhausted
        ? `check weekly quota at ${localTime(weeklyCheckAt)}`
        : !mayAnchorAt(now) && !weeklyResume
          ? "quiet hours; wait for daily check"
          : floatingWindow
            ? "anchor now (unused/floating window)"
            : readyAt > now
              ? `check at ${localTime(readyAt)}`
              : "anchor now (expired window)",
    });
    return;
  }

  if (weekExhausted) {
    log("weekly-exhausted", {
      weeklyResetAt: localTime(week.resetAt),
      nextCheck: localTime(weeklyCheckAt),
    });
    scheduleCheck(weeklyCheckAt, "weekly reset plus 5 minutes", { weeklyResume: true });
    return;
  }

  if (!weeklyResume && !mayAnchorAt(now)) {
    log("quiet-hours", {
      nextDailyCheck: `${String(quietEndHour).padStart(2, "0")}:00`,
    });
    return;
  }

  if (!floatingWindow && readyAt > now) {
    scheduleCheck(readyAt, "current window plus 5 minutes", { weeklyResume });
    return;
  }

  if (floatingWindow) {
    log("unused-floating-window", {
      reportedResetAt: localTime(fiveHour.resetAt),
      action: "anchor now",
    });
  }

  log("anchor-start", { previousResetAt: localTime(fiveHour.resetAt) });
  const result = JSON.parse(
    openclaw([
      "automations",
      "run",
      anchorId,
      "--wait",
      "--wait-timeout",
      "3m",
      "--poll-interval",
      "2s",
    ]),
  );
  if (!result.completed || result.completionStatus !== "succeeded") {
    throw new Error(`anchor did not succeed: ${JSON.stringify(result)}`);
  }

  const completedAt = Date.now();
  let nextAt = completedAt + FIVE_HOURS + GRACE;
  let reason = "anchor completion plus 5h05m (fallback)";
  let nextWeeklyResume = false;
  try {
    const after = readWindows();
    if (after.week.usedPercent >= 100) {
      nextAt = Math.max(after.week.resetAt + GRACE, completedAt + GRACE);
      reason = "weekly reset plus 5 minutes";
      nextWeeklyResume = true;
    } else if (after.fiveHour.resetAt > completedAt) {
      nextAt = after.fiveHour.resetAt + GRACE;
      reason = "new resetAt plus 5 minutes";
    }
  } catch (error) {
    log("post-anchor-status-warning", { error: error.message });
  }

  log("anchor-succeeded", {
    tokens: result.run?.usage?.total_tokens ?? null,
    nextCheck: localTime(nextAt),
  });
  scheduleCheck(nextAt, reason, { weeklyResume: nextWeeklyResume });
}

try {
  main();
} finally {
  closeSync(lockFd);
  rmSync(lockFile, { force: true });
}
