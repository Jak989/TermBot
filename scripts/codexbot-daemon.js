"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { randomUUID } = require("crypto");

const { encodeMessage, parseMessage } = require("./lib/ipc");
const { runCodexTurn } = require("./lib/codex-runner");
const { ensureDir, loadState, saveState } = require("./lib/session-store");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(PROJECT_ROOT, "data", "codexbot");
const STATE_FILE = path.join(DATA_DIR, "state.json");
const PID_FILE = path.join(DATA_DIR, "codexbot.pid");
const LOG_FILE = path.join(DATA_DIR, "daemon.log");

const PRIMARY_SOCKET_PATH = process.env.CODEXBOT_SOCKET_PATH || "/tmp/codexbot.sock";
const FALLBACK_SOCKET_PATH = path.join(DATA_DIR, "codexbot.sock");
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const CODEX_HOME = process.env.CODEX_HOME || path.join(PROJECT_ROOT, ".codex-home");
const CODEX_CWD = process.env.CODEX_CWD || PROJECT_ROOT;
const CODEX_MODEL = process.env.CODEX_MODEL || "";
const CODEX_USE_OSS = String(process.env.CODEX_USE_OSS || "0") === "1";
const CODEX_LOCAL_PROVIDER = String(process.env.CODEX_LOCAL_PROVIDER || "").trim();
const CODEX_YOLO = String(process.env.CODEX_YOLO || "1") !== "0";
const CANCEL_FALLBACK_MS = Number(process.env.CODEXBOT_CANCEL_FALLBACK_MS || 2500);

ensureDir(DATA_DIR);
ensureDir(CODEX_HOME);

const state = loadState(STATE_FILE, {
  activeThreadId: null,
  running: false,
  lastUsedAt: null,
  cwd: CODEX_CWD,
  model: CODEX_MODEL,
});

state.running = false;
state.cwd = CODEX_CWD;
state.model = CODEX_MODEL;
saveState(STATE_FILE, state);

const recentLogs = [];
let shuttingDown = false;
let currentRun = null;
let server = null;
let activeSocketPath = PRIMARY_SOCKET_PATH;

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  recentLogs.push(line);
  if (recentLogs.length > 400) recentLogs.shift();
  try {
    fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
  } catch (_err) {
    // ignore log write issues
  }
  console.log(line);
}

function writePidFile() {
  fs.writeFileSync(PID_FILE, `${process.pid}\n`, "utf8");
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (_err) {
    // best effort cleanup
  }
}

function trimErrorMessage(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err.message) return err.message;
  return String(err);
}

function persistState() {
  saveState(STATE_FILE, state);
}

async function handleAsk(payload) {
  if (state.running || currentRun) {
    throw new Error("A Codex run is already active.");
  }

  const prompt = String(payload?.prompt || "").trim();
  if (!prompt) {
    throw new Error("Prompt is required.");
  }

  state.running = true;
  state.lastUsedAt = new Date().toISOString();
  persistState();

  const run = runCodexTurn({
    codexBin: CODEX_BIN,
    codexHome: CODEX_HOME,
    cwd: state.cwd,
    model: state.model,
    prompt,
    threadId: state.activeThreadId,
    outputDir: DATA_DIR,
    yolo: CODEX_YOLO,
    useOss: CODEX_USE_OSS,
    localProvider: CODEX_LOCAL_PROVIDER,
    cancelFallbackMs: CANCEL_FALLBACK_MS,
    onLog: (line) => log(`runner: ${line}`),
  });

  const startedAt = Date.now();
  currentRun = {
    id: randomUUID(),
    prompt,
    startedAt,
    run,
  };

  log(
    `run started (thread=${state.activeThreadId || "new"}, prompt="${prompt.replace(/\s+/g, " ").slice(0, 100)}")`
  );

  const result = await run.promise;
  currentRun = null;
  state.running = false;
  state.lastUsedAt = new Date().toISOString();
  if (result.threadId) state.activeThreadId = result.threadId;
  persistState();

  const durationMs = Date.now() - startedAt;
  const stderrPreview = result.stderr.slice(-6);
  const errorPreview = result.errors.slice(-6);
  const notesPreview = result.notes.slice(-6);

  if (result.exitCode === 0) {
    log(`run done exit=0 durationMs=${durationMs}`);
    return {
      message: result.message || "",
      threadId: state.activeThreadId,
      exitCode: 0,
      durationMs,
      stderr: stderrPreview,
      errors: errorPreview,
      notes: notesPreview,
    };
  }

  const msgParts = [];
  msgParts.push(`Codex run failed (exit ${result.exitCode ?? "n/a"}).`);
  if (result.canceled) msgParts.push("Run was cancelled.");
  if (result.errors.length) msgParts.push(`Errors: ${result.errors.slice(-2).join(" | ")}`);
  if (result.stderr.length) msgParts.push(`Stderr: ${result.stderr.slice(-2).join(" | ")}`);

  const errorMessage = msgParts.join(" ");
  log(`run failed durationMs=${durationMs} reason=${errorMessage}`);

  const error = new Error(errorMessage);
  error.details = {
    message: result.message || "",
    threadId: state.activeThreadId,
    exitCode: result.exitCode,
    durationMs,
    stderr: stderrPreview,
    errors: errorPreview,
    notes: notesPreview,
  };
  throw error;
}

function handleNew() {
  if (state.running || currentRun) {
    throw new Error("Cannot reset thread while a run is active.");
  }
  state.activeThreadId = null;
  state.lastUsedAt = new Date().toISOString();
  persistState();
  log("thread reset requested");
  return {
    activeThreadId: null,
  };
}

function handleStatus() {
  return {
    pid: process.pid,
    socketPath: activeSocketPath,
    codexBin: CODEX_BIN,
    codexHome: CODEX_HOME,
    providerMode: CODEX_USE_OSS ? "oss" : "codex",
    yolo: CODEX_YOLO,
    localProvider: CODEX_LOCAL_PROVIDER,
    state: { ...state },
    activeRun: currentRun
      ? {
          id: currentRun.id,
          startedAt: new Date(currentRun.startedAt).toISOString(),
          durationMs: Date.now() - currentRun.startedAt,
          promptPreview: currentRun.prompt.slice(0, 120),
        }
      : null,
  };
}

function handleCancel() {
  if (!currentRun) {
    throw new Error("No active run to cancel.");
  }
  const sent = currentRun.run.cancel();
  if (!sent) {
    throw new Error("Could not send cancel signal.");
  }
  log("cancel requested");
  return { requested: true };
}

function handleLogs(payload) {
  const limitRaw = Number(payload?.limit || 200);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(500, limitRaw)) : 200;
  return {
    lines: recentLogs.slice(-limit),
  };
}

function initiateShutdown(reason = "shutdown-request") {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);

  const done = () => {
    removeFileIfExists(PID_FILE);
    removeFileIfExists(activeSocketPath);
    process.exit(0);
  };

  if (currentRun) {
    try {
      currentRun.run.cancel();
    } catch (_err) {
      // best effort
    }
  }

  if (!server) {
    done();
    return;
  }

  server.close(() => done());
  setTimeout(done, 3000);
}

async function dispatch(request) {
  const action = String(request?.action || "").trim();
  const payload = request?.payload || {};

  switch (action) {
    case "status":
      return handleStatus();
    case "ask":
      return await handleAsk(payload);
    case "new":
      return handleNew();
    case "cancel":
      return handleCancel();
    case "logs":
      return handleLogs(payload);
    case "stop":
      setTimeout(() => initiateShutdown("stop-action"), 10);
      return { stopping: true };
    default:
      throw new Error(`Unknown action: ${action || "<empty>"}`);
  }
}

function writeResponse(socket, response) {
  try {
    socket.write(encodeMessage(response));
  } finally {
    socket.end();
  }
}

function attachSocketHandler(socket) {
  let buffer = "";

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");

    for (;;) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) break;
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;

      let request;
      try {
        request = parseMessage(line);
      } catch (err) {
        writeResponse(socket, {
          id: randomUUID(),
          ok: false,
          data: null,
          error: `Invalid request JSON: ${trimErrorMessage(err)}`,
        });
        return;
      }

      const id = request?.id || randomUUID();
      Promise.resolve(dispatch(request))
        .then((data) => {
          writeResponse(socket, {
            id,
            ok: true,
            data,
            error: null,
          });
        })
        .catch((err) => {
          writeResponse(socket, {
            id,
            ok: false,
            data: err.details || null,
            error: trimErrorMessage(err),
          });
        });
      return;
    }
  });

  socket.on("error", (err) => {
    log(`socket error: ${trimErrorMessage(err)}`);
  });
}

function startServer() {
  const candidates = process.env.CODEXBOT_SOCKET_PATH
    ? [PRIMARY_SOCKET_PATH]
    : [PRIMARY_SOCKET_PATH, FALLBACK_SOCKET_PATH];

  function tryListen(index) {
    if (index >= candidates.length) {
      log("daemon socket error: no usable socket path");
      process.exit(1);
      return;
    }

    const socketPath = candidates[index];
    activeSocketPath = socketPath;
    removeFileIfExists(socketPath);

    server = net.createServer(attachSocketHandler);
    server.on("error", (err) => {
      const code = err && err.code ? String(err.code) : "";
      const canFallback = index < candidates.length - 1;
      if ((code === "EPERM" || code === "EACCES") && canFallback) {
        log(`socket path denied (${socketPath}), falling back to ${candidates[index + 1]}`);
        try {
          server.close();
        } catch (_err) {
          // ignore close errors while switching socket path
        }
        tryListen(index + 1);
        return;
      }

      log(`daemon socket error: ${trimErrorMessage(err)}`);
      process.exit(1);
    });

    server.listen(socketPath, () => {
      writePidFile();
      persistState();
      log(`codexbotd started pid=${process.pid} socket=${socketPath}`);
    });
  }

  tryListen(0);
}

process.on("SIGINT", () => initiateShutdown("sigint"));
process.on("SIGTERM", () => initiateShutdown("sigterm"));
process.on("uncaughtException", (err) => {
  log(`uncaught exception: ${trimErrorMessage(err)}`);
  initiateShutdown("uncaughtException");
});
process.on("unhandledRejection", (err) => {
  log(`unhandled rejection: ${trimErrorMessage(err)}`);
  initiateShutdown("unhandledRejection");
});

startServer();
