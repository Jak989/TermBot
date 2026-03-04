"use strict";

const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function defaultState(overrides = {}) {
  return {
    activeThreadId: null,
    running: false,
    lastUsedAt: null,
    cwd: "",
    model: "",
    ...overrides,
  };
}

function loadState(filePath, defaults = {}) {
  const base = defaultState(defaults);

  if (!fs.existsSync(filePath)) {
    return base;
  }

  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...base,
      ...parsed,
      running: false,
    };
  } catch (_err) {
    return base;
  }
}

function saveState(filePath, state) {
  ensureDir(path.dirname(filePath));
  const tempFile = `${filePath}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempFile, filePath);
}

module.exports = {
  ensureDir,
  defaultState,
  loadState,
  saveState,
};
