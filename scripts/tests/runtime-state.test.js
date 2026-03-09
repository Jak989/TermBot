"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  acquireProcessLock,
  releaseProcessLock,
  writeJson,
  waitForReadyMarker,
} = require("../lib/runtime-state");

test("acquire/release lock blocks duplicates", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbot-lock-"));
  const lockPath = path.join(dir, "bot.lock");

  const first = acquireProcessLock(lockPath, { pid: process.pid, role: "test" });
  assert.equal(first.ok, true);

  const second = acquireProcessLock(lockPath, { pid: process.pid + 1000, role: "test-2" });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "already_locked");

  releaseProcessLock(lockPath, process.pid);
  const third = acquireProcessLock(lockPath, { pid: process.pid + 1001, role: "test-3" });
  assert.equal(third.ok, true);
});

test("waitForReadyMarker resolves when marker matches", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "termbot-ready-"));
  const readyFile = path.join(dir, "restart-ready.json");
  const restartId = "rst_test_123";

  setTimeout(() => {
    writeJson(readyFile, {
      pid: process.pid,
      restartId,
      ts: new Date().toISOString(),
    });
  }, 120);

  const result = await waitForReadyMarker(readyFile, {
    restartId,
    expectedPid: process.pid,
    timeoutMs: 1500,
    pollMs: 50,
  });

  assert.equal(result.ok, true);
  assert.equal(result.marker.restartId, restartId);
});
