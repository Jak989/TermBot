"use strict";

const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { spawn } = require("child_process");
const { randomUUID } = require("crypto");

const { sendRequest } = require("./lib/ipc");
const { ensureDir } = require("./lib/session-store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "codexbot");
const PID_FILE = path.join(DATA_DIR, "codexbot.pid");
const LAUNCH_LOG_FILE = path.join(DATA_DIR, "launcher.log");
const DEFAULT_SOCKET_PATH = "/tmp/codexbot.sock";
const FALLBACK_SOCKET_PATH = path.join(DATA_DIR, "codexbot.sock");
const SOCKET_CANDIDATES = process.env.CODEXBOT_SOCKET_PATH
  ? [process.env.CODEXBOT_SOCKET_PATH]
  : [DEFAULT_SOCKET_PATH, FALLBACK_SOCKET_PATH];
const DAEMON_SCRIPT = path.join(__dirname, "codexbot-daemon.js");

function usage() {
  return [
    "Usage:",
    "  node scripts/codexbot-cli.js bot start",
    "  node scripts/codexbot-cli.js bot stop",
    "  node scripts/codexbot-cli.js bot status",
    "  node scripts/codexbot-cli.js bot ask \"<prompt>\"",
    "  node scripts/codexbot-cli.js bot new",
    "  node scripts/codexbot-cli.js bot cancel",
    "  node scripts/codexbot-cli.js bot repl",
    "  node scripts/codexbot-cli.js bot logs [limit]",
  ].join("\n");
}

function fail(message, code = 1) {
  console.error(message);
  process.exit(code);
}

function readPid() {
  try {
    if (!fs.existsSync(PID_FILE)) return null;
    const raw = fs.readFileSync(PID_FILE, "utf8").trim();
    if (!raw) return null;
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch (_err) {
    return null;
  }
}

function readStdinIfAny() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }

    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      input += chunk;
    });
    process.stdin.on("end", () => resolve(input));
  });
}

async function request(action, payload = {}, timeoutMs = 0) {
  let lastError = null;
  for (const socketPath of SOCKET_CANDIDATES) {
    try {
      return await sendRequest(
        socketPath,
        {
          id: randomUUID(),
          action,
          payload,
        },
        { timeoutMs }
      );
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("No socket candidates configured.");
}

async function daemonStatus(timeoutMs = 700) {
  try {
    const response = await request("status", {}, timeoutMs);
    if (!response?.ok) return null;
    return response.data;
  } catch (_err) {
    return null;
  }
}

async function ensureDaemonRunning() {
  const current = await daemonStatus(700);
  if (current) return current;
  await cmdStart(true);
  const after = await daemonStatus(4000);
  if (!after) {
    fail("Daemon did not become ready.");
  }
  return after;
}

async function cmdStart(silent = false) {
  ensureDir(DATA_DIR);
  const existing = await daemonStatus(700);
  if (existing) {
    if (!silent) {
      console.log(`codexbotd already running (pid=${existing.pid})`);
    }
    return;
  }

  const outFd = fs.openSync(LAUNCH_LOG_FILE, "a");
  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    cwd: PROJECT_ROOT,
    detached: true,
    stdio: ["ignore", outFd, outFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(outFd);

  const started = Date.now();
  while (Date.now() - started < 4000) {
    const status = await daemonStatus(400);
    if (status) {
      if (!silent) console.log(`codexbotd started (pid=${status.pid})`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  fail("Failed to start codexbotd. Check data/codexbot/launcher.log");
}

async function cmdStop() {
  try {
    const response = await request("stop", {}, 1200);
    if (response?.ok) {
      console.log("Stop signal sent.");
      return;
    }
  } catch (_err) {
    // fallback below
  }

  const pid = readPid();
  if (!pid) {
    fail("Daemon is not running.");
  }

  try {
    process.kill(pid, "SIGTERM");
    console.log(`Sent SIGTERM to pid ${pid}.`);
  } catch (err) {
    fail(`Failed to stop daemon via PID: ${err.message}`);
  }
}

function formatStatus(status) {
  const s = status.state || {};
  const lines = [
    `running: yes (pid=${status.pid})`,
    `socket: ${status.socketPath}`,
    `codex bin: ${status.codexBin}`,
    `codex home: ${status.codexHome}`,
    `provider mode: ${status.providerMode || "codex"}`,
    `local provider: ${status.localProvider || "-"}`,
    `yolo: ${status.yolo ? "on" : "off"}`,
    `thread: ${s.activeThreadId || "none"}`,
    `busy: ${s.running ? "yes" : "no"}`,
    `cwd: ${s.cwd || "-"}`,
    `model: ${s.model || "(default)"}`,
    `last used: ${s.lastUsedAt || "-"}`,
  ];
  if (status.activeRun) {
    lines.push(`active run: ${status.activeRun.durationMs}ms | ${status.activeRun.promptPreview}`);
  }
  return lines.join("\n");
}

async function cmdStatus() {
  const status = await daemonStatus(900);
  if (!status) {
    console.log("running: no");
    console.log(`socket candidates: ${SOCKET_CANDIDATES.join(", ")}`);
    const pid = readPid();
    if (pid) console.log(`stale pid file: ${pid}`);
    return;
  }
  console.log(formatStatus(status));
}

async function cmdAsk(promptArg) {
  const status = await ensureDaemonRunning();
  const prompt = String(promptArg || "").trim();
  if (!prompt) fail("Prompt is required for ask.");

  const response = await request("ask", { prompt }, 0);
  if (!response?.ok) {
    console.error(response?.error || "Codex request failed.");
    if (response?.data?.stderr?.length) {
      console.error(`stderr: ${response.data.stderr.join(" | ")}`);
    }
    process.exit(1);
  }

  if (response.data?.message) {
    process.stdout.write(`${response.data.message}\n`);
  } else {
    process.stdout.write("\n");
  }

  if (status?.state?.activeThreadId !== response.data?.threadId && response.data?.threadId) {
    console.error(`thread: ${response.data.threadId}`);
  }
}

async function cmdNew() {
  const _status = await ensureDaemonRunning();
  const response = await request("new", {}, 1200);
  if (!response?.ok) fail(response?.error || "Failed to reset thread.");
  console.log("Session reset. Next ask starts a new Codex thread.");
}

async function cmdCancel() {
  const _status = await ensureDaemonRunning();
  const response = await request("cancel", {}, 1200);
  if (!response?.ok) fail(response?.error || "Failed to cancel active run.");
  console.log("Cancel requested.");
}

async function cmdLogs(limitArg) {
  const _status = await ensureDaemonRunning();
  const limit = Number(limitArg || 200);
  const response = await request("logs", { limit }, 1200);
  if (!response?.ok) fail(response?.error || "Failed to fetch logs.");
  const lines = response?.data?.lines || [];
  if (!lines.length) {
    console.log("(no logs)");
    return;
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function cmdRepl() {
  await ensureDaemonRunning();
  console.log("codexbot repl");
  console.log("commands: /new /cancel /status /logs /exit");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: "codexbot> ",
  });

  rl.prompt();
  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    try {
      if (text === "/exit" || text === "/quit") {
        rl.close();
        return;
      }

      if (text === "/new") {
        await cmdNew();
        rl.prompt();
        return;
      }

      if (text === "/cancel") {
        await cmdCancel();
        rl.prompt();
        return;
      }

      if (text === "/status") {
        await cmdStatus();
        rl.prompt();
        return;
      }

      if (text.startsWith("/logs")) {
        const parts = text.split(/\s+/g);
        await cmdLogs(parts[1]);
        rl.prompt();
        return;
      }

      const response = await request("ask", { prompt: text }, 0);
      if (!response?.ok) {
        console.error(response?.error || "ask failed");
        if (response?.data?.stderr?.length) {
          console.error(`stderr: ${response.data.stderr.join(" | ")}`);
        }
      } else {
        process.stdout.write(`${response.data?.message || ""}\n`);
      }
    } catch (err) {
      console.error(err.message || String(err));
    }

    rl.prompt();
  });

  rl.on("close", () => {
    console.log("bye");
    process.exit(0);
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) fail(usage(), 2);

  const [group, command, ...rest] = args;
  if (group !== "bot") {
    fail(usage(), 2);
  }

  if (command === "start") {
    await cmdStart(false);
    return;
  }

  if (command === "stop") {
    await cmdStop();
    return;
  }

  if (command === "status") {
    await cmdStatus();
    return;
  }

  if (command === "ask") {
    let prompt = rest.join(" ").trim();
    if (!prompt) {
      prompt = (await readStdinIfAny()).trim();
    }
    await cmdAsk(prompt);
    return;
  }

  if (command === "new") {
    await cmdNew();
    return;
  }

  if (command === "cancel") {
    await cmdCancel();
    return;
  }

  if (command === "repl") {
    await cmdRepl();
    return;
  }

  if (command === "logs") {
    await cmdLogs(rest[0]);
    return;
  }

  fail(usage(), 2);
}

main().catch((err) => {
  fail(err.message || String(err), 1);
});
