"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const {
  acquireProcessLock,
  releaseProcessLock,
  writeJson,
  removeFile,
} = require("./lib/runtime-state");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BOT_ENTRY = path.join(PROJECT_ROOT, "bot.js");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const RUNTIME_LOG = "/tmp/termbot-bot.log";
const SUP_LOG = "/tmp/termbot-supervisor.log";
const SUP_LOCK_FILE = path.join(RUNTIME_DIR, "supervisor.lock");
const SUP_PID_FILE = path.join(RUNTIME_DIR, "supervisor.pid");
const LEGACY_SUP_PID_FILE = path.join(DATA_DIR, "termbot-supervisor.pid");

let child = null;
let stopping = false;
let lockHeld = false;

function appendSupervisorLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(SUP_LOG, line, "utf8");
  } catch (_err) {
    // ignore
  }
}

function writeSupervisorPid() {
  const payload = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  try {
    writeJson(SUP_PID_FILE, payload);
    writeJson(LEGACY_SUP_PID_FILE, payload);
  } catch (_err) {
    // ignore
  }
}

function clearSupervisorPid() {
  removeFile(SUP_PID_FILE);
  removeFile(LEGACY_SUP_PID_FILE);
}

function releaseLockIfHeld() {
  if (!lockHeld) return;
  releaseProcessLock(SUP_LOCK_FILE, process.pid);
  lockHeld = false;
}

function spawnBot() {
  if (stopping) return;
  const outFd = fs.openSync(RUNTIME_LOG, "a");
  child = spawn(process.execPath, [BOT_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      TERMBOT_SUPERVISED: "1",
      TERMBOT_SUPERVISOR_PID: String(process.pid),
    },
    stdio: ["ignore", outFd, outFd],
  });
  fs.closeSync(outFd);
  appendSupervisorLog(`spawned bot pid=${child.pid}`);

  child.on("exit", (code, signal) => {
    appendSupervisorLog(`bot exited code=${code} signal=${signal || "-"}`);
    child = null;
    if (!stopping) {
      setTimeout(() => {
        spawnBot();
      }, 1200);
    }
  });
}

function shutdown(signalName) {
  if (stopping) return;
  stopping = true;
  appendSupervisorLog(`supervisor stopping on ${signalName}`);
  if (child && child.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch (_err) {
      // ignore
    }
  }
  clearSupervisorPid();
  releaseLockIfHeld();
  setTimeout(() => {
    process.exit(0);
  }, 500);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("exit", () => {
  clearSupervisorPid();
  releaseLockIfHeld();
});

const lockResult = acquireProcessLock(SUP_LOCK_FILE, {
  pid: process.pid,
  role: "supervisor",
  script: path.basename(__filename),
});

if (!lockResult.ok) {
  if (lockResult.reason === "already_locked") {
    appendSupervisorLog(
      `supervisor already running pid=${lockResult.existing?.pid || "unknown"}; exiting duplicate instance`
    );
    process.exit(0);
  }
  appendSupervisorLog(`failed to acquire supervisor lock (${lockResult.reason || "unknown"})`);
  process.exit(1);
}

lockHeld = true;
writeSupervisorPid();
appendSupervisorLog(`supervisor started pid=${process.pid}`);
spawnBot();
