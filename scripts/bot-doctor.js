"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { readJson, isPidAlive } = require("./lib/runtime-state");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const BOT_LOCK = path.join(RUNTIME_DIR, "bot.lock");
const SUP_LOCK = path.join(RUNTIME_DIR, "supervisor.lock");
const SUP_PID_FILE = path.join(RUNTIME_DIR, "supervisor.pid");
const READY_FILE = path.join(RUNTIME_DIR, "restart-ready.json");
const EVENTS_FILE = path.join(RUNTIME_DIR, "events.jsonl");
const CLOUDFLARED_PID_FILE = path.join(DATA_DIR, "cloudflared.pid");

function readPidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (_err) {
    return 0;
  }
}

function fileInfo(filePath) {
  try {
    const stat = fs.statSync(filePath);
    return { exists: true, size: stat.size, mtime: stat.mtime.toISOString() };
  } catch (_err) {
    return { exists: false, size: 0, mtime: "" };
  }
}

function tmuxSessions(prefix) {
  try {
    const out = execFileSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
    return out
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((name) => name.startsWith(prefix));
  } catch (_err) {
    return [];
  }
}

function buildReport() {
  const botLock = readJson(BOT_LOCK, null);
  const supLock = readJson(SUP_LOCK, null);
  const supPidObj = readJson(SUP_PID_FILE, null);
  const ready = readJson(READY_FILE, null);
  const cloudflaredPid = readPidFile(CLOUDFLARED_PID_FILE);

  return {
    generatedAt: new Date().toISOString(),
    runtimeDir: RUNTIME_DIR,
    bot: {
      lockFile: BOT_LOCK,
      lock: botLock,
      pidAlive: isPidAlive(botLock?.pid),
    },
    supervisor: {
      lockFile: SUP_LOCK,
      lock: supLock,
      pidFile: SUP_PID_FILE,
      pid: Number(supPidObj?.pid || 0),
      pidAlive: isPidAlive(supPidObj?.pid),
    },
    restart: {
      readyFile: READY_FILE,
      marker: ready,
      markerPidAlive: isPidAlive(ready?.pid),
    },
    cloudflared: {
      pidFile: CLOUDFLARED_PID_FILE,
      pid: cloudflaredPid,
      pidAlive: isPidAlive(cloudflaredPid),
    },
    tmux: {
      sessions: tmuxSessions("codexbot_"),
    },
    files: {
      events: fileInfo(EVENTS_FILE),
      ready: fileInfo(READY_FILE),
      botLock: fileInfo(BOT_LOCK),
      supervisorLock: fileInfo(SUP_LOCK),
    },
  };
}

function printHuman(report) {
  const lines = [
    `generated: ${report.generatedAt}`,
    `bot pid: ${report.bot.lock?.pid || "-"} (alive=${report.bot.pidAlive})`,
    `supervisor pid: ${report.supervisor.pid || "-"} (alive=${report.supervisor.pidAlive})`,
    `ready marker pid: ${report.restart.marker?.pid || "-"} (alive=${report.restart.markerPidAlive})`,
    `ready marker restart_id: ${report.restart.marker?.restartId || "-"}`,
    `cloudflared pid: ${report.cloudflared.pid || "-"} (alive=${report.cloudflared.pidAlive})`,
    `tmux sessions: ${report.tmux.sessions.length ? report.tmux.sessions.join(", ") : "none"}`,
    `events file: ${report.files.events.exists ? `${report.files.events.size} bytes` : "missing"}`,
  ];
  console.log(lines.join("\n"));
}

const report = buildReport();
if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printHuman(report);
}
