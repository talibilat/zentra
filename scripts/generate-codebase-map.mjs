import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(root, "docs/codebase-map.html");
const sourceRoots = ["src", "scripts", "fixtures", "tests"];

const featureDefinitions = [
  ["entrypoints", "Entrypoints & CLI", "Typed command and package entrypoints", "CLI argv, project JSON, policy sheets, provider configuration, and programmatic requests.", "Bounded JSON results, stable exit codes, or typed library values.", "Commander validates input, composes internal services, and maps domain outcomes without exposing a shell."],
  ["contracts", "Contracts & schemas", "The vocabulary every boundary shares", "Untrusted JSON-like values, identifiers, evidence, budgets, and lifecycle payloads.", "Parsed immutable domain values or a fail-closed validation error.", "Zod schemas and TypeScript contracts define canonical states, digests, authority packets, and terminal outcomes."],
  ["journal", "Event journal", "Authoritative durable state and explicit retention", "Expected stream version, ordered events, or an exact audited maintenance request.", "Stable stored events, SQLite-anchored immutable archive manifests, verified replay, or explicit maintenance evidence.", "SQLite anchors journal identity and archive head, durable operation states serialize effects, bounded segment scans compose archived and active history, and prune requires verified overlap, cursor safety, and exact irreversible confirmation."],
  ["tasks", "Tasks & artifacts", "One schedulable unit and its evidence chain", "Task identity and lifecycle or artifact events.", "A validated TaskView and digest-bound ArtifactView.", "Pure projections reject impossible transitions, post-terminal writes, stale evidence, and incomplete cleanup."],
  ["milestones", "Milestones & planning", "Dependency plans, admission, replanning, and completion", "A milestone plan, role assignments, authority envelope, budgets, and retained evidence.", "A replayed MilestoneRecord, readiness decision, pause, revision, or terminal result.", "The registry appends decisions before effects and verifies completion from retained task and integration evidence."],
  ["policy", "Policy & authority", "Cross-cutting authority plane", "Model/security Markdown, role request, risk, network, repository, and effect scope.", "An approved capability binding, denial, or explicit attention boundary.", "Policy narrows authority; reasoning, installation, and role labels never grant execution authority."],
  ["workers", "Workers & supervision", "Bounded process and worker lifecycles", "Executable plus argv, exact cwd, timeout, minimal environment, and abort signal.", "Canonical outcome, bounded output, native events, usage, and cleanup evidence.", "Direct spawn with shell disabled supervises process groups and maps timeout, cancellation, and failure deterministically."],
  ["agents", "OpenCode agents", "Read-only reasoning and writer evidence adapters", "Admitted task packets, repository snapshot, role binding, model selection, and budgets.", "Sanitized native-event evidence, a role result, or an explicit pause/uncertain outcome.", "Adapters separate agent reasoning from repository, model transport, network, and host effect authority."],
  ["harnesses", "OpenCode harnesses", "Attestation, probing, and host writer invocation", "Canonical executable identity, fixed model, task packet, and isolated worktree.", "Attestation, capability probe, or digest-bound writer report.", "The writer may edit only owned paths; dangerous OpenCode tools and arbitrary environment inheritance are denied."],
  ["capsule", "Capsules & effects", "Docker containment, model protocol, and GitHub effects", "Exact image/runtime/policy identities, broker messages, or one-use GitHub grants.", "Conformance evidence, model receipts, uncertain effect records, or reconciled external state.", "Read-only agents run network-dark in Docker; model, research, and GitHub effects cross separate governed host brokers."],
  ["providers", "Model provider", "Azure OpenAI transport boundary", "Deployment-bound model request, token/cost limits, tools, and an explicit credential variable name.", "Streaming text/tool receipt with usage, cost, provider identity, and canonical outcome.", "The broker validates origin and DNS, pins addresses, bounds SSE, and records uncertainty after ambiguous dispatch."],
  ["research", "Governed research", "One policy-checked web retrieval capability", "GET/HEAD URL, exact origin/path policy, budgets, and abort signal.", "Bounded content for the active turn plus retained digest and provenance evidence.", "Every redirect is reauthorized; raw content is not journaled, and ambiguous dispatched failures become uncertain."],
  ["projects", "Project registry", "Trusted-project configuration and executable identity", "Absolute repository/worktree paths, integration branch, and canonical validation/release argv.", "A validated ProjectConfig selected by project identity.", "Only the approved canonical Node executable identity is accepted for configured validations and release steps."],
  ["runtime", "Repository runtime", "Repository-local bootstrap and atomic service discovery", "A descendant path, fixed local layout, process identity, loopback address, and token-expiry metadata.", "A restrictive initialized layout, one elected owner, machine-readable runtime state, and performed-versus-reconciled discovery/publication evidence.", "Canonical Git discovery and inode-bound fixed helpers use Darwin lockf only for serialization, per-acquisition HMAC capabilities scoped to runtime path/inode identity, one-use request packets, no-follow descriptors, fsync, atomic rename, caller ancestry, and conservative PID evidence. Identity checks reject deterministic replacement before effects but are not an OS sandbox against malicious same-user races."],
  ["workspaces", "Git & worktrees", "Isolated writable state and ownership enforcement", "Project config, safe task identity, exact base commit, and owned/forbidden paths.", "Workspace lease, inspected diff, reviewed commit, cleanup observation, or explicit uncertainty.", "Hardened Git argv operations create, inspect, retain, commit, and remove worktrees without arbitrary shell access."],
  ["validation", "Validation", "Named evidence-producing checks", "Project's focused/full command, canonical cwd, subject digest, timeout, and abort signal.", "Provenance-branded ValidationReport with argv/output digests and canonical outcome.", "Only configured exact executables run with minimal environment; reports bind review and integration to the tested subject."],
  ["reviews", "Independent review", "Digest-bound decision gate", "Worker/reviewer identities, exact nonempty diff, verified focused validation, and optional untrusted guidance.", "Verified approval/denial with diff and validation digests.", "Self-review, stale evidence, malformed model responses, and failed validation are rejected before integration."],
  ["integration", "Integration queue", "Serialized candidate validation and ref update", "Workspace lease, verified review, project identity, and abort signal.", "Prepared/final IntegrationReceipt or known/uncertain failure.", "A disposable candidate merges and fully validates first; compare-and-swap updates the integration ref only afterward."],
  ["orchestration", "Orchestration", "End-to-end deterministic and OpenCode workflows", "Typed ticket or milestone request, policy, roles, budgets, paths, and cancellation.", "Evidence-backed TaskView or MilestoneRecord with one canonical terminal outcome.", "Coordinators append intent before every effect and connect worktrees, agents, validation, review, integration, cleanup, and recovery."],
  ["routing", "Model routing", "Approved capability and outcome-aware selection", "Model sheet, role/harness/tool/network requirements, context need, and retained outcome history.", "One auditable model selection followed by a retained outcome observation.", "Routing uses sheet order until enough evidence exists, then ranks smoothed quality, sample count, and duration."],
  ["release", "Local release", "Exact-commit build/package/verify preparation", "Verified integrated commit and project release preparation configuration.", "Artifact hashes and a local-only release result paused before remote authority.", "A detached exact-commit worktree runs approved steps and proves repository refs remain unchanged."],
  ["observability", "Agent Tail", "Redacted rebuildable operational projection", "Stored journal events.", "Append-only trace/span/actor JSONL records with sensitive fields removed.", "Projection failure never rolls back authoritative journal state; output paths are new safe children of the journal directory."],
  ["tooling", "Build & package", "Hardened deterministic package production", "Repository sources, package policy, canonical tools, umasks, and output bounds.", "Verified dist manifest and reproducible npm archive contents.", "Scripts reject symlinks and path escapes, normalize modes, hash inputs/outputs, and run tools with minimal environments."],
  ["fixtures", "Deterministic fixtures", "Model-free end-to-end execution simulation", "Absolute workspace, one safe root-level filename, and content.", "One artifact.ready JSON event, deterministic waiting, or failure.", "The bundled worker uses no-follow writes and simulates success, cancellation, and timeout without LLM inference."],
  ["tests", "Verification", "Unit, real-process, real-Git, package, Docker, and live gates", "Temporary repositories, fixture processes, injected transports, and gated environment configuration.", "Fresh behavior evidence and regression failures.", "Vitest exercises contracts through E2E flows; Docker and authenticated Azure/OpenCode acceptance remain explicitly gated."],
].map(([id, name, purpose, input, output, process]) => ({ id, name, purpose, input, output, process }));

const featureByDirectory = new Map([
  ["cli", "entrypoints"], ["contracts", "contracts"], ["journal", "journal"], ["tasks", "tasks"],
  ["milestones", "milestones"], ["policy", "policy"], ["workers", "workers"], ["agents", "agents"],
  ["harnesses", "harnesses"], ["capsule", "capsule"], ["providers", "providers"], ["research", "research"],
  ["projects", "projects"], ["workspaces", "workspaces"], ["capabilities", "validation"], ["reviews", "reviews"],
  ["integration", "integration"], ["orchestration", "orchestration"], ["routing", "routing"], ["release", "release"],
  ["observability", "observability"], ["runtime", "runtime"], ["fixtures", "fixtures"],
]);

const flows = [
  {
    id: "deterministic", name: "Deterministic tracer bullet", summary: "The closest E2E reproduction of the original local MVP, with no model inference.",
    steps: [
      ["Accept ticket", "TracerBulletOrchestrator.run", "Typed task, safe file, content, worker/reviewer IDs", "task.created and integration-branch intent", "src/orchestration/tracer-bullet.ts"],
      ["Create workspace", "WorktreeManager.create", "ProjectConfig and task ID", "Isolated ticket branch lease", "src/workspaces/worktree-manager.ts"],
      ["Simulate writer", "ProcessSupervisor.execute", "Bundled deterministic worker argv", "artifact.ready plus worktree diff", "src/workers/process-supervisor.ts"],
      ["Validate", "ValidationRunner.run", "Focused configured command and diff subject", "Verified ValidationReport", "src/capabilities/validation-runner.ts"],
      ["Review", "ProcessReviewerAdapter.review -> ReviewGate.verify", "Diff, validation, independent identities", "Digest-bound approval", "src/reviews/reviewer-adapter.ts"],
      ["Integrate", "IntegrationQueue.integrate", "Committed source and verified review", "Fully validated compare-and-swap receipt", "src/integration/integration-queue.ts"],
      ["Complete", "TaskService.append", "Cleanup and integration observations", "terminal/completed TaskView", "src/tasks/task-service.ts"],
    ],
  },
  {
    id: "installed", name: "Installed four-role milestone", summary: "Planner, researcher, implementer, and reviewer run through separated authority boundaries.",
    steps: [
      ["Plan admission", "InstalledMilestoneRunner.run", "Goal, exact file, sheets, provider, OpenCode attestation", "Fixed four-role plan and authority envelope", "src/orchestration/installed-milestone.ts"],
      ["Route models", "routeApprovedModel", "Role requirements and outcome history", "Durable approved selection", "src/routing/model-router.ts"],
      ["Planner capsule", "OpenCodeReadOnlyProgram.run", "Read-only snapshot and planning prompt", "Untrusted guidance evidence", "src/agents/opencode-read-only-program.ts"],
      ["Research capsule", "GovernedWebResearch.execute", "Fixed IANA GET under exact policy", "Citation, digest, and provenance", "src/research/web-research.ts"],
      ["Writer worktree", "OpenCodeWriter.execute", "Serialized WriterTaskPacket and owned paths", "Native event chain and exact diff", "src/harnesses/opencode-writer.ts"],
      ["Independent reviewer", "OpenCodeReviewerAdapter.review", "Challenged diff and validation prompt", "Schema-checked review decision", "src/reviews/opencode-reviewer-adapter.ts"],
      ["Verified integration", "IntegrationQueue.integrate", "Reviewed commit and full validation", "Integrated commit and terminal milestone evidence", "src/integration/integration-queue.ts"],
    ],
  },
  {
    id: "model", name: "Brokered LLM turn", summary: "The simulated display shows the protocol; production uses an exact Azure deployment through the host broker.",
    steps: [
      ["Serialize prompt", "OpenCodeReadOnlyAgent.run", "Role prompt plus sanitized repository context", "OpenCode chat messages", "src/agents/opencode-read-only-agent.ts"],
      ["Request turn", "DockerOpenCodeReadOnlyCapsule.execute", "model_turn message, model ID, budgets, allowed tools", "Host broker request", "src/capsule/opencode-read-only-capsule.ts"],
      ["Authorize model", "AzureOpenAIModelBroker.execute", "Deployment-bound prompt, limits, optional tools", "Pinned HTTPS streaming request", "src/providers/azure-openai-model-broker.ts"],
      ["Simulated response", "SSE parser", "Provider delta and usage events", "Bounded assistant text/tool call and cost", "src/providers/azure-openai-model-broker.ts"],
      ["Retain evidence", "WorkerLifecycleService.observe", "Receipt digest and usage, not hidden reasoning", "Journal events and redacted Agent Tail spans", "src/workers/worker-lifecycle.ts"],
    ],
  },
  {
    id: "github", name: "GitHub effect and reconciliation", summary: "Potentially effectful dispatch is never called successful merely because the process exited.",
    steps: [
      ["Consume grant", "GitHubEffectBroker.push/createPullRequest", "Exact expiring one-use policy grant", "Immutable grant consumption", "src/capsule/github-broker.ts"],
      ["Attest and dispatch", "GitHubEffectBroker", "Pinned executable, credential handle, preconditions", "Uncertain effect after dispatch", "src/capsule/github-broker.ts"],
      ["Stop automatic work", "TaskService.pauseForUncertainEffect", "Uncertain receipt", "Paused task requiring reconciliation", "src/tasks/task-service.ts"],
      ["Read remote state", "reconcilePush/reconcilePullRequest", "Expected ref or PR identity", "Observed completed or failed effect", "src/capsule/github-broker.ts"],
    ],
  },
  {
    id: "release", name: "Local release preparation", summary: "Release artifacts are produced locally and deliberately stop before remote effects.",
    steps: [
      ["Bind release", "LocalReleaseCoordinator.run", "Terminal milestone and integrated commit", "Immutable release packet", "src/release/local-release-coordinator.ts"],
      ["Prepare worktree", "LocalReleaseRunner.run", "Exact commit and release config", "Detached clean release workspace", "src/release/local-release-runner.ts"],
      ["Build/package/verify", "ValidationRunner-compatible steps", "Canonical Node argv and declared artifacts", "Step evidence and artifact hashes", "src/release/local-release-runner.ts"],
      ["Pause boundary", "MilestoneRegistry.pauseForReleaseBoundary", "Verified local-only result", "Attention item; no push/tag/publish", "src/milestones/milestone-registry.ts"],
    ],
  },
  {
    id: "recovery", name: "Recovery and uncertain effects", summary: "Replay classifies what can resume safely and what requires observation or a human decision.",
    steps: [
      ["Replay", "RecoveryService.inspect", "Task stream, worktree, refs, commits, artifacts", "Read-only RecoveryDecision", "src/orchestration/recovery.ts"],
      ["Classify", "retainClassification", "Known lifecycle and external observations", "resume_preparation / await_reconciliation / record_*", "src/orchestration/recovery.ts"],
      ["Authorize bounded action", "authorizeBoundedCleanup/recordCompletion", "Exact retained decision", "One cleanup or completion append", "src/orchestration/recovery.ts"],
      ["Project", "projectTask", "Updated event stream", "Rebuildable canonical view", "src/tasks/task-projection.ts"],
    ],
  },
  {
    id: "retention", name: "Journal archive and explicit prune", summary: "History remains authoritative across immutable archives and active SQLite while deletion requires a separate audited operator decision.",
    steps: [
      ["Propose archive", "JournalRetentionService.archive", "Exact position boundary and bounded event count", "archive proposed and started evidence", "src/journal/retention.ts"],
      ["Publish segment", "writeSegment/writeImmutable", "Durable SQLite intent plus canonical stored-event JSONL", "Fsynced restrictive segment and checksummed manifest", "src/journal/retention.ts"],
      ["Verify chain", "JournalRetentionService.verify", "SQLite identity/head anchor, segments, manifests, checksums, overlap, and exact ranges", "Verified contiguous archive boundary", "src/journal/retention.ts"],
      ["Authorize prune", "requestPrune/prune", "Single-use request, operator, verified boundary, cursor safety, exact confirmation", "Audited authorization above the prune boundary", "src/journal/retention.ts"],
      ["Reconcile interruption", "inspectRecovery/reconcile", "Read-only classification followed by exact operation ID and confirmation", "Recovered archive, prune, or maintenance completion, or explicit repair/failure evidence without effect retry", "src/journal/retention.ts"],
      ["Replay or restore", "ArchivedEventJournal/restore", "Bounded early-stop archive pages plus active journal", "Stable event IDs, versions, positions, appends, and combined durable projection claims", "src/journal/retention.ts"],
    ],
  },
].map((flow) => ({ ...flow, steps: flow.steps.map(([name, fn, input, output, module]) => ({ name, fn, input, output, module })) }));

function walk(relativeRoot) {
  const absoluteRoot = path.join(root, relativeRoot);
  return readdirSync(absoluteRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name))
    .map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

function featureFor(modulePath) {
  if (modulePath === "src/index.ts") return "entrypoints";
  if (modulePath.startsWith("scripts/")) return "tooling";
  if (modulePath.startsWith("fixtures/")) return "fixtures";
  if (modulePath.startsWith("tests/")) return "tests";
  return featureByDirectory.get(modulePath.split("/")[1]) ?? "entrypoints";
}

function compact(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 640);
}

function declarationSignature(node, sourceFile) {
  const text = node.getText(sourceFile);
  const body = node.body;
  return compact(body ? text.slice(0, Math.max(0, body.pos - node.pos)).replace(/\s*$/, "") : text);
}

function parametersOf(node, sourceFile) {
  return node.parameters?.map((parameter) => compact(parameter.getText(sourceFile))).join(", ") || "none";
}

function returnOf(node, sourceFile) {
  return node.type ? compact(node.type.getText(sourceFile)) : "inferred by TypeScript/runtime schema";
}

function symbolDescription(kind, name) {
  if (kind === "schema") return `Runtime schema for ${name.replace(/Schema$/, "")}. It parses boundary data and rejects malformed values.`;
  if (kind === "class") return `Stateful ${name} component. Expand it to inspect every declared method and constructor.`;
  if (kind === "method") return `${name} is a class operation; its exact declaration below is extracted from the current source.`;
  if (kind === "test") return `${name} is verification code rather than production authority.`;
  return `${name} is an executable declaration extracted from the current repository source.`;
}

function parseModule(modulePath) {
  const absolute = path.join(root, modulePath);
  const text = readFileSync(absolute, "utf8");
  const sourceFile = ts.createSourceFile(
    modulePath,
    text,
    ts.ScriptTarget.Latest,
    true,
    modulePath.endsWith(".mjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS,
  );
  const symbols = [];
  const imports = [];
  const callNames = new Map();

  const addSymbol = (name, kind, node, callable = node) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const id = `${modulePath}#${name}:${line}`;
    symbols.push({
      id, name, kind, line,
      signature: declarationSignature(node, sourceFile),
      inputs: callable?.parameters ? parametersOf(callable, sourceFile) : "see schema/type declaration",
      output: callable?.parameters ? returnOf(callable, sourceFile) : kind === "schema" ? "parsed typed value or validation error" : "constructed instance or declared type",
      description: symbolDescription(kind, name),
      calls: [],
    });
    callNames.set(node, id);
  };

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith(".")) {
        const candidate = path.posix.normalize(path.posix.join(path.posix.dirname(modulePath), specifier)).replace(/\.js$/, ".ts");
        imports.push(candidate);
      }
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) addSymbol(statement.name.text, modulePath.startsWith("tests/") ? "test" : "function", statement);
    if (ts.isClassDeclaration(statement) && statement.name) {
      addSymbol(statement.name.text, "class", statement, undefined);
      for (const member of statement.members) {
        if ((ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) && member.name || ts.isConstructorDeclaration(member)) {
          const memberName = ts.isConstructorDeclaration(member) ? "constructor" : member.name?.getText(sourceFile) ?? "member";
          addSymbol(`${statement.name.text}.${memberName}`, "method", member);
        }
      }
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        const name = declaration.name.text;
        if (declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
          addSymbol(name, modulePath.startsWith("tests/") ? "test" : "function", declaration, declaration.initializer);
        } else if (/Schema$/.test(name)) {
          addSymbol(name, "schema", declaration, undefined);
        }
      }
    }
    if (ts.isInterfaceDeclaration(statement)) addSymbol(statement.name.text, "interface", statement, undefined);
    if (ts.isTypeAliasDeclaration(statement)) addSymbol(statement.name.text, "type", statement, undefined);
  }

  const enclosingSymbol = (node) => {
    let current = node;
    while (current) {
      const found = callNames.get(current);
      if (found) return found;
      current = current.parent;
    }
    return undefined;
  };
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const owner = enclosingSymbol(node);
      const called = ts.isIdentifier(node.expression)
        ? node.expression.text
        : ts.isPropertyAccessExpression(node.expression)
          ? node.expression.name.text
          : undefined;
      if (owner && called) symbols.find((symbol) => symbol.id === owner)?.calls.push(called);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const symbol of symbols) symbol.calls = [...new Set(symbol.calls)].sort();

  const feature = featureFor(modulePath);
  return {
    path: modulePath,
    feature,
    kind: modulePath.startsWith("src/") ? "runtime" : modulePath.startsWith("tests/") ? "test" : modulePath.startsWith("scripts/") ? "tooling" : "fixture",
    summary: `${featureDefinitions.find((entry) => entry.id === feature)?.name ?? feature} module with ${symbols.length} mapped declarations.`,
    imports,
    symbols,
  };
}

const modules = sourceRoots.flatMap(walk).map(parseModule);
const modulePaths = new Set(modules.map((module) => module.path));
for (const module of modules) module.imports = module.imports.filter((candidate) => modulePaths.has(candidate));
const edges = modules.flatMap((module) => module.imports.map((target) => ({ from: module.path, to: target, kind: "imports" })));
const inventory = { generatedAt: "generated from repository source; deterministic timestamp intentionally omitted", features: featureDefinitions, flows, modules, edges };
const inventoryJson = JSON.stringify(inventory).replaceAll("<", "\\u003c");

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Interactive, source-derived architecture and function atlas for the Zentra codebase.">
  <title>Zentra Codebase Atlas</title>
  <style>
    :root{--ink:#13221d;--muted:#60736b;--paper:#f3f0e7;--panel:#fffdf6;--line:#c8d1c8;--green:#0d5c49;--mint:#b9e4d2;--orange:#e96d3b;--yellow:#f4c95d;--blue:#235789;--shadow:0 14px 40px rgba(19,34,29,.09);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:var(--paper)}
    *{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 82% 2%,rgba(244,201,93,.28),transparent 27rem),linear-gradient(90deg,rgba(13,92,73,.035) 1px,transparent 1px),linear-gradient(rgba(13,92,73,.035) 1px,transparent 1px),var(--paper);background-size:auto,28px 28px,28px 28px,auto}button,input,select{font:inherit}button{cursor:pointer}.skip{position:absolute;left:-999px}.skip:focus{left:1rem;top:1rem;z-index:99;background:var(--panel);padding:.7rem;border:2px solid var(--orange)}
    header{padding:clamp(2rem,6vw,5.5rem) clamp(1rem,5vw,5rem) 2rem;max-width:1600px;margin:auto}.eyebrow{font:700 .72rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--green)}h1{font:800 clamp(2.8rem,8vw,7rem)/.88 Georgia,serif;letter-spacing:-.07em;max-width:1000px;margin:.45rem 0 1.5rem}.lede{font-size:clamp(1rem,2vw,1.35rem);line-height:1.55;max-width:800px;color:#3d5149}.stats{display:flex;gap:.65rem;flex-wrap:wrap;margin-top:2rem}.stat{border:1px solid var(--line);background:rgba(255,253,246,.75);padding:.7rem 1rem;border-radius:999px}.stat strong{color:var(--green)}
    .shell{max-width:1600px;margin:auto;padding:0 clamp(1rem,3vw,3rem) 5rem}.toolbar{position:sticky;top:0;z-index:20;background:rgba(243,240,231,.94);backdrop-filter:blur(14px);padding:.8rem 0;border-bottom:1px solid var(--line)}.search-row{display:grid;grid-template-columns:minmax(220px,1fr) auto;gap:.7rem}.search{width:100%;border:1px solid var(--line);background:var(--panel);padding:.85rem 1rem;border-radius:.55rem;outline:none}.search:focus{border-color:var(--green);box-shadow:0 0 0 3px rgba(13,92,73,.12)}.tabs{display:flex;gap:.4rem;overflow:auto;padding:.7rem 0 .1rem;scrollbar-width:thin}.tab{white-space:nowrap;border:1px solid var(--line);background:transparent;color:var(--ink);padding:.55rem .8rem;border-radius:999px}.tab[aria-selected="true"]{background:var(--ink);color:white;border-color:var(--ink)}
    main{padding-top:1.25rem}.panel{background:rgba(255,253,246,.9);border:1px solid var(--line);box-shadow:var(--shadow);border-radius:1rem;padding:clamp(1rem,3vw,2rem);margin-bottom:1.2rem;animation:rise .35s ease both}.panel h2{font:700 clamp(1.7rem,4vw,3rem)/1 Georgia,serif;margin:0 0 .8rem}.panel h3{margin:0 0 .55rem}.feature-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:1px;background:var(--line);border:1px solid var(--line);border-radius:.8rem;overflow:hidden;margin-top:1.25rem}.feature-card{background:var(--panel);padding:1.2rem;min-height:150px}.feature-card small,.label{font:700 .68rem/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase;letter-spacing:.1em;color:var(--green)}.feature-card p{color:var(--muted);line-height:1.45}.io-grid{display:grid;grid-template-columns:1fr 1fr 1.35fr;gap:.8rem;margin:1rem 0}.io{border-left:4px solid var(--green);background:#f4f8f4;padding:1rem}.io.output{border-color:var(--orange)}.io.process{border-color:var(--yellow)}.io p{margin:.45rem 0 0;line-height:1.45}
    .flow-head{display:flex;align-items:end;justify-content:space-between;gap:1rem;margin-bottom:1rem}.flow-select{border:1px solid var(--line);background:var(--panel);padding:.7rem}.stepper{position:relative;min-height:255px;overflow:hidden}.step{display:none;grid-template-columns:5rem 1fr;gap:1rem;animation:slide .3s ease}.step.active{display:grid}.step-no{font:800 3rem/1 Georgia,serif;color:var(--orange)}.step code,.signature{display:block;white-space:pre-wrap;overflow-wrap:anywhere;background:#13221d;color:#dff8ed;padding:.8rem;border-radius:.5rem;font:500 .76rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}.step-meta{display:grid;grid-template-columns:1fr 1fr;gap:.7rem;margin-top:.8rem}.step-meta div{border:1px solid var(--line);padding:.75rem;background:#fff}.step-actions{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--line);padding-top:1rem;margin-top:1rem}.step-actions button,.button{border:0;background:var(--green);color:white;border-radius:.45rem;padding:.65rem .9rem}.step-actions button:disabled{opacity:.35}.follows{font-size:.82rem;color:var(--muted);text-align:center}
    .dashboard-head{display:flex;align-items:end;justify-content:space-between;gap:1rem}.legend{display:flex;gap:.7rem;flex-wrap:wrap;font-size:.75rem;color:var(--muted)}.dot{display:inline-block;width:.65rem;height:.65rem;border-radius:50%;margin-right:.25rem}.graph-wrap{border:1px solid var(--line);background:#10231d;border-radius:.7rem;overflow:auto;max-height:720px;margin-top:1rem}.graph-wrap svg{display:block;min-width:100%}.graph-node{cursor:pointer;transition:opacity .2s,transform .2s}.graph-node:hover{opacity:1;filter:brightness(1.35)}.graph-edge{stroke:#6a8a7d;stroke-width:.65;opacity:.18}.graph-label{fill:#dce9e3;font:9px ui-monospace,SFMono-Regular,Menlo,monospace;pointer-events:none}.detail-drawer{display:grid;grid-template-columns:1fr 1fr;gap:1rem;border:1px solid var(--line);background:#fff;padding:1rem;margin-top:.8rem}.detail-drawer p{margin:.3rem 0;color:var(--muted)}
    .hierarchy-controls{display:flex;gap:.6rem;flex-wrap:wrap;margin:.7rem 0 1rem}.hierarchy-controls button{border:1px solid var(--line);background:white;border-radius:.4rem;padding:.5rem .7rem}.module{border-top:1px solid var(--line)}.module summary{display:grid;grid-template-columns:minmax(220px,1fr) auto auto;gap:.7rem;align-items:center;padding:.85rem 0;cursor:pointer}.module-path{font:700 .8rem ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}.badge{font-size:.65rem;text-transform:uppercase;letter-spacing:.08em;background:var(--mint);padding:.3rem .5rem;border-radius:999px}.symbols{padding:0 0 1rem 1rem;border-left:2px solid var(--mint)}.symbol{position:relative;border:1px solid var(--line);background:#fff;padding:.75rem;margin:.45rem 0;border-radius:.5rem}.symbol button{border:0;background:none;padding:0;text-align:left;color:var(--green);font:700 .78rem ui-monospace,SFMono-Regular,Menlo,monospace}.symbol-grid{display:grid;grid-template-columns:1fr 1fr;gap:.6rem;margin-top:.5rem;font-size:.82rem}.symbol-grid p{margin:.2rem 0;color:var(--muted)}
    .tooltip{position:fixed;z-index:100;max-width:430px;pointer-events:none;background:#071510;color:white;border:1px solid #45685b;border-radius:.55rem;padding:.8rem;box-shadow:0 15px 45px #0006;opacity:0;transform:translateY(5px);transition:.15s}.tooltip.visible{opacity:1;transform:none}.tooltip strong{display:block;color:#b9e4d2;margin-bottom:.35rem}.tooltip code{white-space:pre-wrap;font-size:.7rem}.empty{padding:3rem;text-align:center;color:var(--muted)}footer{padding:2rem 0;color:var(--muted);font-size:.85rem}.noscript{background:#fff1c7;border:1px solid #d5a62d;padding:1rem;margin-bottom:1rem}
    @keyframes rise{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}@keyframes slide{from{opacity:0;transform:translateX(20px)}to{opacity:1;transform:none}}
    @media(max-width:850px){.feature-grid,.io-grid{grid-template-columns:1fr}.search-row{grid-template-columns:1fr}.detail-drawer,.symbol-grid{grid-template-columns:1fr}.module summary{grid-template-columns:1fr auto}.module summary .count{display:none}.step-meta{grid-template-columns:1fr}h1{letter-spacing:-.05em}}
    @media(prefers-reduced-motion:reduce){*,*::before,*::after{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
  </style>
</head>
<body>
  <a class="skip" href="#content">Skip to atlas</a>
  <header>
    <div class="eyebrow">Source-derived system documentation / Darwin arm64 MVP</div>
    <h1>Zentra<br>Codebase Atlas</h1>
    <p class="lede">A navigable representation of the current repository: inputs, schemas, function signatures, intermediate calls, trust boundaries, event flows, tests, and the paths from typed intent to evidence-backed completion.</p>
    <div class="stats" id="stats" aria-label="Inventory totals"></div>
  </header>
  <div class="shell">
    <div class="toolbar">
      <div class="search-row">
        <input class="search" id="search" type="search" placeholder="Search function, schema, module, input, output..." aria-label="Search codebase inventory">
        <button class="button" id="reset" type="button">Reset view</button>
      </div>
      <div class="tabs" id="tabs" role="tablist" aria-label="Feature documentation"></div>
    </div>
    <noscript><div class="noscript">JavaScript is required for tabs, graph navigation, and function hover details. The complete source-derived inventory is embedded in this file as JSON.</div></noscript>
    <main id="content" tabindex="-1">
      <section class="panel" id="feature-panel" aria-live="polite"></section>
      <section class="panel" aria-labelledby="flow-title">
        <div class="flow-head"><div><span class="label">Next step navigation</span><h2 id="flow-title">Trace a complete path</h2></div><select id="flow-select" class="flow-select" aria-label="Choose a data flow"></select></div>
        <p id="flow-summary"></p><div id="stepper" class="stepper"></div>
      </section>
      <section class="panel" aria-labelledby="dashboard-title">
        <div class="dashboard-head"><div><span class="label">Dashboard visualization</span><h2 id="dashboard-title">Every mapped function</h2></div><div class="legend"><span><i class="dot" style="background:#b9e4d2"></i>function</span><span><i class="dot" style="background:#f4c95d"></i>schema/type</span><span><i class="dot" style="background:#e96d3b"></i>class/method</span></div></div>
        <p>Each point is one extracted declaration. Columns group features; faint edges show source-observed call names when they resolve uniquely. Select a point for its exact signature, input, output, file, and downstream calls.</p>
        <div class="graph-wrap"><svg id="function-graph" role="img" aria-label="Function relationship graph"></svg></div>
        <div class="detail-drawer" id="graph-detail" aria-live="polite"><div><span class="label">Select a node</span><h3>Function detail</h3></div><p>The graph includes every declaration extracted from runtime, scripts, fixtures, and tests.</p></div>
      </section>
      <section class="panel" id="hierarchy" aria-labelledby="hierarchy-title">
        <span class="label">Function hierarchy</span><h2 id="hierarchy-title">Entrypoints to intermediate functions</h2>
        <p>Main functions and classes are listed by feature and module. Expand a module to continue into its functions, methods, schemas, interfaces, inputs, outputs, and observed calls.</p>
        <div class="hierarchy-controls"><button id="expand-all" type="button">Expand all</button><button id="collapse-all" type="button">Collapse all</button><span id="result-count" aria-live="polite"></span></div>
        <div id="hierarchy-list"></div>
      </section>
    </main>
    <footer>Current implementation map, not an authority grant. SQLite journal state remains authoritative; this dashboard is a rebuildable documentation projection. Historical plans can differ from the implementation inventory shown here.</footer>
  </div>
  <div class="tooltip" id="function-tooltip" role="tooltip"></div>
  <script id="codebase-inventory" type="application/json">${inventoryJson}</script>
  <script>
    (() => {
      const data = JSON.parse(document.getElementById('codebase-inventory').textContent);
      const state = { feature: 'overview', query: '', flow: data.flows[0].id, step: 0 };
      const colors = { function:'#b9e4d2', test:'#8db9de', schema:'#f4c95d', type:'#f4c95d', interface:'#f4c95d', class:'#e96d3b', method:'#e96d3b' };
      const allSymbols = data.modules.flatMap(module => module.symbols.map(symbol => ({...symbol,module:module.path,feature:module.feature,moduleKind:module.kind})));
      const symbolById = new Map(allSymbols.map(symbol => [symbol.id,symbol]));
      const names = new Map();
      for (const symbol of allSymbols) names.set(symbol.name.split('.').at(-1), [...(names.get(symbol.name.split('.').at(-1)) || []), symbol]);
      const esc = value => String(value).replace(/[&<>"']/g, character => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
      const activeFeature = () => data.features.find(feature => feature.id === state.feature);
      const visibleModules = () => data.modules.filter(module => (state.feature === 'overview' || module.feature === state.feature) && (!state.query || (module.path+' '+module.summary+' '+module.symbols.map(s => s.name+' '+s.signature+' '+s.inputs+' '+s.output).join(' ')).toLowerCase().includes(state.query)));

      function renderStats(){
        const production = data.modules.filter(module => module.kind === 'runtime').length;
        document.getElementById('stats').innerHTML = '<span class="stat"><strong>'+data.features.length+'</strong> feature tabs</span><span class="stat"><strong>'+data.modules.length+'</strong> modules</span><span class="stat"><strong>'+allSymbols.length+'</strong> declarations</span><span class="stat"><strong>'+data.edges.length+'</strong> import edges</span><span class="stat"><strong>'+production+'</strong> runtime modules</span>';
      }
      function renderTabs(){
        const tabs = [{id:'overview',name:'Main feature'},...data.features];
        document.getElementById('tabs').innerHTML = tabs.map(tab => '<button class="tab" role="tab" id="tab-'+tab.id+'" aria-selected="'+(tab.id===state.feature)+'" aria-controls="feature-panel" tabindex="'+(tab.id===state.feature?'0':'-1')+'" data-feature="'+tab.id+'">'+esc(tab.name)+'</button>').join('');
        document.querySelectorAll('.tab').forEach(button => button.addEventListener('click', () => selectFeature(button.dataset.feature)));
      }
      function selectFeature(id){state.feature=id;state.query='';document.getElementById('search').value='';location.hash=id==='overview'?'':id;render();}
      function renderFeature(){
        const panel = document.getElementById('feature-panel');
        const feature = activeFeature();
        if (!feature) {
          panel.innerHTML = '<span class="label">Main feature</span><h2>Typed intent becomes retained evidence</h2><p class="lede">Zentra is a local-first orchestration kernel. The main input is a typed task or milestone request containing identity, project scope, exact paths, role capability requirements, budgets, policy context, acceptance criteria, and evidence requirements. Natural language alone grants no authority.</p><div class="io-grid"><div class="io"><span class="label">Canonical input structure</span><p><strong>Identity + scope</strong><br>task/milestone/project IDs, exact repository revision, owned and forbidden paths.</p><p><strong>Authority + policy</strong><br>roles, model/security sheets, capabilities, network/effect grants.</p><p><strong>Execution + evidence</strong><br>budgets, deadlines, validations, reviewer, success criteria.</p></div><div class="io output"><span class="label">Canonical output</span><p>A replayable journal stream ending in <code>completed</code>, <code>cancelled</code>, <code>denied</code>, <code>timed_out</code>, or <code>failed</code>, backed by artifacts, validation, review, integration, cleanup, and trace evidence.</p></div><div class="io process"><span class="label">Invariant</span><p>Every accepted transition is journaled before the next effect. Potentially effectful uncertain results are paused for reconciliation and never automatically retried.</p></div></div><div class="feature-grid">'+data.features.map(item => '<button class="feature-card" data-open="'+item.id+'" style="border:0;text-align:left"><small>'+esc(item.purpose)+'</small><h3>'+esc(item.name)+'</h3><p>'+esc(item.process)+'</p></button>').join('')+'</div>';
          panel.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click',()=>selectFeature(button.dataset.open)));
        } else {
          const modules = data.modules.filter(module => module.feature===feature.id);
          const count = modules.reduce((sum,module)=>sum+module.symbols.length,0);
          panel.innerHTML = '<span class="label">Feature tab / '+modules.length+' modules / '+count+' declarations</span><h2>'+esc(feature.name)+'</h2><p class="lede">'+esc(feature.purpose)+'</p><div class="io-grid"><div class="io"><span class="label">Exact input category</span><p>'+esc(feature.input)+'</p></div><div class="io output"><span class="label">Expected output</span><p>'+esc(feature.output)+'</p></div><div class="io process"><span class="label">How it works</span><p>'+esc(feature.process)+'</p></div></div>';
        }
      }
      function renderFlowOptions(){
        const select=document.getElementById('flow-select');select.innerHTML=data.flows.map(flow=>'<option value="'+flow.id+'" '+(flow.id===state.flow?'selected':'')+'>'+esc(flow.name)+'</option>').join('');
        select.onchange=()=>{state.flow=select.value;state.step=0;renderStepper()};
      }
      function renderStepper(){
        const flow=data.flows.find(item=>item.id===state.flow);const step=flow.steps[state.step];const next=flow.steps[state.step+1];
        document.getElementById('flow-summary').textContent=flow.summary;
        document.getElementById('stepper').innerHTML='<article class="step active"><div class="step-no">'+String(state.step+1).padStart(2,'0')+'</div><div><span class="label">'+esc(flow.name)+'</span><h3>'+esc(step.name)+'</h3><code>'+esc(step.fn)+'</code><div class="step-meta"><div><span class="label">Input</span><p>'+esc(step.input)+'</p></div><div><span class="label">Output</span><p>'+esc(step.output)+'</p></div></div><p><span class="label">Source</span> <code style="display:inline;padding:.15rem .3rem">'+esc(step.module)+'</code></p></div></article><div class="step-actions"><button id="prev-step" '+(state.step===0?'disabled':'')+'>Previous</button><div class="follows">'+(next?'What follows: <strong>'+esc(next.name)+'</strong>':'Terminal evidence reached')+'<br>Step '+(state.step+1)+' of '+flow.steps.length+'</div><button id="next-step" '+(next?'':'disabled')+'>Next step</button></div>';
        document.getElementById('prev-step').onclick=()=>{state.step--;renderStepper()};document.getElementById('next-step').onclick=()=>{state.step++;renderStepper()};
      }
      function renderGraph(){
        const modules=visibleModules();const symbols=modules.flatMap(module=>module.symbols.map(symbol=>({...symbol,module:module.path,feature:module.feature})));
        const svg=document.getElementById('function-graph');const featureIds=[...new Set(symbols.map(symbol=>symbol.feature))];const colWidth=210,rowHeight=18,pad=32;const positions=new Map();let maxRows=1;
        featureIds.forEach((featureId,col)=>{const items=symbols.filter(symbol=>symbol.feature===featureId);maxRows=Math.max(maxRows,items.length);items.forEach((symbol,row)=>positions.set(symbol.id,{x:pad+col*colWidth,y:55+row*rowHeight}));});
        const width=Math.max(800,pad*2+featureIds.length*colWidth),height=Math.max(260,80+maxRows*rowHeight);svg.setAttribute('viewBox','0 0 '+width+' '+height);svg.setAttribute('width',width);svg.setAttribute('height',height);
        const edges=[];for(const symbol of symbols){const from=positions.get(symbol.id);for(const call of symbol.calls){const targets=names.get(call)||[];if(targets.length===1&&positions.has(targets[0].id)){const to=positions.get(targets[0].id);edges.push('<line class="graph-edge" x1="'+from.x+'" y1="'+from.y+'" x2="'+to.x+'" y2="'+to.y+'"/>')}}}
        const heads=featureIds.map((id,col)=>'<text class="graph-label" x="'+(pad+col*colWidth)+'" y="24" style="font-size:11px;font-weight:700">'+esc(data.features.find(f=>f.id===id)?.name||id)+'</text>');
        const nodes=symbols.map(symbol=>{const p=positions.get(symbol.id);return '<g class="graph-node" tabindex="0" role="button" aria-label="'+esc(symbol.name)+'" data-symbol="'+esc(symbol.id)+'"><circle cx="'+p.x+'" cy="'+p.y+'" r="4.4" fill="'+(colors[symbol.kind]||'#b9e4d2')+'"/><text class="graph-label" x="'+(p.x+9)+'" y="'+(p.y+3)+'">'+esc(symbol.name.slice(0,27))+'</text></g>'});
        svg.innerHTML=edges.join('')+heads.join('')+nodes.join('');svg.querySelectorAll('[data-symbol]').forEach(node=>{node.addEventListener('click',()=>showGraphDetail(node.dataset.symbol));node.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showGraphDetail(node.dataset.symbol)}});bindTooltip(node,node.dataset.symbol)});
      }
      function showGraphDetail(id){const symbol=symbolById.get(id);if(!symbol)return;document.getElementById('graph-detail').innerHTML='<div><span class="label">'+esc(symbol.kind)+' / line '+symbol.line+'</span><h3>'+esc(symbol.name)+'</h3><p>'+esc(symbol.module)+'</p></div><div><code class="signature">'+esc(symbol.signature)+'</code><p><strong>Input:</strong> '+esc(symbol.inputs)+'</p><p><strong>Output:</strong> '+esc(symbol.output)+'</p><p><strong>Observed calls:</strong> '+esc(symbol.calls.join(', ')||'none in declaration body')+'</p></div>'}
      function bindTooltip(element,id){const tooltip=document.getElementById('function-tooltip');const show=event=>{const symbol=symbolById.get(id);tooltip.innerHTML='<strong>'+esc(symbol.name)+'</strong><code>'+esc(symbol.signature)+'</code><p>Input: '+esc(symbol.inputs)+'</p><p>Output: '+esc(symbol.output)+'</p>';tooltip.classList.add('visible');move(event)};const move=event=>{const x=Math.min(innerWidth-450,(event.clientX||element.getBoundingClientRect().left)+14);const y=Math.min(innerHeight-220,(event.clientY||element.getBoundingClientRect().bottom)+14);tooltip.style.left=Math.max(8,x)+'px';tooltip.style.top=Math.max(8,y)+'px'};element.addEventListener('mouseenter',show);element.addEventListener('mousemove',move);element.addEventListener('mouseleave',()=>tooltip.classList.remove('visible'));element.addEventListener('focus',show);element.addEventListener('blur',()=>tooltip.classList.remove('visible'))}
      function renderHierarchy(){
        const modules=visibleModules();const symbolCount=modules.reduce((sum,module)=>sum+module.symbols.length,0);document.getElementById('result-count').textContent=modules.length+' modules / '+symbolCount+' declarations';
        document.getElementById('hierarchy-list').innerHTML=modules.length?modules.map((module,index)=>'<details class="module" '+(index<2?'open':'')+'><summary><span class="module-path">'+esc(module.path)+'</span><span class="badge">'+esc(module.kind)+'</span><span class="count">'+module.symbols.length+' declarations</span></summary><div class="symbols">'+(module.symbols.length?module.symbols.map(symbol=>'<article class="symbol"><button type="button" data-symbol="'+esc(symbol.id)+'">'+esc(symbol.name)+'</button><span class="badge" style="float:right">'+esc(symbol.kind)+'</span><code class="signature">'+esc(symbol.signature)+'</code><div class="symbol-grid"><div><span class="label">Input</span><p>'+esc(symbol.inputs)+'</p></div><div><span class="label">Output</span><p>'+esc(symbol.output)+'</p></div><div><span class="label">Definition</span><p>'+esc(symbol.description)+'</p></div><div><span class="label">Intermediate calls</span><p>'+esc(symbol.calls.join(' → ')||'No direct calls observed')+'</p></div></div></article>').join(''):'<p>No named declarations; module side effects/import surface still mapped.</p>')+'</div></details>').join(''):'<div class="empty">No modules match this feature and search.</div>';
        document.querySelectorAll('.symbol [data-symbol]').forEach(button=>bindTooltip(button,button.dataset.symbol));
      }
      function render(){renderTabs();renderFeature();renderGraph();renderHierarchy()}
      document.getElementById('search').addEventListener('input',event=>{state.query=event.target.value.trim().toLowerCase();renderGraph();renderHierarchy()});
      document.getElementById('reset').onclick=()=>selectFeature('overview');document.getElementById('expand-all').onclick=()=>document.querySelectorAll('.module').forEach(item=>item.open=true);document.getElementById('collapse-all').onclick=()=>document.querySelectorAll('.module').forEach(item=>item.open=false);
      document.getElementById('tabs').addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;const tabs=[...document.querySelectorAll('.tab')];const current=tabs.indexOf(document.activeElement);const next=(current+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[next].focus();tabs[next].click()});
      const hash=location.hash.slice(1);if(data.features.some(feature=>feature.id===hash))state.feature=hash;renderStats();renderFlowOptions();renderStepper();render();
    })();
  </script>
</body>
</html>
`;

if (process.argv.includes("--stdout")) process.stdout.write(html);
else writeFileSync(outputPath, html, "utf8");
