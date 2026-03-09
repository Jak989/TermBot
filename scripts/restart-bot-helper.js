"use strict";

const fs = require("fs");
const { spawn } = require("child_process");
const {
  isPidAlive,
  waitForReadyMarker,
  removeFile,
} = require("./lib/runtime-state");

function parseArgs(argv) {
  const out = {};
  for (const item of argv) {
    if (!item.startsWith("--")) continue;
    const idx = item.indexOf("=");
    if (idx < 0) {
      out[item.slice(2)] = "1";
      continue;
    }
    out[item.slice(2, idx)] = item.slice(idx + 1);
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(logPath, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(logPath, line, "utf8");
  } catch (_err) {
    // ignore
  }
}

function createRestartId() {
  return `rst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function spawnDetachedBot({
  nodeBin,
  botEntry,
  cwd,
  runtimeLogPath,
  restartSource,
  restartChatId,
  restartId,
}) {
  const outFd = fs.openSync(runtimeLogPath, "a");
  const env = {
    ...process.env,
    TERMBOT_RESTART_SOURCE: String(restartSource || "").trim(),
    TERMBOT_RESTART_CHAT_ID: String(restartChatId || "").trim(),
    TERMBOT_RESTART_ID: String(restartId || "").trim(),
  };
  const child = spawn(nodeBin, [botEntry], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", outFd, outFd],
  });
  fs.closeSync(outFd);
  child.unref();
  return child.pid;
}

async function waitForPidToExit(pid, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (!isPidAlive(pid)) return true;
    await sleep(200);
  }
  return !isPidAlive(pid);
}

async function ensureOldProcessStopped(oldPid, restartLogPath) {
  if (!Number.isSafeInteger(oldPid) || oldPid <= 0) return;
  if (!isPidAlive(oldPid)) return;

  const exitedQuick = await waitForPidToExit(oldPid, 12_000);
  if (exitedQuick) return;

  appendLog(restartLogPath, `old pid still alive after timeout, sending SIGTERM (${oldPid})`);
  try {
    process.kill(oldPid, "SIGTERM");
  } catch (_err) {
    // ignore
  }

  const exitedAfterTerm = await waitForPidToExit(oldPid, 6_000);
  if (exitedAfterTerm) return;

  appendLog(restartLogPath, `old pid still alive after SIGTERM, sending SIGKILL (${oldPid})`);
  try {
    process.kill(oldPid, "SIGKILL");
  } catch (_err) {
    // ignore
  }

  await waitForPidToExit(oldPid, 2_000);
}

async function stopProcessIfAlive(pid, restartLogPath) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (!isPidAlive(pid)) return;

  try {
    process.kill(pid, "SIGTERM");
  } catch (_err) {
    // ignore
  }
  const exited = await waitForPidToExit(pid, 1500);
  if (exited) return;

  appendLog(restartLogPath, `new pid still alive after failed health check; sending SIGKILL (${pid})`);
  try {
    process.kill(pid, "SIGKILL");
  } catch (_err) {
    // ignore
  }
  await waitForPidToExit(pid, 500);
}

async function spawnWithRetry(params) {
  const attempts = [0, 500, 1200];
  for (let idx = 0; idx < attempts.length; idx += 1) {
    const waitBefore = attempts[idx];
    if (waitBefore > 0) await sleep(waitBefore);

    removeFile(params.readyFilePath);

    let newPid = null;
    try {
      newPid = spawnDetachedBot(params);
    } catch (err) {
      appendLog(params.restartLogPath, `spawn attempt ${idx + 1} failed: ${err.message}`);
      continue;
    }

    await sleep(800);
    if (!isPidAlive(newPid)) {
      appendLog(params.restartLogPath, `spawn attempt ${idx + 1} started pid=${newPid} but process exited early`);
      continue;
    }

    const health = await waitForReadyMarker(params.readyFilePath, {
      restartId: params.restartId,
      expectedPid: newPid,
      timeoutMs: params.healthTimeoutMs,
      pollMs: 250,
    });

    if (health.ok) {
      appendLog(
        params.restartLogPath,
        `restart success on attempt ${idx + 1}, new pid=${newPid}, restart_id=${params.restartId}`
      );
      return true;
    }

    appendLog(
      params.restartLogPath,
      `spawn attempt ${idx + 1} pid=${newPid} failed health check (restart_id=${params.restartId})`
    );
    await stopProcessIfAlive(newPid, params.restartLogPath);
  }

  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const oldPid = Number(args["old-pid"] || "0");
  const cwd = String(args.cwd || "").trim() || process.cwd();
  const nodeBin = String(args.node || process.execPath).trim() || process.execPath;
  const botEntry = String(args.entry || "").trim();
  const runtimeLogPath = String(args.log || "/tmp/termbot-bot.log").trim() || "/tmp/termbot-bot.log";
  const restartLogPath = String(args["restart-log"] || "/tmp/termbot-restart.log").trim() || "/tmp/termbot-restart.log";
  const source = String(args.source || "unknown").trim() || "unknown";
  const restartChatId = String(args["chat-id"] || "").trim();
  const restartId = String(args["restart-id"] || "").trim() || createRestartId();
  const readyFilePath = String(args["ready-file"] || "").trim();
  const healthTimeoutMs = Number.isFinite(Number(args["health-timeout"]))
    ? Math.max(1500, Number(args["health-timeout"]))
    : 15000;

  if (!botEntry) {
    appendLog(restartLogPath, "restart aborted: missing --entry");
    return;
  }
  if (!readyFilePath) {
    appendLog(restartLogPath, "restart aborted: missing --ready-file");
    return;
  }

  appendLog(
    restartLogPath,
    `restart helper started (source=${source}, oldPid=${oldPid}, restart_id=${restartId}, health_timeout_ms=${healthTimeoutMs})`
  );

  await ensureOldProcessStopped(oldPid, restartLogPath);

  const ok = await spawnWithRetry({
    nodeBin,
    botEntry,
    cwd,
    runtimeLogPath,
    restartLogPath,
    restartSource: source,
    restartChatId,
    restartId,
    readyFilePath,
    healthTimeoutMs,
  });

  if (!ok) {
    appendLog(restartLogPath, `restart failed: all spawn attempts exhausted (restart_id=${restartId})`);
  }
}

main().catch((err) => {
  const fallbackLog = "/tmp/termbot-restart.log";
  appendLog(fallbackLog, `restart helper crashed: ${err.message}`);
});
