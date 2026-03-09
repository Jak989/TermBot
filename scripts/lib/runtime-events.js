"use strict";

const fs = require("fs");
const path = require("path");

function appendRuntimeEvent(filePath, event) {
  const payload = {
    ts: new Date().toISOString(),
    ...event,
  };

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (_err) {
    // ignore logging failures
  }
}

module.exports = {
  appendRuntimeEvent,
};
