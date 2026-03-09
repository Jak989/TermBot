"use strict";

const path = require("path");
const { readJson, isPidAlive } = require("./lib/runtime-state");

const PROJECT_ROOT = path.resolve(__dirname, "..");
const RUNTIME_DIR = path.join(PROJECT_ROOT, "data", "runtime");
const BOT_LOCK = path.join(RUNTIME_DIR, "bot.lock");
const SUP_PID = path.join(RUNTIME_DIR, "supervisor.pid");
const READY = path.join(RUNTIME_DIR, "restart-ready.json");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseArgs(argv) {
  const out = {};
  for (const item of argv) {
    if (!item.startsWith("--")) continue;
    const idx = item.indexOf("=");
    if (idx < 0) {
      out[item.slice(2)] = "1";
      continue;
    }
    out[item.slice(2, idx)] = item.slice(idx + 1);
  }
  return out;
}

function readPid(filePath) {
  const payload = readJson(filePath, null);
  const pid = Number(payload?.pid || 0);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
}

async function waitForRestart(oldPid, oldMarkerTs, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const botPid = readPid(BOT_LOCK);
    const marker = readJson(READY, null);
    const markerTs = marker?.ts || "";
    const switchedPid = botPid > 0 && botPid !== oldPid && isPidAlive(botPid);
    const markerAdvanced = Boolean(markerTs && markerTs !== oldMarkerTs && Number(marker?.pid || 0) === botPid);
    if (switchedPid && markerAdvanced) {
      return { ok: true, pid: botPid, markerTs };
    }
    await sleep(250);
  }
  return { ok: false };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const count = Number.isFinite(Number(args.count)) ? Math.max(1, Number(args.count)) : 10;
  const timeoutMs = Number.isFinite(Number(args.timeout)) ? Math.max(2000, Number(args.timeout)) : 20000;

  const supervisorPid = readPid(SUP_PID);
  if (!supervisorPid || !isPidAlive(supervisorPid)) {
    console.error("restart-test: supervisor is not running (expected data/runtime/supervisor.pid).");
    process.exit(1);
  }

  console.log(`restart-test: supervisor pid=${supervisorPid}, cycles=${count}, timeout=${timeoutMs}ms`);

  for (let i = 1; i <= count; i += 1) {
    const currentBotPid = readPid(BOT_LOCK);
    const marker = readJson(READY, null);
    const markerTs = marker?.ts || "";

    if (!currentBotPid || !isPidAlive(currentBotPid)) {
      console.error(`restart-test: cycle ${i} failed, bot pid missing/alive=false`);
      process.exit(1);
    }

    process.kill(currentBotPid, "SIGTERM");
    const waited = await waitForRestart(currentBotPid, markerTs, timeoutMs);
    if (!waited.ok) {
      console.error(`restart-test: cycle ${i} failed, no healthy replacement within timeout`);
      process.exit(1);
    }

    console.log(`cycle ${i}/${count}: old=${currentBotPid} new=${waited.pid} marker=${waited.markerTs}`);
  }

  console.log("restart-test: OK");
}

main().catch((err) => {
  console.error(`restart-test crashed: ${err?.message || err}`);
  process.exit(1);
});
