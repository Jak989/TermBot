const fs = require("fs");
const path = require("path");

function makeExecutable(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const stat = fs.statSync(filePath);
  const mode = stat.mode & 0o777;
  const newMode = mode | 0o111;
  if (newMode !== mode) {
    fs.chmodSync(filePath, newMode);
  }
  return true;
}

function main() {
  const root = process.cwd();
  const nodePtyRoot = path.join(root, "node_modules", "node-pty");
  if (!fs.existsSync(nodePtyRoot)) return;

  const candidates = [
    path.join(nodePtyRoot, "build", "Release", "spawn-helper"),
    path.join(nodePtyRoot, "prebuilds", "darwin-arm64", "spawn-helper"),
    path.join(nodePtyRoot, "prebuilds", "darwin-x64", "spawn-helper"),
    path.join(nodePtyRoot, "prebuilds", "linux-x64", "spawn-helper"),
    path.join(nodePtyRoot, "prebuilds", "linux-arm64", "spawn-helper"),
  ];

  let changed = 0;
  for (const candidate of candidates) {
    try {
      if (makeExecutable(candidate)) {
        changed += 1;
      }
    } catch (err) {
      console.warn(`[fix-node-pty-perms] Could not update ${candidate}: ${err.message}`);
    }
  }

  if (changed > 0) {
    console.log(`[fix-node-pty-perms] checked ${changed} spawn-helper binaries`);
  }
}

main();
