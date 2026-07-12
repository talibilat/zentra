import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
const leaderExitFile = process.argv[3];
const descendantTerminationFile = process.argv[4];
if (pidFile === undefined || leaderExitFile === undefined || descendantTerminationFile === undefined) {
  throw new Error("pid, leader exit, and descendant termination files are required");
}

const descendant = spawn(
  process.execPath,
  [
    "-e",
    `
      const { writeFileSync } = require("node:fs");
      process.on("SIGTERM", () => {
        writeFileSync(process.argv[1], process.hrtime.bigint().toString(), "utf8");
        process.exit(0);
      });
      setInterval(() => {}, 1_000);
    `,
    descendantTerminationFile,
  ],
  { stdio: "inherit" },
);
if (descendant.pid === undefined) {
  throw new Error("descendant pid is unavailable");
}
descendant.unref();

writeFileSync(pidFile, String(descendant.pid), "utf8");
process.on("exit", () => {
  writeFileSync(leaderExitFile, process.hrtime.bigint().toString(), "utf8");
});
console.log(
  JSON.stringify({
    type: "artifact.ready",
    path: "out.txt",
    sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  }),
);
