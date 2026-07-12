import { spawn } from "node:child_process";

spawn(
  process.execPath,
  [
    "-e",
    'setTimeout(() => process.stdout.write("x".repeat(4096)), 100); setTimeout(() => process.exit(0), 200);',
  ],
  { stdio: "inherit" },
);

process.exit(0);
