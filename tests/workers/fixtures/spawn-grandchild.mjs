// Test helper: spawns a long-lived grandchild in the same process group,
// records its pid, then waits until terminated. Used to prove the supervisor
// kills the entire process group, not just the direct child.
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
const mode = process.argv[3] ?? "wait";
if (!pidFile) {
  console.error("spawn-grandchild: missing pid file argument");
  process.exit(1);
}

const grandchildScript =
  mode === "exceed-output"
    ? 'process.stdout.write("x".repeat(4096)); setInterval(() => {}, 1000);'
    : "setInterval(() => {}, 1000);";

const grandchild = spawn(
  process.execPath,
  ["-e", grandchildScript],
  { stdio: "inherit" },
);

writeFileSync(pidFile, String(grandchild.pid));
console.log(JSON.stringify({ type: "grandchild.spawned", pid: grandchild.pid }));

setInterval(() => {}, 1000);
