import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (pidFile === undefined) {
  throw new Error("pid file is required");
}

const descendant = spawn(
  process.execPath,
  [
    "-e",
    'process.on("SIGTERM", () => {}); process.send("ready"); setInterval(() => {}, 1_000);',
  ],
  { stdio: ["ignore", "ignore", "ignore", "ipc"] },
);
if (descendant.pid === undefined) {
  throw new Error("descendant pid is unavailable");
}
await new Promise((resolve) => descendant.once("message", resolve));

writeFileSync(pidFile, String(descendant.pid), "utf8");
descendant.disconnect();
descendant.unref();
console.log(
  JSON.stringify({
    type: "artifact.ready",
    path: "out.txt",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  }),
);
