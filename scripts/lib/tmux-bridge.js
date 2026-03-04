"use strict";

const { execFile } = require("child_process");

function run(tmuxBin, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);
  return new Promise((resolve, reject) => {
    execFile(
      tmuxBin,
      args,
      {
        encoding: "utf8",
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
      },
      (error, stdout, stderr) => {
        if (error) {
          error.stdout = stdout || "";
          error.stderr = stderr || "";
          reject(error);
          return;
        }
        resolve({
          stdout: stdout || "",
          stderr: stderr || "",
        });
      }
    );
  });
}

function isNoSessionError(err) {
  const text = `${err?.message || ""}\n${err?.stderr || ""}`.toLowerCase();
  return text.includes("can't find session") || text.includes("no server running");
}

async function hasSession(tmuxBin, sessionName) {
  try {
    await run(tmuxBin, ["has-session", "-t", sessionName]);
    return true;
  } catch (err) {
    if (isNoSessionError(err)) return false;
    throw err;
  }
}

async function listSessions(tmuxBin) {
  try {
    const result = await run(tmuxBin, ["list-sessions", "-F", "#{session_name}"]);
    return result.stdout
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    if (isNoSessionError(err)) return [];
    throw err;
  }
}

async function killSession(tmuxBin, sessionName) {
  try {
    await run(tmuxBin, ["kill-session", "-t", sessionName]);
  } catch (err) {
    if (isNoSessionError(err)) return false;
    throw err;
  }
  return true;
}

async function cleanupSessionsByPrefix(tmuxBin, prefix) {
  const sessions = await listSessions(tmuxBin);
  const stale = sessions.filter((name) => name.startsWith(prefix));
  for (const name of stale) {
    await killSession(tmuxBin, name);
  }
  return stale;
}

async function startSession(tmuxBin, sessionName, cwd, command) {
  await run(tmuxBin, ["new-session", "-d", "-s", sessionName, "-c", cwd, command]);
}

async function sendKeys(tmuxBin, sessionName, keys) {
  const list = Array.isArray(keys) ? keys.filter((k) => typeof k === "string" && k.length > 0) : [];
  if (list.length === 0) return;
  await run(tmuxBin, ["send-keys", "-t", sessionName, ...list]);
}

async function sendLiteral(tmuxBin, sessionName, text) {
  await run(tmuxBin, ["set-buffer", "--", text]);
  await run(tmuxBin, ["paste-buffer", "-d", "-t", sessionName]);
}

async function interrupt(tmuxBin, sessionName) {
  await sendKeys(tmuxBin, sessionName, ["C-c"]);
}

async function capturePane(tmuxBin, sessionName, lines = 120) {
  const safeLines = Number.isFinite(lines) ? Math.max(20, Math.min(500, lines)) : 120;
  const result = await run(tmuxBin, [
    "capture-pane",
    "-p",
    "-t",
    sessionName,
    "-J",
    "-S",
    `-${safeLines}`,
  ]);
  return result.stdout;
}

module.exports = {
  run,
  hasSession,
  listSessions,
  killSession,
  cleanupSessionsByPrefix,
  startSession,
  sendKeys,
  sendLiteral,
  interrupt,
  capturePane,
};
