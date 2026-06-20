const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = process.cwd();
const safeHome = path.join(root, ".build-home");
const safeAppData = path.join(safeHome, "AppData", "Roaming");
const safeLocalAppData = path.join(safeHome, "AppData", "Local");

for (const dir of [safeHome, safeAppData, safeLocalAppData]) {
  fs.mkdirSync(dir, { recursive: true });
}

const env = {
  ...process.env,
  HOME: safeHome,
  USERPROFILE: safeHome,
  APPDATA: safeAppData,
  LOCALAPPDATA: safeLocalAppData,
};

const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextBin, "build", "--webpack"], {
  stdio: "inherit",
  env,
  cwd: root,
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
