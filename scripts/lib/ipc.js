"use strict";

const net = require("net");

function encodeMessage(value) {
  return `${JSON.stringify(value)}\n`;
}

function parseMessage(line) {
  if (!line || !line.trim()) return null;
  return JSON.parse(line);
}

function sendRequest(socketPath, request, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 0);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let buffer = "";

    const socket = net.createConnection(socketPath);

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.removeAllListeners();
      socket.end();
      socket.destroy();
      if (err) {
        reject(err);
        return;
      }
      resolve(value);
    };

    socket.on("connect", () => {
      socket.write(encodeMessage(request));
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      const line = buffer.slice(0, newlineIdx);
      try {
        const response = parseMessage(line);
        finish(null, response);
      } catch (err) {
        finish(new Error(`Invalid response from daemon: ${err.message}`));
      }
    });

    socket.on("error", (err) => {
      finish(err);
    });

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        finish(new Error(`IPC request timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }
  });
}

module.exports = {
  encodeMessage,
  parseMessage,
  sendRequest,
};
