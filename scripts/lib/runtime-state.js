"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function isPidAlive(pid) {
  const numeric = Number(pid);
  if (!Number.isSafeInteger(numeric) || numeric <= 0) return false;
  try {
    process.kill(numeric, 0);
    return true;
  } catch (_err) {
    return false;
  }
}

function readJson(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_err) {
    return fallback;
  }
}

function writeJson(filePath, payload) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (_err) {
    // ignore
  }
}

function acquireProcessLock(lockPath, meta = {}) {
  const pid = Number(meta.pid || process.pid);
  const payload = {
    pid,
    startedAt: new Date().toISOString(),
    ...meta,
  };

  ensureDir(lockPath);

  try {
    const fd = fs.openSync(lockPath, "wx", 0o644);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, lock: payload };
  } catch (err) {
    if (!err || err.code !== "EEXIST") {
      return { ok: false, reason: `lock_open_failed:${err?.message || "unknown"}` };
    }
  }

  const existing = readJson(lockPath, {});
  const existingPid = Number(existing?.pid || 0);
  if (existingPid > 0 && isPidAlive(existingPid) && existingPid !== pid) {
    return {
      ok: false,
      reason: "already_locked",
      existing,
    };
  }

  removeFile(lockPath);

  try {
    const fd = fs.openSync(lockPath, "wx", 0o644);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, lock: payload, replacedStaleLock: true };
  } catch (err) {
    return { ok: false, reason: `lock_recreate_failed:${err?.message || "unknown"}`, existing };
  }
}

function releaseProcessLock(lockPath, pid = process.pid) {
  const existing = readJson(lockPath, null);
  if (!existing) {
    removeFile(lockPath);
    return;
  }

  const existingPid = Number(existing?.pid || 0);
  if (existingPid > 0 && existingPid !== Number(pid)) {
    return;
  }

  removeFile(lockPath);
}

async function waitForReadyMarker(readyFilePath, options = {}) {
  const restartId = String(options.restartId || "").trim();
  const expectedPid = Number(options.expectedPid || 0);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(500, Number(options.timeoutMs)) : 15000;
  const pollMs = Number.isFinite(Number(options.pollMs)) ? Math.max(100, Number(options.pollMs)) : 250;
  const started = Date.now();

  while (Date.now() - started < timeoutMs) {
    const marker = readJson(readyFilePath, null);
    if (marker) {
      const markerRestartId = String(marker.restartId || "").trim();
      const markerPid = Number(marker.pid || 0);
      const restartIdOk = restartId ? markerRestartId === restartId : true;
      const pidOk = expectedPid > 0 ? markerPid === expectedPid : markerPid > 0;
      if (restartIdOk && pidOk && isPidAlive(markerPid)) {
        return { ok: true, marker };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }

  return { ok: false, reason: "timeout" };
}

module.exports = {
  isPidAlive,
  readJson,
  writeJson,
  removeFile,
  acquireProcessLock,
  releaseProcessLock,
  waitForReadyMarker,
};
