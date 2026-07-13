import { writeFileSync } from "node:fs";

const pidFile = process.argv[2];
if (pidFile === undefined) {
  throw new Error("pid file is required");
}

writeFileSync(pidFile, String(process.pid), "utf8");
setInterval(() => {}, 1_000);
