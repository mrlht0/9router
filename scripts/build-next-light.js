const { spawnSync } = require("node:child_process");

const env = {
  ...process.env,
  NEXT_STANDALONE: "1",
};

const result = spawnSync(process.execPath, ["scripts/build-next-safe.js"], {
  stdio: "inherit",
  env,
});

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
