"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    return JSON.parse(trimmed);
  } catch (_err) {
    return null;
  }
}

function consumeLines(buffer, onLine) {
  let next = buffer;
  for (;;) {
    const idx = next.indexOf("\n");
    if (idx === -1) break;
    const line = next.slice(0, idx);
    next = next.slice(idx + 1);
    onLine(line);
  }
  return next;
}

function buildArgs(options) {
  if (options.threadId) {
    const args = ["exec", "resume", "--json", "--skip-git-repo-check", "-o", options.outputFile];
    if (options.model) {
      args.push("-m", options.model);
    }
    if (options.yolo) {
      args.push("--dangerously-bypass-approvals-and-sandbox");
    }
    args.push(options.threadId, options.prompt);
    return args;
  }

  const args = ["exec", "--json", "--skip-git-repo-check", "-C", options.cwd, "-o", options.outputFile];

  if (options.useOss) {
    args.push("--oss");
    if (options.localProvider) {
      args.push("--local-provider", options.localProvider);
    }
  }

  if (options.model) {
    args.push("-m", options.model);
  }

  if (options.yolo) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  }

  args.push(options.prompt);
  return args;
}

function runCodexTurn(options) {
  const outDir = options.outputDir;
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(options.codexHome, { recursive: true });

  const outputFile = path.join(
    outDir,
    `last-message-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`
  );

  const args = buildArgs({
    threadId: options.threadId,
    cwd: options.cwd,
    outputFile,
    prompt: options.prompt,
    model: options.model,
    yolo: Boolean(options.yolo),
    useOss: Boolean(options.useOss),
    localProvider: options.localProvider || "",
  });

  const env = {
    ...process.env,
    CODEX_HOME: options.codexHome,
  };

  const child = spawn(options.codexBin || "codex", args, {
    cwd: options.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const errors = [];
  const stderrLines = [];
  const nonJsonStdout = [];
  let stdoutBuffer = "";
  let threadId = options.threadId || null;
  let cancelRequested = false;
  let finished = false;
  let cancelTimer = null;

  const mark = (msg) => {
    if (typeof options.onLog === "function") {
      options.onLog(msg);
    }
  };

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf8");
    stdoutBuffer = consumeLines(stdoutBuffer, (line) => {
      const event = parseJsonLine(line);
      if (!event) {
        if (line.trim()) nonJsonStdout.push(line.trim());
        return;
      }

      if (event.type === "thread.started" && event.thread_id) {
        threadId = event.thread_id;
      }

      if (event.type === "error" && event.message) {
        errors.push(event.message);
      }
    });
  });

  child.stderr.on("data", (chunk) => {
    const lines = chunk
      .toString("utf8")
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean);
    stderrLines.push(...lines);
  });

  child.on("error", (err) => {
    mark(`failed to spawn codex: ${err.message}`);
  });

  const promise = new Promise((resolve) => {
    child.on("close", (exitCode, signal) => {
      finished = true;
      if (cancelTimer) clearTimeout(cancelTimer);

      let message = "";
      try {
        if (fs.existsSync(outputFile)) {
          message = fs.readFileSync(outputFile, "utf8").trim();
        }
      } catch (_err) {
        // ignore output file read failures and rely on stderr/error events
      } finally {
        try {
          fs.unlinkSync(outputFile);
        } catch (_err) {
          // ignore cleanup failures
        }
      }

      resolve({
        exitCode: typeof exitCode === "number" ? exitCode : null,
        signal: signal || null,
        threadId,
        message,
        errors,
        stderr: stderrLines,
        notes: nonJsonStdout,
        canceled: cancelRequested,
        command: [options.codexBin || "codex", ...args].join(" "),
      });
    });
  });

  function cancel() {
    if (finished) return false;
    cancelRequested = true;

    try {
      child.kill("SIGINT");
    } catch (_err) {
      return false;
    }

    cancelTimer = setTimeout(() => {
      if (finished) return;
      try {
        child.kill("SIGKILL");
      } catch (_err) {
        // best effort
      }
    }, Number(options.cancelFallbackMs || 2500));

    return true;
  }

  return {
    promise,
    cancel,
    child,
  };
}

module.exports = {
  runCodexTurn,
};
