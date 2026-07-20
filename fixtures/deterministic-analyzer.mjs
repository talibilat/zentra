import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
const requests = [];
for await (const line of lines) requests.push(line);
if (requests.length !== 1) process.exit(2);

const request = JSON.parse(requests[0]);
const encoded = JSON.stringify(request);
if (process.env.ANALYSIS_SECRET_CANARY !== undefined) process.exit(3);
if (/"(?:repositoryPath|workspacePath|writerPath|toolPath)"/.test(encoded)) process.exit(4);
if (request.securityBoundary?.authority !== "none" || request.securityBoundary?.effects !== "none") process.exit(5);
if (Object.keys(request.securityBoundary?.environment ?? {}).length !== 0) process.exit(6);
if ((request.securityBoundary?.tools ?? []).length !== 0 || (request.securityBoundary?.secrets ?? []).length !== 0) process.exit(7);

const source = request.sources[0];
if (source?.quotedText.includes("__WAIT__")) await new Promise(() => undefined);
if (source?.quotedText.includes("__OVERSIZE__")) {
  process.stdout.write("x".repeat(1024 * 1024));
  process.exit(0);
}

const first = request.answers.length === 0;
const result = first ? {
  observations: [{
    observationId: "obs-api",
    summary: "The retained source and repository observations leave API and wording choices open.",
    sourceIds: [source.sourceId],
    repositoryPaths: ["src/index.ts"],
    affectedScopes: ["scope:api"],
  }],
  uncertainties: [
    {
      uncertaintyId: "api-policy",
      question: "Should source compatibility be preserved?",
      materiality: "material",
      affectedScopes: ["scope:api"],
      dependentScopes: ["scope:api-tests"],
      options: [
        { optionId: "breaking", label: "Permit a breaking API", impacts: ["Consumers must migrate"] },
        { optionId: "compatible", label: "Preserve source compatibility", impacts: ["Current consumers continue"] },
      ],
      recommendation: { optionId: "compatible", rationale: "No migration authority was provided." },
    },
    {
      uncertaintyId: "wording",
      question: "Which internal name should be used?",
      materiality: "advisory",
      affectedScopes: ["scope:wording"],
      dependentScopes: [],
      options: [{ optionId: "coordinator", label: "Use coordinator", impacts: ["No behavior changes"] }],
      recommendation: { optionId: "coordinator", rationale: "It matches the component role." },
    },
  ],
  usage: { inputTokens: 120, outputTokens: 180, outputBytes: 0, durationMs: 0, costUsdNano: 0 },
} : {
  observations: [{
    observationId: source?.quotedText.includes("__DUPLICATE_ID__") ? "obs-api" : "obs-resolved",
    summary: "The durable answer resolves all material uncertainty.",
    sourceIds: [source.sourceId],
    repositoryPaths: [],
    affectedScopes: ["scope:api"],
  }],
  uncertainties: [],
  usage: { inputTokens: 80, outputTokens: 40, outputBytes: 0, durationMs: 0, costUsdNano: 0 },
};
if (source?.quotedText.includes("__OVER_BUDGET__")) result.usage.inputTokens = 5_000;
process.stdout.write(`${JSON.stringify(result)}\n`);
