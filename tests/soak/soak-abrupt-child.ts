import { createSoakProfile, runSoakHarness, type SoakAbruptPoint } from "../../src/soak/soak-harness.js";

const [root, privateKeyPath, trustedPublicKeySha256, abruptPoint, resume] = process.argv.slice(2);
if (root === undefined || privateKeyPath === undefined || trustedPublicKeySha256 === undefined || abruptPoint === undefined) {
  throw new Error("abrupt soak child arguments are incomplete");
}
const config = createSoakProfile("ci", { seed: "abrupt-matrix", workerCount: 20,
  signing: { privateKeyPath, trustedPublicKeySha256 } });
await runSoakHarness({ root, config, resume: resume === "true", abruptPoint: abruptPoint as SoakAbruptPoint,
  abruptMode: "sigkill" });
