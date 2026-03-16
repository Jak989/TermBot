const fs = require("fs");
const path = require("path");
const https = require("https");
const dns = require("node:dns").promises;
const { spawn, spawnSync } = require("child_process");
const dotenv = require("dotenv");
const express = require("express");
const TelegramBot = require("node-telegram-bot-api");
const pty = require("node-pty");
const tmux = require("./scripts/lib/tmux-bridge");
const { validateInitData } = require("./scripts/lib/telegram-webapp-auth");
const {
  acquireProcessLock,
  releaseProcessLock,
  writeJson: writeRuntimeJson,
} = require("./scripts/lib/runtime-state");
const { appendRuntimeEvent } = require("./scripts/lib/runtime-events");
const { normalizeTurnOutput } = require("./scripts/lib/chat-output");
const { applyOstdeutschLexicon, detectDialectLevel } = require("./scripts/lib/schenni-style");

dotenv.config();

function readAndConsumeRestartContext(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { source: "", chatId: "", restartId: "" };
    }
    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (!raw) {
      fs.unlinkSync(filePath);
      return { source: "", chatId: "", restartId: "" };
    }
    const parsed = JSON.parse(raw);
    fs.unlinkSync(filePath);
    return {
      source: String(parsed?.source || "").trim().toLowerCase(),
      chatId: String(parsed?.chatId || "").trim(),
      restartId: String(parsed?.restartId || "").trim(),
    };
  } catch (_err) {
    return { source: "", chatId: "", restartId: "" };
  }
}

function writeRestartContext(filePath, source, chatId, restartId = "") {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          source: String(source || "").trim(),
          chatId: String(chatId || "").trim(),
          restartId: String(restartId || "").trim(),
          ts: new Date().toISOString(),
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (_err) {
    // ignore
  }
}

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_ALLOWED_USER_ID = String(process.env.TELEGRAM_ALLOWED_USER_ID || "").trim();
// V0.2(schenni): Slack runtime path is disabled for now to keep the chat pipeline focused.
const SLACK_BOT_ENABLED = false;
const SLACK_BOT_TOKEN = String(process.env.SLACK_BOT_TOKEN || "").trim();
const SLACK_APP_TOKEN = String(process.env.SLACK_APP_TOKEN || "").trim();
const SLACK_ALLOWED_USER_ID = String(process.env.SLACK_ALLOWED_USER_ID || "").trim();
const SLACK_ALLOWED_CHANNEL_ID = String(process.env.SLACK_ALLOWED_CHANNEL_ID || "").trim();
const SLACK_STARTUP_CHANNEL_ID = String(process.env.SLACK_STARTUP_CHANNEL_ID || "").trim();
const BOT_SHELL = process.env.BOT_SHELL || "/bin/zsh";
const BOT_CWD = process.env.BOT_CWD || path.resolve(__dirname);
const BOT_TIMEOUT_MS = Number(process.env.BOT_TIMEOUT_MS || 900000);
const BOT_STATUS_INTERVAL_MS = Number(process.env.BOT_STATUS_INTERVAL_MS || 0);
const BOT_LIVE_STATUS_INTERVAL_MS = Number(process.env.BOT_LIVE_STATUS_INTERVAL_MS || 2000);
const BOT_ENTER_FALLBACK_MS = Number(process.env.BOT_ENTER_FALLBACK_MS || 1200);
const BOT_SUBMIT_MAX_ATTEMPTS = Number.isFinite(Number(process.env.BOT_SUBMIT_MAX_ATTEMPTS))
  ? Math.max(3, Math.min(12, Number(process.env.BOT_SUBMIT_MAX_ATTEMPTS)))
  : 8;
const BOT_CAPTURE_LINES = Number(process.env.BOT_CAPTURE_LINES || 120);
const BOT_TURN_IDLE_DONE_MS = Number(process.env.BOT_TURN_IDLE_DONE_MS || 5000);
const BOT_TURN_FORCE_DONE_MS = Number.isFinite(Number(process.env.BOT_TURN_FORCE_DONE_MS))
  ? Math.max(BOT_TURN_IDLE_DONE_MS, Number(process.env.BOT_TURN_FORCE_DONE_MS))
  : 30000;
const BOT_CODEX_READY_TIMEOUT_MS = Number.isFinite(Number(process.env.BOT_CODEX_READY_TIMEOUT_MS))
  ? Math.max(1000, Number(process.env.BOT_CODEX_READY_TIMEOUT_MS))
  : 15000;
const BOT_CODEX_BACKEND = String(process.env.BOT_CODEX_BACKEND || "tmux").toLowerCase();
const BOT_CODEX_MODEL_DEFAULT = String(process.env.BOT_CODEX_MODEL || process.env.CODEX_MODEL || "gpt-5.4").trim() || "gpt-5.4";
const BOT_CODEX_REASONING_DEFAULT = String(process.env.BOT_CODEX_REASONING_EFFORT || "standard").trim().toLowerCase() || "standard";
const BOT_TMUX_BIN = process.env.BOT_TMUX_BIN || "tmux";
const BOT_PROMPT_ON_START = String(process.env.BOT_PROMPT_ON_START || "1") !== "0";
const BOT_AUTO_START_CODEX = String(process.env.BOT_AUTO_START_CODEX || "1") !== "0";
const BOT_STARTUP_SEND_PANEL = String(process.env.BOT_STARTUP_SEND_PANEL || "1") !== "0";
const BOT_STARTUP_BOOT_DELAY_MS = Number.isFinite(Number(process.env.BOT_STARTUP_BOOT_DELAY_MS))
  ? Number(process.env.BOT_STARTUP_BOOT_DELAY_MS)
  : 1500;
const BOT_STARTUP_CHAT_ID = String(process.env.BOT_STARTUP_CHAT_ID || "").trim();
const BOT_WEBAPP_URL = String(process.env.BOT_WEBAPP_URL || "").trim();
const BOT_CLOUDFLARE_TUNNEL_MODE = String(process.env.BOT_CLOUDFLARE_TUNNEL_MODE || "auto").trim().toLowerCase();
const BOT_CLOUDFLARE_TUNNEL_NAME = String(process.env.BOT_CLOUDFLARE_TUNNEL_NAME || "").trim();
const BOT_CLOUDFLARE_TUNNEL_HOSTNAME = String(process.env.BOT_CLOUDFLARE_TUNNEL_HOSTNAME || "").trim();
const BOT_CLOUDFLARE_CONFIG_PATH = String(process.env.BOT_CLOUDFLARE_CONFIG_PATH || "").trim();
const BOT_TUNNEL_AUTO_RESTORE = String(process.env.BOT_TUNNEL_AUTO_RESTORE || "1") !== "0";
const BOT_TUNNEL_START_TIMEOUT_MS = Number.isFinite(Number(process.env.BOT_TUNNEL_START_TIMEOUT_MS))
  ? Number(process.env.BOT_TUNNEL_START_TIMEOUT_MS)
  : 10000;
const BOT_WEB_HOST = process.env.BOT_WEB_HOST || "127.0.0.1";
const BOT_WEB_PORT = Number.isFinite(Number(process.env.BOT_WEB_PORT))
  ? Number(process.env.BOT_WEB_PORT)
  : 8787;
const BOT_WEBAPP_ENABLE = String(process.env.BOT_WEBAPP_ENABLE || "1") !== "0";
const BOT_WEBAPP_AUTO_MENU = String(process.env.BOT_WEBAPP_AUTO_MENU || "1") !== "0";
const BOT_WEBAPP_REFRESH_MS = Number.isFinite(Number(process.env.BOT_WEBAPP_REFRESH_MS))
  ? Number(process.env.BOT_WEBAPP_REFRESH_MS)
  : 1200;
const BOT_WEBAPP_MAX_SCREEN_CHARS = Number.isFinite(Number(process.env.BOT_WEBAPP_MAX_SCREEN_CHARS))
  ? Number(process.env.BOT_WEBAPP_MAX_SCREEN_CHARS)
  : 8000;
const BOT_CHAT_CODEX_FEEDBACK = String(process.env.BOT_CHAT_CODEX_FEEDBACK || "0") !== "0";
const BOT_CHAT_INCLUDE_SYSTEM_META = String(process.env.BOT_CHAT_INCLUDE_SYSTEM_META || "0") !== "0";
const BOT_CHAT_SEND_THINKING_MARKER = String(process.env.BOT_CHAT_SEND_THINKING_MARKER || "0") !== "0";
const BOT_CHAT_SEND_DONE_MARKER = String(process.env.BOT_CHAT_SEND_DONE_MARKER || "0") !== "0";
const BOT_CHAT_TYPING_ACTION = String(process.env.BOT_CHAT_TYPING_ACTION || "1") !== "0";
const BOT_CHAT_TYPING_INTERVAL_MS = Number.isFinite(Number(process.env.BOT_CHAT_TYPING_INTERVAL_MS))
  ? Math.max(1500, Number(process.env.BOT_CHAT_TYPING_INTERVAL_MS))
  : 3500;
const BOT_CHAT_THINKING_MARKER_DELAY_MS = Number.isFinite(Number(process.env.BOT_CHAT_THINKING_MARKER_DELAY_MS))
  ? Math.max(1000, Number(process.env.BOT_CHAT_THINKING_MARKER_DELAY_MS))
  : 12000;
const BOT_REPLY_BUTTONS_ENABLED = String(process.env.BOT_REPLY_BUTTONS_ENABLED || "1") !== "0";
const BOT_CHAT_ESSENTIAL_MAX_CHARS = Number.isFinite(Number(process.env.BOT_CHAT_ESSENTIAL_MAX_CHARS))
  ? Math.max(120, Number(process.env.BOT_CHAT_ESSENTIAL_MAX_CHARS))
  : 320;
const BOT_CHAT_ESSENTIAL_MAX_LINES = Number.isFinite(Number(process.env.BOT_CHAT_ESSENTIAL_MAX_LINES))
  ? Math.max(1, Number(process.env.BOT_CHAT_ESSENTIAL_MAX_LINES))
  : 4;
const BOT_ENABLE_RESTART_COMMAND = String(process.env.BOT_ENABLE_RESTART_COMMAND || "1") !== "0";
const BOT_SINGLE_INSTANCE = String(process.env.BOT_SINGLE_INSTANCE || "1") !== "0";
const BOT_RESTART_HEALTH_TIMEOUT_MS = Number.isFinite(Number(process.env.BOT_RESTART_HEALTH_TIMEOUT_MS))
  ? Math.max(1500, Number(process.env.BOT_RESTART_HEALTH_TIMEOUT_MS))
  : 15000;
const BOT_RESTART_READY_FILE_RAW = String(process.env.BOT_RESTART_READY_FILE || "data/runtime/restart-ready.json").trim();
const BOT_PERSONALITY_AUTO_APPLY = String(process.env.BOT_PERSONALITY_AUTO_APPLY || "1") !== "0";
const BOT_PERSONALITY_FILE = String(process.env.BOT_PERSONALITY_FILE || "V3_PERSONALITY.md").trim() || "V3_PERSONALITY.md";
const BOT_PERSONALITY_MAX_CHARS = Number.isFinite(Number(process.env.BOT_PERSONALITY_MAX_CHARS))
  ? Math.max(500, Number(process.env.BOT_PERSONALITY_MAX_CHARS))
  : 12000;
const BOT_PREFERENCE_LEARNING = String(process.env.BOT_PREFERENCE_LEARNING || "1") !== "0";
const BOT_PREFERENCE_LEARNING_MAX_HINTS = Number.isFinite(Number(process.env.BOT_PREFERENCE_LEARNING_MAX_HINTS))
  ? Math.max(3, Math.min(60, Number(process.env.BOT_PREFERENCE_LEARNING_MAX_HINTS)))
  : 20;
const RESOLVED_CODEX_HOME = (() => {
  const configured = String(process.env.CODEX_HOME || "").trim();
  if (configured) return configured;
  const home = String(process.env.HOME || "").trim();
  if (home) return path.join(home, ".codex");
  return path.join(__dirname, ".codex");
})();
const BOT_VOICE_ENABLED = String(process.env.BOT_VOICE_ENABLED || "1") !== "0";
const BOT_VOICE_MAX_DURATION_SEC = Number.isFinite(Number(process.env.BOT_VOICE_MAX_DURATION_SEC))
  ? Math.max(5, Number(process.env.BOT_VOICE_MAX_DURATION_SEC))
  : 240;
const BOT_VOICE_TRANSCRIBE_BIN = String(process.env.BOT_VOICE_TRANSCRIBE_BIN || "python3").trim() || "python3";
const BOT_VOICE_TRANSCRIBE_SCRIPT = String(
  process.env.BOT_VOICE_TRANSCRIBE_SCRIPT ||
    path.join(RESOLVED_CODEX_HOME, "skills", "transcribe", "scripts", "transcribe_diarize.py")
).trim();
const BOT_VOICE_TRANSCRIBE_MODEL = String(process.env.BOT_VOICE_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe").trim();
const BOT_VOICE_LANGUAGE = String(process.env.BOT_VOICE_LANGUAGE || "").trim();
const BOT_VOICE_ECHO_TRANSCRIPT = String(process.env.BOT_VOICE_ECHO_TRANSCRIPT || "1") !== "0";
const BOT_VOICE_KEEP_FILES = String(process.env.BOT_VOICE_KEEP_FILES || "0") === "1";
const BOT_VOICE_TRANSCRIBE_TIMEOUT_MS = Number.isFinite(Number(process.env.BOT_VOICE_TRANSCRIBE_TIMEOUT_MS))
  ? Math.max(10_000, Number(process.env.BOT_VOICE_TRANSCRIBE_TIMEOUT_MS))
  : 180_000;

const OUTPUT_CHUNK_SIZE = 3400;
const TELEGRAM_TEXT_CHUNK_CHARS = 3500;
const MAX_OUTPUT_CHARS = 50000;
const CANCEL_FALLBACK_MS = 2500;
const STREAM_FLUSH_MS = 1500;
const MARKER_TAIL_KEEP = 256;
const TMUX_SESSION_PREFIX = "codexbot_";
const MAX_CAPTURE_CHARS = 1800;
const MAX_EVENT_LOG = 200;
const REPLY_BUTTON_COOLDOWN_MS = 45000;
const TELEGRAM_CONFLICT_WINDOW_MS = 60_000;
const TELEGRAM_CONFLICT_MAX = 5;
const CHAT_PIPELINE_VERSION = "V2(schenni)";
const CHAT_PIPELINE_RELEASE_LABEL = "chat_pipeline_v2_schenni";
const TELEGRAM_INIT_HEADER = "x-telegram-init-data";
const MINIAPP_AUTH_MAX_AGE_SECONDS = 24 * 60 * 60;
const MINIAPP_INPUT_MAX_CHARS = 4000;
const MINIAPP_RATE_WINDOW_MS = Number.isFinite(Number(process.env.MINIAPP_RATE_WINDOW_MS))
  ? Math.max(1000, Number(process.env.MINIAPP_RATE_WINDOW_MS))
  : 60_000;
const MINIAPP_RATE_LIMIT_LIVE = Number.isFinite(Number(process.env.MINIAPP_RATE_LIMIT_LIVE))
  ? Math.max(30, Number(process.env.MINIAPP_RATE_LIMIT_LIVE))
  : 180;
const MINIAPP_RATE_LIMIT_INPUT = Number.isFinite(Number(process.env.MINIAPP_RATE_LIMIT_INPUT))
  ? Math.max(5, Number(process.env.MINIAPP_RATE_LIMIT_INPUT))
  : 40;
const DEFAULT_SCREEN_TEXT = "(no output yet)";
const PTY_ENTER = "\r";
const RECENT_PROJECTS_PATH = path.join(__dirname, "data", "recent-projects.json");
const USER_PROFILE_PATH = path.join(__dirname, "data", "user-profile.json");
const USER_PREFERENCE_HINTS_PATH = path.join(__dirname, "data", "user-preference-hints.json");
const MODEL_PROFILE_PATH = path.join(__dirname, "data", "model-profile.json");
const REMINDERS_PATH = path.join(__dirname, "data", "reminders.json");
const PERSONALITY_PRESETS_DIR = path.join(__dirname, "personality-presets");
const MAX_RECENT_PROJECTS = 12;
const MAX_REMINDER_TEXT_CHARS = 280;
const MAX_REMINDERS = 200;
const VOICE_INPUT_DIR = path.join(__dirname, "data", "voice");
const ENV_FILE_PATH = path.join(__dirname, ".env");
const CLOUDFLARED_LOG_PATH = path.join(__dirname, "data", "cloudflared.log");
const CLOUDFLARED_PID_PATH = path.join(__dirname, "data", "cloudflared.pid");
const ACTIVITY_LOG_PATH = path.join(__dirname, "data", "activity-log.jsonl");
const BOT_RUNTIME_DIR = path.join(__dirname, "data", "runtime");
const BOT_RUNTIME_LOCK_PATH = path.join(BOT_RUNTIME_DIR, "bot.lock");
const BOT_RUNTIME_EVENTS_PATH = path.join(BOT_RUNTIME_DIR, "events.jsonl");
const BOT_RUNTIME_STATE_PATH = path.join(BOT_RUNTIME_DIR, "state.json");
const BOT_RESTART_HELPER_PATH = path.join(__dirname, "scripts", "restart-bot-helper.js");
const BOT_RESTART_LOG_PATH = "/tmp/termbot-restart.log";
const BOT_RUNTIME_LOG_PATH = "/tmp/termbot-bot.log";
const BOT_PROJECT_ROOT = path.resolve(__dirname);
const BOT_RESTART_CONTEXT_PATH = path.join(__dirname, "data", "restart-context.json");
const BOT_RESTART_READY_FILE = path.isAbsolute(BOT_RESTART_READY_FILE_RAW)
  ? BOT_RESTART_READY_FILE_RAW
  : path.join(__dirname, BOT_RESTART_READY_FILE_RAW);
const BOT_SUPERVISED = String(process.env.TERMBOT_SUPERVISED || "0") === "1";
const restartContext = readAndConsumeRestartContext(BOT_RESTART_CONTEXT_PATH);
const BOT_RESTART_BOOT_SOURCE =
  String(process.env.TERMBOT_RESTART_SOURCE || "").trim().toLowerCase() || restartContext.source;
const BOT_RESTART_BOOT_CHAT_ID = String(process.env.TERMBOT_RESTART_CHAT_ID || "").trim() || restartContext.chatId;
const BOT_RESTART_BOOT_ID = String(process.env.TERMBOT_RESTART_ID || "").trim() || restartContext.restartId;
const BOT_FORCE_CODEX_ON_RESTART = String(process.env.BOT_FORCE_CODEX_ON_RESTART || "1") !== "0";
const NOTION_SYNC_ENABLED = String(process.env.NOTION_SYNC_ENABLED || "0") === "1";
const NOTION_API_TOKEN = String(process.env.NOTION_API_TOKEN || "").trim();
const NOTION_DATABASE_ID_RAW = String(process.env.NOTION_DATABASE_ID || "").trim();
const NOTION_SYNC_MODE = String(process.env.NOTION_SYNC_MODE || "auto").trim().toLowerCase();
const RESOLVED_CODEX_BIN = String(process.env.CODEX_BIN || "codex").trim() || "codex";
const NOTION_SYNC_CODEX_BIN = String(process.env.NOTION_SYNC_CODEX_BIN || process.env.CODEX_BIN || "codex").trim() || "codex";
const NOTION_SYNC_CODEX_MODEL = String(process.env.NOTION_SYNC_CODEX_MODEL || "").trim();
const NOTION_SYNC_CODEX_TIMEOUT_MS = Number.isFinite(Number(process.env.NOTION_SYNC_CODEX_TIMEOUT_MS))
  ? Math.max(20_000, Number(process.env.NOTION_SYNC_CODEX_TIMEOUT_MS))
  : 120_000;
const NOTION_TIMEOUT_MS = Number.isFinite(Number(process.env.NOTION_TIMEOUT_MS))
  ? Math.max(1500, Number(process.env.NOTION_TIMEOUT_MS))
  : 8000;
const NOTION_API_VERSION = "2022-06-28";
const NOTION_TITLE_MAX_CHARS = 180;
const NOTION_RICH_TEXT_MAX_CHARS = 1800;
const NOTION_MAX_SYNC_RETRIES = 3;

const notionDatabaseId = normalizeNotionDatabaseId(NOTION_DATABASE_ID_RAW);
const notionSyncQueue = [];
let notionSyncRunning = false;
let notionTitlePropertyName = "";

if (!TELEGRAM_BOT_TOKEN) {
  throw new Error("Missing TELEGRAM_BOT_TOKEN in environment.");
}

if (!TELEGRAM_ALLOWED_USER_ID) {
  throw new Error("Missing TELEGRAM_ALLOWED_USER_ID in environment.");
}

let runtimeLockHeld = false;
if (BOT_SINGLE_INSTANCE) {
  const lockResult = acquireProcessLock(BOT_RUNTIME_LOCK_PATH, {
    pid: process.pid,
    role: "bot",
    startedAt: new Date().toISOString(),
    cwd: BOT_PROJECT_ROOT,
  });
  if (!lockResult.ok) {
    const existingPid = Number(lockResult?.existing?.pid || 0);
    console.error(
      lockResult.reason === "already_locked"
        ? `[runtime] single-instance guard: bot already running pid=${existingPid || "unknown"}`
        : `[runtime] single-instance guard failed: ${lockResult.reason || "unknown"}`
    );
    process.exit(1);
  }
  runtimeLockHeld = true;
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });
let slackApp = null;

process.on("unhandledRejection", (reason) => {
  const detail = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error("[runtime] unhandledRejection:", detail);
});

process.on("uncaughtException", (err) => {
  console.error("[runtime] uncaughtException:", err?.stack || err?.message || String(err));
});

let shutdownSignalHandled = false;
function handleShutdownSignal(signalName) {
  if (shutdownSignalHandled) return;
  shutdownSignalHandled = true;
  console.error(`[runtime] received ${signalName}, shutting down`);
  setTimeout(() => {
    process.exit(0);
  }, 120);
}

process.on("SIGTERM", () => handleShutdownSignal("SIGTERM"));
process.on("SIGINT", () => handleShutdownSignal("SIGINT"));

process.on("exit", (code) => {
  if (runtimeLockHeld) {
    releaseProcessLock(BOT_RUNTIME_LOCK_PATH, process.pid);
    runtimeLockHeld = false;
  }
  console.error(`[runtime] process exit code=${code}`);
});

function ensureExecutableIfNeeded(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.statSync(filePath);
  const mode = stat.mode & 0o777;
  if ((mode & 0o111) !== 0) return;
  fs.chmodSync(filePath, mode | 0o755);
}

function ensureNodePtyHelperExecutable() {
  try {
    const nodePtyRoot = path.dirname(require.resolve("node-pty/package.json"));
    const helperPrebuild = path.join(
      nodePtyRoot,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper"
    );
    const helperBuild = path.join(nodePtyRoot, "build", "Release", "spawn-helper");
    ensureExecutableIfNeeded(helperPrebuild);
    ensureExecutableIfNeeded(helperBuild);
  } catch (err) {
    console.warn("Could not verify node-pty helper permissions:", err.message);
  }
}

function resolveShellPath(requestedShell) {
  if (requestedShell && fs.existsSync(requestedShell)) return requestedShell;
  if (fs.existsSync("/bin/zsh")) return "/bin/zsh";
  return "/bin/sh";
}

function resolveCwd(requestedCwd) {
  if (requestedCwd && fs.existsSync(requestedCwd)) return requestedCwd;
  return path.resolve(__dirname);
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

function splitText(text, chunkSize) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks.length ? chunks : [""];
}

function ensureParentDir(filePath) {
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeNotionDatabaseId(value) {
  const input = String(value || "").trim();
  if (!input) return "";
  const compactUuid = input.match(/[0-9a-fA-F]{32}/);
  if (compactUuid && compactUuid[0]) {
    const v = compactUuid[0].toLowerCase();
    return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
  }
  const dashedUuid = input.match(/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/);
  if (dashedUuid && dashedUuid[0]) return dashedUuid[0].toLowerCase();
  return "";
}

function shortenText(input, maxChars) {
  const text = String(input || "").trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function chunkText(input, chunkSize) {
  const text = String(input || "");
  if (!text) return [];
  const out = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    out.push(text.slice(i, i + chunkSize));
  }
  return out;
}

function notionSyncModeResolved() {
  if (NOTION_SYNC_MODE === "api") return "api";
  if (NOTION_SYNC_MODE === "mcp") return "mcp";
  return NOTION_API_TOKEN ? "api" : "mcp";
}

function notionSyncConfigured() {
  if (!NOTION_SYNC_ENABLED) return false;
  if (!notionDatabaseId) return false;
  const mode = notionSyncModeResolved();
  if (mode === "api") return Boolean(NOTION_API_TOKEN);
  return true;
}

function appendActivityLocal(entry) {
  try {
    ensureParentDir(ACTIVITY_LOG_PATH);
    fs.appendFileSync(ACTIVITY_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (err) {
    console.warn("Failed to write activity log:", err.message);
  }
}

function buildNotionParagraphBlocks(details) {
  const chunks = chunkText(String(details || "").trim(), NOTION_RICH_TEXT_MAX_CHARS);
  return chunks.map((content) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [
        {
          type: "text",
          text: { content },
        },
      ],
    },
  }));
}

function notionApiRequest(method, apiPath, payload) {
  return new Promise((resolve, reject) => {
    if (!NOTION_API_TOKEN) {
      reject(new Error("NOTION_API_TOKEN is missing."));
      return;
    }
    const body = payload ? JSON.stringify(payload) : "";
    const req = https.request(
      {
        hostname: "api.notion.com",
        port: 443,
        path: apiPath,
        method,
        timeout: NOTION_TIMEOUT_MS,
        headers: {
          Authorization: `Bearer ${NOTION_API_TOKEN}`,
          "Notion-Version": NOTION_API_VERSION,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          let parsed = {};
          try {
            parsed = raw ? JSON.parse(raw) : {};
          } catch (_err) {
            parsed = {};
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
            return;
          }
          const message = parsed.message || raw || "unknown error";
          reject(new Error(`Notion API ${method} ${apiPath} failed (${res.statusCode}): ${message}`));
        });
      }
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Notion API timeout after ${NOTION_TIMEOUT_MS}ms`));
    });
    req.on("error", (err) => {
      reject(err);
    });
    req.write(body);
    req.end();
  });
}

async function ensureNotionTitlePropertyName() {
  if (notionTitlePropertyName) return notionTitlePropertyName;
  const database = await notionApiRequest("GET", `/v1/databases/${notionDatabaseId}`);
  const properties = database?.properties && typeof database.properties === "object" ? database.properties : {};
  for (const [name, descriptor] of Object.entries(properties)) {
    if (descriptor && descriptor.type === "title") {
      notionTitlePropertyName = name;
      return notionTitlePropertyName;
    }
  }
  throw new Error("No title property found in NOTION_DATABASE_ID.");
}

async function syncActivityToNotionViaApi(entry) {
  const titlePropertyName = await ensureNotionTitlePropertyName();
  const title = shortenText(entry.title || "Aktivitaet", NOTION_TITLE_MAX_CHARS);
  const lines = [
    `Typ: ${entry.type}`,
    `Zeit: ${entry.createdAt}`,
    `Quelle: ${entry.source || "telegram-bot"}`,
    `Chat-ID: ${entry.chatId || "-"}`,
  ];
  if (entry.details) lines.push("", String(entry.details));
  const children = buildNotionParagraphBlocks(lines.join("\n"));
  const payload = {
    parent: { database_id: notionDatabaseId },
    properties: {
      [titlePropertyName]: {
        title: [
          {
            type: "text",
            text: { content: title || "Aktivitaet" },
          },
        ],
      },
    },
    children,
  };
  await notionApiRequest("POST", "/v1/pages", payload);
}

function readFileMaybe(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    return fs.readFileSync(filePath, "utf8");
  } catch (_err) {
    return "";
  }
}

function runCodexExecPrompt(prompt) {
  return new Promise((resolve, reject) => {
    const outPath = path.join(
      __dirname,
      "data",
      `notion-sync-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.txt`
    );
    const args = [
      "exec",
      "--skip-git-repo-check",
      "-C",
      RESOLVED_BOT_CWD,
      "-s",
      "read-only",
      "-o",
      outPath,
    ];
    if (NOTION_SYNC_CODEX_MODEL) {
      args.push("-m", NOTION_SYNC_CODEX_MODEL);
    }
    args.push(String(prompt || ""));

    let stderr = "";
    let timedOut = false;
    const child = spawn(NOTION_SYNC_CODEX_BIN, args, {
      cwd: RESOLVED_BOT_CWD,
      env: process.env,
      stdio: ["ignore", "ignore", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch (_err) {
        // ignore
      }
    }, NOTION_SYNC_CODEX_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 6000) {
        stderr = stderr.slice(stderr.length - 6000);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      const out = readFileMaybe(outPath);
      try {
        fs.unlinkSync(outPath);
      } catch (_err) {
        // ignore
      }
      if (timedOut) {
        reject(new Error(`codex exec timed out after ${NOTION_SYNC_CODEX_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        const hint = stderr.trim() || out.trim() || "codex exec failed";
        reject(new Error(hint));
        return;
      }
      resolve(out.trim());
    });
  });
}

async function syncActivityToNotionViaMcp(entry) {
  const title = shortenText(entry.title || "Aktivitaet", NOTION_TITLE_MAX_CHARS);
  const lines = [
    `Typ: ${entry.type}`,
    `Zeit: ${entry.createdAt}`,
    `Quelle: ${entry.source || "telegram-bot"}`,
    `Chat-ID: ${entry.chatId || "-"}`,
  ];
  if (entry.details) lines.push("", String(entry.details));

  const prompt = [
    "Nutze ausschliesslich Notion MCP Tools. Fuehre keine Shell-Befehle aus.",
    "Erstelle genau eine neue Seite in der folgenden Notion Datenquelle:",
    `collection://${notionDatabaseId}`,
    "",
    "Seitentitel:",
    title,
    "",
    "Inhalt:",
    lines.join("\n"),
    "",
    "Antworte nur mit: OK",
  ].join("\n");

  const result = await runCodexExecPrompt(prompt);
  if (result && !/\bok\b/i.test(result)) {
    // Even if Codex didn't return exactly OK, the run may still have created the page.
    console.warn("Notion MCP sync finished with non-OK response:", shortenText(result, 220));
  }
}

async function syncActivityToNotion(entry) {
  if (notionSyncModeResolved() === "api") {
    await syncActivityToNotionViaApi(entry);
    return;
  }
  await syncActivityToNotionViaMcp(entry);
}

async function drainNotionSyncQueue() {
  if (notionSyncRunning) return;
  notionSyncRunning = true;
  try {
    while (notionSyncQueue.length > 0) {
      const current = notionSyncQueue[0];
      try {
        await syncActivityToNotion(current);
        notionSyncQueue.shift();
      } catch (err) {
        current.attempts = Number(current.attempts || 0) + 1;
        if (current.attempts >= NOTION_MAX_SYNC_RETRIES) {
          console.warn("Dropping Notion sync entry after retries:", err.message);
          notionSyncQueue.shift();
        } else {
          console.warn(`Notion sync retry ${current.attempts}/${NOTION_MAX_SYNC_RETRIES}:`, err.message);
          await sleep(Math.min(3000, current.attempts * 800));
        }
      }
    }
  } finally {
    notionSyncRunning = false;
  }
}

function recordActivity(type, title, details, chatId = "") {
  const entry = {
    type: String(type || "activity"),
    title: shortenText(title || "Aktivitaet", NOTION_TITLE_MAX_CHARS),
    details: String(details || "").trim(),
    chatId: String(chatId || "").trim(),
    source: "telegram-bot",
    createdAt: new Date().toISOString(),
  };
  appendActivityLocal(entry);
  if (!notionSyncConfigured()) return;
  notionSyncQueue.push({ ...entry, attempts: 0 });
  void drainNotionSyncQueue();
}

function logNotionSyncStatus() {
  if (!NOTION_SYNC_ENABLED) {
    console.log("Notion sync: disabled (set NOTION_SYNC_ENABLED=1 to enable).");
    return;
  }
  if (!notionDatabaseId) {
    console.log("Notion sync: disabled (NOTION_DATABASE_ID missing/invalid).");
    return;
  }
  const mode = notionSyncModeResolved();
  if (mode === "api" && !NOTION_API_TOKEN) {
    console.log("Notion sync: disabled (mode=api but NOTION_API_TOKEN missing).");
    return;
  }
  if (mode === "api") {
    console.log(`Notion sync: enabled (mode=api, database=${notionDatabaseId}).`);
    return;
  }
  console.log(`Notion sync: enabled (mode=mcp, database=${notionDatabaseId}, bin=${NOTION_SYNC_CODEX_BIN}).`);
}

function readPidFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf8").trim();
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    return pid;
  } catch (_err) {
    return null;
  }
}

function writePidFile(filePath, pid) {
  ensureParentDir(filePath);
  fs.writeFileSync(filePath, `${pid}\n`, "utf8");
}

function clearPidFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_err) {
    // ignore
  }
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

function commandLineForPid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return "";
  try {
    const probe = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
    });
    if (!probe || probe.status !== 0) return "";
    return String(probe.stdout || "").trim();
  } catch (_err) {
    return "";
  }
}

function listProjectBotPids() {
  try {
    const probe = spawnSync("pgrep", ["-f", path.join(BOT_PROJECT_ROOT, "bot.js")], {
      encoding: "utf8",
    });
    if (!probe || probe.status !== 0) return [];
    return String(probe.stdout || "")
      .split(/\r?\n/g)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
  } catch (_err) {
    return [];
  }
}

function isProjectBotPid(pid) {
  const cmd = commandLineForPid(pid);
  if (!cmd) return false;
  return cmd.includes(path.join(BOT_PROJECT_ROOT, "bot.js"));
}

function findListeningPidForPort(port) {
  const safePort = Number(port);
  if (!Number.isSafeInteger(safePort) || safePort <= 0) return 0;
  try {
    const probe = spawnSync("lsof", ["-nP", "-t", `-iTCP:${safePort}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    });
    if (!probe || probe.status !== 0) return 0;
    const line = String(probe.stdout || "")
      .split(/\r?\n/g)
      .map((item) => item.trim())
      .find(Boolean);
    const pid = Number(line || 0);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  } catch (_err) {
    return 0;
  }
}

async function terminatePidGracefully(pid, timeoutMs = 2500) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  if (!isPidAlive(pid)) return true;
  try {
    process.kill(pid, "SIGTERM");
  } catch (_err) {
    return false;
  }
  const exited = await waitForProcessExit(pid, timeoutMs);
  if (exited) return true;
  try {
    process.kill(pid, "SIGKILL");
  } catch (_err) {
    return false;
  }
  return waitForProcessExit(pid, 1000);
}

async function cleanupOtherProjectBotProcesses() {
  const pids = listProjectBotPids().filter((pid) => pid !== process.pid);
  let cleaned = 0;
  for (const pid of pids) {
    const ok = await terminatePidGracefully(pid, 1800);
    if (ok) cleaned += 1;
  }
  return cleaned;
}

function parseTryCloudflareUrl(text) {
  const matches = String(text || "").match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi);
  if (!matches || !matches.length) return "";
  return matches[matches.length - 1];
}

function readCloudflaredUrlFromLog() {
  try {
    if (!fs.existsSync(CLOUDFLARED_LOG_PATH)) return "";
    const raw = fs.readFileSync(CLOUDFLARED_LOG_PATH, "utf8");
    return parseTryCloudflareUrl(raw);
  } catch (_err) {
    return "";
  }
}

function updateEnvValue(key, value) {
  const normalizedKey = String(key || "").trim();
  if (!normalizedKey) return;
  const serialized = `${normalizedKey}=${String(value || "")}`;
  let lines = [];
  try {
    if (fs.existsSync(ENV_FILE_PATH)) {
      lines = fs.readFileSync(ENV_FILE_PATH, "utf8").split(/\r?\n/);
    }
  } catch (_err) {
    lines = [];
  }

  let replaced = false;
  const nextLines = lines.map((line) => {
    if (line.startsWith(`${normalizedKey}=`)) {
      replaced = true;
      return serialized;
    }
    return line;
  });
  if (!replaced) {
    if (nextLines.length && nextLines[nextLines.length - 1] !== "") {
      nextLines.push("");
    }
    nextLines.push(serialized);
  }

  ensureParentDir(ENV_FILE_PATH);
  fs.writeFileSync(ENV_FILE_PATH, `${nextLines.join("\n").replace(/\n*$/, "\n")}`, "utf8");
}

function readRecentProjects() {
  try {
    if (!fs.existsSync(RECENT_PROJECTS_PATH)) return [];
    const raw = fs.readFileSync(RECENT_PROJECTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item) => item && typeof item.id === "string" && typeof item.command === "string")
      .map((item) => ({
        id: item.id,
        key: String(item.key || ""),
        command: String(item.command || "codex"),
        cwd: resolveCwd(item.cwd || RESOLVED_BOT_CWD),
        projectName: String(item.projectName || path.basename(resolveCwd(item.cwd || RESOLVED_BOT_CWD))),
        starts: Number.isFinite(Number(item.starts)) ? Number(item.starts) : 1,
        lastStartedAt: String(item.lastStartedAt || new Date().toISOString()),
        lastFinishedAt: item.lastFinishedAt ? String(item.lastFinishedAt) : "",
        lastReason: item.lastReason ? String(item.lastReason) : "",
      }))
      .slice(0, MAX_RECENT_PROJECTS);
  } catch (err) {
    console.warn("Failed to read recent projects:", err.message);
    return [];
  }
}

function writeRecentProjects(projects) {
  try {
    ensureParentDir(RECENT_PROJECTS_PATH);
    fs.writeFileSync(RECENT_PROJECTS_PATH, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn("Failed to write recent projects:", err.message);
  }
}

const MODEL_ALIASES = new Map([
  ["5.4", "gpt-5.4"],
  ["gpt-5.4", "gpt-5.4"],
  ["5.3-codex", "gpt-5.3-codex"],
  ["gpt-5.3-codex", "gpt-5.3-codex"],
]);

function normalizeModelName(value) {
  const lowered = String(value || "").trim().toLowerCase();
  if (!lowered) return "";
  if (MODEL_ALIASES.has(lowered)) return MODEL_ALIASES.get(lowered) || "";
  if (/^gpt-[a-z0-9._-]+$/.test(lowered)) return lowered;
  return "";
}

function normalizeReasoningEffort(value) {
  const lowered = String(value || "").trim().toLowerCase();
  if (!lowered) return "";
  if (["high", "deep", "max"].includes(lowered)) return "high";
  if (["standard", "std", "default", "medium", "normal"].includes(lowered)) return "standard";
  return "";
}

function reasoningEffortCliValue(value) {
  return normalizeReasoningEffort(value) === "high" ? "high" : "medium";
}

function defaultModelProfile() {
  return {
    model: normalizeModelName(BOT_CODEX_MODEL_DEFAULT) || "gpt-5.4",
    reasoningEffort: normalizeReasoningEffort(BOT_CODEX_REASONING_DEFAULT) || "standard",
    updatedAt: "",
    schemaVersion: 1,
  };
}

function readModelProfile() {
  try {
    if (!fs.existsSync(MODEL_PROFILE_PATH)) return defaultModelProfile();
    const raw = fs.readFileSync(MODEL_PROFILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultModelProfile();
    return {
      ...defaultModelProfile(),
      model: normalizeModelName(parsed.model || "") || defaultModelProfile().model,
      reasoningEffort: normalizeReasoningEffort(parsed.reasoningEffort || "") || defaultModelProfile().reasoningEffort,
      updatedAt: String(parsed.updatedAt || "").trim(),
      schemaVersion: 1,
    };
  } catch (err) {
    console.warn("Failed to read model profile:", err.message);
    return defaultModelProfile();
  }
}

function writeModelProfile(profile) {
  const defaults = defaultModelProfile();
  const normalized = {
    ...defaults,
    ...(profile || {}),
    model: normalizeModelName(profile?.model || "") || defaults.model,
    reasoningEffort: normalizeReasoningEffort(profile?.reasoningEffort || "") || defaults.reasoningEffort,
    updatedAt: String(profile?.updatedAt || "").trim() || new Date().toISOString(),
    schemaVersion: 1,
  };
  try {
    ensureParentDir(MODEL_PROFILE_PATH);
    fs.writeFileSync(MODEL_PROFILE_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn("Failed to write model profile:", err.message);
  }
  return normalized;
}

function currentModelProfile() {
  if (!modelProfile) modelProfile = readModelProfile();
  return modelProfile;
}

function modelProfileSummary(profile = currentModelProfile()) {
  const model = normalizeModelName(profile?.model || "") || defaultModelProfile().model;
  const effort = normalizeReasoningEffort(profile?.reasoningEffort || "") || defaultModelProfile().reasoningEffort;
  return `${model} (${effort})`;
}

function parseModelSwitchInput(rawInput) {
  const raw = String(rawInput || "").trim();
  if (!raw) return { ok: true, showOnly: true };
  const lowered = raw.toLowerCase();
  if (["list", "help", "show", "status", "current"].includes(lowered)) {
    return { ok: true, showOnly: true };
  }
  const tokens = raw
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
  let model = "";
  let reasoningEffort = "";
  for (const token of tokens) {
    const parsedModel = normalizeModelName(token);
    if (parsedModel) {
      model = parsedModel;
      continue;
    }
    const parsedEffort = normalizeReasoningEffort(token);
    if (parsedEffort) {
      reasoningEffort = parsedEffort;
      continue;
    }
    return {
      ok: false,
      error: `Unbekannter model-Parameter: "${token}"`,
    };
  }
  if (!model && !reasoningEffort) {
    return {
      ok: false,
      error: "Bitte gib mindestens ein Ziel an: 5.4, 5.3-codex, high oder standard.",
    };
  }
  return {
    ok: true,
    showOnly: false,
    model,
    reasoningEffort,
  };
}

function buildModelHelpLines(profile = currentModelProfile()) {
  return [
    `Aktives Modellprofil: ${modelProfileSummary(profile)}`,
    "Optionen:",
    "- model: 5.4 | 5.3-codex",
    "- effort: high | standard",
    "Beispiele:",
    "- /model 5.4",
    "- /model 5.3-codex",
    "- /model high",
    "- /model standard",
    "- /model 5.4 high",
  ];
}

function defaultUserProfile() {
  return {
    ownerName: "",
    assistantName: "",
    tone: "",
    preferences: "",
    personaPreset: "",
    configuredAt: "",
    setupCompleted: false,
    schemaVersion: 1,
  };
}

const PERSONA_PRESET_DEFINITIONS = [
  {
    key: "schenni",
    label: "Schenni",
    summary: "Frech-keck, leicht ostdeutsch, standardmaessig kurz.",
    aliases: ["schenni", "ostdeutsch", "ost", "katze"],
  },
  {
    key: "custom",
    label: "Custom",
    summary: "Eigene Persoenlichkeit mit deinem Stil.",
    aliases: ["custom", "eigene", "selber", "self", "own"],
  },
  {
    key: "no-bs-engineer",
    label: "No-BS Engineer",
    summary: "Technisch, klar, direkt, ohne Floskeln.",
    aliases: ["no-bs", "nobs", "engineer", "tech"],
  },
  {
    key: "witty-coach",
    label: "Witty Coach",
    summary: "Locker, motivierend, aber konkret.",
    aliases: ["coach", "witty", "mentor"],
  },
  {
    key: "stoiber-style",
    label: "Stoiber-Style (inspiriert)",
    summary: "Politisch-satirischer DE-Ton, nicht 1:1 Imitation.",
    aliases: ["stoiber", "edmund-stoiber", "bayern", "bavarian"],
  },
  {
    key: "showman-en",
    label: "Showman EN (inspiriert)",
    summary: "Show-lastiger englischer Ton, nicht 1:1 Imitation.",
    aliases: ["showman", "trump", "donald-trump", "english-showman", "en-showman"],
  },
];

const PERSONA_PRESET_BY_KEY = new Map(PERSONA_PRESET_DEFINITIONS.map((entry) => [entry.key, entry]));
const PERSONA_PRESET_ALIAS = (() => {
  const next = new Map();
  for (const entry of PERSONA_PRESET_DEFINITIONS) {
    next.set(entry.key, entry.key);
    for (const alias of entry.aliases || []) {
      next.set(String(alias).toLowerCase(), entry.key);
    }
  }
  return next;
})();

function personaPresetLabel(value) {
  const normalized = normalizePersonaPreset(value);
  if (!normalized) return "-";
  return PERSONA_PRESET_BY_KEY.get(normalized)?.label || normalized;
}

function availablePersonaPresetKeys() {
  return PERSONA_PRESET_DEFINITIONS.map((entry) => entry.key);
}

function normalizePersonaPreset(value) {
  const lowered = String(value || "").trim().toLowerCase();
  if (!lowered) return "";
  const normalized = lowered
    .replace(/[`"'.,;:!?()[\]{}]/g, " ")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  if (!normalized) return "";
  if (PERSONA_PRESET_BY_KEY.has(normalized)) return normalized;
  if (PERSONA_PRESET_ALIAS.has(normalized)) return PERSONA_PRESET_ALIAS.get(normalized) || "";
  return "";
}

function personaPresetDir(preset) {
  const normalized = normalizePersonaPreset(preset);
  if (!normalized) return "";
  return path.join(PERSONALITY_PRESETS_DIR, normalized);
}

function defaultPresetFileContent(preset, filename) {
  const normalized = normalizePersonaPreset(preset);
  if (normalized === "schenni") {
    if (filename === "profile.md") {
      return [
        "# Schenni Personality Profile",
        "",
        "Schenni ist frech, direkt und leicht ostdeutsch gefaerbt.",
        "Fakten bleiben korrekt, Ton bleibt locker und hilfreich.",
        "",
      ].join("\n");
    }
    if (filename === "answer-style.md") {
      return [
        "# Answer Style",
        "",
        "- Kurz und knackig als Standard.",
        "- Bei komplexen Themen: laenger erlaubt, aber kompakt und klar.",
        "- Nicht mit Floskeln starten, direkt zum Punkt.",
        "- Sprachregel: Deutsch-Input => voller Schenni-Ton.",
        "- Sprachregel: Englisch-Input => Englisch antworten, Schenni nur leicht dosieren.",
        "",
      ].join("\n");
    }
    if (filename === "lexicon.md") {
      return [
        "# Lexicon",
        "",
        "- nuescht = nichts",
        "- nue glar = ja",
        "- niet = nein",
        "- Bemme = belegtes Brot",
        "- Datsche = Gartenhaus",
        "",
      ].join("\n");
    }
  }
  if (normalized === "custom") {
    if (filename === "profile.md") {
      return [
        "# Custom Personality Profile",
        "",
        "Hier steht deine eigene Persona-Basis.",
        "Der Setup-Wizard schreibt deinen Profilblock automatisch dazu.",
        "",
      ].join("\n");
    }
    if (filename === "answer-style.md") {
      return [
        "# Answer Style",
        "",
        "- Default: klar, knapp, ohne unnötigen Overhead.",
        "- Darf bei komplexen Aufgaben laenger werden, bleibt aber strukturiert.",
        "",
      ].join("\n");
    }
    if (filename === "lexicon.md") {
      return [
        "# Lexicon",
        "",
        "- Trage hier bevorzugte Begriffe und Formulierungen ein.",
        "",
      ].join("\n");
    }
  }
  if (normalized === "no-bs-engineer") {
    if (filename === "profile.md") {
      return [
        "# No-BS Engineer Profile",
        "",
        "Antwortet technisch, praezise und ohne Drumherum.",
        "Nutzt klare Annahmen, Trade-offs und naechste Schritte.",
        "",
      ].join("\n");
    }
    if (filename === "answer-style.md") {
      return [
        "# Answer Style",
        "",
        "- Ergebnis zuerst, dann Belege oder Schritte.",
        "- Kurz bei einfachen Fragen, strukturiert bei komplexen Themen.",
        "- Keine motivierenden Phrasen, nur verwertbare Aussagen.",
        "",
      ].join("\n");
    }
    if (filename === "lexicon.md") {
      return [
        "# Lexicon",
        "",
        "- default: reproducible, deterministic, regression-safe",
        "- de: belastbar, reproduzierbar, robust",
        "",
      ].join("\n");
    }
  }
  if (normalized === "witty-coach") {
    if (filename === "profile.md") {
      return [
        "# Witty Coach Profile",
        "",
        "Locker, freundlich, etwas Humor, aber immer zielorientiert.",
        "Hilft beim Umsetzen statt nur zu motivieren.",
        "",
      ].join("\n");
    }
    if (filename === "answer-style.md") {
      return [
        "# Answer Style",
        "",
        "- Kurz, positiv, konkret.",
        "- Humor leicht einsetzen, nicht albern werden.",
        "- Immer 1-3 klare naechste Schritte anbieten.",
        "",
      ].join("\n");
    }
    if (filename === "lexicon.md") {
      return [
        "# Lexicon",
        "",
        "- fokus, momentum, naechster schritt, pragmatisch",
        "",
      ].join("\n");
    }
  }
  if (normalized === "stoiber-style") {
    if (filename === "profile.md") {
      return [
        "# Stoiber-Style (Inspired) Profile",
        "",
        "Satirisch-politischer deutscher Ton mit langen Schleifen als Stilmittel.",
        "Nur inspiriert, keine 1:1 Nachahmung realer Personen.",
        "",
      ].join("\n");
    }
    if (filename === "answer-style.md") {
      return [
        "# Answer Style",
        "",
        "- Deutsch antworten, mit leicht satirischem Buehnencharakter.",
        "- Kernaussage trotzdem klar und am Anfang.",
        "- Bei komplexen Themen strukturieren, nicht in Endlossaetzen verlieren.",
        "",
      ].join("\n");
    }
    if (filename === "lexicon.md") {
      return [
        "# Lexicon",
        "",
        "- meine damen und herren, nu pass uff, ganz klar",
        "",
      ].join("\n");
    }
  }
  if (normalized === "showman-en") {
    if (filename === "profile.md") {
      return [
        "# Showman EN (Inspired) Profile",
        "",
        "English-first, high-energy, show style for punchy delivery.",
        "Inspired tone only, not a real-person imitation.",
        "",
      ].join("\n");
    }
    if (filename === "answer-style.md") {
      return [
        "# Answer Style",
        "",
        "- English by default.",
        "- Strong claims only when backed by facts.",
        "- Keep it punchy, then give concrete action.",
        "",
      ].join("\n");
    }
    if (filename === "lexicon.md") {
      return [
        "# Lexicon",
        "",
        "- big picture, clear win, straight answer, next move",
        "",
      ].join("\n");
    }
  }
  return "# Personality\n";
}

function ensurePersonaPresetFiles(preset) {
  const dir = personaPresetDir(preset);
  if (!dir) return { ok: false, error: "invalid preset", path: "" };
  const files = ["profile.md", "answer-style.md", "lexicon.md"];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const file of files) {
      const target = path.join(dir, file);
      if (!fs.existsSync(target)) {
        fs.writeFileSync(target, defaultPresetFileContent(preset, file), "utf8");
      }
    }
    return { ok: true, path: dir };
  } catch (err) {
    return { ok: false, error: err.message, path: dir };
  }
}

function readPersonaPresetText(preset) {
  const normalized = normalizePersonaPreset(preset);
  if (!normalized) return { ok: false, status: "invalid", detail: "invalid preset", path: "" };
  const ensured = ensurePersonaPresetFiles(normalized);
  if (!ensured.ok) {
    return {
      ok: false,
      status: "error",
      detail: `preset init failed: ${ensured.error || "unknown error"}`,
      path: ensured.path || "",
    };
  }
  const dir = ensured.path;
  const files = ["profile.md", "answer-style.md", "lexicon.md"];
  try {
    const parts = [];
    for (const file of files) {
      const full = path.join(dir, file);
      if (!fs.existsSync(full)) continue;
      const raw = fs.readFileSync(full, "utf8").trim();
      if (!raw) continue;
      parts.push(raw);
    }
    const text = parts.join("\n\n");
    if (!text.trim()) {
      return { ok: false, status: "empty", detail: `preset files are empty: ${dir}`, path: dir };
    }
    return { ok: true, status: "ok", detail: "ok", path: dir, text };
  } catch (err) {
    return { ok: false, status: "error", detail: `preset read failed: ${err.message}`, path: dir };
  }
}

function readUserProfile() {
  try {
    if (!fs.existsSync(USER_PROFILE_PATH)) return defaultUserProfile();
    const raw = fs.readFileSync(USER_PROFILE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultUserProfile();
    return {
      ...defaultUserProfile(),
      ownerName: String(parsed.ownerName || "").trim(),
      assistantName: String(parsed.assistantName || "").trim(),
      tone: String(parsed.tone || "").trim(),
      preferences: String(parsed.preferences || "").trim(),
      personaPreset: normalizePersonaPreset(parsed.personaPreset || ""),
      configuredAt: String(parsed.configuredAt || "").trim(),
      setupCompleted: Boolean(parsed.setupCompleted),
    };
  } catch (err) {
    console.warn("Failed to read user profile:", err.message);
    return defaultUserProfile();
  }
}

function writeUserProfile(profile) {
  const normalized = {
    ...defaultUserProfile(),
    ...(profile || {}),
    ownerName: String(profile?.ownerName || "").trim(),
    assistantName: String(profile?.assistantName || "").trim(),
    tone: String(profile?.tone || "").trim(),
    preferences: String(profile?.preferences || "").trim(),
    personaPreset: normalizePersonaPreset(profile?.personaPreset || ""),
    configuredAt: String(profile?.configuredAt || "").trim(),
    setupCompleted: Boolean(profile?.setupCompleted),
  };
  try {
    ensureParentDir(USER_PROFILE_PATH);
    fs.writeFileSync(USER_PROFILE_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn("Failed to write user profile:", err.message);
  }
  return normalized;
}

function normalizeTone(value) {
  const lowered = String(value || "").trim().toLowerCase();
  if (!lowered) return "";
  if (/formal|förmlich|sie/.test(lowered)) return "formal";
  if (/leger|locker|casual|du/.test(lowered)) return "leger";
  return "custom";
}

function toneLabel(tone) {
  if (tone === "formal") return "formal";
  if (tone === "leger") return "leger";
  if (tone === "custom") return "eigene preferences";
  return "-";
}

function isUserProfileComplete(profile) {
  return Boolean(profile?.ownerName && profile?.assistantName && profile?.tone && profile?.setupCompleted);
}

const PERSONALITY_MARKER_START = "<!-- BOT_PROFILE_START -->";
const PERSONALITY_MARKER_END = "<!-- BOT_PROFILE_END -->";

function renderProfilePersonalitySection(profile) {
  const lines = [
    PERSONALITY_MARKER_START,
    "## Persönliche Präferenzen (automatisch gepflegt)",
    `- Nutzername: ${profile.ownerName || "-"}`,
    `- Assistentenname: ${profile.assistantName || "-"}`,
    `- Kommunikationsstil: ${toneLabel(profile.tone)}`,
    `- Eigene Preferences: ${profile.preferences || "-"}`,
    `- Zuletzt aktualisiert: ${profile.configuredAt || new Date().toISOString()}`,
    PERSONALITY_MARKER_END,
  ];
  return lines.join("\n");
}

function upsertUserProfileIntoPersonality(profile) {
  const preset = normalizePersonaPreset(profile?.personaPreset || "");
  const profilePath = preset
    ? path.join(personaPresetDir(preset), "profile.md")
    : resolvePersonalityFilePath(BOT_PERSONALITY_FILE);
  const nextSection = renderProfilePersonalitySection(profile);
  try {
    let raw = "";
    if (preset) {
      ensurePersonaPresetFiles(preset);
    }
    if (fs.existsSync(profilePath)) {
      raw = fs.readFileSync(profilePath, "utf8");
    } else {
      raw = preset ? defaultPresetFileContent(preset, "profile.md") : "# V3 Persönlichkeits- und Rollenprofil\n";
    }

    const markerPattern = new RegExp(
      `${escapeRegExp(PERSONALITY_MARKER_START)}[\\s\\S]*?${escapeRegExp(PERSONALITY_MARKER_END)}`,
      "m"
    );
    const updated = markerPattern.test(raw)
      ? raw.replace(markerPattern, nextSection)
      : `${raw.replace(/\s*$/, "\n\n")}${nextSection}\n`;
    ensureParentDir(profilePath);
    fs.writeFileSync(profilePath, updated, "utf8");
    return { ok: true, path: profilePath };
  } catch (err) {
    return { ok: false, path: profilePath, error: err.message };
  }
}

function defaultPreferenceHintsState() {
  return {
    schemaVersion: 1,
    hints: [],
  };
}

function sanitizePreferenceHint(entry) {
  if (!entry || typeof entry !== "object") return null;
  const text = String(entry.text || "").replace(/\s+/g, " ").trim().slice(0, 220);
  if (!text || text.length < 8) return null;
  const createdAt = String(entry.createdAt || "").trim() || new Date().toISOString();
  const source = String(entry.source || "chat").trim() || "chat";
  const count = Number.isFinite(Number(entry.count)) ? Math.max(1, Number(entry.count)) : 1;
  return {
    text,
    source,
    createdAt,
    updatedAt: String(entry.updatedAt || createdAt).trim() || createdAt,
    count,
  };
}

function readPreferenceHintsState() {
  try {
    if (!fs.existsSync(USER_PREFERENCE_HINTS_PATH)) return defaultPreferenceHintsState();
    const raw = fs.readFileSync(USER_PREFERENCE_HINTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultPreferenceHintsState();
    const hints = Array.isArray(parsed.hints) ? parsed.hints.map(sanitizePreferenceHint).filter(Boolean) : [];
    return {
      schemaVersion: 1,
      hints: hints.slice(-BOT_PREFERENCE_LEARNING_MAX_HINTS),
    };
  } catch (err) {
    console.warn("Failed to read preference hints:", err.message);
    return defaultPreferenceHintsState();
  }
}

function writePreferenceHintsState(state) {
  const normalized = {
    schemaVersion: 1,
    hints: Array.isArray(state?.hints) ? state.hints.map(sanitizePreferenceHint).filter(Boolean).slice(-BOT_PREFERENCE_LEARNING_MAX_HINTS) : [],
  };
  try {
    ensureParentDir(USER_PREFERENCE_HINTS_PATH);
    fs.writeFileSync(USER_PREFERENCE_HINTS_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn("Failed to write preference hints:", err.message);
  }
  return normalized;
}

function extractPreferenceLearningHint(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length < 8) return "";
  if (normalized.startsWith("/")) return "";
  const lower = normalized.toLowerCase();

  const signalPattern =
    /\b(merk dir|merke dir|künftig|zukünftig|ab jetzt|ich mag|ich möchte|ich will|bevorzuge|nenn mich|nenne mich|du sollst|sprich|dialekt|kurz|knackig|frech|ohne fluff)\b/i;
  if (!signalPattern.test(lower)) return "";

  return normalized.slice(0, 220);
}

function buildLearnedPreferenceOverlayText() {
  if (!BOT_PREFERENCE_LEARNING) return "";
  const hints = Array.isArray(preferenceHintsState?.hints) ? preferenceHintsState.hints : [];
  if (!hints.length) return "";
  const recent = hints.slice(-8);
  const lines = [
    "## Learned preferences from recent chats",
    ...recent.map((hint) => `- ${hint.text}`),
  ];
  return lines.join("\n");
}

function maybeLearnPreferenceFromText(chatId, text, source = "chat") {
  if (!BOT_PREFERENCE_LEARNING) return false;
  const hint = extractPreferenceLearningHint(text);
  if (!hint) return false;
  const key = hint.toLowerCase();
  const nowIso = new Date().toISOString();
  const hints = Array.isArray(preferenceHintsState?.hints) ? [...preferenceHintsState.hints] : [];
  const idx = hints.findIndex((item) => String(item?.text || "").toLowerCase() === key);

  if (idx >= 0) {
    hints[idx] = {
      ...hints[idx],
      source: String(source || hints[idx].source || "chat"),
      updatedAt: nowIso,
      count: Math.max(1, Number(hints[idx].count || 1) + 1),
    };
  } else {
    hints.push({
      text: hint,
      source: String(source || "chat"),
      createdAt: nowIso,
      updatedAt: nowIso,
      count: 1,
    });
  }

  preferenceHintsState = writePreferenceHintsState({
    schemaVersion: 1,
    hints,
  });

  logRuntimeEvent("preference_learned", {
    chatId: String(chatId || ""),
    source: String(source || "chat"),
    hintPreview: shortInputPreview(hint),
    hintsCount: preferenceHintsState.hints.length,
  });
  return true;
}

function defaultReminderState() {
  return {
    schemaVersion: 1,
    reminders: [],
  };
}

function sanitizeReminder(reminder) {
  if (!reminder || typeof reminder !== "object") return null;
  const id = String(reminder.id || "").trim();
  if (!id) return null;
  const type = String(reminder.type || "").trim();
  if (type !== "once" && type !== "daily") return null;
  const message = String(reminder.message || "").trim();
  if (!message) return null;
  const chatId = reminder.chatId;
  if (!(typeof chatId === "string" || Number.isSafeInteger(chatId))) return null;
  const active = reminder.active !== false;
  const createdAt = String(reminder.createdAt || "").trim() || new Date().toISOString();

  if (type === "once") {
    const runAt = Number(reminder.runAt);
    if (!Number.isFinite(runAt) || runAt <= 0) return null;
    return {
      id,
      type,
      message,
      chatId,
      active,
      createdAt,
      runAt: Math.floor(runAt),
      sentAt: reminder.sentAt ? String(reminder.sentAt) : "",
    };
  }

  const time = String(reminder.time || "").trim();
  if (!/^\d{2}:\d{2}$/.test(time)) return null;
  return {
    id,
    type,
    message,
    chatId,
    active,
    createdAt,
    time,
    lastSentAt: reminder.lastSentAt ? String(reminder.lastSentAt) : "",
  };
}

function readReminderState() {
  try {
    if (!fs.existsSync(REMINDERS_PATH)) return defaultReminderState();
    const raw = fs.readFileSync(REMINDERS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultReminderState();
    const reminders = Array.isArray(parsed.reminders) ? parsed.reminders.map(sanitizeReminder).filter(Boolean) : [];
    return {
      schemaVersion: 1,
      reminders: reminders.slice(0, MAX_REMINDERS),
    };
  } catch (err) {
    console.warn("Failed to read reminder state:", err.message);
    return defaultReminderState();
  }
}

function writeReminderState(state) {
  const normalized = {
    schemaVersion: 1,
    reminders: Array.isArray(state?.reminders) ? state.reminders.map(sanitizeReminder).filter(Boolean).slice(0, MAX_REMINDERS) : [],
  };
  try {
    ensureParentDir(REMINDERS_PATH);
    fs.writeFileSync(REMINDERS_PATH, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn("Failed to write reminders:", err.message);
  }
  return normalized;
}

function parseDurationMs(raw) {
  const input = String(raw || "").trim().toLowerCase();
  const match = /^(\d+)(s|m|h|d)$/.exec(input);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2];
  const map = { s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };
  return amount * map[unit];
}

function parseClockHHMM(raw) {
  const value = String(raw || "").trim();
  const match = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatLocalDateTime(ts) {
  try {
    return new Date(ts).toLocaleString("de-DE", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch (_err) {
    return new Date(ts).toISOString();
  }
}

function nextRunForClockHHMM(hhmm, nowTs = Date.now()) {
  const parsed = parseClockHHMM(hhmm);
  if (!parsed) return null;
  const [h, m] = parsed.split(":").map((x) => Number(x));
  const now = new Date(nowTs);
  const run = new Date(nowTs);
  run.setSeconds(0, 0);
  run.setHours(h, m, 0, 0);
  if (run.getTime() <= now.getTime()) {
    run.setDate(run.getDate() + 1);
  }
  return run.getTime();
}

function projectKey(command, cwd) {
  return `${resolveCwd(cwd)}\n${String(command || "codex").trim()}`;
}

function shortProjectName(cwd) {
  const normalized = resolveCwd(cwd);
  const base = path.basename(normalized);
  if (!base || base === path.sep) return normalized;
  return base;
}

function shortRecentButtonLabel(entry) {
  const project = shortProjectName(entry.cwd);
  const command = shortCommand(entry.command || "codex");
  const label = `${project} · ${command}`;
  if (label.length <= 54) return label;
  return `${label.slice(0, 51)}...`;
}

function extractReplyPrompt(screenText) {
  const lines = String(screenText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";

  const startIndex = Math.max(0, lines.length - 40);
  for (let i = lines.length - 1; i >= startIndex; i -= 1) {
    const line = lines[i];
    if (/^\s*(question|follow[- ]?up|rueckfrage|rückfrage)\s*[:\-]/i.test(line)) {
      return line.slice(0, 220);
    }
    if (
      /^(please|bitte)\b/i.test(line) &&
      /(reply|respond|answer|confirm|choose|select|decide|proceed|continue|antworte|antworten|waehle|wähle)/i.test(
        line
      ) &&
      line.length <= 220
    ) {
      return line;
    }
  }
  return "";
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function shortCommand(text) {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= 90) return oneLine;
  return `${oneLine.slice(0, 87)}...`;
}

function shortInputPreview(text) {
  const visible = text.replace(/\s/g, (ch) => (ch === " " ? "·" : ch));
  if (visible.length <= 80) return visible;
  return `${visible.slice(0, 77)}...`;
}

function resolvePersonalityFilePath(filePath) {
  const raw = String(filePath || "").trim();
  if (!raw) return path.join(__dirname, "V3_PERSONALITY.md");
  if (path.isAbsolute(raw)) return raw;
  return path.join(__dirname, raw);
}

function readPersonalityProfile() {
  const preset = normalizePersonaPreset(userProfile?.personaPreset || "");
  if (preset) {
    const fromPreset = readPersonaPresetText(preset);
    if (!fromPreset.ok) {
      return {
        ok: false,
        path: fromPreset.path || "",
        status: fromPreset.status || "error",
        detail: fromPreset.detail || "preset read failed",
      };
    }
    const raw = fromPreset.text.trim();
    const truncated = raw.length > BOT_PERSONALITY_MAX_CHARS;
    const text = truncated ? `${raw.slice(0, BOT_PERSONALITY_MAX_CHARS)}\n\n...[truncated by BOT_PERSONALITY_MAX_CHARS]` : raw;
    return {
      ok: true,
      path: fromPreset.path,
      text,
      truncated,
      originalChars: raw.length,
      loadedChars: text.length,
    };
  }

  const profilePath = resolvePersonalityFilePath(BOT_PERSONALITY_FILE);
  try {
    if (!fs.existsSync(profilePath)) {
      return {
        ok: false,
        path: profilePath,
        status: "missing",
        detail: `profile file not found: ${profilePath}`,
      };
    }

    const raw = fs.readFileSync(profilePath, "utf8").trim();
    if (!raw) {
      return {
        ok: false,
        path: profilePath,
        status: "empty",
        detail: `profile file is empty: ${profilePath}`,
      };
    }

    const truncated = raw.length > BOT_PERSONALITY_MAX_CHARS;
    const text = truncated ? `${raw.slice(0, BOT_PERSONALITY_MAX_CHARS)}\n\n...[truncated by BOT_PERSONALITY_MAX_CHARS]` : raw;
    return {
      ok: true,
      path: profilePath,
      text,
      truncated,
      originalChars: raw.length,
      loadedChars: text.length,
    };
  } catch (err) {
    return {
      ok: false,
      path: profilePath,
      status: "error",
      detail: `profile read failed: ${err.message}`,
    };
  }
}

function buildPersonalityBootstrapPrompt(profile) {
  const learnedOverlay = buildLearnedPreferenceOverlayText();
  const profileBody = learnedOverlay ? `${profile.text}\n\n${learnedOverlay}` : profile.text;
  const schenniStyle = [
    "User-facing answer style (mandatory):",
    "- Persona: Schenni (keck, frech, unkonventionell, leicht ostdeutscher Einschlag).",
    "- Lexicon anchors: use 'nüscht' for 'nichts', 'nü glar' for 'ja', and 'niet' for 'nein' when it fits naturally.",
    "- Default answer length: kurz und knackig (2-4 Zeilen oder 1 kurzer Absatz).",
    "- Bei komplexen Themen: darf laenger sein, aber kompakt und ohne Labertext.",
    "- Kleine Umgangssprache/leichte absichtliche Schreibfehler sind okay, aber Fakten muessen korrekt bleiben.",
    "- Kein Vorlauf mit Meta-Texten (kein 'thinking', kein 'Antwort gesendet', keine UI-Reste).",
    "- Keine Altantwort-Leaks: beantworte immer nur die aktuelle Frage.",
  ].join("\n");
  const lines = [
    "Use the following operating profile as the default behavior for this entire session.",
    "Apply it to planning, execution, communication, project management, development, and testing outputs.",
    "If any request conflicts with safety or system policy, follow safety/policy first and continue pragmatically.",
    "",
    `Profile source: ${profile.path}`,
    "",
    "[PROFILE_START]",
    profileBody,
    "[PROFILE_END]",
    "",
    "[SCHENNI_STYLE_START]",
    schenniStyle,
    "[SCHENNI_STYLE_END]",
  ];
  return lines.join("\n");
}

function truncateTail(text, maxChars) {
  const safeMax = Number.isFinite(maxChars) ? Math.max(200, Math.floor(maxChars)) : 200;
  if (text.length <= safeMax) return text;
  return `...[truncated]\n${text.slice(-safeMax)}`;
}

function shellSingleQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandStartsCodex(command) {
  const first = String(command || "").trim().split(/\s+/)[0] || "";
  if (!first) return false;
  if (first === "codex") return true;
  return /(^|\/)codex$/.test(first);
}

function commandHasModelFlag(command) {
  return /(^|\s)(-m|--model)\s+\S+/i.test(String(command || ""));
}

function commandHasReasoningConfig(command) {
  const raw = String(command || "");
  return /(^|\s)-c\s+['"]?(model_reasoning_effort|reasoning_effort)\s*=/i.test(raw);
}

function applyModelProfileToCodexCommand(command, profile = currentModelProfile()) {
  const raw = String(command || "").trim() || "codex";
  if (!commandStartsCodex(raw)) return raw;

  const model = normalizeModelName(profile?.model || "") || defaultModelProfile().model;
  const reasoningEffort = normalizeReasoningEffort(profile?.reasoningEffort || "") || defaultModelProfile().reasoningEffort;

  let next = raw;
  if (!commandHasModelFlag(next)) {
    next += ` -m ${shellSingleQuote(model)}`;
  }
  if (!commandHasReasoningConfig(next)) {
    next += ` -c model_reasoning_effort=${shellSingleQuote(reasoningEffortCliValue(reasoningEffort))}`;
  }
  return next;
}

function resolveWebAppLaunchUrl(rawUrl) {
  if (!rawUrl) return "";
  try {
    const parsed = new URL(rawUrl);
    if (parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/telegram-miniapp/index.html";
    } else if (parsed.pathname.endsWith("/")) {
      parsed.pathname = `${parsed.pathname}telegram-miniapp/index.html`.replace(/\/{2,}/g, "/");
    }
    return parsed.toString();
  } catch (err) {
    return "";
  }
}

function setRuntimeWebAppUrl(nextUrl, persist = false) {
  const normalized = String(nextUrl || "").trim();
  if (!normalized) return;
  runtimeWebAppUrl = normalized;
  process.env.BOT_WEBAPP_URL = normalized;
  if (persist) {
    try {
      updateEnvValue("BOT_WEBAPP_URL", normalized);
    } catch (err) {
      console.warn("Failed to persist BOT_WEBAPP_URL:", err.message);
    }
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

function cloudflareTunnelTargetUrl() {
  return `http://${BOT_WEB_HOST}:${BOT_WEB_PORT}`;
}

function resolveCloudflareTunnelMode() {
  if (["off", "disabled", "none"].includes(BOT_CLOUDFLARE_TUNNEL_MODE)) return "off";
  if (BOT_CLOUDFLARE_TUNNEL_MODE === "quick") return "quick";
  if (BOT_CLOUDFLARE_TUNNEL_MODE === "named") return "named";
  if (BOT_CLOUDFLARE_TUNNEL_NAME) return "named";
  if (!runtimeWebAppUrl || isTryCloudflareUrl(runtimeWebAppUrl)) return "quick";
  return "off";
}

function cloudflareNamedLaunchUrl() {
  const explicitUrl = String(runtimeWebAppUrl || BOT_WEBAPP_URL || "").trim();
  if (explicitUrl && !isTryCloudflareUrl(explicitUrl)) {
    return resolveWebAppLaunchUrl(explicitUrl);
  }
  if (BOT_CLOUDFLARE_TUNNEL_HOSTNAME) {
    return resolveWebAppLaunchUrl(`https://${BOT_CLOUDFLARE_TUNNEL_HOSTNAME}`);
  }
  return "";
}

function cloudflaredProcessPattern(mode) {
  if (mode === "named") {
    if (BOT_CLOUDFLARE_TUNNEL_NAME) return `tunnel run ${BOT_CLOUDFLARE_TUNNEL_NAME}`;
    return "tunnel run";
  }
  return `cloudflared tunnel --url ${cloudflareTunnelTargetUrl()}`;
}

function buildCloudflaredSpawnArgs(mode) {
  if (mode === "named") {
    if (!BOT_CLOUDFLARE_TUNNEL_NAME) {
      throw new Error("BOT_CLOUDFLARE_TUNNEL_NAME is required for named tunnel mode");
    }
    const args = [];
    if (BOT_CLOUDFLARE_CONFIG_PATH) {
      args.push("--config", BOT_CLOUDFLARE_CONFIG_PATH);
    }
    args.push("tunnel", "run", BOT_CLOUDFLARE_TUNNEL_NAME);
    return args;
  }
  return ["tunnel", "--url", cloudflareTunnelTargetUrl(), "--protocol", "http2", "--ha-connections", "4"];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForProcessExit(pid, timeoutMs) {
  const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true;
    await wait(200);
  }
  return !isPidAlive(pid);
}

async function stopCloudflaredProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return;
  if (!isPidAlive(pid)) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch (_err) {
    // ignore
  }
  const exitedOnTerm = await waitForProcessExit(pid, 3000);
  if (exitedOnTerm) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (_err) {
    // ignore
  }
  await waitForProcessExit(pid, 1000);
}

function cleanupOrphanCloudflaredProcesses(trackedPid, mode) {
  const pattern = cloudflaredProcessPattern(mode);
  const probe = spawnSync("pgrep", ["-f", pattern], {
    encoding: "utf8",
  });
  if (!probe || typeof probe.stdout !== "string") return 0;
  const found = probe.stdout
    .split(/\r?\n/g)
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);

  let cleaned = 0;
  for (const pid of found) {
    if (Number.isSafeInteger(trackedPid) && pid === trackedPid) continue;
    try {
      process.kill(pid, "SIGTERM");
      cleaned += 1;
    } catch (_err) {
      // ignore
    }
  }
  return cleaned;
}

function probeUrlOnce(url, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(Boolean(ok));
    };
    const onError = () => finish(false);

    let req;
    try {
      const parsed = new URL(url);
      const client = parsed.protocol === "http:" ? require("http") : require("https");
      req = client.request(
        parsed,
        {
          method: "GET",
          timeout: Math.max(1000, Number(timeoutMs) || 3000),
          headers: { "user-agent": "termbot-health/1.0" },
        },
        (res) => {
          const status = Number(res.statusCode || 0);
          res.resume();
          finish(status >= 200 && status < 500);
        }
      );
      req.on("timeout", () => {
        req.destroy(new Error("timeout"));
      });
      req.on("error", onError);
      req.end();
    } catch (_err) {
      finish(false);
    }
  });
}

async function isWebAppLaunchReachable(rawUrl) {
  const launch = resolveWebAppLaunchUrl(rawUrl);
  if (!launch) return false;
  return probeUrlOnce(launch, 3500);
}

async function resolvesWebAppHostViaPublicDns(rawUrl) {
  const launch = resolveWebAppLaunchUrl(rawUrl);
  if (!launch) return false;
  try {
    const parsed = new URL(launch);
    const hostname = String(parsed.hostname || "").trim();
    if (!hostname) return false;
    const resolver = new dns.Resolver();
    resolver.setServers(["1.1.1.1", "8.8.8.8"]);
    const records = await resolver.resolve(hostname);
    return Array.isArray(records) && records.length > 0;
  } catch (_err) {
    return false;
  }
}

async function resolvesWebAppHostViaSystemDns(rawUrl) {
  const launch = resolveWebAppLaunchUrl(rawUrl);
  if (!launch) return false;
  try {
    const parsed = new URL(launch);
    const hostname = String(parsed.hostname || "").trim();
    if (!hostname) return false;
    await dns.lookup(hostname);
    return true;
  } catch (_err) {
    return false;
  }
}

function spawnCloudflaredTunnelProcess(mode) {
  ensureParentDir(CLOUDFLARED_LOG_PATH);
  fs.writeFileSync(CLOUDFLARED_LOG_PATH, "", "utf8");

  const logFd = fs.openSync(CLOUDFLARED_LOG_PATH, "a");
  let child;
  try {
    child = spawn("cloudflared", buildCloudflaredSpawnArgs(mode), {
      cwd: RESOLVED_BOT_CWD,
      env: process.env,
      detached: true,
      stdio: ["ignore", logFd, logFd],
    });
  } finally {
    fs.closeSync(logFd);
  }

  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    throw new Error(`cloudflared failed to start (${mode})`);
  }
  child.unref();
  writePidFile(CLOUDFLARED_PID_PATH, child.pid);
  return child.pid;
}

async function ensureCloudflareTunnelOnStartup() {
  if (!BOT_WEBAPP_ENABLE) {
    return { ok: true, skipped: true, notice: "Cloudflare check skipped: BOT_WEBAPP_ENABLE=0" };
  }
  if (!BOT_TUNNEL_AUTO_RESTORE) {
    return { ok: true, skipped: true, notice: "Cloudflare check skipped: BOT_TUNNEL_AUTO_RESTORE=0" };
  }
  const tunnelMode = resolveCloudflareTunnelMode();
  if (tunnelMode === "off") {
    return { ok: true, skipped: true, notice: "Cloudflare check skipped: managed tunnel mode is off" };
  }

  if (tunnelMode === "named") {
    if (!BOT_CLOUDFLARE_TUNNEL_NAME) {
      return {
        ok: false,
        skipped: false,
        started: false,
        notice: "Cloudflare named tunnel requires BOT_CLOUDFLARE_TUNNEL_NAME",
      };
    }
    const namedLaunchUrl = cloudflareNamedLaunchUrl();
    if (!namedLaunchUrl) {
      return {
        ok: false,
        skipped: false,
        started: false,
        notice: "Cloudflare named tunnel requires BOT_WEBAPP_URL or BOT_CLOUDFLARE_TUNNEL_HOSTNAME",
      };
    }
    setRuntimeWebAppUrl(namedLaunchUrl, false);
  }

  const pid = readPidFile(CLOUDFLARED_PID_PATH);
  if (pid && !isPidAlive(pid)) {
    clearPidFile(CLOUDFLARED_PID_PATH);
  }
  const trackedPid = readPidFile(CLOUDFLARED_PID_PATH);
  const cleanedOrphans = cleanupOrphanCloudflaredProcesses(trackedPid, tunnelMode);
  if (cleanedOrphans > 0) {
    console.log(`Cleaned orphan cloudflared processes: ${cleanedOrphans}`);
  }

  const runningPid = readPidFile(CLOUDFLARED_PID_PATH);
  if (runningPid && isPidAlive(runningPid)) {
    let healthUrl = runtimeWebAppUrl;
    if (tunnelMode === "quick") {
      const existingUrl = readCloudflaredUrlFromLog();
      if (existingUrl) setRuntimeWebAppUrl(existingUrl, true);
      healthUrl = existingUrl || runtimeWebAppUrl;
    }
    const reachable = await isWebAppLaunchReachable(healthUrl);
    const dnsReachable = reachable ? true : await resolvesWebAppHostViaPublicDns(healthUrl);
    if (!reachable && !dnsReachable) {
      await stopCloudflaredProcess(runningPid);
      clearPidFile(CLOUDFLARED_PID_PATH);
    } else {
      const systemDnsReachable = await resolvesWebAppHostViaSystemDns(healthUrl);
      const dnsNotice = systemDnsReachable
        ? ""
        : " Warning: local DNS cannot resolve BOT_WEBAPP_URL (Mini App may fail on this host).";
      return {
        ok: true,
        skipped: false,
        started: false,
        notice: `Cloudflare tunnel active (${tunnelMode}, pid=${runningPid}).${dnsNotice}`,
      };
    }
  }

  let startedPid;
  try {
    startedPid = spawnCloudflaredTunnelProcess(tunnelMode);
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      started: false,
      notice: `Cloudflare tunnel restart failed: ${err.message}`,
    };
  }

  const waitTimeoutMs = Math.max(5000, BOT_TUNNEL_START_TIMEOUT_MS);
  const deadline = Date.now() + waitTimeoutMs;
  let lastUnreachableUrl = "";

  if (tunnelMode === "named") {
    while (Date.now() < deadline) {
      if (!isPidAlive(startedPid)) {
        clearPidFile(CLOUDFLARED_PID_PATH);
        return {
          ok: false,
          skipped: false,
          started: true,
          notice: "Cloudflare named tunnel exited unexpectedly while starting.",
        };
      }
      const reachable = await isWebAppLaunchReachable(runtimeWebAppUrl);
      const dnsReachable = reachable ? true : await resolvesWebAppHostViaPublicDns(runtimeWebAppUrl);
      if (reachable || dnsReachable) {
        const systemDnsReachable = await resolvesWebAppHostViaSystemDns(runtimeWebAppUrl);
        const dnsNotice = systemDnsReachable
          ? ""
          : " Warning: local DNS cannot resolve BOT_WEBAPP_URL (Mini App may fail on this host).";
        return {
          ok: true,
          skipped: false,
          started: true,
          notice: `Cloudflare tunnel restored (${tunnelMode}): ${runtimeWebAppUrl}.${dnsNotice}`,
        };
      }
      await sleep(1000);
    }

    return {
      ok: false,
      skipped: false,
      started: true,
      notice: `Cloudflare tunnel started (pid=${startedPid}) but URL not reachable: ${runtimeWebAppUrl}`,
    };
  }

  while (Date.now() < deadline) {
    if (!isPidAlive(startedPid)) {
      clearPidFile(CLOUDFLARED_PID_PATH);
      return {
        ok: false,
        skipped: false,
        started: true,
        notice: "Cloudflare tunnel exited unexpectedly while starting.",
      };
    }
    const nextUrl = readCloudflaredUrlFromLog();
    if (nextUrl) {
      const reachable = await isWebAppLaunchReachable(nextUrl);
      const dnsReachable = reachable ? true : await resolvesWebAppHostViaPublicDns(nextUrl);
      if (reachable || dnsReachable) {
        setRuntimeWebAppUrl(nextUrl, true);
        const systemDnsReachable = await resolvesWebAppHostViaSystemDns(nextUrl);
        const dnsNotice = systemDnsReachable
          ? ""
          : " Warning: local DNS cannot resolve BOT_WEBAPP_URL (Mini App may fail on this host).";
        return {
          ok: true,
          skipped: false,
          started: true,
          notice: `Cloudflare tunnel restored (${tunnelMode}): ${nextUrl}.${dnsNotice}`,
        };
      }
      if (nextUrl !== lastUnreachableUrl) {
        lastUnreachableUrl = nextUrl;
        console.warn(`Cloudflare tunnel URL not reachable yet: ${nextUrl}`);
      }
    }
    await sleep(1000);
  }

  return {
    ok: false,
    skipped: false,
    started: true,
    notice: lastUnreachableUrl
      ? `Cloudflare tunnel started (pid=${startedPid}) but URL not reachable: ${lastUnreachableUrl}`
      : `Cloudflare tunnel started (pid=${startedPid}) but no URL detected within ${waitTimeoutMs}ms.`,
  };
}

function getWebAppReadiness() {
  const launchUrl = resolveWebAppLaunchUrl(runtimeWebAppUrl);
  if (!BOT_WEBAPP_ENABLE) {
    return {
      ok: false,
      launchUrl: "",
      reason: "BOT_WEBAPP_ENABLE=0",
    };
  }
  if (!launchUrl) {
    return {
      ok: false,
      launchUrl: "",
      reason: "BOT_WEBAPP_URL missing or invalid",
    };
  }

  try {
    const parsed = new URL(launchUrl);
    if (parsed.protocol !== "https:") {
      return {
        ok: false,
        launchUrl,
        reason: "BOT_WEBAPP_URL must use https:// for Telegram Mini App",
      };
    }
  } catch (err) {
    return {
      ok: false,
      launchUrl: "",
      reason: "BOT_WEBAPP_URL missing or invalid",
    };
  }

  return {
    ok: true,
    launchUrl,
    reason: "ready",
  };
}

function isAuthorized(msg) {
  return String(msg?.from?.id || "") === TELEGRAM_ALLOWED_USER_ID;
}

function isSlackChatId(chatId) {
  return typeof chatId === "string" && chatId.startsWith("slack:");
}

function makeSlackChatId(channelId) {
  const value = String(channelId || "").trim();
  if (!value) return "";
  return `slack:${value}`;
}

function slackChannelFromChatId(chatId) {
  if (!isSlackChatId(chatId)) return "";
  return String(chatId).slice("slack:".length);
}

function decodeHtmlEntities(text) {
  return String(text || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function telegramHtmlToSlackText(text) {
  let value = String(text || "");
  value = value.replace(/<pre>([\s\S]*?)<\/pre>/gi, (_match, block) => `\`\`\`\n${decodeHtmlEntities(block)}\n\`\`\``);
  value = value.replace(/<code>([\s\S]*?)<\/code>/gi, (_match, block) => `\`${decodeHtmlEntities(block)}\``);
  value = value.replace(/<\/?b>/gi, "*").replace(/<\/?strong>/gi, "*");
  value = value.replace(/<\/?i>/gi, "_").replace(/<\/?em>/gi, "_");
  value = value.replace(/<\/?[^>]+>/g, "");
  return decodeHtmlEntities(value);
}

async function sendSlackMessage(chatId, text) {
  const channel = slackChannelFromChatId(chatId);
  if (!channel || !slackApp) return null;
  try {
    const response = await slackApp.client.chat.postMessage({
      channel,
      text: telegramHtmlToSlackText(text),
      unfurl_links: false,
      unfurl_media: false,
    });
    if (!response?.ok) return null;
    return { message_id: response.ts };
  } catch (err) {
    console.error("Failed to send Slack message:", err.message);
    return null;
  }
}

async function sendMessage(chatId, text, options = {}) {
  try {
    return await bot.sendMessage(chatId, text, options);
  } catch (err) {
    console.error("Failed to send Telegram message:", err.message);
    logRuntimeEvent("telegram_send_failed", {
      chatId: String(chatId || ""),
      error: trimErrorMessage(err),
    });
    return null;
  }
}

async function sendTypingAction(chatId) {
  try {
    await bot.sendChatAction(chatId, "typing");
    return true;
  } catch (err) {
    logRuntimeEvent("telegram_typing_failed", {
      chatId: String(chatId || ""),
      error: trimErrorMessage(err),
    });
    return false;
  }
}

function splitTextForTelegram(text, maxChars = TELEGRAM_TEXT_CHUNK_CHARS) {
  const normalized = String(text || "").replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];
  if (normalized.length <= maxChars) return [normalized];

  const chunks = [];
  let remaining = normalized;
  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf("\n\n", maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = remaining.lastIndexOf("\n", maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = remaining.lastIndexOf(" ", maxChars);
    if (cut < Math.floor(maxChars * 0.5)) cut = maxChars;
    const piece = remaining.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.trim()) chunks.push(remaining.trim());
  return chunks;
}

async function sendLongText(chatId, text, options = {}) {
  const chunks = splitTextForTelegram(text, TELEGRAM_TEXT_CHUNK_CHARS);
  if (!chunks.length) return null;

  let last = null;
  for (const chunk of chunks) {
    last = await sendMessage(chatId, chunk, options);
  }
  return last;
}

function trimErrorMessage(err) {
  const raw = String(err?.message || err || "").replace(/\s+/g, " ").trim();
  return raw.slice(0, 300) || "unknown error";
}

function codexLoginCommandHint() {
  if (fs.existsSync("/.dockerenv")) {
    return "docker compose exec termbot codex login --device-auth";
  }
  return `${RESOLVED_CODEX_BIN} login --device-auth`;
}

function codexLoginStatusCommandHint() {
  if (fs.existsSync("/.dockerenv")) {
    return "docker compose exec termbot codex login status";
  }
  return `${RESOLVED_CODEX_BIN} login status`;
}

function buildCodexLoginRequiredMessage() {
  return [
    "Codex ist noch nicht angemeldet.",
    `Bitte zuerst anmelden: ${codexLoginCommandHint()}`,
    `Danach pruefen: ${codexLoginStatusCommandHint()}`,
    "Erst danach starte ich den Setup-Wizard und Codex-Sessions sauber.",
  ].join("\n");
}

async function probeCodexLoginStatus() {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(RESOLVED_CODEX_BIN, ["login", "status"], {
      cwd: RESOLVED_BOT_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 4000) stdout = stdout.slice(-4000);
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });

    child.on("error", (err) => {
      resolve({
        ok: false,
        installed: false,
        loggedIn: false,
        detail: trimErrorMessage(err),
      });
    });

    child.on("close", (code) => {
      const combined = `${stdout}\n${stderr}`.trim();
      const normalized = combined.toLowerCase();
      const loggedIn = code === 0 && /logged in/.test(normalized);
      resolve({
        ok: loggedIn,
        installed: true,
        loggedIn,
        detail: combined || (code === 0 ? "ok" : `exit code ${code}`),
      });
    });
  });
}

async function ensureCodexLoginReady(chatId, options = {}) {
  const result = await probeCodexLoginStatus();
  if (result.ok) return true;
  if (!options.silent) {
    await sendMessage(chatId, buildCodexLoginRequiredMessage());
  }
  return false;
}

function createRuntimeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function extractCommandName(text) {
  const normalized = String(text || "").trim();
  if (!normalized) return "(empty)";
  const first = normalized.split(/\s+/g)[0];
  if (first.startsWith("/")) return first.toLowerCase();
  if (first.length > 64) return `${first.slice(0, 61)}...`;
  return first.toLowerCase();
}

function currentRuntimeState() {
  if (isRestartingBot) return "restarting";
  if (!activeRun) return "idle";
  if (activeRun.mode === "shell_command" && !activeRun.done) return "shell_running";
  if (activeRun.mode === "codex_tmux" && !activeRun.done) return "codex_running";
  return "idle";
}

function logRuntimeEvent(type, payload = {}) {
  appendRuntimeEvent(BOT_RUNTIME_EVENTS_PATH, {
    type,
    pid: process.pid,
    state: currentRuntimeState(),
    pipelineVersion: CHAT_PIPELINE_VERSION,
    releaseLabel: CHAT_PIPELINE_RELEASE_LABEL,
    ...payload,
  });
}

function beginCommandTrace(source, chatId, text) {
  const trace = {
    id: createRuntimeId("cmd"),
    source: String(source || "unknown"),
    chatId: String(chatId || ""),
    command: extractCommandName(text),
    textPreview: shortInputPreview(text || ""),
    finished: false,
    startedAt: Date.now(),
  };
  logRuntimeEvent("command_received", {
    commandId: trace.id,
    source: trace.source,
    chatId: trace.chatId,
    command: trace.command,
    textPreview: trace.textPreview,
  });
  logRuntimeEvent("command_started", {
    commandId: trace.id,
    source: trace.source,
    chatId: trace.chatId,
    command: trace.command,
  });
  return trace;
}

function finishCommandTrace(trace, status, payload = {}) {
  if (!trace || trace.finished) return;
  trace.finished = true;
  const runtimeMs = Date.now() - trace.startedAt;
  logRuntimeEvent(status, {
    commandId: trace.id,
    source: trace.source,
    chatId: trace.chatId,
    command: trace.command,
    runtimeMs,
    ...payload,
  });
}

function writeRuntimeStateSnapshot(extra = {}) {
  writeRuntimeJson(BOT_RUNTIME_STATE_PATH, {
    pid: process.pid,
    state: currentRuntimeState(),
    ts: new Date().toISOString(),
    ...extra,
  });
}

function writeRestartReadyMarker(extra = {}) {
  writeRuntimeJson(BOT_RESTART_READY_FILE, {
    pid: process.pid,
    restartId: BOT_RESTART_BOOT_ID || "",
    source: BOT_RESTART_BOOT_SOURCE || "",
    chatId: BOT_RESTART_BOOT_CHAT_ID || "",
    ts: new Date().toISOString(),
    ...extra,
  });
}

function getOpenAiApiKey() {
  return String(process.env.OPENAI_API_KEY || "").trim();
}

function getVoiceInputMeta(msg) {
  if (msg?.voice?.file_id) {
    return {
      kind: "voice",
      fileId: String(msg.voice.file_id),
      durationSec: Number(msg.voice.duration || 0),
    };
  }
  if (msg?.audio?.file_id) {
    return {
      kind: "audio",
      fileId: String(msg.audio.file_id),
      durationSec: Number(msg.audio.duration || 0),
    };
  }
  return null;
}

function buildVoiceReadiness() {
  const scriptExists = Boolean(BOT_VOICE_TRANSCRIBE_SCRIPT && fs.existsSync(BOT_VOICE_TRANSCRIBE_SCRIPT));
  const keySet = Boolean(getOpenAiApiKey());
  const ready = BOT_VOICE_ENABLED && scriptExists && keySet;
  const reason = ready
    ? "ready"
    : !BOT_VOICE_ENABLED
      ? "BOT_VOICE_ENABLED=0"
      : !scriptExists
        ? `transcribe script missing (${BOT_VOICE_TRANSCRIBE_SCRIPT})`
        : "OPENAI_API_KEY missing";
  return {
    ready,
    reason,
    scriptExists,
    keySet,
  };
}

function buildVoiceStatusLines() {
  const readiness = buildVoiceReadiness();
  return [
    "Voice status:",
    `- enabled: ${BOT_VOICE_ENABLED ? "on" : "off"}`,
    `- max duration: ${BOT_VOICE_MAX_DURATION_SEC}s`,
    `- transcribe bin: ${BOT_VOICE_TRANSCRIBE_BIN}`,
    `- transcribe model: ${BOT_VOICE_TRANSCRIBE_MODEL}`,
    `- transcribe script: ${readiness.scriptExists ? "found" : "missing"} (${BOT_VOICE_TRANSCRIBE_SCRIPT})`,
    `- OPENAI_API_KEY: ${readiness.keySet ? "set" : "missing"}`,
    `- result: ${readiness.reason}`,
  ];
}

function normalizeTranscribedText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function transcribeAudioFileWithSkill(audioPath) {
  return new Promise((resolve, reject) => {
    const args = [
      BOT_VOICE_TRANSCRIBE_SCRIPT,
      audioPath,
      "--model",
      BOT_VOICE_TRANSCRIBE_MODEL,
      "--response-format",
      "text",
      "--chunking-strategy",
      "auto",
      "--stdout",
    ];
    if (BOT_VOICE_LANGUAGE) {
      args.push("--language", BOT_VOICE_LANGUAGE);
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(BOT_VOICE_TRANSCRIBE_BIN, args, {
      cwd: RESOLVED_BOT_CWD,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch (_err) {
        // ignore
      }
    }, BOT_VOICE_TRANSCRIBE_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 120_000) {
        stdout = stdout.slice(stdout.length - 120_000);
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 12_000) {
        stderr = stderr.slice(stderr.length - 12_000);
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`voice transcription timed out after ${BOT_VOICE_TRANSCRIBE_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        const message = stderr.trim() || `transcribe process exited with code ${code}`;
        reject(new Error(message));
        return;
      }
      resolve(normalizeTranscribedText(stdout));
    });
  });
}

async function transcribeVoiceInput(chatId, voiceMeta) {
  if (!BOT_VOICE_ENABLED) {
    await sendMessage(chatId, "Voice messages are disabled (BOT_VOICE_ENABLED=0).");
    return "";
  }

  if (voiceMeta.durationSec > 0 && voiceMeta.durationSec > BOT_VOICE_MAX_DURATION_SEC) {
    await sendMessage(
      chatId,
      `Voice message too long (${voiceMeta.durationSec}s). Max allowed: ${BOT_VOICE_MAX_DURATION_SEC}s.`
    );
    return "";
  }

  const readiness = buildVoiceReadiness();
  if (!readiness.ready) {
    await sendMessage(chatId, `Voice transcription not ready: ${readiness.reason}. Use /voice for details.`);
    return "";
  }

  await sendMessage(chatId, "Voice message received. Transcribing...");
  fs.mkdirSync(VOICE_INPUT_DIR, { recursive: true });

  let downloadedPath = "";
  try {
    downloadedPath = await bot.downloadFile(voiceMeta.fileId, VOICE_INPUT_DIR);
  } catch (err) {
    await sendMessage(chatId, `Could not download voice file: ${err.message}`);
    return "";
  }

  try {
    const transcript = await transcribeAudioFileWithSkill(downloadedPath);
    if (!transcript) {
      await sendMessage(chatId, "Transcription returned no text. Please try again with clearer speech.");
      return "";
    }
    if (BOT_VOICE_ECHO_TRANSCRIPT) {
      await sendMessage(chatId, `Transcription:\n${shortenText(transcript, 900)}`);
    }
    return transcript;
  } catch (err) {
    await sendMessage(chatId, `Voice transcription failed: ${err.message}`);
    return "";
  } finally {
    if (!BOT_VOICE_KEEP_FILES && downloadedPath) {
      try {
        fs.unlinkSync(downloadedPath);
      } catch (_err) {
        // ignore
      }
    }
  }
}

async function sendCodeBlock(chatId, output) {
  if (!output) return;
  const chunks = splitText(output, OUTPUT_CHUNK_SIZE);
  for (const chunk of chunks) {
    await sendMessage(chatId, `<pre>${escapeHtml(chunk)}</pre>`, { parse_mode: "HTML" });
  }
}

function normalizeShellOutput(text) {
  return text
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

function normalizeCapturedScreen(text) {
  let output = String(text || "")
    .replace(/\r/g, "")
    .replace(/\u0000/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b\][^\u0007]*(\u0007|\u001b\\)/g, "");

  output = output
    .split("\n")
    .map((line) =>
      line
        .replace(/\s+$/g, "")
        .replace(/^(\s*)[•●◦▪▫]\s+/u, "$1- ")
        .replace(/\t/g, "  ")
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();

  if (!output) return DEFAULT_SCREEN_TEXT;
  return output;
}

const RESOLVED_BOT_SHELL = resolveShellPath(BOT_SHELL);
const RESOLVED_BOT_CWD = resolveCwd(BOT_CWD);

let shell = null;
let isRestartingShell = false;
let lastKnownCwd = RESOLVED_BOT_CWD;
let activeRun = null;
let tmuxAvailable = BOT_CODEX_BACKEND === "tmux";
let miniAppServer = null;
let lastMiniSnapshot = null;
let recentProjects = readRecentProjects();
let isRestartingBot = false;
let runtimeWebAppUrl = BOT_WEBAPP_URL;
let startupTunnelNotice = "";
let userProfile = readUserProfile();
let modelProfile = readModelProfile();
let preferenceHintsState = readPreferenceHintsState();
let onboardingState = null;
let reminderState = readReminderState();
let telegramConflictTimestamps = [];
let telegramConflictRecoveryScheduled = false;
const reminderTimers = new Map();
const callbackQuerySeen = new Map();

function profileDisplayName() {
  return userProfile.ownerName || "User";
}

function assistantDisplayName() {
  return userProfile.assistantName || "Assistant";
}

function applyUserProfileToPersonality() {
  const saved = writeUserProfile(userProfile);
  userProfile = saved;
  const syncResult = upsertUserProfileIntoPersonality(userProfile);
  if (!syncResult.ok) {
    console.warn(`Failed to sync user profile into personality file: ${syncResult.error}`);
  }
  return syncResult;
}

function startProfileOnboarding(chatId, force = false) {
  if (!force && isUserProfileComplete(userProfile)) return false;
  onboardingState = {
    chatId,
    step: "persona_preset",
    draft: {
      personaPreset: force ? "" : normalizePersonaPreset(userProfile.personaPreset || ""),
      ownerName: force ? "" : userProfile.ownerName || "",
      assistantName: force ? "" : userProfile.assistantName || "",
      tone: force ? "" : userProfile.tone || "",
      preferences: force ? "" : userProfile.preferences || "",
    },
    startedAt: Date.now(),
  };
  return true;
}

async function sendOnboardingPrompt(chatId) {
  if (!onboardingState || onboardingState.chatId !== chatId) return;
  if (onboardingState.step === "persona_preset") {
    await sendMessage(
      chatId,
      "Waehle dein Persona-Setup: `schenni` (Preset) oder `custom` (eigene Persoenlichkeit)."
    );
    return;
  }
  if (onboardingState.step === "owner_name") {
    await sendMessage(chatId, "Bevor wir starten: Wie heißt du? (z.B. Alex)");
    return;
  }
  if (onboardingState.step === "assistant_name") {
    await sendMessage(chatId, "Wie soll ich heißen? (z.B. Codex, Jarvis, Assistent)");
    return;
  }
  if (onboardingState.step === "tone") {
    await sendMessage(chatId, "Wie soll ich mit dir kommunizieren? `formal`, `leger` oder `eigene preferences`", {
      parse_mode: "Markdown",
    });
    return;
  }
  if (onboardingState.step === "preferences") {
    await sendMessage(
      chatId,
      "Nenne bitte deine eigenen Preferences in einem Satz (z.B. kurz, direkt, 1-3 Schritte, keine Floskeln)."
    );
  }
}

async function completeOnboarding(chatId) {
  if (!onboardingState || onboardingState.chatId !== chatId) return;
  const chosenPreset = normalizePersonaPreset(onboardingState.draft.personaPreset || "") || "custom";
  userProfile = {
    ...userProfile,
    ownerName: onboardingState.draft.ownerName || userProfile.ownerName || "",
    assistantName: onboardingState.draft.assistantName || userProfile.assistantName || "",
    tone: onboardingState.draft.tone || userProfile.tone || "custom",
    preferences: onboardingState.draft.preferences || userProfile.preferences || "",
    personaPreset: chosenPreset,
    configuredAt: new Date().toISOString(),
    setupCompleted: true,
  };
  onboardingState = null;
  const syncResult = applyUserProfileToPersonality();
  const syncInfo = syncResult.ok ? "in die Persönlichkeit gespeichert" : "lokal gespeichert (Persönlichkeitsdatei konnte nicht aktualisiert werden)";
  const presetLabel = personaPresetLabel(chosenPreset);
  await sendMessage(
    chatId,
    `Danke ${profileDisplayName()}. Aktiv: ${presetLabel}. Ich heiße jetzt ${assistantDisplayName()} und kommuniziere ${toneLabel(userProfile.tone)}. Einstellungen wurden ${syncInfo}.`
  );
}

async function maybeHandleOnboardingReply(chatId, text) {
  if (!onboardingState || onboardingState.chatId !== chatId) return false;
  const normalized = String(text || "").trim();
  const lowered = normalized.toLowerCase();

  if (!normalized) return true;
  if (lowered === "/cancel" || lowered === "/abbrechen") {
    onboardingState = null;
    await sendMessage(chatId, "Onboarding abgebrochen. Starte es jederzeit mit /setupassistant.");
    return true;
  }
  if (normalized.startsWith("/")) {
    await sendMessage(chatId, "Bitte antworte mit Text oder nutze /cancel.");
    return true;
  }

  if (onboardingState.step === "persona_preset") {
    const preset = normalizePersonaPreset(normalized);
    if (!preset || (preset !== "schenni" && preset !== "custom")) {
      await sendMessage(chatId, "Bitte antworte mit `schenni` oder `custom`.");
      return true;
    }
    onboardingState.draft.personaPreset = preset;
    if (preset === "schenni") {
      onboardingState.step = "owner_name";
      await sendMessage(chatId, "Schenni ist aktiv. Wir brauchen nur deinen Namen, den Rest setze ich aus dem Preset.");
      await sendOnboardingPrompt(chatId);
      return true;
    }
    onboardingState.step = "owner_name";
    await sendMessage(chatId, "Custom ist aktiv. Wir bauen jetzt deine eigene Persoenlichkeit.");
    await sendOnboardingPrompt(chatId);
    return true;
  }

  if (onboardingState.step === "owner_name") {
    onboardingState.draft.ownerName = normalized.slice(0, 80);
    if (onboardingState.draft.personaPreset === "schenni") {
      onboardingState.draft.assistantName = "Schenni";
      onboardingState.draft.tone = "leger";
      onboardingState.draft.preferences =
        "Kurz, keck und ostdeutsch. Bei komplexen Themen kompakt und strukturiert.";
      await completeOnboarding(chatId);
      return true;
    }
    onboardingState.step = "assistant_name";
    await sendOnboardingPrompt(chatId);
    return true;
  }
  if (onboardingState.step === "assistant_name") {
    onboardingState.draft.assistantName = normalized.slice(0, 80);
    onboardingState.step = "tone";
    await sendOnboardingPrompt(chatId);
    return true;
  }
  if (onboardingState.step === "tone") {
    const tone = normalizeTone(normalized);
    onboardingState.draft.tone = tone || "custom";
    onboardingState.step = "preferences";
    await sendOnboardingPrompt(chatId);
    return true;
  }
  if (onboardingState.step === "preferences") {
    onboardingState.draft.preferences = normalized.slice(0, 300);
    await completeOnboarding(chatId);
    return true;
  }

  return false;
}

function parseTimerCommandInput(text) {
  const match = /^\/timer\s+([0-9]+[smhd])(?:\s+([\s\S]+))?$/i.exec(String(text || "").trim());
  if (!match) return null;
  const ms = parseDurationMs(match[1]);
  if (!ms) return null;
  const label = String(match[2] || "Timer abgelaufen.").trim().slice(0, MAX_REMINDER_TEXT_CHARS);
  return {
    ms,
    label: label || "Timer abgelaufen.",
  };
}

function parseRemindCommandInput(text) {
  const match = /^\/remind\s+(\d{1,2}:\d{2})(?:\s+([\s\S]+))?$/i.exec(String(text || "").trim());
  if (!match) return null;
  const hhmm = parseClockHHMM(match[1]);
  if (!hhmm) return null;
  const runAt = nextRunForClockHHMM(hhmm, Date.now());
  if (!runAt) return null;
  const label = String(match[2] || "Erinnerung.").trim().slice(0, MAX_REMINDER_TEXT_CHARS);
  return {
    runAt,
    hhmm,
    label: label || "Erinnerung.",
  };
}

function parseDailyCommandInput(text) {
  const match = /^\/daily\s+(\d{1,2}:\d{2})(?:\s+([\s\S]+))?$/i.exec(String(text || "").trim());
  if (!match) return null;
  const hhmm = parseClockHHMM(match[1]);
  if (!hhmm) return null;
  const label = String(match[2] || "Tägliche Erinnerung.").trim().slice(0, MAX_REMINDER_TEXT_CHARS);
  return {
    hhmm,
    label: label || "Tägliche Erinnerung.",
  };
}

function createReminderId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function persistReminders() {
  reminderState = writeReminderState(reminderState);
}

function unscheduleReminder(id) {
  const timer = reminderTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    reminderTimers.delete(id);
  }
}

function scheduleReminder(reminder) {
  unscheduleReminder(reminder.id);
  if (!reminder.active) return;

  let dueAt = 0;
  if (reminder.type === "once") {
    dueAt = Number(reminder.runAt || 0);
    if (!Number.isFinite(dueAt) || dueAt <= 0) return;
  } else {
    dueAt = nextRunForClockHHMM(reminder.time, Date.now());
    if (!dueAt) return;
  }

  const now = Date.now();
  let delay = Math.max(0, dueAt - now);
  const MAX_DELAY = 2_147_000_000;
  if (delay > MAX_DELAY) delay = MAX_DELAY;

  const timer = setTimeout(async () => {
    reminderTimers.delete(reminder.id);
    const idx = reminderState.reminders.findIndex((item) => item.id === reminder.id);
    if (idx < 0) return;
    const current = reminderState.reminders[idx];
    if (!current || !current.active) return;

    const who = profileDisplayName();
    const sent = await sendMessage(current.chatId, `⏰ Erinnerung für ${who}: ${current.message}`);
    if (!sent) {
      logRuntimeEvent("reminder_send_failed", {
        reminderId: String(current.id || ""),
        reminderType: String(current.type || ""),
        chatId: String(current.chatId || ""),
      });
      if (current.type === "once") {
        const retryAt = Date.now() + 60_000;
        reminderState.reminders[idx] = {
          ...current,
          runAt: retryAt,
          lastErrorAt: new Date().toISOString(),
        };
        persistReminders();
        scheduleReminder(reminderState.reminders[idx]);
        return;
      }
      reminderState.reminders[idx] = {
        ...current,
        lastErrorAt: new Date().toISOString(),
      };
      persistReminders();
      scheduleReminder(reminderState.reminders[idx]);
      return;
    }
    recordActivity(
      "reminder_triggered",
      "Erinnerung ausgeloest",
      `ID: ${current.id}\nTyp: ${current.type}\nText: ${current.message}`,
      current.chatId
    );

    if (current.type === "once") {
      reminderState.reminders[idx] = {
        ...current,
        active: false,
        sentAt: new Date().toISOString(),
      };
      persistReminders();
      return;
    }

    reminderState.reminders[idx] = {
      ...current,
      lastSentAt: new Date().toISOString(),
    };
    persistReminders();
    scheduleReminder(reminderState.reminders[idx]);
  }, delay);

  reminderTimers.set(reminder.id, timer);
}

function scheduleAllReminders() {
  for (const reminder of reminderState.reminders) {
    if (!reminder.active) continue;
    // Catch up overdue one-time reminders after restarts instead of dropping them.
    scheduleReminder(reminder);
  }
  persistReminders();
}

function listActiveReminders() {
  return reminderState.reminders.filter((item) => item.active);
}

function rememberRecentProject(command, cwd) {
  const normalizedCommand = String(command || "codex").trim() || "codex";
  const normalizedCwd = resolveCwd(cwd || RESOLVED_BOT_CWD);
  const nowIso = new Date().toISOString();
  const key = projectKey(normalizedCommand, normalizedCwd);

  const existingIndex = recentProjects.findIndex((item) => item.key === key);
  if (existingIndex >= 0) {
    const entry = {
      ...recentProjects[existingIndex],
      command: normalizedCommand,
      cwd: normalizedCwd,
      projectName: shortProjectName(normalizedCwd),
      starts: Math.max(1, Number(recentProjects[existingIndex].starts || 1) + 1),
      lastStartedAt: nowIso,
    };
    recentProjects.splice(existingIndex, 1);
    recentProjects.unshift(entry);
    writeRecentProjects(recentProjects.slice(0, MAX_RECENT_PROJECTS));
    return entry;
  }

  const entry = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    key,
    command: normalizedCommand,
    cwd: normalizedCwd,
    projectName: shortProjectName(normalizedCwd),
    starts: 1,
    lastStartedAt: nowIso,
    lastFinishedAt: "",
    lastReason: "",
  };
  recentProjects.unshift(entry);
  if (recentProjects.length > MAX_RECENT_PROJECTS) {
    recentProjects = recentProjects.slice(0, MAX_RECENT_PROJECTS);
  }
  writeRecentProjects(recentProjects);
  return entry;
}

function markRecentProjectFinished(recentId, reason) {
  if (!recentId) return;
  const index = recentProjects.findIndex((item) => item.id === recentId);
  if (index < 0) return;
  recentProjects[index] = {
    ...recentProjects[index],
    lastFinishedAt: new Date().toISOString(),
    lastReason: String(reason || ""),
  };
  writeRecentProjects(recentProjects);
}

function findRecentProjectById(id) {
  return recentProjects.find((item) => item.id === id) || null;
}

function buildRecentProjectsKeyboard() {
  const rows = [];
  for (const entry of recentProjects.slice(0, 8)) {
    rows.push([{ text: shortRecentButtonLabel(entry), callback_data: `recent_start:${entry.id}` }]);
  }
  rows.push([{ text: "Start New Session", callback_data: "start_codex" }]);
  return rows;
}

function buildRecentProjectsPlaintext() {
  if (!recentProjects.length) {
    return "No previous sessions found.";
  }
  const lines = ["Previous sessions:"];
  recentProjects.slice(0, 8).forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.projectName} | ${entry.command}`);
    lines.push(`   id=${entry.id}`);
    lines.push(`   cwd=${entry.cwd}`);
  });
  lines.push("");
  lines.push("Use: /recentstart <id>");
  return lines.join("\n");
}

async function restartBotProcess(chatId, source = "chat") {
  if (isRestartingBot) {
    await sendMessage(chatId, "Restart already in progress.");
    return false;
  }

  isRestartingBot = true;
  if (activeRun && activeRun.mode === "codex_tmux" && !activeRun.done) {
    pushRunEvent(activeRun, `bot restart requested (${source})`);
  }

  const restartId = createRuntimeId("rst");
  await sendMessage(chatId, `Restart accepted (id=${restartId}).`);
  logRuntimeEvent("restart_requested", {
    restartId,
    source: String(source || "unknown"),
    chatId: String(chatId || ""),
  });

  try {
    writeRestartContext(BOT_RESTART_CONTEXT_PATH, source, chatId, restartId);
    if (BOT_SUPERVISED) {
      setTimeout(() => {
        process.exit(0);
      }, 350);
      return true;
    }
    const helperArgs = [
      BOT_RESTART_HELPER_PATH,
      `--old-pid=${process.pid}`,
      `--cwd=${BOT_PROJECT_ROOT}`,
      `--node=${process.execPath}`,
      `--entry=${path.join(__dirname, "bot.js")}`,
      `--log=${BOT_RUNTIME_LOG_PATH}`,
      `--restart-log=${BOT_RESTART_LOG_PATH}`,
      `--chat-id=${String(chatId || "").trim()}`,
      `--source=${source}`,
      `--restart-id=${restartId}`,
      `--ready-file=${BOT_RESTART_READY_FILE}`,
      `--health-timeout=${BOT_RESTART_HEALTH_TIMEOUT_MS}`,
    ];
    const child = spawn(process.execPath, helperArgs, {
      cwd: RESOLVED_BOT_CWD,
      env: process.env,
      detached: true,
      stdio: "ignore",
    });
    if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
      throw new Error("could not start replacement bot process");
    }
    child.unref();
    setTimeout(() => {
      process.exit(0);
    }, 350);
    return true;
  } catch (err) {
    isRestartingBot = false;
    logRuntimeEvent("restart_failed", {
      restartId,
      source: String(source || "unknown"),
      chatId: String(chatId || ""),
      error: trimErrorMessage(err),
    });
    await sendMessage(chatId, `Restart failed (id=${restartId}): ${trimErrorMessage(err)}`);
    return false;
  }
}

function runMode() {
  return currentRuntimeState();
}

function codexTurnState(run) {
  return run.awaitingTurnCompletion ? "thinking ..." : "done";
}

function normalizeCapturedLine(line) {
  return String(line || "").replace(/\s+/g, " ").trim();
}

function stripLeadingListMarker(line) {
  return normalizeCapturedLine(line).replace(/^[-*]\s+/, "").trim();
}

function normalizeComparableText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\[pasted content[^\]]*\]/gi, " ")
    .replace(/[^a-z0-9\u00c0-\u017f\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripPromptPrefix(line) {
  return String(line || "").replace(/^\s*›\s*/, "").trim();
}

function isCodexUiNoiseLine(line, options = {}) {
  const normalized = normalizeCapturedLine(line);
  if (!normalized) return true;
  const stripped = stripLeadingListMarker(normalized);
  if (!stripped) return true;
  const lower = stripped.toLowerCase();
  const lowerPreview = normalizeComparableText(options?.lowerPreview || "");
  const turnPrompt = normalizeComparableText(options?.turnPrompt || "");
  const sessionName = String(options?.sessionName || "").trim().toLowerCase();

  const noisePatterns = [
    /^thinking\s*\.\.\.$/i,
    /^done$/i,
    /^antwort gesendet\.?$/i,
    /^answer sent\.?$/i,
    /^=+$/,
    /^[-_]{3,}$/,
    /^\[(\s*system\s*\|\s*meta|\s*answer\s*\|\s*(live|done))\]$/i,
    /^(state|mode|session|status|runtime|turn|input|rev|profile|last_input|last_event)\s*:/i,
    /^(global commands:|idle mode:|while codex is running:|mini app:)/i,
    /^\/[a-z0-9_-]+/i,
    /^(telegram terminal bot is ready|codex session (finished|cancelled|timed out))/i,
    /^[\u2500-\u257f]+$/,
    /^\s*›\s.+$/,
    /^\s*gpt-\d+/i,
    /^model:\s*/i,
    /^directory:\s*/i,
    /^\?\s+for shortcuts/i,
    /^tip:\s*/i,
    /^use \/skills\b/i,
    /^working\s*\(/i,
    /^\(teil\s+\d+\/\d+\)\s*$/i,
    /^searched$/i,
    /^searched\s+/i,
    /^profile source:\s*/i,
    /^#{1,6}\s*[a-d]\)\s*(pers[oö]nlicher assistent|projektmanager|developer|testing[- ]ingenieur)\b/i,
    /^(aufgabe|verhalten|output[- ]format|engineering[- ]regeln|test[- ]mindeststandard)\s*:?\s*$/i,
    /^(kritische systeme\/services kurz verifizieren|waehrend der arbeit|aenderungen in kleinen, nachvollziehbaren schritten|vor riskanten aenderungen:\s*backup\/checkpoint)\b/i,
    /^##\s*(rollenmodell|entscheidungsprinzipien|kommunikationsmodus|v3 start-checkliste)\b/i,
    /^use the following operating profile/i,
    /^\[profile_(start|end)\]/i,
    /^openai codex\s*\(v/i,
    /^model:\s+loading\b/i,
    /^hi\.\s+what do you need\?$/i,
    /^hi\.?$/i,
    /^\s*[│╭╮╰╯].*$/,
    /^p'? or visit https:\/\/chatgpt\.com\/codex/i,
  ];

  if (noisePatterns.some((pattern) => pattern.test(stripped) || pattern.test(normalized))) return true;
  if (sessionName && lower.includes(sessionName)) return true;
  if (lowerPreview && lowerPreview.length >= 8 && lower.includes(lowerPreview)) return true;
  if (turnPrompt && turnPrompt.length >= 10 && lower === turnPrompt) return true;
  return false;
}

function splitScreenLines(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""));
}

function findPromptAnchorIndex(lines, promptText = "") {
  const promptNorm = normalizeComparableText(promptText);
  const needles = [];
  if (promptNorm) {
    needles.push(promptNorm);
    if (promptNorm.length >= 80) needles.push(promptNorm.slice(0, 80));
    if (promptNorm.length >= 48) needles.push(promptNorm.slice(0, 48));
    if (promptNorm.length >= 24) needles.push(promptNorm.slice(0, 24));
  }
  const uniqueNeedles = [...new Set(needles.filter((entry) => entry.length >= 16))];

  if (uniqueNeedles.length) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const lineNorm = normalizeComparableText(stripPromptPrefix(lines[i] || ""));
      if (!lineNorm) continue;
      if (uniqueNeedles.some((needle) => lineNorm.includes(needle) || needle.includes(lineNorm))) {
        return i;
      }
    }
  }

  let fallback = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const raw = String(lines[i] || "");
    if (!/^\s*›\s/.test(raw)) continue;
    const body = stripPromptPrefix(raw);
    if (!body || /^use \/skills\b/i.test(body)) continue;
    if (fallback < 0) fallback = i;
    if (!uniqueNeedles.length) continue;
    const bodyNorm = normalizeComparableText(body);
    if (!bodyNorm) continue;
    if (uniqueNeedles.some((needle) => bodyNorm.includes(needle) || needle.includes(bodyNorm))) {
      return i;
    }
  }

  if (uniqueNeedles.length) {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const lineNorm = normalizeComparableText(lines[i] || "");
      if (!lineNorm) continue;
      if (!uniqueNeedles.some((needle) => lineNorm.includes(needle))) continue;
      for (let j = i; j >= 0; j -= 1) {
        if (/^\s*›\s/.test(String(lines[j] || ""))) return j;
      }
      break;
    }
  }

  return fallback;
}

function findScreenLineOverlap(beforeLines, afterLines) {
  const max = Math.min(beforeLines.length, afterLines.length);
  for (let overlap = max; overlap >= 1; overlap -= 1) {
    let allEqual = true;
    for (let i = 0; i < overlap; i += 1) {
      if (beforeLines[beforeLines.length - overlap + i] !== afterLines[i]) {
        allEqual = false;
        break;
      }
    }
    if (allEqual) return overlap;
  }
  return 0;
}

function computeTurnDeltaScreen(run) {
  const beforeText = String(run?.turnBaselineScreen || "");
  const afterText = String(run?.screenTextFull || run?.screenText || "");
  if (!afterText.trim()) return "";

  const beforeLines = splitScreenLines(beforeText);
  const afterLines = splitScreenLines(afterText);
  if (!beforeLines.length) return afterLines.join("\n").trim();

  const overlap = findScreenLineOverlap(beforeLines, afterLines);
  let deltaLines = afterLines.slice(overlap);

  if (!deltaLines.length) {
    let prefix = 0;
    const prefixMax = Math.min(beforeLines.length, afterLines.length);
    while (prefix < prefixMax && beforeLines[prefix] === afterLines[prefix]) {
      prefix += 1;
    }
    deltaLines = afterLines.slice(prefix);
  }

  return deltaLines.join("\n").trim();
}

function extractTurnSegmentFromPrompt(run) {
  const lines = splitScreenLines(run?.screenTextFull || run?.screenText || "");
  if (!lines.length) return [];
  const anchorIndex = findPromptAnchorIndex(lines, run?.currentTurnPromptText || "");
  if (anchorIndex < 0) return [];
  let endIndex = lines.length;
  for (let i = anchorIndex + 1; i < lines.length; i += 1) {
    if (/^\s*›\s/.test(String(lines[i] || ""))) {
      endIndex = i;
      break;
    }
  }
  return lines.slice(anchorIndex + 1, endIndex);
}

function hasTurnOutputCandidate(run) {
  if (run?.currentTurnSuppressOutput) return true;
  const primary = cleanTurnOutputLines(extractTurnSegmentFromPrompt(run), run);
  if (primary.length) return true;
  const baselineComparable = new Set(
    splitScreenLines(run?.turnBaselineScreen || "")
      .map((line) => normalizeComparableText(stripPromptPrefix(line)))
      .filter((line) => line.length >= 12)
  );
  const deltaLines = splitScreenLines(computeTurnDeltaScreen(run));
  const delta = cleanTurnOutputLines(deltaLines, run, { excludeComparableSet: baselineComparable });
  return delta.length > 0;
}

function cleanTurnOutputLines(lines, run, options = {}) {
  const output = [];
  let dropNextSearchUrl = false;
  const promptComparable = normalizeComparableText(run?.currentTurnPromptText || "");
  const excludeComparableSet = options?.excludeComparableSet instanceof Set ? options.excludeComparableSet : null;
  const seen = new Set();

  for (const rawLine of lines) {
    const line = String(rawLine || "").replace(/\s+$/g, "");
    const normalized = normalizeCapturedLine(line);
    if (!normalized) {
      if (output.length && output[output.length - 1] !== "") output.push("");
      continue;
    }
    if (/^searched$/i.test(normalized)) {
      dropNextSearchUrl = true;
      continue;
    }
    if (dropNextSearchUrl && /^https?:\/\/\S+$/i.test(normalized)) {
      dropNextSearchUrl = false;
      continue;
    }
    dropNextSearchUrl = false;
    if (
      isCodexUiNoiseLine(normalized, {
        lowerPreview: run?.lastInputPreview || "",
        sessionName: run?.sessionName || "",
        turnPrompt: run?.currentTurnPromptText || "",
      })
    ) {
      continue;
    }
    if (promptComparable && normalizeComparableText(normalized) === promptComparable) continue;

    const lineKey = normalizeComparableText(normalized);
    if (!lineKey) continue;
    if (excludeComparableSet && lineKey.length >= 12 && excludeComparableSet.has(lineKey)) continue;
    if (output.length && output[output.length - 1] === normalized) continue;
    if (seen.has(`recent:${lineKey}`) && output.length && output[output.length - 1] !== "") continue;

    output.push(normalized);
    seen.add(`recent:${lineKey}`);
    if (seen.size > 120) {
      const first = seen.values().next().value;
      seen.delete(first);
    }
  }

  while (output.length && !output[0]) output.shift();
  while (output.length && !output[output.length - 1]) output.pop();
  if (!output.length) return [];

  const bulletLikeLines = output.filter((line) => line && /^[-*]\s+/.test(line));
  if (bulletLikeLines.length >= Math.ceil(output.filter(Boolean).length * 0.7)) {
    return output.map((line) => (line ? stripLeadingListMarker(line) : line));
  }
  return output;
}

function looksLikeTechnicalPrompt(promptText) {
  const prompt = normalizeComparableText(promptText);
  if (!prompt) return false;
  const technicalPatterns = [
    /\b(code|coding|funktion|function|javascript|typescript|python|java|sql|regex|api|sdk)\b/,
    /\b(debug|bug|error|stacktrace|exception|test|unittest|integrationstest)\b/,
    /\b(docker|kubernetes|k8s|tmux|terminal|shell|bash|zsh|git|commit|branch)\b/,
    /\b(architektur|refactor|migration|deploy|pipeline|ci|cd)\b/,
  ];
  return technicalPatterns.some((pattern) => pattern.test(prompt));
}

function outputLooksLikeCode(text) {
  const value = String(text || "");
  if (!value) return false;
  if (/```/.test(value)) return true;
  if (/^\s*(function|const|let|var|class|def)\b/m.test(value)) return true;
  if (/[{};]/.test(value) && /\b(return|=>|import|export)\b/.test(value)) return true;
  return false;
}

function shouldForceCompactTurnOutput(promptText, outputText) {
  const prompt = String(promptText || "").trim();
  if (!prompt) return false;
  if (looksLikeTechnicalPrompt(prompt)) return false;
  if (outputLooksLikeCode(outputText)) return false;
  if (prompt.length > 180) return false;
  if (/\n{2,}/.test(outputText) && String(outputText || "").length > 500) return true;
  const shortQuestionLike =
    /^(wie|was|wer|wo|wann|wieviel|wie viele|wetter|temperatur|soll|kann|ist)\b/i.test(prompt) ||
    /\?$/.test(prompt);
  return shortQuestionLike;
}

function trimToBoundary(text, maxChars) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (value.length <= maxChars) return value;
  const boundaries = [". ", "! ", "? ", "\n"];
  let cut = -1;
  for (const token of boundaries) {
    const idx = value.lastIndexOf(token, maxChars);
    if (idx > cut) cut = idx + token.length;
  }
  if (cut < Math.floor(maxChars * 0.55)) cut = maxChars;
  return value.slice(0, cut).trim();
}

function compactTurnOutputText(text, maxLines, maxChars) {
  const lines = String(text || "")
    .split(/\r?\n/g)
    .map((line) => stripLeadingListMarker(line))
    .map((line) => line.replace(/^\d+\.\s+/, "").trim())
    .map((line) => line.replace(/^searched\s+/i, "").trim())
    .map((line) => line.replace(/\bhttps?:\/\/\S+/gi, "").replace(/\s{2,}/g, " ").trim())
    .filter((line) => !/^https?:\/\/\S+$/i.test(line))
    .filter((line) => !/^(quelle|source)\s*:/i.test(line))
    .filter(Boolean);
  if (!lines.length) return "";
  const picked = lines.slice(0, Math.max(1, maxLines));
  const joined = picked.join("\n");
  return trimToBoundary(joined, Math.max(120, maxChars));
}

function applySchenniTone(text, promptText, options = {}) {
  let value = String(text || "").trim();
  if (!value) return "";
  if (outputLooksLikeCode(value)) return value;

  const simpleMode = Boolean(options.simpleMode);
  const dialectLevel = detectDialectLevel(promptText, value, { simpleMode });
  value = applyOstdeutschLexicon(value, dialectLevel);

  const prompt = normalizeComparableText(promptText);
  const weatherLike = /\b(wetter|temperatur|regen|wind|sonnig|bewoelkt|bewolkt|grad|celsius)\b/.test(prompt);
  if (simpleMode && weatherLike && !/\b(jacke|schirm|mantel|regenjacke|pulli)\b/i.test(value)) {
    if (dialectLevel === "voll") {
      value = `${value}\nNimm lieba ne Jacke mit, sonst wirste biddschenass.`;
    } else if (dialectLevel === "mittel") {
      value = `${value}\nNimm lieber 'ne Jacke mit, sonst wird's nass.`;
    }
  }
  return value.trim();
}

function formatTurnChatOutput(run, rawText) {
  let value = String(rawText || "").trim();
  if (!value) return "";
  if (/^Kein klarer Ergebnis-Text erkannt\.?$/i.test(value)) {
    return "Ick hab grad keene saubere Antwort rausgezogen. Schick dit bitte kurz nochmal.";
  }
  const promptText = String(run?.currentTurnPromptText || "");
  value = normalizeTurnOutput(value, {
    prompt: promptText,
    maxLines: BOT_CHAT_ESSENTIAL_MAX_LINES,
    maxChars: BOT_CHAT_ESSENTIAL_MAX_CHARS,
  });
  if (!value) return "";
  const simpleMode = shouldForceCompactTurnOutput(promptText, value);
  if (simpleMode) {
    value = compactTurnOutputText(value, BOT_CHAT_ESSENTIAL_MAX_LINES, BOT_CHAT_ESSENTIAL_MAX_CHARS);
  }
  value = applySchenniTone(value, promptText, { simpleMode });
  if (simpleMode) {
    value = compactTurnOutputText(value, BOT_CHAT_ESSENTIAL_MAX_LINES, BOT_CHAT_ESSENTIAL_MAX_CHARS);
  }
  return value.trim();
}

function buildTurnResultTwoLiner(run) {
  const primaryLines = extractTurnSegmentFromPrompt(run);
  const primary = cleanTurnOutputLines(primaryLines, run);
  if (primary.length) {
    return normalizeTurnOutput(primary.join("\n"), {
      prompt: run?.currentTurnPromptText || "",
      maxLines: BOT_CHAT_ESSENTIAL_MAX_LINES,
      maxChars: BOT_CHAT_ESSENTIAL_MAX_CHARS,
    });
  }

  const baselineComparable = new Set(
    splitScreenLines(run?.turnBaselineScreen || "")
      .map((line) => normalizeComparableText(stripPromptPrefix(line)))
      .filter((line) => line.length >= 12)
  );
  const deltaLines = splitScreenLines(computeTurnDeltaScreen(run));
  const delta = cleanTurnOutputLines(deltaLines, run, { excludeComparableSet: baselineComparable });
  if (delta.length) {
    return normalizeTurnOutput(delta.join("\n"), {
      prompt: run?.currentTurnPromptText || "",
      maxLines: BOT_CHAT_ESSENTIAL_MAX_LINES,
      maxChars: BOT_CHAT_ESSENTIAL_MAX_CHARS,
    });
  }

  if (!run?.currentTurnSuppressOutput) {
    return "Kein klarer Ergebnis-Text erkannt.";
  }
  return "";
}

function buildMiniAppSnapshot(run = activeRun) {
  const now = Date.now();
  if (!run) {
    if (lastMiniSnapshot) {
      return {
        ...lastMiniSnapshot,
        active: false,
        needsReply: false,
      };
    }
    return {
      mode: "idle",
      active: false,
      status: "done",
      runtimeMs: 0,
      runtime: "0m 0s",
      turn: 0,
      input: 0,
      rev: 0,
      command: "",
      session: "",
      cwd: lastKnownCwd,
      screen: DEFAULT_SCREEN_TEXT,
      lastInput: "-",
      lastEvent: "-",
      events: [],
      needsReply: false,
      replyPrompt: "",
      updatedAt: new Date(now).toISOString(),
    };
  }

  if (run.mode === "shell_command") {
    return {
      mode: run.mode,
      active: !run.done,
      status: run.done ? "done" : "thinking ...",
      runtimeMs: now - run.startedAt,
      runtime: formatDuration(now - run.startedAt),
      turn: 0,
      input: 0,
      rev: 0,
      command: shortCommand(run.command || ""),
      session: "",
      cwd: lastKnownCwd,
      screen: "Shell command running. Output is sent in chat as code blocks.",
      lastInput: "-",
      lastEvent: run.done ? "command finished" : "command running",
      events: [],
      needsReply: false,
      replyPrompt: "",
      updatedAt: new Date(now).toISOString(),
    };
  }

  const replyPrompt = extractReplyPrompt(run.screenTextFull || run.screenText || "");
  const needsReply = !run.awaitingTurnCompletion && !run.done && Boolean(replyPrompt);

  return {
    mode: run.mode,
    active: !run.done,
    status: codexTurnState(run),
    runtimeMs: now - run.startedAt,
    runtime: formatDuration(now - run.startedAt),
    turn: run.turnIndex,
    input: run.inputCount,
    rev: run.screenRevision,
    command: shortCommand(run.command || ""),
    session: run.sessionName,
    cwd: run.cwd || lastKnownCwd,
    screen: run.screenTextFull || run.screenText || DEFAULT_SCREEN_TEXT,
    lastInput: run.lastInputPreview || "-",
    lastEvent: run.lastEvent || "-",
    events: run.events.slice(-20),
    needsReply,
    replyPrompt,
    updatedAt: new Date(now).toISOString(),
  };
}

function updateMiniSnapshot(run = activeRun) {
  lastMiniSnapshot = buildMiniAppSnapshot(run);
  writeRuntimeStateSnapshot({
    mode: lastMiniSnapshot.mode,
    runActive: Boolean(run && !run.done),
  });
}

function pushRunEvent(run, message) {
  const ts = new Date().toISOString().slice(11, 19);
  run.events.push(`${ts} ${message}`);
  if (run.events.length > MAX_EVENT_LOG) {
    run.events.splice(0, run.events.length - MAX_EVENT_LOG);
  }
  run.lastEvent = run.events[run.events.length - 1];
  updateMiniSnapshot(run);
}

function beginNewTurn(run, reason, options = {}) {
  run.turnIndex += 1;
  run.awaitingTurnCompletion = true;
  run.turnDoneNotified = false;
  run.turnStartedAt = Date.now();
  run.turnLastChangeAt = Date.now();
  run.turnHadAnyChange = false;
  run.turnSubmitRetried = false;
  run.responseMessageId = null;
  run.lastResponseText = "";
  run.currentTurnPromptText = String(options.promptText || "").trim();
  run.currentTurnPromptComparable = normalizeComparableText(run.currentTurnPromptText);
  run.currentTurnSuppressOutput = Boolean(options.suppressOutput);
  clearThinkingMarkerTimer(run);
  run.thinkingMarkerSent = false;
  run.turnBaselineScreen = String(run.screenTextFull || run.screenText || "");
  pushRunEvent(
    run,
    `turn ${run.turnIndex} started (${reason}${run.currentTurnSuppressOutput ? ", output=suppressed" : ""})`
  );
}

function stopTypingTicker(run) {
  if (run?.typingTimer) clearInterval(run.typingTimer);
  if (run) {
    run.typingTimer = null;
    run.lastTypingAt = 0;
  }
}

function clearThinkingMarkerTimer(run) {
  if (run?.thinkingMarkerTimer) clearTimeout(run.thinkingMarkerTimer);
  if (run) {
    run.thinkingMarkerTimer = null;
  }
}

function scheduleThinkingMarker(run) {
  if (!BOT_CHAT_SEND_THINKING_MARKER) return;
  if (!isActiveCodexRun(run)) return;
  if (!run.awaitingTurnCompletion) return;
  if (run.currentTurnSuppressOutput) return;
  if (isSlackChatId(run.chatId)) return;
  if (run.thinkingMarkerSent) return;
  if (run.thinkingMarkerTimer) return;

  const turn = run.turnIndex;
  run.thinkingMarkerTimer = setTimeout(async () => {
    run.thinkingMarkerTimer = null;
    if (!isActiveCodexRun(run)) return;
    if (!run.awaitingTurnCompletion) return;
    if (run.turnIndex !== turn) return;
    if (run.currentTurnSuppressOutput) return;
    if (run.thinkingMarkerSent) return;
    run.thinkingMarkerSent = true;
    logRuntimeEvent("thinking_marker_sent", {
      chatId: String(run.chatId || ""),
      turn: run.turnIndex,
      delayMs: BOT_CHAT_THINKING_MARKER_DELAY_MS,
    });
    await sendMessage(run.chatId, "thinking ...");
  }, BOT_CHAT_THINKING_MARKER_DELAY_MS);
}

function startTypingTicker(run) {
  if (!BOT_CHAT_TYPING_ACTION) return;
  if (!isActiveCodexRun(run)) return;
  if (!run.awaitingTurnCompletion) return;
  if (isSlackChatId(run.chatId)) return;
  if (run.typingTimer) return;

  const tick = () => {
    if (!isActiveCodexRun(run) || !run.awaitingTurnCompletion) {
      stopTypingTicker(run);
      return;
    }
    if (Date.now() - run.lastTypingAt < BOT_CHAT_TYPING_INTERVAL_MS - 250) return;
    run.lastTypingAt = Date.now();
    void sendTypingAction(run.chatId);
  };

  tick();
  run.typingTimer = setInterval(tick, BOT_CHAT_TYPING_INTERVAL_MS);
}

async function notifyTurnThinking(run) {
  if (!isActiveCodexRun(run)) return;
  if (run.lastThinkingTurn !== run.turnIndex) {
    run.lastThinkingTurn = run.turnIndex;
  }
  startTypingTicker(run);
  scheduleThinkingMarker(run);
}

function currentReplyPromptSignature(run) {
  const prompt = extractReplyPrompt(run?.screenTextFull || run?.screenText || "");
  return prompt ? prompt.toLowerCase() : "";
}

function suppressCurrentReplyPrompt(run, reason) {
  const signature = currentReplyPromptSignature(run) || run.lastReplyPrompt || "";
  if (!signature) return;
  if (run.replyPromptSuppressed === signature) return;
  run.replyPromptSuppressed = signature;
  run.replyPromptSuppressedAt = Date.now();
  pushRunEvent(run, `reply prompt suppressed (${reason})`);
}

function codexRuntimeCommandMessage(run) {
  const lines = [
    `Codex started (${run.sessionName}) [${CHAT_PIPELINE_VERSION}].`,
    "Kommandos:",
    "- /stopcodex",
    "- /livecodex (/panel)",
    `Profile auto-load: ${run.personalityStatus || "n/a"}`,
  ];
  if (BOT_ENABLE_RESTART_COMMAND) {
    lines.splice(3, 0, "- /restartbot");
  }
  return lines.join("\n");
}

function buildWrappedCommand(command, marker) {
  const safeMarker = marker.replace(/'/g, "'\\''");
  const wrappedCommand = shellSingleQuote(command);
  return `__bot_cmd=${wrappedCommand}; eval "$__bot_cmd"; __bot_rc=$?; __bot_cwd="$(pwd)"; printf '\\n${safeMarker}:%s\\t%s\\n' "$__bot_rc" "$__bot_cwd"`;
}

function ensureShell() {
  if (shell) return;
  createShell();
}

function createShell() {
  try {
    shell = pty.spawn(RESOLVED_BOT_SHELL, [], {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: RESOLVED_BOT_CWD,
      env: process.env,
    });
  } catch (err) {
    if (RESOLVED_BOT_SHELL !== "/bin/sh") {
      console.warn(
        `Failed to spawn shell "${RESOLVED_BOT_SHELL}" (${err.message}). Falling back to /bin/sh.`
      );
      shell = pty.spawn("/bin/sh", [], {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: RESOLVED_BOT_CWD,
        env: process.env,
      });
    } else {
      throw err;
    }
  }

  shell.onData((data) => {
    if (!activeRun || activeRun.mode !== "shell_command" || activeRun.done) return;
    activeRun.rawBuffer += data;
    const completion = drainShellOutputAndMaybeFinalize(activeRun);
    if (!completion) return;
    lastKnownCwd = completion.cwd;
    void finalizeShellRun(activeRun, {
      exitCode: completion.exitCode,
      reason: activeRun.cancelReason || null,
      forcedRestart: false,
    });
  });

  shell.onExit(({ exitCode, signal }) => {
    const run = activeRun;
    shell = null;

    if (isRestartingShell) return;

    if (run && run.mode === "shell_command" && !run.done) {
      appendShellOutput(run, normalizeShellOutput(run.rawBuffer));
      run.rawBuffer = "";
      void finalizeShellRun(run, {
        exitCode: typeof exitCode === "number" ? exitCode : null,
        reason: run.cancelReason || "shell-exit",
        forcedRestart: true,
      });
    }

    console.error(`Shell exited (code=${exitCode}, signal=${signal}). Restarting shell.`);
    createShell();
  });
}

function restartShell() {
  isRestartingShell = true;
  try {
    if (shell) shell.kill();
  } catch (err) {
    console.error("Failed to kill shell during restart:", err.message);
  }
  shell = null;
  createShell();
  isRestartingShell = false;
}

function appendShellOutput(run, text) {
  if (!text) return;
  if (run.totalOutputChars >= MAX_OUTPUT_CHARS) {
    run.outputTruncated = true;
    return;
  }

  const remaining = MAX_OUTPUT_CHARS - run.totalOutputChars;
  const accepted = text.slice(0, remaining);
  if (accepted.length > 0) {
    run.pendingOutput += accepted;
    run.totalOutputChars += accepted.length;
  }
  if (accepted.length < text.length) {
    run.outputTruncated = true;
  }
}

async function flushShellOutput(run) {
  if (!run.pendingOutput) return;
  const output = run.pendingOutput;
  run.pendingOutput = "";
  await sendCodeBlock(run.chatId, output);
}

function clearShellTimers(run) {
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
  if (run.statusTimer) clearInterval(run.statusTimer);
  if (run.flushTimer) clearTimeout(run.flushTimer);
  run.timeoutTimer = null;
  run.statusTimer = null;
  run.flushTimer = null;
}

function scheduleShellFlush(run) {
  if (run.flushTimer) return;
  run.flushTimer = setTimeout(() => {
    run.flushTimer = null;
    void flushShellOutput(run);
  }, STREAM_FLUSH_MS);
}

function drainShellOutputAndMaybeFinalize(run) {
  let streamedSomething = false;

  while (true) {
    const markerIndex = run.rawBuffer.indexOf(run.marker);

    if (markerIndex === -1) {
      const flushLen = Math.max(0, run.rawBuffer.length - MARKER_TAIL_KEEP);
      if (flushLen > 0) {
        appendShellOutput(run, normalizeShellOutput(run.rawBuffer.slice(0, flushLen)));
        run.rawBuffer = run.rawBuffer.slice(flushLen);
        streamedSomething = true;
      }
      if (streamedSomething) scheduleShellFlush(run);
      return null;
    }

    if (markerIndex > 0) {
      appendShellOutput(run, normalizeShellOutput(run.rawBuffer.slice(0, markerIndex)));
      run.rawBuffer = run.rawBuffer.slice(markerIndex);
      streamedSomething = true;
    }

    const lineEnd = run.rawBuffer.indexOf("\n");
    if (lineEnd === -1) {
      if (streamedSomething) scheduleShellFlush(run);
      return null;
    }

    const markerLine = run.rawBuffer.slice(0, lineEnd).replace(/\r/g, "");
    run.rawBuffer = run.rawBuffer.slice(lineEnd + 1);

    const pattern = new RegExp(`^${escapeRegExp(run.marker)}:(\\d+)\\t(.*)$`);
    const match = pattern.exec(markerLine);
    if (!match) {
      appendShellOutput(run, normalizeShellOutput(`${markerLine}\n`));
      streamedSomething = true;
      continue;
    }

    if (streamedSomething) scheduleShellFlush(run);
    return {
      exitCode: Number(match[1]),
      cwd: match[2] || lastKnownCwd,
    };
  }
}

async function finalizeShellRun(run, result) {
  if (run.done) return;
  run.done = true;
  clearShellTimers(run);
  updateMiniSnapshot(run);

  if (activeRun === run) {
    activeRun = null;
  }

  const elapsed = Date.now() - run.startedAt;
  await flushShellOutput(run);

  if (run.outputTruncated) {
    await sendMessage(run.chatId, `Output truncated after ${MAX_OUTPUT_CHARS} chars.`);
  }

  if (result.reason === "cancel") {
    await sendMessage(run.chatId, `Command cancelled after ${formatDuration(elapsed)}.`);
    return;
  }

  if (result.reason === "timeout") {
    await sendMessage(run.chatId, `Command timed out after ${formatDuration(elapsed)}.`);
    return;
  }

  if (result.reason === "shell-exit") {
    await sendMessage(
      run.chatId,
      `Shell exited unexpectedly after ${formatDuration(elapsed)}.${result.forcedRestart ? " Shell was restarted." : ""}`
    );
    return;
  }

  await sendMessage(
    run.chatId,
    `Done. Exit code: ${result.exitCode}. Runtime: ${formatDuration(elapsed)}. CWD: ${lastKnownCwd}`
  );
  updateMiniSnapshot(run);
}

async function cancelShellRun(reason) {
  if (!activeRun || activeRun.mode !== "shell_command" || activeRun.done) return;

  const run = activeRun;
  run.cancelReason = reason;
  run.cancelRequestedAt = Date.now();
  shell.write("\u0003");

  setTimeout(() => {
    if (!activeRun || activeRun !== run || run.done) return;
    appendShellOutput(run, normalizeShellOutput(run.rawBuffer));
    run.rawBuffer = "";
    restartShell();
    void finalizeShellRun(run, {
      exitCode: null,
      reason,
      forcedRestart: true,
    });
  }, CANCEL_FALLBACK_MS);
}

async function startShellCommand(chatId, command) {
  ensureShell();
  if (activeRun) {
    await sendMessage(chatId, "A session is already running. Use /stopcodex or /livecodex.");
    return;
  }

  const marker = `__BOT_DONE_${Date.now()}_${Math.random().toString(16).slice(2)}__`;
  const run = {
    mode: "shell_command",
    chatId,
    command,
    marker,
    startedAt: Date.now(),
    rawBuffer: "",
    pendingOutput: "",
    totalOutputChars: 0,
    outputTruncated: false,
    done: false,
    timeoutTimer: null,
    statusTimer: null,
    flushTimer: null,
    cancelReason: null,
    cancelRequestedAt: null,
  };
  activeRun = run;
  updateMiniSnapshot(run);

  await sendMessage(chatId, `Running shell command: ${shortCommand(command)}`);

  if (BOT_TIMEOUT_MS > 0) {
    run.timeoutTimer = setTimeout(() => {
      void sendMessage(chatId, `Timeout reached (${formatDuration(BOT_TIMEOUT_MS)}). Cancelling...`);
      void cancelShellRun("timeout");
    }, BOT_TIMEOUT_MS);
  }

  if (BOT_STATUS_INTERVAL_MS > 0) {
    run.statusTimer = setInterval(() => {
      if (!activeRun || activeRun !== run || run.done) return;
      const elapsed = Date.now() - run.startedAt;
      void sendMessage(chatId, `Status: shell command running for ${formatDuration(elapsed)}.`);
    }, BOT_STATUS_INTERVAL_MS);
  }

  shell.write(buildWrappedCommand(command, marker) + PTY_ENTER);
}

function makeTmuxSessionName(chatId) {
  const safeChat = String(chatId).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${TMUX_SESSION_PREFIX}${safeChat}_${Date.now().toString(36)}`;
}

function isCodexCommand(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const first = trimmed.split(/\s+/)[0];
  if (first === "codex") return true;
  return first.endsWith("/codex");
}

const SHELL_HINT_COMMANDS = new Set([
  "ls",
  "pwd",
  "cd",
  "cat",
  "grep",
  "rg",
  "git",
  "npm",
  "node",
  "python",
  "python3",
  "docker",
  "tmux",
  "ps",
  "kill",
  "top",
  "tail",
  "head",
  "sed",
  "awk",
  "curl",
  "wget",
  "chmod",
  "chown",
  "mkdir",
  "rm",
  "mv",
  "cp",
  "touch",
  "echo",
  "find",
  "which",
  "whoami",
  "date",
  "uname",
  "ssh",
  "scp",
  "rsync",
  "kubectl",
  "helm",
  "make",
  "pnpm",
  "yarn",
  "bun",
]);

function looksLikeShellInput(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  if (/^(?:\.{1,2}\/|~\/|\/)/.test(value)) return true;
  if (/(^|\s)(\|\||&&|\||;|>>?|<<?|2>>?|2>)(\s|$)/.test(value)) return true;
  if (/^[a-zA-Z0-9_.-]+\s+--?[a-zA-Z0-9][\w-]*/.test(value)) return true;
  const first = value.split(/\s+/)[0].toLowerCase();
  if (SHELL_HINT_COMMANDS.has(first)) return true;
  return false;
}

function classifyInputIntent(text) {
  const raw = String(text || "");
  const normalized = raw.trim();
  if (!normalized) return { type: "empty" };

  const shellMatch = /^\/sh(?:\s+([\s\S]+))?$/i.exec(normalized);
  if (shellMatch) {
    const command = String(shellMatch[1] || "").trim();
    if (!command) return { type: "shell_usage_error" };
    return { type: "shell", command, explicit: true };
  }

  const bangMatch = /^!\s*([\s\S]+)$/.exec(normalized);
  if (bangMatch) {
    const command = String(bangMatch[1] || "").trim();
    if (!command) return { type: "shell_usage_error" };
    return { type: "shell", command, explicit: true };
  }

  if (normalized.startsWith("/")) return { type: "command" };
  if (looksLikeShellInput(normalized)) {
    return { type: "shell", command: raw, explicit: false };
  }
  return { type: "codex", prompt: raw };
}

async function ensureCodexSessionForPrompt(chatId, prompt) {
  const payload = String(prompt || "").trim();
  if (!payload) return false;

  if (activeRun && activeRun.mode === "shell_command") {
    await sendMessage(chatId, "A shell command is running. Use /stopcodex first.");
    return false;
  }

  if (activeRun && activeRun.mode === "codex_tmux" && !activeRun.done) {
    await sendCodexInputLine(activeRun, payload);
    return true;
  }

  if (BOT_CODEX_BACKEND !== "tmux") {
    await sendMessage(chatId, "Direct Codex input is only available with BOT_CODEX_BACKEND=tmux.");
    return false;
  }

  if (!tmuxAvailable) {
    await sendMessage(chatId, "tmux backend is unavailable. Please check tmux installation/config.");
    return false;
  }

  await startCodexTmuxRun(chatId, "codex");
  if (activeRun && activeRun.mode === "codex_tmux" && !activeRun.done) {
    await sendCodexInputLine(activeRun, payload);
    return true;
  }
  await sendMessage(chatId, "Could not start codex session.");
  return false;
}

function buildCodexResponseMessage(run, isFinal = false) {
  if (!isFinal && codexTurnState(run) === "thinking ...") {
    return "thinking ...";
  }
  return "Antwort gesendet.";
}

function buildCodexSystemMessage(run, isFinal = false) {
  const elapsed = Date.now() - run.startedAt;
  const turnState = codexTurnState(run);
  const statusLabel = isFinal ? "DONE" : "LIVE";
  const kv = (label, value) => `${label.padEnd(12)} : ${value}`;
  const systemLines = [
    "==============================",
    "[ SYSTEM | META ]",
    "==============================",
    kv("state", statusLabel),
    kv("mode", BOT_CODEX_BACKEND),
    kv("session", run.sessionName),
    kv("status", turnState),
    kv("runtime", formatDuration(elapsed)),
    kv("turn", String(run.turnIndex)),
    kv("input", String(run.inputCount)),
    kv("rev", String(run.screenRevision)),
    kv("profile", run.personalityStatus || "-"),
    kv("last_input", run.lastInputPreview || "-"),
    kv("last_event", run.lastEvent || "-"),
  ];

  return `<pre>${escapeHtml(systemLines.join("\n"))}</pre>`;
}

async function upsertCodexMessage(run, nextText, messageIdKey, lastTextKey, label) {
  if (run[lastTextKey] === nextText) return;

  if (!run[messageIdKey]) {
    const sent = await sendMessage(run.chatId, nextText, { parse_mode: "HTML" });
    if (sent?.message_id) {
      run[messageIdKey] = sent.message_id;
      run[lastTextKey] = nextText;
    }
    return;
  }

  if (isSlackChatId(run.chatId)) {
    const channel = slackChannelFromChatId(run.chatId);
    if (!channel || !slackApp) return;
    try {
      await slackApp.client.chat.update({
        channel,
        ts: String(run[messageIdKey]),
        text: telegramHtmlToSlackText(nextText),
      });
      run[lastTextKey] = nextText;
      return;
    } catch (err) {
      const msg = String(err?.message || "");
      if (/message_not_found|cant_update_message/i.test(msg)) {
        run[messageIdKey] = null;
        run[lastTextKey] = "";
        const sent = await sendMessage(run.chatId, nextText);
        if (sent?.message_id) {
          run[messageIdKey] = sent.message_id;
          run[lastTextKey] = nextText;
        }
        return;
      }
      console.error(`Failed to update codex ${label} Slack message:`, msg);
      return;
    }
  }

  try {
    await bot.editMessageText(nextText, {
      chat_id: run.chatId,
      message_id: run[messageIdKey],
      parse_mode: "HTML",
    });
    run[lastTextKey] = nextText;
  } catch (err) {
    const msg = String(err?.message || "");
    if (/message is not modified/i.test(msg)) {
      run[lastTextKey] = nextText;
      return;
    }
    if (/message to edit not found|message can't be edited/i.test(msg)) {
      run[messageIdKey] = null;
      run[lastTextKey] = "";
      const sent = await sendMessage(run.chatId, nextText, { parse_mode: "HTML" });
      if (sent?.message_id) {
        run[messageIdKey] = sent.message_id;
        run[lastTextKey] = nextText;
      }
      return;
    }
    console.error(`Failed to update codex ${label} message:`, msg);
  }
}

async function upsertCodexStatus(run, isFinal = false) {
  void isFinal;
  // V0.2(schenni): Miniapp snapshot updates stay, chat meta/status messages stay off.
  updateMiniSnapshot(run);
}

function clearCodexTimers(run) {
  if (run.timeoutTimer) clearTimeout(run.timeoutTimer);
  if (run.captureTimer) clearInterval(run.captureTimer);
  stopTypingTicker(run);
  clearThinkingMarkerTimer(run);
  run.timeoutTimer = null;
  run.captureTimer = null;
}

function isActiveCodexRun(run) {
  return Boolean(activeRun && activeRun === run && run.mode === "codex_tmux" && !run.done);
}

async function finalizeCodexRun(run, reason) {
  if (run.done) return;
  run.done = true;
  run.awaitingTurnCompletion = false;
  run.turnDoneNotified = true;
  stopTypingTicker(run);
  clearCodexTimers(run);
  updateMiniSnapshot(run);

  if (activeRun === run) {
    activeRun = null;
  }

  if (reason === "cancel" || reason === "timeout") {
    try {
      await tmux.killSession(BOT_TMUX_BIN, run.sessionName);
    } catch (err) {
      pushRunEvent(run, `kill-session failed: ${err.message}`);
    }
  }

  pushRunEvent(run, `finalized (${reason})`);
  markRecentProjectFinished(run.recentProjectId, reason);
  await upsertCodexStatus(run, true);
  updateMiniSnapshot(run);

  const elapsed = Date.now() - run.startedAt;
  if (reason === "cancel") {
    await sendMessage(run.chatId, `Codex session cancelled after ${formatDuration(elapsed)}.`);
    return;
  }
  if (reason === "timeout") {
    await sendMessage(run.chatId, `Codex session timed out after ${formatDuration(elapsed)}.`);
    return;
  }
  await sendMessage(run.chatId, `Codex session finished after ${formatDuration(elapsed)}.`);
}

async function maybeNotifyTurnDone(run) {
  if (!isActiveCodexRun(run)) return;
  if (!run.awaitingTurnCompletion) return;
  if (run.turnDoneNotified) return;

  const idleMs = Date.now() - run.turnLastChangeAt;
  if (idleMs < BOT_TURN_IDLE_DONE_MS) return;
  const screen = String(run.screenTextFull || run.screenText || "");
  const promptVisible = looksLikeCodexPrompt(screen);
  if (!promptVisible && idleMs < BOT_TURN_FORCE_DONE_MS) return;
  if (screenIndicatesCodexWorking(run) && idleMs < BOT_TURN_FORCE_DONE_MS) return;
  if (!hasTurnOutputCandidate(run)) {
    if (!run.turnSubmitRetried) {
      run.turnSubmitRetried = true;
      pushRunEvent(run, `turn ${run.turnIndex} no output yet -> submit retry`);
      await submitWithFallback(run, "turn-no-output-retry");
      return;
    }
    if (idleMs < BOT_TURN_FORCE_DONE_MS * 2) return;
  }

  run.awaitingTurnCompletion = false;
  run.turnDoneNotified = true;
  clearThinkingMarkerTimer(run);
  stopTypingTicker(run);
  pushRunEvent(run, `turn ${run.turnIndex} considered done after ${idleMs}ms idle`);
  const turnTextRaw = buildTurnResultTwoLiner(run);
  const turnText = formatTurnChatOutput(run, turnTextRaw);
  logRuntimeEvent("turn_output_prepared", {
    chatId: String(run.chatId || ""),
    turn: run.turnIndex,
    suppressed: Boolean(run.currentTurnSuppressOutput),
    outputPreview: shortInputPreview(turnText || ""),
  });
  if (run.currentTurnSuppressOutput) {
    pushRunEvent(run, `turn ${run.turnIndex} output intentionally suppressed`);
  } else if (turnText) {
    await sendLongText(run.chatId, turnText);
  }
  if (BOT_CHAT_SEND_DONE_MARKER) {
    await sendMessage(run.chatId, "done");
  }
  await upsertCodexStatus(run, false);
}

async function maybeNotifyReplyButtons(run) {
  if (!isActiveCodexRun(run)) return;
  if (run.awaitingTurnCompletion || run.done) return;
  if (!BOT_REPLY_BUTTONS_ENABLED) return;

  const replyPrompt = extractReplyPrompt(run.screenTextFull || run.screenText || "");
  if (!replyPrompt) return;
  if (Date.now() - run.lastReplyButtonsAt < REPLY_BUTTON_COOLDOWN_MS) return;

  const signature = replyPrompt.toLowerCase();
  if (run.replyPromptSuppressed && run.replyPromptSuppressed !== signature) {
    run.replyPromptSuppressed = "";
  }
  if (run.replyPromptSuppressed === signature) {
    return;
  }
  // Never respawn the same follow-up prompt repeatedly.
  if (run.lastReplyPrompt === signature) {
    return;
  }

  run.lastReplyPrompt = signature;
  run.lastReplyButtonsAt = Date.now();
  pushRunEvent(run, "reply prompt detected");
  logRuntimeEvent("reply_prompt_sent", {
    chatId: String(run.chatId || ""),
    turn: run.turnIndex,
    promptPreview: shortInputPreview(replyPrompt),
  });

  const keyboard = [
    [
      { text: "yes", callback_data: "reply:yes" },
      { text: "yes always", callback_data: "reply:yes_always" },
    ],
    [
      { text: "no but...", callback_data: "reply:no_but" },
      { text: "manual", callback_data: "reply:manual" },
    ],
    [
      { text: "mini app", callback_data: "reply:panel" },
      { text: "cancel", callback_data: "reply:cancel" },
    ],
  ];

  await sendMessage(run.chatId, `Rueckfrage:\n${replyPrompt}`, {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

async function tickCodexRun(run) {
  if (!isActiveCodexRun(run)) return;
  if (run.captureInFlight) return;
  run.captureInFlight = true;

  try {
    const exists = await tmux.hasSession(BOT_TMUX_BIN, run.sessionName);
    if (!exists) {
      await finalizeCodexRun(run, run.cancelReason || "exit");
      return;
    }

    const captured = await tmux.capturePane(BOT_TMUX_BIN, run.sessionName, BOT_CAPTURE_LINES);
    const normalized = normalizeCapturedScreen(captured);
    const fullScreen = truncateTail(normalized, BOT_WEBAPP_MAX_SCREEN_CHARS);
    const chatScreen = truncateTail(normalized, MAX_CAPTURE_CHARS);
    if (fullScreen !== run.screenTextFull) {
      run.screenTextFull = fullScreen;
      run.screenText = chatScreen;
      run.screenRevision += 1;
      if (run.awaitingTurnCompletion) {
        run.turnHadAnyChange = true;
        run.turnLastChangeAt = Date.now();
      }
      pushRunEvent(run, `screen changed -> rev ${run.screenRevision}`);
      await upsertCodexStatus(run, false);
    }
    await maybeNotifyTurnDone(run);
    await maybeNotifyReplyButtons(run);
  } catch (err) {
    pushRunEvent(run, `capture error: ${err.message}`);
    await upsertCodexStatus(run, false);
  } finally {
    run.captureInFlight = false;
  }
}

const SUBMIT_ATTEMPTS = (() => {
  const attempts = [];
  for (let i = 0; i < BOT_SUBMIT_MAX_ATTEMPTS; i += 1) {
    attempts.push({ label: `CR#${i + 1}`, keys: ["C-m"] });
  }
  attempts.push({ label: "LF", keys: ["C-j"] });
  attempts.push({ label: "CRLF", keys: ["C-m", "C-j"] });
  return attempts;
})();

function screenIndicatesCodexWorking(run) {
  const combined = `${run?.screenTextFull || ""}\n${run?.screenText || ""}`;
  return /working\s*\(|esc to interrupt/i.test(combined);
}

async function performSubmitAttempt(run, token, baseRevision, index) {
  if (!isActiveCodexRun(run)) return;
  if (run.submitToken !== token) return;
  if (index >= SUBMIT_ATTEMPTS.length) return;

  const attempt = SUBMIT_ATTEMPTS[index];
  try {
    await tmux.sendKeys(BOT_TMUX_BIN, run.sessionName, attempt.keys);
    pushRunEvent(run, `submit attempt ${index + 1}/${SUBMIT_ATTEMPTS.length}: ${attempt.label}`);
  } catch (err) {
    pushRunEvent(run, `submit failed: ${err.message}`);
    await upsertCodexStatus(run, false);
    return;
  }

  await upsertCodexStatus(run, false);

  setTimeout(() => {
    void checkSubmitProgress(run, token, baseRevision, index);
  }, BOT_ENTER_FALLBACK_MS);
}

async function checkSubmitProgress(run, token, baseRevision, index) {
  if (!isActiveCodexRun(run)) return;
  if (run.submitToken !== token) return;

  if (screenIndicatesCodexWorking(run)) {
    pushRunEvent(run, "submit acknowledged by codex working state");
    await upsertCodexStatus(run, false);
    return;
  }

  if (index + 1 < SUBMIT_ATTEMPTS.length) {
    await performSubmitAttempt(run, token, baseRevision, index + 1);
    return;
  }

  pushRunEvent(run, "submit fallback exhausted without screen change");
  await upsertCodexStatus(run, false);
}

async function submitWithFallback(run, reasonLabel) {
  if (!isActiveCodexRun(run)) return;
  const token = `${Date.now()}_${Math.random().toString(16).slice(2)}`;
  run.submitToken = token;
  const baseRevision = run.screenRevision;
  pushRunEvent(run, `submit sequence started (${reasonLabel}) baseline=${baseRevision}`);
  await performSubmitAttempt(run, token, baseRevision, 0);
}

function looksLikeCodexPrompt(screenText) {
  const text = String(screenText || "");
  if (!text) return false;
  const hasBranding = /openai codex|gpt-\d+/i.test(text);
  const hasPrompt = /(^|\n)\s*›\s/m.test(text);
  return hasBranding && hasPrompt;
}

function looksLikeCodexTrustPrompt(screenText) {
  const text = String(screenText || "");
  if (!text) return false;
  return (
    /do you trust the contents of this directory\?/i.test(text) &&
    /1\.\s*yes,\s*continue/i.test(text) &&
    /press enter to continue/i.test(text)
  );
}

async function maybeAutoAcceptCodexTrustPrompt(run, screenText, reasonLabel) {
  if (!isActiveCodexRun(run)) return false;
  if (run.trustPromptHandled) return false;
  if (!looksLikeCodexTrustPrompt(screenText)) return false;

  run.trustPromptHandled = true;
  pushRunEvent(run, `codex trust prompt detected -> auto-accept (${reasonLabel})`);
  try {
    await tmux.sendKeys(BOT_TMUX_BIN, run.sessionName, ["1", "C-m"]);
    await wait(300);
    return true;
  } catch (err) {
    pushRunEvent(run, `trust prompt auto-accept failed: ${trimErrorMessage(err)}`);
    return false;
  }
}

async function ensureCodexPromptReady(run, reasonLabel = "input") {
  if (!isActiveCodexRun(run)) return false;
  if (run.promptReady) return true;
  if (run.promptReadyPromise) return run.promptReadyPromise;

  run.promptReadyPromise = (async () => {
    const deadline = Date.now() + BOT_CODEX_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (!isActiveCodexRun(run)) return false;
      try {
        const captured = await tmux.capturePane(BOT_TMUX_BIN, run.sessionName, BOT_CAPTURE_LINES);
        const normalized = normalizeCapturedScreen(captured);
        const acceptedTrustPrompt = await maybeAutoAcceptCodexTrustPrompt(run, normalized, reasonLabel);
        if (acceptedTrustPrompt) {
          continue;
        }
        if (looksLikeCodexPrompt(normalized)) {
          run.promptReady = true;
          pushRunEvent(run, `codex prompt ready (${reasonLabel})`);
          return true;
        }
      } catch (err) {
        pushRunEvent(run, `prompt check failed: ${trimErrorMessage(err)}`);
      }
      await wait(250);
    }
    pushRunEvent(run, `codex prompt wait timeout (${BOT_CODEX_READY_TIMEOUT_MS}ms, reason=${reasonLabel})`);
    return false;
  })();

  try {
    return await run.promptReadyPromise;
  } finally {
    run.promptReadyPromise = null;
  }
}

async function sendCodexInputLine(run, text, options = {}) {
  if (!isActiveCodexRun(run)) return;
  const reasonLabel = String(options.turnReason || "line-input");
  await ensureCodexPromptReady(run, reasonLabel);
  suppressCurrentReplyPrompt(run, "text-input");
  try {
    await tmux.sendLiteral(BOT_TMUX_BIN, run.sessionName, text);
  } catch (err) {
    pushRunEvent(run, `input failed: ${trimErrorMessage(err)}`);
    if (/can't find pane|no server running|session.*not found/i.test(String(err?.message || ""))) {
      await finalizeCodexRun(run, "exit");
    }
    throw err;
  }
  run.inputCount += 1;
  run.lastInputPreview = shortInputPreview(text);
  beginNewTurn(run, reasonLabel, {
    promptText: text,
    suppressOutput: Boolean(options.suppressOutput),
  });
  await notifyTurnThinking(run);
  pushRunEvent(run, `input line sent (${text.length} chars)`);
  await upsertCodexStatus(run, false);
  await submitWithFallback(run, reasonLabel);
}

async function maybeAutoApplyPersonality(run) {
  if (!isActiveCodexRun(run)) return;
  if (run.personalityApplied) return;
  if (!BOT_PERSONALITY_AUTO_APPLY) {
    run.personalityApplied = true;
    run.personalityStatus = "disabled";
    pushRunEvent(run, "personality auto-load disabled");
    await upsertCodexStatus(run, false);
    return;
  }
  if (!isCodexCommand(run.command || "")) {
    run.personalityApplied = true;
    run.personalityStatus = "skipped (non-codex command)";
    pushRunEvent(run, "personality skipped (non-codex command)");
    await upsertCodexStatus(run, false);
    return;
  }

  const profile = readPersonalityProfile();
  if (!profile.ok) {
    run.personalityApplied = true;
    run.personalityStatus = `not loaded (${profile.status})`;
    pushRunEvent(run, profile.detail);
    await sendMessage(run.chatId, `Profile auto-load skipped: ${profile.detail}`);
    await upsertCodexStatus(run, false);
    return;
  }

  run.personalityPath = profile.path;
  run.personalityApplied = true;
  run.personalityStatus = profile.truncated ? "loaded (truncated)" : "loaded";
  pushRunEvent(
    run,
    profile.truncated
      ? `personality loaded (${profile.loadedChars}/${profile.originalChars} chars)`
      : `personality loaded (${profile.loadedChars} chars)`
  );
  await upsertCodexStatus(run, false);

  const prompt = buildPersonalityBootstrapPrompt(profile);
  await sendCodexInputLine(run, prompt, {
    turnReason: "personality-bootstrap",
    suppressOutput: true,
  });
}

async function sendCodexRaw(run, payload) {
  if (!isActiveCodexRun(run)) return;
  await ensureCodexPromptReady(run, "raw-input");
  suppressCurrentReplyPrompt(run, "raw-input");
  await tmux.sendLiteral(BOT_TMUX_BIN, run.sessionName, payload);
  run.inputCount += 1;
  run.lastInputPreview = `[raw] ${shortInputPreview(payload)}`;
  pushRunEvent(run, `raw input sent (${payload.length} chars)`);
  await upsertCodexStatus(run, false);
}

async function requestCancelCodexRun(run, reason) {
  if (!isActiveCodexRun(run)) return;
  if (run.cancelRequested) return;
  run.cancelRequested = true;
  run.cancelReason = reason;
  stopTypingTicker(run);
  pushRunEvent(run, `cancel requested (${reason})`);
  await upsertCodexStatus(run, false);

  try {
    await tmux.interrupt(BOT_TMUX_BIN, run.sessionName);
    pushRunEvent(run, "sent C-c");
  } catch (err) {
    pushRunEvent(run, `interrupt failed: ${err.message}`);
  }

  await tickCodexRun(run);

  setTimeout(() => {
    void enforceCodexCancel(run, reason);
  }, CANCEL_FALLBACK_MS);
}

async function enforceCodexCancel(run, reason) {
  if (!isActiveCodexRun(run)) return;

  try {
    const exists = await tmux.hasSession(BOT_TMUX_BIN, run.sessionName);
    if (exists) {
      await tmux.killSession(BOT_TMUX_BIN, run.sessionName);
      pushRunEvent(run, "kill-session fallback applied");
    }
  } catch (err) {
    pushRunEvent(run, `kill-session failed: ${err.message}`);
  }

  await finalizeCodexRun(run, reason);
}

async function startCodexTmuxRun(chatId, command, options = {}) {
  if (activeRun) {
    await sendMessage(chatId, "A session is already running. Use /stopcodex or /livecodex.");
    return;
  }

  if (!tmuxAvailable) {
    await sendMessage(chatId, "tmux backend is unavailable. Please check tmux installation/config.");
    return;
  }
  if (isCodexCommand(command) && !(await ensureCodexLoginReady(chatId, { silent: false }))) {
    return;
  }

  const runCwd = resolveCwd(options.cwd || RESOLVED_BOT_CWD);
  const selectedModelProfile = currentModelProfile();
  const launchCommand = applyModelProfileToCodexCommand(command, selectedModelProfile);
  const sessionName = makeTmuxSessionName(chatId);
  try {
    await tmux.startSession(BOT_TMUX_BIN, sessionName, runCwd, launchCommand);
  } catch (err) {
    await sendMessage(chatId, `Failed to start codex tmux session: ${err.message}`);
    return;
  }
  const recentEntry = rememberRecentProject(launchCommand, runCwd);

  const run = {
    mode: "codex_tmux",
    chatId,
    command: launchCommand,
    sessionName,
    cwd: runCwd,
    recentProjectId: recentEntry ? recentEntry.id : null,
    startedAt: Date.now(),
    screenText: "(starting codex...)",
    screenTextFull: "(starting codex...)",
    screenRevision: 0,
    inputCount: 0,
    lastInputPreview: "",
    submitToken: null,
    captureInFlight: false,
    responseMessageId: null,
    lastResponseText: "",
    systemMessageId: null,
    lastSystemText: "",
    events: [],
    lastEvent: "",
    turnIndex: 0,
    awaitingTurnCompletion: false,
    turnDoneNotified: false,
    turnStartedAt: 0,
    turnLastChangeAt: 0,
    turnHadAnyChange: false,
    turnSubmitRetried: false,
    turnBaselineScreen: "(starting codex...)",
    currentTurnPromptText: "",
    currentTurnPromptComparable: "",
    currentTurnSuppressOutput: false,
    lastThinkingTurn: 0,
    lastReplyPrompt: "",
    lastReplyButtonsAt: 0,
    replyPromptSuppressed: "",
    replyPromptSuppressedAt: 0,
    personalityApplied: false,
    personalityStatus: BOT_PERSONALITY_AUTO_APPLY ? "pending" : "disabled",
    personalityPath: resolvePersonalityFilePath(BOT_PERSONALITY_FILE),
    modelProfileAtStart: {
      model: selectedModelProfile.model,
      reasoningEffort: selectedModelProfile.reasoningEffort,
    },
    promptReady: false,
    promptReadyPromise: null,
    trustPromptHandled: false,
    cancelRequested: false,
    cancelReason: null,
    timeoutTimer: null,
    captureTimer: null,
    typingTimer: null,
    lastTypingAt: 0,
    thinkingMarkerTimer: null,
    thinkingMarkerSent: false,
    done: false,
  };

  lastKnownCwd = runCwd;
  pushRunEvent(run, `session started (${sessionName}) cwd=${runCwd}`);
  activeRun = run;
  updateMiniSnapshot(run);

  await sendMessage(chatId, codexRuntimeCommandMessage(run));
  await sendPanelButton(chatId, {
    silentIfUnavailable: true,
    title: "Codex Live Panel (this run):",
  });
  await upsertCodexStatus(run, false);

  if (BOT_TIMEOUT_MS > 0) {
    run.timeoutTimer = setTimeout(() => {
      pushRunEvent(run, `timeout ${BOT_TIMEOUT_MS}ms reached`);
      void requestCancelCodexRun(run, "timeout");
    }, BOT_TIMEOUT_MS);
  }

  run.captureTimer = setInterval(() => {
    void tickCodexRun(run);
  }, BOT_LIVE_STATUS_INTERVAL_MS);

  await tickCodexRun(run);
  await maybeAutoApplyPersonality(run);
}

function startMessage() {
  const webApp = getWebAppReadiness();
  const lines = [
    `Bereit. Ich bin ${assistantDisplayName()}.`,
    "",
    "Verfuegbare Kommandos:",
    "- /startcodex",
    "- /stopcodex",
    "- /livecodex (/panel)",
    "- /persona (show/switch personality preset)",
    "- /model (5.4 | 5.3-codex | high | standard)",
    "",
    "Normaler Text geht direkt an Codex.",
    `Chat-Pipeline: ${CHAT_PIPELINE_VERSION}`,
    `CWD: ${lastKnownCwd}`,
    `Codex backend: ${BOT_CODEX_BACKEND}`,
    `Modelprofil: ${modelProfileSummary()}`,
    `Mini App: ${webApp.ok ? "ready" : webApp.reason}`,
  ];
  if (BOT_ENABLE_RESTART_COMMAND) {
    lines.splice(6, 0, "- /restartbot");
  }
  return lines.join("\n");
}

function helpMessage() {
  const webApp = getWebAppReadiness();
  const lines = [
    "Befehle:",
    "- /startcodex",
    "- /stopcodex",
    "- /livecodex (/panel)",
    "- /persona (show/switch personality preset)",
    "- /model [5.4|5.3-codex|high|standard]",
    "- /setupassistant",
    "- /status",
    "",
    "Modi:",
    "- Idle: normaler Text = neue Codex-Anfrage",
    "- Laufende Codex-Session: normaler Text = Eingabe an Codex",
    "",
    `Mini App: ${webApp.ok ? "ready" : webApp.reason}`,
  ];
  if (BOT_ENABLE_RESTART_COMMAND) {
    lines.splice(4, 0, "- /restartbot");
  }
  return lines.join("\n");
}

function buildAsciiBanner() {
  return [
    "  ____ ___  ____  _______  __   ____   ___ _____",
    " / ___/ _ \\|  _ \\| ____\\ \\/ /  | __ ) / _ \\_   _|",
    "| |  | | | | | | |  _|  \\  /   |  _ \\| | | || |",
    "| |__| |_| | |_| | |___ /  \\   | |_) | |_| || |",
    " \\____\\___/|____/|_____/_/\\_\\  |____/ \\___/ |_|",
    "",
    "telegram bridge v2",
  ].join("\n");
}

async function sendAsciiBanner(chatId) {
  await sendMessage(chatId, `<pre>${escapeHtml(buildAsciiBanner())}</pre>`, {
    parse_mode: "HTML",
  });
}

async function sendStartCodexPrompt(chatId) {
  const webApp = getWebAppReadiness();
  const keyboard = [[{ text: "Startcodex", callback_data: "start_codex" }]];
  if (webApp.ok) {
    keyboard.push([{ text: "LiveCodex", web_app: { url: webApp.launchUrl } }]);
  }
  await sendMessage(chatId, "Was soll losgehn?", {
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });
}

async function sendRecentProjectsPrompt(chatId) {
  if (!recentProjects.length) {
    await sendMessage(chatId, "No previous sessions found. Start a new session first.", {
      reply_markup: {
        inline_keyboard: [[{ text: "Startcodex", callback_data: "start_codex" }]],
      },
    });
    return;
  }

  await sendMessage(chatId, "Previous sessions - select one to start:", {
    reply_markup: {
      inline_keyboard: buildRecentProjectsKeyboard(),
    },
  });
}

function resolveStartupChatId() {
  if (BOT_RESTART_BOOT_CHAT_ID) return BOT_RESTART_BOOT_CHAT_ID;
  if (BOT_STARTUP_CHAT_ID) return BOT_STARTUP_CHAT_ID;
  return TELEGRAM_ALLOWED_USER_ID;
}

function toTelegramChatId(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const numeric = Number(raw);
  if (Number.isSafeInteger(numeric)) return numeric;
  return raw;
}

async function maybeAutoStartCodexOnStartup(chatId, options = {}) {
  const force = options && options.force === true;
  if (!BOT_AUTO_START_CODEX) return false;
  if (activeRun) return false;
  if (!force && BOT_PROMPT_ON_START && recentProjects.length > 0) {
    await sendMessage(chatId, "Previous sessions found. Please choose what to start from the start menu.");
    return false;
  }

  if (BOT_CODEX_BACKEND !== "tmux") {
    await sendMessage(chatId, "Auto-start skipped: BOT_CODEX_BACKEND is not tmux.");
    return false;
  }
  if (!tmuxAvailable) {
    await sendMessage(chatId, "Auto-start skipped: tmux is not available.");
    return false;
  }
  if (!(await ensureCodexLoginReady(chatId, { silent: false }))) {
    return false;
  }

  if (force) {
    await sendMessage(chatId, "Restart complete. Starting Codex automatically...");
  } else {
    await sendMessage(chatId, "All systems ready. Starting Codex automatically...");
  }
  await startCodexTmuxRun(chatId, "codex");
  return Boolean(activeRun && activeRun.mode === "codex_tmux");
}

async function sendStartupFlow() {
  const startupChatId = toTelegramChatId(resolveStartupChatId());
  if (!startupChatId) return;

  const forceCodexAfterRestart = Boolean(BOT_RESTART_BOOT_SOURCE) && BOT_FORCE_CODEX_ON_RESTART;
  if (BOT_RESTART_BOOT_SOURCE) {
    await sendMessage(
      startupChatId,
      `Restart completed (id=${BOT_RESTART_BOOT_ID || "n/a"}, pid=${process.pid}, source=${BOT_RESTART_BOOT_SOURCE}).`
    );
    logRuntimeEvent("restart_completed", {
      restartId: BOT_RESTART_BOOT_ID || "",
      source: BOT_RESTART_BOOT_SOURCE,
      chatId: String(startupChatId),
      pid: process.pid,
    });
  } else {
    await sendMessage(startupChatId, "Bot started on your Mac.");
  }
  const codexLoginReady = await ensureCodexLoginReady(startupChatId, { silent: false });
  if (!codexLoginReady) {
    if (BOT_STARTUP_SEND_PANEL) {
      await sendPanelButton(startupChatId);
    }
    return;
  }
  if (!forceCodexAfterRestart) {
    const promptedOnboarding = await maybePromptProfileOnFirstStart(startupChatId);
    if (promptedOnboarding) {
      return;
    }
  }
  if (startupTunnelNotice) {
    await sendMessage(startupChatId, startupTunnelNotice);
  }

  const autoStarted = await maybeAutoStartCodexOnStartup(startupChatId, {
    force: forceCodexAfterRestart,
  });
  if (!autoStarted && BOT_PROMPT_ON_START && !forceCodexAfterRestart) {
    await sendStartCodexPrompt(startupChatId);
  }
  if (!autoStarted && forceCodexAfterRestart) {
    await sendMessage(startupChatId, "Restart finished, but Codex could not auto-start. Use /startcodex.");
  }

  // Avoid duplicate panel messages after auto-start:
  // startCodexTmuxRun() already sends "Codex Live Panel (this run)".
  if (BOT_STARTUP_SEND_PANEL && !autoStarted) {
    await sendPanelButton(startupChatId);
  }
}

function getInitDataFromRequest(req) {
  // Header first; query fallback is kept for compatibility with older clients.
  const queryValue = typeof req.query?.initData === "string" ? req.query.initData : "";
  const headerValue = typeof req.headers?.[TELEGRAM_INIT_HEADER] === "string" ? req.headers[TELEGRAM_INIT_HEADER] : "";
  return headerValue || queryValue;
}

function authorizeMiniAppRequest(req, res) {
  const initData = getInitDataFromRequest(req);
  const validation = validateInitData(initData, TELEGRAM_BOT_TOKEN, {
    maxAgeSeconds: MINIAPP_AUTH_MAX_AGE_SECONDS,
  });
  if (!validation.ok || String(validation.userId) !== TELEGRAM_ALLOWED_USER_ID) {
    res.status(401).json({
      ok: false,
      error: validation.reason || "unauthorized",
    });
    return null;
  }
  return validation;
}

const miniAppRateState = new Map();

function miniAppRateLimitForPath(pathname) {
  if (pathname === "/input") return MINIAPP_RATE_LIMIT_INPUT;
  return MINIAPP_RATE_LIMIT_LIVE;
}

function miniAppSecurityHeaders(_req, res, next) {
  const csp = [
    "default-src 'self'",
    "script-src 'self' https://telegram.org",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'self' https://t.me https://*.t.me https://web.telegram.org https://*.telegram.org",
  ].join("; ");

  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
}

function miniAppApiRateLimiter(req, res, next) {
  const now = Date.now();
  const limit = miniAppRateLimitForPath(req.path);
  const key = `${req.ip}:${req.path}`;
  const bucket = miniAppRateState.get(key);

  if (!bucket || now - bucket.windowStart >= MINIAPP_RATE_WINDOW_MS) {
    miniAppRateState.set(key, { count: 1, windowStart: now });
  } else {
    bucket.count += 1;
    if (bucket.count > limit) {
      const retryAfterSeconds = Math.max(1, Math.ceil((MINIAPP_RATE_WINDOW_MS - (now - bucket.windowStart)) / 1000));
      res.setHeader("Retry-After", String(retryAfterSeconds));
      res.status(429).json({ ok: false, error: "rate_limited" });
      return;
    }
  }

  if (miniAppRateState.size > 5000) {
    for (const [mapKey, value] of miniAppRateState.entries()) {
      if (now - value.windowStart > MINIAPP_RATE_WINDOW_MS * 2) {
        miniAppRateState.delete(mapKey);
      }
    }
  }

  res.setHeader("X-RateLimit-Limit", String(limit));
  next();
}

function miniAppChatId() {
  return resolveStartupChatId() || TELEGRAM_ALLOWED_USER_ID;
}

function isRestartCommand(text) {
  const lowered = String(text || "").trim().toLowerCase();
  if (lowered === "restart bot") return true;
  if (/^\/restartbot(?:@[a-z0-9_]+)?$/i.test(lowered)) return true;
  if (/^\/restart(?:@[a-z0-9_]+)?$/i.test(lowered)) return true;
  return false;
}

function isStartCodexCommand(text) {
  return /^\/(?:startcodex|codexstart)(?:@[a-z0-9_]+)?$/i.test(String(text || "").trim());
}

function isLiveCodexCommand(text) {
  return /^\/(?:livecodex|panel)(?:@[a-z0-9_]+)?$/i.test(String(text || "").trim());
}

async function handleMiniAppInput(rawText) {
  const text = typeof rawText === "string" ? rawText : "";
  if (!text.length) {
    return { ok: false, error: "empty_input" };
  }
  if (text.length > MINIAPP_INPUT_MAX_CHARS) {
    return { ok: false, error: `input_too_long_${MINIAPP_INPUT_MAX_CHARS}` };
  }

  const chatId = miniAppChatId();
  const normalized = text.trim();
  const lowered = normalized.toLowerCase();
  const trace = beginCommandTrace("miniapp", chatId, normalized);

  try {
    if (currentRuntimeState() === "restarting" && lowered !== "/status" && !isRestartCommand(lowered)) {
      await sendMessage(chatId, "Restart in progress. Please wait a few seconds.");
      finishCommandTrace(trace, "command_failed", { reason: "restart_in_progress" });
      return { ok: false, error: "restart_in_progress" };
    }

    if (lowered === "/status") {
      await handleStatus(chatId);
      finishCommandTrace(trace, "command_completed", { action: "status" });
      return { ok: true, action: "status" };
    }

    if (isRestartCommand(lowered)) {
      if (!BOT_ENABLE_RESTART_COMMAND) {
        finishCommandTrace(trace, "command_failed", { reason: "restart_disabled" });
        return { ok: false, error: "restart_disabled" };
      }
      await restartBotProcess(chatId, "miniapp");
      finishCommandTrace(trace, "command_completed", { action: "restart_bot" });
      return { ok: true, action: "restart_bot" };
    }

    if (lowered === "/stopcodex" || lowered === "stop codex" || lowered === "/cancel") {
      if (!activeRun) {
        finishCommandTrace(trace, "command_completed", { action: "stop_idle" });
        return { ok: true, action: "stop_idle" };
      }
      if (activeRun.mode === "shell_command") {
        await cancelShellRun("cancel");
        finishCommandTrace(trace, "command_completed", { action: "stop_shell" });
        return { ok: true, action: "stop_shell" };
      }
      await requestCancelCodexRun(activeRun, "cancel");
      finishCommandTrace(trace, "command_completed", { action: "stop_codex" });
      return { ok: true, action: "stop_codex" };
    }

    if (await maybeHandleOnboardingReply(chatId, text)) {
      finishCommandTrace(trace, "command_completed", { action: "onboarding_reply" });
      return { ok: true, action: "onboarding_reply" };
    }

    if (await maybeHandleReminderCommands(chatId, text)) {
      finishCommandTrace(trace, "command_completed", { action: "reminder" });
      return { ok: true, action: "reminder" };
    }
    maybeLearnPreferenceFromText(chatId, text, "miniapp");

    if (activeRun && activeRun.mode === "shell_command") {
      finishCommandTrace(trace, "command_failed", { reason: "shell_busy" });
      return { ok: false, error: "shell_busy" };
    }

    if (activeRun && activeRun.mode === "codex_tmux") {
      const run = activeRun;

      if (lowered === "/enter") {
        run.inputCount += 1;
        run.lastInputPreview = "[ENTER]";
        beginNewTurn(run, "miniapp-enter");
        await notifyTurnThinking(run);
        pushRunEvent(run, "miniapp /enter");
        await upsertCodexStatus(run, false);
        await submitWithFallback(run, "miniapp-enter");
        finishCommandTrace(trace, "command_completed", { action: "enter" });
        return { ok: true, action: "enter" };
      }

      if (text.startsWith("/raw ")) {
        await sendCodexRaw(run, text.slice(5));
        finishCommandTrace(trace, "command_completed", { action: "raw" });
        return { ok: true, action: "raw" };
      }

      if (/^\/sh\b/i.test(normalized)) {
        finishCommandTrace(trace, "command_failed", { reason: "shell_while_codex_running" });
        return { ok: false, error: "shell_while_codex_running" };
      }

      if (normalized.startsWith("/")) {
        finishCommandTrace(trace, "command_failed", { reason: "unknown_runtime_command" });
        return { ok: false, error: "unknown_runtime_command" };
      }

      await sendCodexInputLine(run, text);
      finishCommandTrace(trace, "command_completed", { action: "codex_input" });
      return { ok: true, action: "codex_input" };
    }

    if (isStartCodexCommand(lowered)) {
      if (BOT_CODEX_BACKEND !== "tmux") {
        finishCommandTrace(trace, "command_failed", { reason: "codex_backend_not_tmux" });
        return { ok: false, error: "codex_backend_not_tmux" };
      }
      await startCodexTmuxRun(chatId, "codex");
      finishCommandTrace(trace, "command_completed", { action: "start_codex" });
      return { ok: true, action: "start_codex" };
    }

    if (BOT_CODEX_BACKEND === "tmux" && isCodexCommand(normalized)) {
      await startCodexTmuxRun(chatId, normalized);
      finishCommandTrace(trace, "command_completed", { action: "start_codex_cmd" });
      return { ok: true, action: "start_codex_cmd" };
    }

    const intent = classifyInputIntent(text);
    if (intent.type === "shell_usage_error") {
      finishCommandTrace(trace, "command_failed", { reason: "shell_usage_error" });
      return { ok: false, error: "shell_usage_error", hint: "Usage: /sh <command>" };
    }

    if (intent.type === "shell") {
      await startShellCommand(chatId, intent.command);
      finishCommandTrace(trace, "command_completed", { action: "start_shell_cmd" });
      return { ok: true, action: "start_shell_cmd" };
    }

    if (intent.type === "codex") {
      const sent = await ensureCodexSessionForPrompt(chatId, intent.prompt);
      finishCommandTrace(trace, "command_completed", { action: sent ? "codex_input" : "codex_input_failed" });
      if (!sent) return { ok: false, error: "codex_input_failed" };
      return { ok: true, action: "codex_input" };
    }

    finishCommandTrace(trace, "command_failed", { reason: "no_active_codex" });
    return { ok: false, error: "no_active_codex", hint: "send /startcodex first" };
  } catch (err) {
    finishCommandTrace(trace, "command_failed", { reason: "exception", error: trimErrorMessage(err) });
    await sendMessage(chatId, `Command failed (${trace.id}): ${trimErrorMessage(err)}`);
    return { ok: false, error: "exception" };
  }
}

function buildPanelStatusLines() {
  const readiness = getWebAppReadiness();
  return [
    "Panel status:",
    `- enable: ${BOT_WEBAPP_ENABLE ? "on" : "off"}`,
    `- auto menu: ${BOT_WEBAPP_AUTO_MENU ? "on" : "off"}`,
    `- local api: http://${BOT_WEB_HOST}:${BOT_WEB_PORT}/api/miniapp/live`,
    `- input api: http://${BOT_WEB_HOST}:${BOT_WEB_PORT}/api/miniapp/input`,
    `- launch url: ${readiness.launchUrl || "(missing)"}`,
    `- result: ${readiness.ok ? "ready" : readiness.reason}`,
  ];
}

async function sendPanelButton(chatId, options = {}) {
  const silentIfUnavailable = Boolean(options.silentIfUnavailable);
  const panelTitle = typeof options.title === "string" && options.title.trim() ? options.title.trim() : "Codex Live Panel:";
  const readiness = getWebAppReadiness();
  if (!readiness.ok) {
    if (!silentIfUnavailable) {
      await sendMessage(chatId, `Panel is not ready: ${readiness.reason}`);
    }
    return false;
  }
  await sendMessage(chatId, panelTitle, {
    reply_markup: {
      inline_keyboard: [[{ text: "Open Codex Live", web_app: { url: readiness.launchUrl } }]],
    },
  });
  return true;
}

async function configureMiniAppMenuButton() {
  if (!BOT_WEBAPP_ENABLE || !BOT_WEBAPP_AUTO_MENU) return;
  const readiness = getWebAppReadiness();
  if (!readiness.ok) {
    console.warn(`Mini App menu button not set: ${readiness.reason}`);
    return;
  }

  const chatId = Number(resolveStartupChatId());
  const payload = {
    menu_button: {
      type: "web_app",
      text: "Codex Live",
      web_app: { url: readiness.launchUrl },
    },
  };

  if (Number.isFinite(chatId)) {
    payload.chat_id = chatId;
  }

  try {
    await bot.setChatMenuButton(payload);
    console.log(`Mini App menu button configured: ${readiness.launchUrl}`);
  } catch (err) {
    console.error("Failed to set chat menu button:", err.message);
  }
}

async function configureTelegramCommands() {
  try {
    await bot.setMyCommands([
      { command: "start", description: "Show start and quick help" },
      { command: "help", description: "Show command reference" },
      { command: "setupassistant", description: "Run profile/persona setup" },
      { command: "persona", description: "Show/switch personality preset" },
      { command: "model", description: "Show/switch model profile" },
      { command: "startcodex", description: "Start Codex" },
      { command: "codexstart", description: "Alias for /startcodex" },
      { command: "livecodex", description: "Open Codex Live panel" },
      { command: "panel", description: "Alias for /livecodex" },
      { command: "panelstatus", description: "Show mini app status" },
      { command: "ask", description: "Ask Codex directly (/ask <text>)" },
      { command: "sh", description: "Run shell command (/sh <cmd>)" },
      { command: "projects", description: "Show recent project sessions" },
      { command: "voice", description: "Show voice transcription status" },
      { command: "status", description: "Show runtime status" },
      { command: "pwd", description: "Show current working directory" },
      { command: "timer", description: "Create timer (/timer 25m text)" },
      { command: "remind", description: "One-time reminder (/remind 18:30 text)" },
      { command: "daily", description: "Daily reminder (/daily 09:00 text)" },
      { command: "terminal", description: "Quick terminal reminder" },
      { command: "reminders", description: "List active reminders" },
      { command: "remindoff", description: "Disable reminder (/remindoff <id>)" },
      { command: "stopcodex", description: "Stop active codex session" },
      { command: "cancel", description: "Alias for /stopcodex" },
      { command: "codexskip", description: "Skip codex start prompt" },
      { command: "restartbot", description: "Restart this bot process" },
    ]);
  } catch (err) {
    console.error("Failed to set bot commands:", err.message);
  }
}

async function tryRecoverMiniAppPortConflict(err, attempt) {
  if (!err || err.code !== "EADDRINUSE") return false;
  if (attempt > 1) return false;
  const ownerPid = findListeningPidForPort(BOT_WEB_PORT);
  if (!ownerPid || ownerPid === process.pid) return false;
  if (!isProjectBotPid(ownerPid)) return false;
  const stopped = await terminatePidGracefully(ownerPid, 2500);
  if (!stopped) return false;
  logRuntimeEvent("miniapp_port_conflict_recovered", {
    port: BOT_WEB_PORT,
    ownerPid,
  });
  return true;
}

function startMiniAppServer() {
  if (!BOT_WEBAPP_ENABLE) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const app = express();
    app.disable("x-powered-by");
    app.set("etag", false);
    app.set("trust proxy", false);
    app.use(express.json({ limit: "64kb" }));
    app.use(miniAppSecurityHeaders);

    const miniAppRoot = path.join(__dirname, "public", "telegram-miniapp");
    app.use("/telegram-miniapp", express.static(miniAppRoot, { index: "index.html" }));
    app.get("/", (_req, res) => {
      res.redirect("/miniapp");
    });
    app.get("/miniapp", (_req, res) => {
      res.redirect("/telegram-miniapp/index.html");
    });
    app.use("/api/miniapp", miniAppApiRateLimiter);

    app.get("/api/miniapp/live", (req, res) => {
      const authorized = authorizeMiniAppRequest(req, res);
      if (!authorized) return;

      res.setHeader("Cache-Control", "no-store, max-age=0");
      res.json({
        ok: true,
        config: {
          refreshMs: BOT_WEBAPP_REFRESH_MS,
          inputMaxChars: MINIAPP_INPUT_MAX_CHARS,
          restartEnabled: BOT_ENABLE_RESTART_COMMAND,
        },
        snapshot: buildMiniAppSnapshot(activeRun),
      });
    });

    app.post("/api/miniapp/input", async (req, res) => {
      const authorized = authorizeMiniAppRequest(req, res);
      if (!authorized) return;

      res.setHeader("Cache-Control", "no-store, max-age=0");
      const text = typeof req.body?.text === "string" ? req.body.text : "";
      try {
        const result = await handleMiniAppInput(text);
        if (!result.ok) {
          res.status(400).json({
            ok: false,
            ...result,
            snapshot: buildMiniAppSnapshot(activeRun),
          });
          return;
        }
        res.json({
          ok: true,
          ...result,
          snapshot: buildMiniAppSnapshot(activeRun),
        });
      } catch (err) {
        console.error("Mini App input handler failed:", err?.message || err);
        res.status(500).json({
          ok: false,
          error: "input_handler_failed",
        });
      }
    });

    let attempt = 0;
    const listenOnce = () => {
      attempt += 1;
      miniAppServer = app.listen(BOT_WEB_PORT, BOT_WEB_HOST, () => {
        console.log(`Mini App API listening on http://${BOT_WEB_HOST}:${BOT_WEB_PORT}`);
        finish(true);
      });
      miniAppServer.once("error", (err) => {
        void (async () => {
          console.error("Mini App API failed to start:", err.message);
          const recovered = await tryRecoverMiniAppPortConflict(err, attempt);
          if (recovered) {
            await wait(600);
            listenOnce();
            return;
          }
          finish(false);
        })();
      });
    };

    listenOnce();
  });
}

async function handleStatus(chatId) {
  if (!activeRun) {
    await sendMessage(chatId, `Status: idle. CWD: ${lastKnownCwd}`);
    return;
  }

  if (activeRun.mode === "shell_command") {
    const elapsed = Date.now() - activeRun.startedAt;
    await sendMessage(
      chatId,
      `Status: shell command running "${shortCommand(activeRun.command)}" for ${formatDuration(elapsed)}.`
    );
    return;
  }

  const elapsed = Date.now() - activeRun.startedAt;
  const eventTail = activeRun.events.slice(-6).join("\n") || "(no events yet)";
  const runModelSummary = activeRun.modelProfileAtStart
    ? modelProfileSummary(activeRun.modelProfileAtStart)
    : modelProfileSummary();
  await sendMessage(
    chatId,
    `Status: codex tmux running (${activeRun.sessionName}) for ${formatDuration(elapsed)}.\nModel: ${runModelSummary}\nRecent events:\n<pre>${escapeHtml(eventTail)}</pre>`,
    { parse_mode: "HTML" }
  );
}

async function maybePromptProfileOnFirstStart(chatId) {
  if (isUserProfileComplete(userProfile)) return false;
  if (!(await ensureCodexLoginReady(chatId, { silent: false }))) return false;
  const started = startProfileOnboarding(chatId, false);
  if (!started) return false;
  await sendMessage(
    chatId,
    "Kurzes Setup beim ersten Start. Du waehlst zuerst `schenni` oder `custom` und danach fuehre ich dich durch die passenden Schritte."
  );
  await sendOnboardingPrompt(chatId);
  return true;
}

async function createOnceReminder(chatId, runAt, message) {
  const reminder = sanitizeReminder({
    id: createReminderId("once"),
    type: "once",
    runAt,
    message,
    chatId,
    active: true,
    createdAt: new Date().toISOString(),
    sentAt: "",
  });
  if (!reminder) return null;
  reminderState.reminders.unshift(reminder);
  if (reminderState.reminders.length > MAX_REMINDERS) {
    reminderState.reminders = reminderState.reminders.slice(0, MAX_REMINDERS);
  }
  persistReminders();
  scheduleReminder(reminder);
  recordActivity(
    "reminder_created_once",
    "Einmalige Erinnerung erstellt",
    `ID: ${reminder.id}\nFaellig: ${formatLocalDateTime(reminder.runAt)}\nText: ${reminder.message}`,
    chatId
  );
  return reminder;
}

async function createDailyReminder(chatId, hhmm, message) {
  const reminder = sanitizeReminder({
    id: createReminderId("daily"),
    type: "daily",
    time: hhmm,
    message,
    chatId,
    active: true,
    createdAt: new Date().toISOString(),
    lastSentAt: "",
  });
  if (!reminder) return null;
  reminderState.reminders.unshift(reminder);
  if (reminderState.reminders.length > MAX_REMINDERS) {
    reminderState.reminders = reminderState.reminders.slice(0, MAX_REMINDERS);
  }
  persistReminders();
  scheduleReminder(reminder);
  recordActivity(
    "reminder_created_daily",
    "Taegliche Erinnerung erstellt",
    `ID: ${reminder.id}\nUhrzeit: ${reminder.time}\nText: ${reminder.message}`,
    chatId
  );
  return reminder;
}

function buildPersonaOverviewLines() {
  const activeKey = normalizePersonaPreset(userProfile?.personaPreset || "") || "custom";
  const activeLabel = personaPresetLabel(activeKey);
  const lines = [
    `Aktive Persona: ${activeLabel} (${activeKey})`,
    "Verfuegbare Presets:",
  ];
  for (const entry of PERSONA_PRESET_DEFINITIONS) {
    lines.push(`- ${entry.key}: ${entry.summary}`);
  }
  lines.push("Umschalten: /persona <preset>");
  lines.push("Beispiel: /persona showman-en");
  return lines;
}

async function switchPersonaPreset(chatId, presetInput) {
  const preset = normalizePersonaPreset(presetInput);
  if (!preset) {
    await sendMessage(chatId, `Unbekanntes Preset: "${presetInput}".\n${buildPersonaOverviewLines().join("\n")}`);
    return true;
  }
  if (!availablePersonaPresetKeys().includes(preset)) {
    await sendMessage(chatId, `Preset nicht verfuegbar: "${preset}".`);
    return true;
  }

  const ensured = ensurePersonaPresetFiles(preset);
  if (!ensured.ok) {
    await sendMessage(chatId, `Preset konnte nicht aktiviert werden: ${ensured.error || "init failed"}`);
    return true;
  }

  const nextProfile = {
    ...userProfile,
    personaPreset: preset,
    configuredAt: new Date().toISOString(),
  };
  if (preset === "schenni") {
    if (!nextProfile.assistantName) nextProfile.assistantName = "Schenni";
    if (!nextProfile.tone) nextProfile.tone = "leger";
    if (!nextProfile.preferences) {
      nextProfile.preferences = "Kurz, keck und ostdeutsch. Bei komplexen Themen kompakt und strukturiert.";
    }
  }
  const completeCandidate = {
    ...nextProfile,
    setupCompleted: Boolean(nextProfile.setupCompleted),
  };
  if (!completeCandidate.setupCompleted && isUserProfileComplete(completeCandidate)) {
    completeCandidate.setupCompleted = true;
  }

  userProfile = completeCandidate;
  const syncResult = applyUserProfileToPersonality();
  const syncInfo = syncResult.ok ? "Persona-Dateien aktualisiert." : `Profil lokal gespeichert, Sync-Fehler: ${syncResult.error}`;
  await sendMessage(
    chatId,
    `Persona aktiv: ${personaPresetLabel(preset)} (${preset}). ${syncInfo}`
  );
  return true;
}

function activeReminderLines() {
  const active = listActiveReminders();
  if (!active.length) return ["Keine aktiven Erinnerungen."];
  return active.slice(0, 25).map((item) => {
    if (item.type === "once") {
      return `- ${item.id}: einmalig am ${formatLocalDateTime(item.runAt)} -> ${item.message}`;
    }
    return `- ${item.id}: taeglich ${item.time} -> ${item.message}`;
  });
}

async function maybeHandleReminderCommands(chatId, text) {
  const normalized = String(text || "").trim();
  const lowered = normalized.toLowerCase();

  if (lowered === "/reminders") {
    await sendMessage(chatId, ["Aktive Erinnerungen:", ...activeReminderLines()].join("\n"));
    return true;
  }

  if (lowered === "/setupassistant") {
    if (!(await ensureCodexLoginReady(chatId, { silent: false }))) {
      return true;
    }
    startProfileOnboarding(chatId, true);
    await sendMessage(chatId, "Setup gestartet (Preset-Wahl + Persona). Du kannst jederzeit mit /cancel abbrechen.");
    await sendOnboardingPrompt(chatId);
    return true;
  }

  const personaMatch = /^\/(?:persona|personality)(?:\s+([\s\S]+))?$/i.exec(normalized);
  if (personaMatch) {
    const argRaw = String(personaMatch[1] || "").trim();
    const argLower = argRaw.toLowerCase();
    if (!argRaw || argLower === "list" || argLower === "help" || argLower === "show") {
      await sendMessage(chatId, buildPersonaOverviewLines().join("\n"));
      return true;
    }
    if (argLower === "current" || argLower === "status") {
      const activeKey = normalizePersonaPreset(userProfile?.personaPreset || "") || "custom";
      await sendMessage(chatId, `Aktive Persona: ${personaPresetLabel(activeKey)} (${activeKey})`);
      return true;
    }
    const effectiveArg = argLower.startsWith("set ") ? argRaw.slice(4).trim() : argRaw;
    if (!effectiveArg) {
      await sendMessage(chatId, "Bitte gib ein Preset an. Beispiel: /persona schenni");
      return true;
    }
    return switchPersonaPreset(chatId, effectiveArg);
  }

  const modelMatch = /^\/model(?:\s+([\s\S]+))?$/i.exec(normalized);
  if (modelMatch) {
    const parsed = parseModelSwitchInput(modelMatch[1] || "");
    if (!parsed.ok) {
      await sendMessage(chatId, `${parsed.error}\n\n${buildModelHelpLines().join("\n")}`);
      return true;
    }
    if (parsed.showOnly) {
      await sendMessage(chatId, buildModelHelpLines().join("\n"));
      return true;
    }

    const current = currentModelProfile();
    const next = writeModelProfile({
      ...current,
      model: parsed.model || current.model,
      reasoningEffort: parsed.reasoningEffort || current.reasoningEffort,
      updatedAt: new Date().toISOString(),
    });
    modelProfile = next;

    const note = activeRun && activeRun.mode === "codex_tmux" && !activeRun.done
      ? " Laufende Session bleibt unveraendert; gilt ab naechster /codexstart."
      : " Gilt ab sofort fuer neue Sessions.";
    await sendMessage(chatId, `Modelprofil gesetzt: ${modelProfileSummary(next)}.${note}`);
    return true;
  }

  const timer = parseTimerCommandInput(normalized);
  if (timer) {
    const runAt = Date.now() + timer.ms;
    const created = await createOnceReminder(chatId, runAt, timer.label);
    if (!created) {
      await sendMessage(chatId, "Timer konnte nicht erstellt werden.");
      return true;
    }
    await sendMessage(chatId, `Timer gesetzt (${created.id}) bis ${formatLocalDateTime(runAt)}.`);
    return true;
  }

  const remind = parseRemindCommandInput(normalized);
  if (remind) {
    const created = await createOnceReminder(chatId, remind.runAt, remind.label);
    if (!created) {
      await sendMessage(chatId, "Erinnerung konnte nicht erstellt werden.");
      return true;
    }
    await sendMessage(chatId, `Einmalige Erinnerung gesetzt (${created.id}) fuer ${formatLocalDateTime(remind.runAt)}.`);
    return true;
  }

  const daily = parseDailyCommandInput(normalized);
  if (daily) {
    const created = await createDailyReminder(chatId, daily.hhmm, daily.label);
    if (!created) {
      await sendMessage(chatId, "Taegliche Erinnerung konnte nicht erstellt werden.");
      return true;
    }
    await sendMessage(chatId, `Taegliche Erinnerung gesetzt (${created.id}) um ${daily.hhmm}.`);
    return true;
  }

  const terminalMatch = /^\/terminal(?:\s+(\d{1,2}:\d{2}))?$/i.exec(normalized);
  if (terminalMatch) {
    const hhmm = parseClockHHMM(terminalMatch[1] || "09:00");
    if (!hhmm) {
      await sendMessage(chatId, "Ungueltige Zeit. Beispiel: /terminal 09:00");
      return true;
    }
    const runAt = nextRunForClockHHMM(hhmm);
    const created = await createOnceReminder(chatId, runAt, "Bitte heute ans Terminal denken.");
    if (!created) {
      await sendMessage(chatId, "Terminal-Erinnerung konnte nicht erstellt werden.");
      return true;
    }
    await sendMessage(chatId, `Terminal-Erinnerung gesetzt (${created.id}) fuer ${formatLocalDateTime(runAt)}.`);
    return true;
  }

  const offMatch = /^\/remindoff\s+([a-z0-9_]+)$/i.exec(normalized);
  if (offMatch) {
    const reminderId = offMatch[1];
    const index = reminderState.reminders.findIndex((item) => item.id === reminderId);
    if (index < 0) {
      await sendMessage(chatId, "Reminder-ID nicht gefunden.");
      return true;
    }
    reminderState.reminders[index] = {
      ...reminderState.reminders[index],
      active: false,
    };
    persistReminders();
    unscheduleReminder(reminderId);
    recordActivity("reminder_disabled", "Erinnerung deaktiviert", `ID: ${reminderId}`, chatId);
    await sendMessage(chatId, `Reminder deaktiviert: ${reminderId}`);
    return true;
  }

  return false;
}

function normalizeSlackInput(text) {
  return String(text || "")
    .replace(/<@[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isSlackMessageAuthorized(userId, channelId) {
  const user = String(userId || "").trim();
  const channel = String(channelId || "").trim();
  if (SLACK_ALLOWED_USER_ID && user !== SLACK_ALLOWED_USER_ID) {
    return { ok: false, reason: "Not authorized." };
  }
  if (SLACK_ALLOWED_CHANNEL_ID && channel !== SLACK_ALLOWED_CHANNEL_ID) {
    return { ok: false, reason: "Not authorized in this channel." };
  }
  return { ok: true, reason: "ok" };
}

async function handleSlackIncomingText(channelId, userId, rawText) {
  const chatId = makeSlackChatId(channelId);
  if (!chatId) return;

  const auth = isSlackMessageAuthorized(userId, channelId);
  if (!auth.ok) {
    await sendMessage(chatId, auth.reason);
    return;
  }

  const text = normalizeSlackInput(rawText);
  const normalized = text.trim();
  const lowered = normalized.toLowerCase();
  const trace = beginCommandTrace("slack", chatId, normalized);

  try {
    if (currentRuntimeState() === "restarting" && lowered !== "/status" && !isRestartCommand(lowered)) {
      await sendMessage(chatId, "Restart in progress. Please wait a few seconds.");
      finishCommandTrace(trace, "command_failed", { reason: "restart_in_progress" });
      return;
    }

    if (await maybeHandleOnboardingReply(chatId, text)) {
      return;
    }

  if (await maybeHandleReminderCommands(chatId, text)) {
    return;
  }
  maybeLearnPreferenceFromText(chatId, text, "slack");

  if (normalized === "/start" || lowered === "start") {
    await sendMessage(chatId, startMessage());
    await sendMessage(chatId, "Slack quick start: /startcodex | /stopcodex | /livecodex");
    return;
  }

  if (lowered === "/help" || lowered === "/hilfe" || lowered === "help") {
    await sendMessage(chatId, `${helpMessage()}\n\nSlack: /recentstart <id> (statt Button-Auswahl)`);
    return;
  }

  if (isStartCodexCommand(lowered)) {
    if (activeRun) {
      await sendMessage(chatId, "A session is already running. Use /stopcodex or /livecodex.");
      return;
    }
    if (BOT_CODEX_BACKEND === "tmux") {
      await startCodexTmuxRun(chatId, "codex");
      return;
    }
    await sendMessage(chatId, "Starting Codex is only available with BOT_CODEX_BACKEND=tmux.");
    return;
  }

  if (isLiveCodexCommand(lowered)) {
    await sendPanelButton(chatId);
    return;
  }

  if (lowered === "/panelstatus") {
    await sendMessage(chatId, buildPanelStatusLines().join("\n"));
    return;
  }

  if (lowered === "/voice") {
    await sendMessage(chatId, "Voice transcription is only supported in Telegram chats.");
    return;
  }

  if (isRestartCommand(lowered)) {
    if (!BOT_ENABLE_RESTART_COMMAND) {
      await sendMessage(chatId, "Restart command is disabled.");
      return;
    }
    await restartBotProcess(chatId, "slack");
    return;
  }

  if (lowered === "/projects" || lowered === "/project" || lowered === "/recent" || lowered === "/recentprojects") {
    await sendMessage(chatId, buildRecentProjectsPlaintext());
    return;
  }

  const recentStart = /^\/recentstart\s+([a-z0-9_]+)$/i.exec(normalized);
  if (recentStart) {
    const entry = findRecentProjectById(recentStart[1]);
    if (!entry) {
      await sendMessage(chatId, "This recent project was not found.");
      return;
    }
    await sendMessage(
      chatId,
      `Starting recent project:\n- project: ${entry.projectName}\n- cwd: ${entry.cwd}\n- command: ${entry.command}`
    );
    await startCodexTmuxRun(chatId, entry.command, { cwd: entry.cwd, source: "recent-projects" });
    return;
  }

  const askMatch = /^\/ask(?:\s+([\s\S]+))?$/i.exec(text);
  if (askMatch) {
    const payload = String(askMatch[1] || "").trim();
    if (!payload) {
      await sendMessage(chatId, "Usage: /ask <text>");
      return;
    }
    await ensureCodexSessionForPrompt(chatId, payload);
    return;
  }

  if (activeRun && activeRun.mode === "codex_tmux") {
    const run = activeRun;

    if (lowered === "/status") {
      await handleStatus(chatId);
      return;
    }

    if (lowered === "/stopcodex" || lowered === "stop codex" || lowered === "/cancel") {
      await sendMessage(chatId, "Stop requested for codex session...");
      await requestCancelCodexRun(run, "cancel");
      return;
    }

    if (lowered === "/enter") {
      run.inputCount += 1;
      run.lastInputPreview = "[ENTER]";
      beginNewTurn(run, "manual-enter");
      await notifyTurnThinking(run);
      pushRunEvent(run, "manual /enter");
      await upsertCodexStatus(run, false);
      await submitWithFallback(run, "manual-enter");
      return;
    }

    if (text.startsWith("/raw ")) {
      const payload = text.slice(5);
      await sendCodexRaw(run, payload);
      return;
    }

    if (/^\/sh\b/i.test(normalized)) {
      await sendMessage(chatId, "Shell commands via /sh are only available when no codex session is running. Use /stopcodex first.");
      return;
    }

    if (normalized.startsWith("/")) {
      await sendMessage(chatId, "Unbekannter Befehl. Erlaubt: /stopcodex | /livecodex");
      return;
    }

    if (!text.length) return;

    await sendCodexInputLine(run, text);
    return;
  }

  if (lowered === "/status" || lowered === "status") {
    await handleStatus(chatId);
    return;
  }

  if (lowered === "/stopcodex" || lowered === "stop codex" || lowered === "/cancel" || lowered === "cancel") {
    if (!activeRun) {
      await sendMessage(chatId, "No active session.");
      return;
    }
    if (activeRun.mode === "shell_command") {
      await sendMessage(chatId, "Stop requested. Sending Ctrl+C...");
      await cancelShellRun("cancel");
      return;
    }
    await sendMessage(chatId, "Stop requested for codex session...");
    await requestCancelCodexRun(activeRun, "cancel");
    return;
  }

  if (lowered === "/pwd" || lowered === "pwd") {
    if (activeRun) {
      await sendMessage(chatId, `Current CWD (last known): ${lastKnownCwd}`);
      return;
    }
    await startShellCommand(chatId, "pwd");
    return;
  }

  if (activeRun && activeRun.mode === "shell_command") {
    await sendMessage(chatId, "A shell command is already running. Use /stopcodex.");
    return;
  }

  if (!normalized) return;
  if (BOT_CODEX_BACKEND === "tmux" && isCodexCommand(normalized)) {
    await startCodexTmuxRun(chatId, normalized);
    return;
  }

  const intent = classifyInputIntent(text);
  if (intent.type === "shell_usage_error") {
    await sendMessage(chatId, "Usage: /sh <command>");
    return;
  }

  if (intent.type === "command") {
    await sendMessage(chatId, "Unbekannter Befehl. Nutz /startcodex, /stopcodex, /livecodex oder /restartbot.");
    return;
  }

  if (intent.type === "shell") {
    await startShellCommand(chatId, intent.command);
    return;
  }

  if (intent.type === "codex") {
    await ensureCodexSessionForPrompt(chatId, intent.prompt);
    return;
  }

  await startShellCommand(chatId, text);
  } catch (err) {
    finishCommandTrace(trace, "command_failed", { reason: "exception", error: trimErrorMessage(err) });
    await sendMessage(chatId, `Command failed (${trace.id}): ${trimErrorMessage(err)}`);
    return;
  } finally {
    finishCommandTrace(trace, "command_completed");
  }
}

function slackEnabled() {
  return SLACK_BOT_ENABLED;
}

function slackReadyConfig() {
  return Boolean(SLACK_BOT_TOKEN && SLACK_APP_TOKEN);
}

async function bootstrapSlackBridge() {
  console.log("Slack bridge: disabled in V0.2(schenni).");
  return false;
}

async function cleanupStaleTmuxSessions() {
  if (BOT_CODEX_BACKEND !== "tmux") return;
  try {
    await tmux.run(BOT_TMUX_BIN, ["-V"]);
    tmuxAvailable = true;
  } catch (err) {
    tmuxAvailable = false;
    console.error(`tmux unavailable (${BOT_TMUX_BIN}):`, err.message);
    return;
  }

  try {
    const removed = await tmux.cleanupSessionsByPrefix(BOT_TMUX_BIN, TMUX_SESSION_PREFIX);
    if (removed.length > 0) {
      console.log(`Cleaned stale tmux sessions: ${removed.join(", ")}`);
    }
  } catch (err) {
    console.error("Failed to cleanup stale tmux sessions:", err.message);
  }
}

async function bootstrapRuntime() {
  writeRuntimeStateSnapshot({ phase: "booting" });
  logRuntimeEvent("runtime_bootstrap_started", { supervised: BOT_SUPERVISED });
  const cleanedBots = await cleanupOtherProjectBotProcesses();
  if (cleanedBots > 0) {
    console.warn(`Cleaned concurrent bot processes during bootstrap: ${cleanedBots}`);
    logRuntimeEvent("bootstrap_cleaned_orphan_bots", { cleanedBots });
  }
  ensureNodePtyHelperExecutable();
  applyUserProfileToPersonality();
  updateMiniSnapshot(null);
  createShell();
  const miniAppStarted = await startMiniAppServer();
  if (BOT_WEBAPP_ENABLE && !miniAppStarted) {
    throw new Error(`Mini App API could not bind on ${BOT_WEB_HOST}:${BOT_WEB_PORT}`);
  }
  const tunnelState = await ensureCloudflareTunnelOnStartup();
  startupTunnelNotice = tunnelState.notice || "";
  if (!tunnelState.ok) {
    console.warn(startupTunnelNotice);
  } else if (startupTunnelNotice) {
    console.log(startupTunnelNotice);
  }
  await cleanupStaleTmuxSessions();
  scheduleAllReminders();
  await configureMiniAppMenuButton();
  await configureTelegramCommands();
  writeRestartReadyMarker({ phase: "ready" });
  writeRuntimeStateSnapshot({ phase: "ready" });
  logRuntimeEvent("runtime_ready", {
    restartId: BOT_RESTART_BOOT_ID || "",
    restartSource: BOT_RESTART_BOOT_SOURCE || "",
    supervised: BOT_SUPERVISED,
  });
  setTimeout(() => {
    void sendStartupFlow();
  }, Math.max(0, BOT_STARTUP_BOOT_DELAY_MS));
}

void bootstrapRuntime().catch((err) => {
  const message = trimErrorMessage(err);
  console.error("Runtime bootstrap failed:", message);
  logRuntimeEvent("runtime_bootstrap_failed", { error: message });
  setTimeout(() => {
    process.exit(1);
  }, 150);
});

async function maybeRecoverTelegramPollingConflict(err) {
  const message = trimErrorMessage(err);
  if (!/409 conflict/i.test(message)) return;
  const now = Date.now();
  telegramConflictTimestamps = telegramConflictTimestamps.filter((ts) => now - ts <= TELEGRAM_CONFLICT_WINDOW_MS);
  telegramConflictTimestamps.push(now);

  if (telegramConflictTimestamps.length < TELEGRAM_CONFLICT_MAX) return;
  if (telegramConflictRecoveryScheduled) return;
  telegramConflictRecoveryScheduled = true;

  let cleanedBots = 0;
  try {
    cleanedBots = await cleanupOtherProjectBotProcesses();
  } catch (_err) {
    cleanedBots = 0;
  }

  logRuntimeEvent("telegram_conflict_threshold", {
    count: telegramConflictTimestamps.length,
    windowMs: TELEGRAM_CONFLICT_WINDOW_MS,
    cleanedBots,
  });

  if (cleanedBots > 0) {
    telegramConflictTimestamps = [];
    telegramConflictRecoveryScheduled = false;
    return;
  }

  console.error("Telegram polling conflict threshold reached, restarting process.");
  setTimeout(() => {
    process.exit(1);
  }, 200);
}

bot.on("polling_error", (err) => {
  console.error("Telegram polling error:", err.message);
  logRuntimeEvent("telegram_polling_error", { error: trimErrorMessage(err) });
  void maybeRecoverTelegramPollingConflict(err);
});

async function answerCallback(query, text = "") {
  if (!query || !query.id) return;
  try {
    await bot.answerCallbackQuery(query.id, text ? { text } : {});
  } catch (err) {
    console.error("Failed to answer callback query:", err.message);
  }
}

function markCallbackQuerySeen(queryId) {
  const id = String(queryId || "").trim();
  if (!id) return false;
  const now = Date.now();
  const seenAt = callbackQuerySeen.get(id);
  if (seenAt && now - seenAt < 5 * 60 * 1000) {
    return true;
  }
  callbackQuerySeen.set(id, now);
  if (callbackQuerySeen.size > 4000) {
    for (const [knownId, ts] of callbackQuerySeen.entries()) {
      if (now - ts > 10 * 60 * 1000) {
        callbackQuerySeen.delete(knownId);
      }
    }
  }
  return false;
}

bot.on("callback_query", async (query) => {
  if (markCallbackQuerySeen(query?.id)) {
    await answerCallback(query);
    return;
  }
  const chatId = query?.message?.chat?.id;
  const data = String(query?.data || "");

  if (!chatId) {
    await answerCallback(query);
    return;
  }

  if (!isAuthorized(query)) {
    await answerCallback(query, "Not authorized.");
    return;
  }

  if (data === "start_codex") {
    await answerCallback(query, "Starting codex...");
    if (BOT_CODEX_BACKEND !== "tmux") {
      await sendMessage(chatId, "Starting Codex is only available with BOT_CODEX_BACKEND=tmux.");
      return;
    }
    await startCodexTmuxRun(chatId, "codex");
    return;
  }

  if (data === "recent_projects") {
    await answerCallback(query);
    await sendRecentProjectsPrompt(chatId);
    return;
  }

  if (data === "skip_codex") {
    await answerCallback(query, "Okay");
    await sendMessage(chatId, "Okay, no automatic codex start.");
    return;
  }

  if (data.startsWith("reply:")) {
    await answerCallback(query);
    if (!activeRun || activeRun.mode !== "codex_tmux" || activeRun.done) {
      logRuntimeEvent("reply_button_failed", {
        chatId: String(chatId || ""),
        action: data.slice("reply:".length),
        reason: "no_active_session",
      });
      await sendMessage(chatId, "No active codex session for reply buttons.");
      return;
    }

    const action = data.slice("reply:".length);
    const run = activeRun;
    logRuntimeEvent("reply_button_clicked", {
      chatId: String(chatId || ""),
      action,
      turn: run.turnIndex,
    });
    if (action === "cancel") {
      await sendMessage(chatId, "Stop requested for codex session...");
      await requestCancelCodexRun(run, "cancel");
      return;
    }
    if (action === "manual") {
      suppressCurrentReplyPrompt(run, "manual-reply");
      await sendMessage(chatId, "Please send your custom reply now as a normal text message.");
      return;
    }
    if (action === "no_but") {
      suppressCurrentReplyPrompt(run, "manual-reason");
      await sendMessage(chatId, "Please send your reason now. I will send it as: no but <reason>.");
      return;
    }
    if (action === "panel") {
      await sendPanelButton(chatId, { title: "Mini App:" });
      return;
    }

    const map = {
      yes: "yes",
      yes_always: "yes always",
    };
    const payload = map[action];
    if (!payload) {
      await sendMessage(chatId, "Unknown reply button.");
      return;
    }
    await sendCodexInputLine(run, payload);
    return;
  }

  if (data.startsWith("recent_start:")) {
    const recentId = data.slice("recent_start:".length);
    const entry = findRecentProjectById(recentId);
    await answerCallback(query);
    if (!entry) {
      await sendMessage(chatId, "This recent project was not found.");
      return;
    }
    await sendMessage(
      chatId,
      `Starting recent project:\n- project: ${entry.projectName}\n- cwd: ${entry.cwd}\n- command: ${entry.command}`
    );
    await startCodexTmuxRun(chatId, entry.command, { cwd: entry.cwd, source: "recent-projects" });
  }
});

bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  let text = typeof msg.text === "string" ? msg.text : "";
  if (!text && typeof msg.caption === "string") {
    text = msg.caption;
  }

  if (!isAuthorized(msg)) {
    await sendMessage(chatId, "Not authorized.");
    return;
  }

  if (!text) {
    const voiceMeta = getVoiceInputMeta(msg);
    if (voiceMeta) {
      const transcript = await transcribeVoiceInput(chatId, voiceMeta);
      if (!transcript) return;
      text = transcript;
    }
  }

  const normalized = text.trim();
  const lowered = normalized.toLowerCase();
  const trace = beginCommandTrace("telegram", chatId, normalized);

  try {
    if (currentRuntimeState() === "restarting" && lowered !== "/status" && !isRestartCommand(lowered)) {
      await sendMessage(chatId, "Restart in progress. Please wait a few seconds.");
      finishCommandTrace(trace, "command_failed", { reason: "restart_in_progress" });
      return;
    }

    if (await maybeHandleOnboardingReply(chatId, text)) {
      return;
    }

  if (await maybeHandleReminderCommands(chatId, text)) {
    return;
  }
  maybeLearnPreferenceFromText(chatId, text, "telegram");

  if (normalized === "/start" || normalized.startsWith("/start@")) {
    await sendMessage(chatId, startMessage());
    await sendStartCodexPrompt(chatId);
    return;
  }

  if (lowered === "/help" || lowered === "/hilfe") {
    await sendMessage(chatId, helpMessage());
    return;
  }

  if (isStartCodexCommand(lowered)) {
    if (activeRun) {
      await sendMessage(chatId, "A session is already running. Use /stopcodex or /livecodex.");
      return;
    }
    if (BOT_CODEX_BACKEND === "tmux") {
      await startCodexTmuxRun(chatId, "codex");
      return;
    }
    await sendMessage(chatId, "Starting Codex is only available with BOT_CODEX_BACKEND=tmux.");
    return;
  }

  if (lowered === "/codexskip") {
    await sendMessage(chatId, "Okay, no automatic codex start.");
    return;
  }

  if (isLiveCodexCommand(lowered)) {
    await sendPanelButton(chatId);
    return;
  }

  if (lowered === "/panelstatus") {
    await sendMessage(chatId, buildPanelStatusLines().join("\n"));
    return;
  }

  if (lowered === "/voice") {
    await sendMessage(chatId, buildVoiceStatusLines().join("\n"));
    return;
  }

  if (isRestartCommand(lowered)) {
    if (!BOT_ENABLE_RESTART_COMMAND) {
      await sendMessage(chatId, "Restart command is disabled.");
      return;
    }
    await restartBotProcess(chatId, "chat");
    return;
  }

  if (lowered === "/projects" || lowered === "/project" || lowered === "/recent" || lowered === "/recentprojects") {
    await sendRecentProjectsPrompt(chatId);
    return;
  }

  const askMatch = /^\/ask(?:\s+([\s\S]+))?$/i.exec(text);
  if (askMatch) {
    const payload = String(askMatch[1] || "").trim();
    if (!payload) {
      await sendMessage(chatId, "Usage: /ask <text>");
      return;
    }
    await ensureCodexSessionForPrompt(chatId, payload);
    return;
  }

  if (activeRun && activeRun.mode === "codex_tmux") {
    const run = activeRun;

    if (lowered === "/status") {
      await handleStatus(chatId);
      return;
    }

    if (lowered === "/stopcodex" || lowered === "stop codex" || lowered === "/cancel") {
      await sendMessage(chatId, "Stop requested for codex session...");
      await requestCancelCodexRun(run, "cancel");
      return;
    }

    if (lowered === "/enter") {
      run.inputCount += 1;
      run.lastInputPreview = "[ENTER]";
      beginNewTurn(run, "manual-enter");
      await notifyTurnThinking(run);
      pushRunEvent(run, "manual /enter");
      await upsertCodexStatus(run, false);
      await submitWithFallback(run, "manual-enter");
      return;
    }

    if (text.startsWith("/raw ")) {
      const payload = text.slice(5);
      await sendCodexRaw(run, payload);
      return;
    }

    if (/^\/sh\b/i.test(normalized)) {
      await sendMessage(chatId, "Shell commands via /sh are only available when no codex session is running. Use /stopcodex first.");
      return;
    }

    if (normalized.startsWith("/")) {
      await sendMessage(chatId, "Unbekannter Befehl. Erlaubt: /stopcodex | /livecodex");
      return;
    }

    if (!text.length) return;

    await sendCodexInputLine(run, text);
    return;
  }

  if (lowered === "/status" || lowered === "status") {
    await handleStatus(chatId);
    return;
  }

  if (
    lowered === "/stopcodex" ||
    lowered === "stop codex" ||
    lowered === "/cancel" ||
    lowered === "cancel"
  ) {
    if (!activeRun) {
      await sendMessage(chatId, "No active session.");
      return;
    }
    if (activeRun.mode === "shell_command") {
      await sendMessage(chatId, "Stop requested. Sending Ctrl+C...");
      await cancelShellRun("cancel");
      return;
    }
    await sendMessage(chatId, "Stop requested for codex session...");
    await requestCancelCodexRun(activeRun, "cancel");
    return;
  }

  if (lowered === "/pwd" || lowered === "pwd") {
    if (activeRun) {
      await sendMessage(chatId, `Current CWD (last known): ${lastKnownCwd}`);
      return;
    }
    await startShellCommand(chatId, "pwd");
    return;
  }

  if (activeRun && activeRun.mode === "shell_command") {
    await sendMessage(chatId, "A shell command is already running. Use /stopcodex.");
    return;
  }

  if (!normalized) return;
  if (BOT_CODEX_BACKEND === "tmux" && isCodexCommand(normalized)) {
    await startCodexTmuxRun(chatId, normalized);
    return;
  }

  const intent = classifyInputIntent(text);
  if (intent.type === "shell_usage_error") {
    await sendMessage(chatId, "Usage: /sh <command>");
    return;
  }

  if (intent.type === "command") {
    await sendMessage(chatId, "Unbekannter Befehl. Nutz /startcodex, /stopcodex, /livecodex oder /restartbot.");
    return;
  }

  if (intent.type === "shell") {
    await startShellCommand(chatId, intent.command);
    return;
  }

  if (intent.type === "codex") {
    await ensureCodexSessionForPrompt(chatId, intent.prompt);
    return;
  }

  await startShellCommand(chatId, text);
  } catch (err) {
    finishCommandTrace(trace, "command_failed", { reason: "exception", error: trimErrorMessage(err) });
    await sendMessage(chatId, `Command failed (${trace.id}): ${trimErrorMessage(err)}`);
    return;
  } finally {
    finishCommandTrace(trace, "command_completed");
  }
});

console.log("Terminal bot started (Telegram primary).");
logNotionSyncStatus();
