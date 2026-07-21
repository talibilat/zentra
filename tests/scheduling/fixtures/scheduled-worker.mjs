import { appendFileSync } from "node:fs";

const [marker, taskId, mode = "effect"] = process.argv.slice(2);
if (!marker || !taskId || !["effect", "delay", "wait"].includes(mode)) process.exit(64);

const effect = () => {
  appendFileSync(marker, `${JSON.stringify({
    taskId,
    pid: process.pid,
    secretInherited: process.env.ZENTRA_SECRET_CANARY !== undefined,
  })}\n`, "utf8");
};

if (mode === "wait") {
  setInterval(() => {}, 1_000);
} else if (mode === "delay") {
  setTimeout(effect, 200);
} else {
  effect();
}
