"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const BOT_ENTRY = path.join(PROJECT_ROOT, "bot.js");
const RUNTIME_LOG = "/tmp/termbot-bot.log";
const SUP_LOG = "/tmp/termbot-supervisor.log";
const SUP_PID_FILE = path.join(PROJECT_ROOT, "data", "termbot-supervisor.pid");

let child = null;
let stopping = false;

function appendSupervisorLog(message) {
  const line = `[${new Date().toISOString()}] ${message}\n`;
  try {
    fs.appendFileSync(SUP_LOG, line, "utf8");
  } catch (_err) {
    // ignore
  }
}

function writeSupervisorPid() {
  try {
    fs.mkdirSync(path.dirname(SUP_PID_FILE), { recursive: true });
    fs.writeFileSync(SUP_PID_FILE, `${process.pid}\n`, "utf8");
  } catch (_err) {
    // ignore
  }
}

function clearSupervisorPid() {
  try {
    fs.unlinkSync(SUP_PID_FILE);
  } catch (_err) {
    // ignore
  }
}

function spawnBot() {
  if (stopping) return;
  const outFd = fs.openSync(RUNTIME_LOG, "a");
  child = spawn(process.execPath, [BOT_ENTRY], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      TERMBOT_SUPERVISED: "1",
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
  setTimeout(() => {
    process.exit(0);
  }, 500);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("exit", () => clearSupervisorPid());

writeSupervisorPid();
appendSupervisorLog(`supervisor started pid=${process.pid}`);
spawnBot();
