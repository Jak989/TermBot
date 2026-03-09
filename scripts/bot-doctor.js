"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const dotenv = require("dotenv");
const { readJson, isPidAlive } = require("./lib/runtime-state");

const PROJECT_ROOT = path.resolve(__dirname, "..");
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
const DATA_DIR = path.join(PROJECT_ROOT, "data");
const RUNTIME_DIR = path.join(DATA_DIR, "runtime");
const BOT_LOCK = path.join(RUNTIME_DIR, "bot.lock");
const SUP_LOCK = path.join(RUNTIME_DIR, "supervisor.lock");
const SUP_PID_FILE = path.join(RUNTIME_DIR, "supervisor.pid");
const READY_FILE = path.join(RUNTIME_DIR, "restart-ready.json");
const EVENTS_FILE = path.join(RUNTIME_DIR, "events.jsonl");
const CLOUDFLARED_PID_FILE = path.join(DATA_DIR, "cloudflared.pid");
const BOT_ENTRY = path.join(PROJECT_ROOT, "bot.js");
const SUP_ENTRY = "termbot-supervisor.js";
const BOT_WEB_HOST = String(process.env.BOT_WEB_HOST || "127.0.0.1").trim() || "127.0.0.1";
const BOT_WEB_PORT = Number.isFinite(Number(process.env.BOT_WEB_PORT)) ? Number(process.env.BOT_WEB_PORT) : 8787;
const BOT_WEBAPP_URL = String(process.env.BOT_WEBAPP_URL || "").trim();
const BOT_CLOUDFLARE_TUNNEL_MODE = String(process.env.BOT_CLOUDFLARE_TUNNEL_MODE || "auto").trim().toLowerCase();
const BOT_CLOUDFLARE_TUNNEL_NAME = String(process.env.BOT_CLOUDFLARE_TUNNEL_NAME || "").trim();

function parseArgs(argv) {
  const out = new Set();
  for (const arg of argv) out.add(String(arg || ""));
  return {
    json: out.has("--json"),
    fix: out.has("--fix"),
  };
}

function run(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: "utf8" });
  } catch (_err) {
    return "";
  }
}

function listPidsByPattern(pattern) {
  const out = run("pgrep", ["-f", pattern]);
  return out
    .split(/\r?\n/g)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

function commandLineForPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "";
  return run("ps", ["-p", String(pid), "-o", "command="]).trim();
}

function readSimplePidFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch (_err) {
    return 0;
  }
}

function isTryCloudflareUrl(rawUrl) {
  const raw = String(rawUrl || "").trim();
  if (!raw) return false;
  try {
    const parsed = new URL(raw);
    return /\.trycloudflare\.com$/i.test(parsed.hostname);
  } catch (_err) {
    return /trycloudflare\.com/i.test(raw);
  }
}

function resolveTunnelMode() {
  if (["off", "disabled", "none"].includes(BOT_CLOUDFLARE_TUNNEL_MODE)) return "off";
  if (BOT_CLOUDFLARE_TUNNEL_MODE === "quick") return "quick";
  if (BOT_CLOUDFLARE_TUNNEL_MODE === "named") return "named";
  if (BOT_CLOUDFLARE_TUNNEL_NAME) return "named";
  if (!BOT_WEBAPP_URL || isTryCloudflareUrl(BOT_WEBAPP_URL)) return "quick";
  return "off";
}

function expectedCloudflaredPattern(mode) {
  if (mode === "named") {
    if (BOT_CLOUDFLARE_TUNNEL_NAME) return `tunnel run ${BOT_CLOUDFLARE_TUNNEL_NAME}`;
    return "tunnel run";
  }
  if (mode === "quick") {
    return `--url http://${BOT_WEB_HOST}:${BOT_WEB_PORT}`;
  }
  return "";
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

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (_err) {
    return false;
  }
}

function killPid(pid, signal = "SIGTERM") {
  try {
    process.kill(pid, signal);
  } catch (_err) {
    return false;
  }
  if (signal === "SIGTERM") {
    try {
      process.kill(pid, "SIGKILL");
    } catch (_err) {
      // ignore
    }
  }
  return true;
}

function buildReport() {
  const tunnelMode = resolveTunnelMode();
  const expectedTunnelPattern = expectedCloudflaredPattern(tunnelMode);
  const botLock = readJson(BOT_LOCK, null);
  const supLock = readJson(SUP_LOCK, null);
  const supPidObj = readJson(SUP_PID_FILE, null);
  const ready = readJson(READY_FILE, null);
  const cloudflaredPid = readSimplePidFile(CLOUDFLARED_PID_FILE);
  const botPids = listPidsByPattern(BOT_ENTRY);
  const supervisorPids = listPidsByPattern(SUP_ENTRY);
  const cloudflaredPids = listPidsByPattern("cloudflared tunnel");

  return {
    generatedAt: new Date().toISOString(),
    runtimeDir: RUNTIME_DIR,
    bot: {
      lockFile: BOT_LOCK,
      lock: botLock,
      pidAlive: isPidAlive(botLock?.pid),
      pids: botPids,
    },
    supervisor: {
      lockFile: SUP_LOCK,
      lock: supLock,
      pidFile: SUP_PID_FILE,
      pid: Number(supPidObj?.pid || 0),
      pidAlive: isPidAlive(supPidObj?.pid),
      pids: supervisorPids,
    },
    restart: {
      readyFile: READY_FILE,
      marker: ready,
      markerPidAlive: isPidAlive(ready?.pid),
    },
    cloudflared: {
      mode: tunnelMode,
      expectedPattern: expectedTunnelPattern,
      pidFile: CLOUDFLARED_PID_FILE,
      pid: cloudflaredPid,
      pidAlive: isPidAlive(cloudflaredPid),
      pids: cloudflaredPids,
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

function applyFix(report) {
  const actions = [];

  const activeSupervisorPid = Number(report.supervisor.pid || 0);
  const keepSupervisorPid = activeSupervisorPid && isPidAlive(activeSupervisorPid) ? activeSupervisorPid : 0;
  for (const pid of report.supervisor.pids) {
    if (pid === keepSupervisorPid) continue;
    if (killPid(pid, "SIGTERM")) {
      actions.push(`killed duplicate supervisor pid=${pid}`);
    }
  }

  const lockBotPid = Number(report.bot.lock?.pid || 0);
  const keepBotPid = lockBotPid && isPidAlive(lockBotPid) ? lockBotPid : 0;
  for (const pid of report.bot.pids) {
    if (pid === keepBotPid) continue;
    if (killPid(pid, "SIGTERM")) {
      actions.push(`killed duplicate bot pid=${pid}`);
    }
  }

  if (report.bot.lock && !report.bot.pidAlive && removeFile(BOT_LOCK)) {
    actions.push("removed stale bot.lock");
  }
  if (report.supervisor.lock && !report.supervisor.pidAlive && removeFile(SUP_LOCK)) {
    actions.push("removed stale supervisor.lock");
  }
  if (report.supervisor.pid && !report.supervisor.pidAlive && removeFile(SUP_PID_FILE)) {
    actions.push("removed stale supervisor.pid");
  }
  if (report.restart.marker && !report.restart.markerPidAlive && removeFile(READY_FILE)) {
    actions.push("removed stale restart-ready.json");
  }

  const trackedTunnelPid = Number(report.cloudflared.pid || 0);
  const keepTunnelPid = trackedTunnelPid && isPidAlive(trackedTunnelPid) ? trackedTunnelPid : 0;
  for (const pid of report.cloudflared.pids) {
    if (pid === keepTunnelPid) continue;
    const cmd = commandLineForPid(pid);
    if (!cmd.includes("cloudflared tunnel")) continue;
    if (report.cloudflared.expectedPattern && !cmd.includes(report.cloudflared.expectedPattern)) continue;
    if (killPid(pid, "SIGTERM")) {
      actions.push(`killed duplicate cloudflared pid=${pid}`);
    }
  }

  const runtimeActive = report.bot.pidAlive || report.supervisor.pidAlive;
  if (!runtimeActive && keepTunnelPid > 0 && killPid(keepTunnelPid, "SIGTERM")) {
    actions.push(`killed cloudflared without active runtime pid=${keepTunnelPid}`);
  }

  if (trackedTunnelPid && !isPidAlive(trackedTunnelPid) && removeFile(CLOUDFLARED_PID_FILE)) {
    actions.push("removed stale cloudflared.pid");
  }

  return actions;
}

function printHuman(report, actions = []) {
  const lines = [
    `generated: ${report.generatedAt}`,
    `bot pid(lock): ${report.bot.lock?.pid || "-"} (alive=${report.bot.pidAlive})`,
    `bot pids(actual): ${report.bot.pids.length ? report.bot.pids.join(", ") : "none"}`,
    `supervisor pid(file): ${report.supervisor.pid || "-"} (alive=${report.supervisor.pidAlive})`,
    `supervisor pids(actual): ${report.supervisor.pids.length ? report.supervisor.pids.join(", ") : "none"}`,
    `ready marker pid: ${report.restart.marker?.pid || "-"} (alive=${report.restart.markerPidAlive})`,
    `ready marker restart_id: ${report.restart.marker?.restartId || "-"}`,
    `cloudflared mode(expected): ${report.cloudflared.mode || "off"}`,
    `cloudflared pattern(expected): ${report.cloudflared.expectedPattern || "-"}`,
    `cloudflared pid(file): ${report.cloudflared.pid || "-"} (alive=${report.cloudflared.pidAlive})`,
    `cloudflared pids(actual): ${report.cloudflared.pids.length ? report.cloudflared.pids.join(", ") : "none"}`,
    `tmux sessions: ${report.tmux.sessions.length ? report.tmux.sessions.join(", ") : "none"}`,
    `events file: ${report.files.events.exists ? `${report.files.events.size} bytes` : "missing"}`,
  ];
  if (actions.length) {
    lines.push("fix actions:");
    for (const action of actions) lines.push(`- ${action}`);
  }
  console.log(lines.join("\n"));
}

(function main() {
  const args = parseArgs(process.argv.slice(2));
  const before = buildReport();
  let actions = [];

  if (args.fix) {
    actions = applyFix(before);
  }

  const after = buildReport();

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          before,
          after,
          fixApplied: args.fix,
          actions,
        },
        null,
        2
      )
    );
    return;
  }

  printHuman(after, actions);
})();
