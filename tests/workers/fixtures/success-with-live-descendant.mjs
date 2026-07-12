import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (pidFile === undefined) {
  throw new Error("pid file is required");
}

const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
  stdio: "ignore",
});
if (descendant.pid === undefined) {
  throw new Error("descendant pid is unavailable");
}
descendant.unref();

writeFileSync(pidFile, String(descendant.pid), "utf8");
console.log(JSON.stringify({ type: "worker.completed" }));
