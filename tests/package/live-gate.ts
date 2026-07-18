export function classifyLiveGate(value: string | undefined): "skip" | "run" | "invalid" {
  if (value === undefined || value === "" || value === "0") return "skip";
  if (value === "1") return "run";
  return "invalid";
}

export function classifyArtifactRetention(
  value: string | undefined,
  liveGate: "skip" | "run" | "invalid",
): "cleanup" | "keep" | "invalid" {
  if (value === undefined || value === "" || value === "0") return "cleanup";
  if (value === "1" && liveGate === "run") return "keep";
  return "invalid";
}
