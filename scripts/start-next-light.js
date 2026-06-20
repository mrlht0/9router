const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = process.cwd();
const standaloneCustomServer = path.join(root, ".next", "standalone", "custom-server.js");
const standaloneServer = path.join(root, ".next", "standalone", "server.js");

let command;
let args;
let cwd = root;

if (fs.existsSync(standaloneCustomServer)) {
  command = process.execPath;
  args = [standaloneCustomServer];
  cwd = path.dirname(standaloneCustomServer);
} else if (fs.existsSync(standaloneServer)) {
  command = process.execPath;
  args = [standaloneServer];
  cwd = path.dirname(standaloneServer);
} else {
  command = process.platform === "win32" ? "npx.cmd" : "npx";
  args = ["next", "start"];
}

const maxOldSpace = process.env.NODE_MAX_OLD_SPACE_MB || "512";
const env = {
  ...process.env,
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--max-old-space-size=${maxOldSpace}`]
    .filter(Boolean)
    .join(" "),
};

const child = spawn(command, args, {
  stdio: "inherit",
  env,
  cwd,
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

child.on("error", (error) => {
  console.error("[start:light] failed:", error.message);
  process.exit(1);
});
