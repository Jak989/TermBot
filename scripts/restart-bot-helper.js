"use strict";

const fs = require("fs");
const { spawn } = require("child_process");

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

function isPidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

function appendLog(logPath, message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(logPath, line, "utf8");
  } catch (_err) {
    // ignore
  }
}

function spawnDetachedBot({ nodeBin, botEntry, cwd, runtimeLogPath, restartSource, restartChatId }) {
  const outFd = fs.openSync(runtimeLogPath, "a");
  const env = {
    ...process.env,
    TERMBOT_RESTART_SOURCE: String(restartSource || "").trim(),
    TERMBOT_RESTART_CHAT_ID: String(restartChatId || "").trim(),
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

async function spawnWithRetry(params) {
  const attempts = [0, 500, 1200];
  for (let idx = 0; idx < attempts.length; idx += 1) {
    const waitBefore = attempts[idx];
    if (waitBefore > 0) await sleep(waitBefore);

    let newPid = null;
    try {
      newPid = spawnDetachedBot(params);
    } catch (err) {
      appendLog(params.restartLogPath, `spawn attempt ${idx + 1} failed: ${err.message}`);
      continue;
    }

    await sleep(1200);
    if (isPidAlive(newPid)) {
      appendLog(params.restartLogPath, `restart success on attempt ${idx + 1}, new pid=${newPid}`);
      return true;
    }

    appendLog(params.restartLogPath, `spawn attempt ${idx + 1} started pid=${newPid} but process exited early`);
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

  if (!botEntry) {
    appendLog(restartLogPath, "restart aborted: missing --entry");
    return;
  }

  appendLog(restartLogPath, `restart helper started (source=${source}, oldPid=${oldPid})`);

  await ensureOldProcessStopped(oldPid, restartLogPath);

  const ok = await spawnWithRetry({
    nodeBin,
    botEntry,
    cwd,
    runtimeLogPath,
    restartLogPath,
    restartSource: source,
    restartChatId,
  });

  if (!ok) {
    appendLog(restartLogPath, "restart failed: all spawn attempts exhausted");
  }
}

main().catch((err) => {
  const fallbackLog = "/tmp/termbot-restart.log";
  appendLog(fallbackLog, `restart helper crashed: ${err.message}`);
});
