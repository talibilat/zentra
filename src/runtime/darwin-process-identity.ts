import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

const PS_EXECUTABLE = "/bin/ps";

export function inspectDarwinProcessStartIdentity(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("process identity PID is invalid");
  const result = spawnSync(PS_EXECUTABLE, ["-p", String(pid), "-o", "lstart=", "-o", "uid=", "-o", "ucomm="], {
    shell: false, env: { LANG: "C", LC_ALL: "C" }, encoding: "utf8", timeout: 5_000, maxBuffer: 16 * 1024,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 1 && result.stdout.trim() === "") return null;
  if (result.status !== 0) throw new Error("process start identity inspection failed");
  const fields = result.stdout.trim().replace(/\s+/g, " ").split(" ");
  if (fields.length < 7 || !/^\d{1,2}$/.test(fields[2] ?? "") ||
    !/^\d{2}:\d{2}:\d{2}$/.test(fields[3] ?? "") || !/^\d{4}$/.test(fields[4] ?? "") ||
    !/^\d+$/.test(fields[5] ?? "")) throw new Error("process start identity evidence is malformed");
  const evidence = JSON.stringify({ startTime: fields.slice(0, 5).join(" "), uid: fields[5],
    executableName: fields.slice(6).join(" ") });
  return `darwin-ps-v1:${createHash("sha256").update(evidence).digest("hex")}`;
}

export function classifyDarwinProcessIdentity(pid: number, expected: string): "alive" | "dead" | "replaced" | "unknown" {
  try {
    const current = inspectDarwinProcessStartIdentity(pid);
    return current === null ? "dead" : current === expected ? "alive" : "replaced";
  } catch { return "unknown"; }
}
