export interface RunListItemView {
  readonly runId: string;
  readonly title: string;
  readonly projectName: string;
  readonly projectDescription?: string;
  readonly workspace?: string;
  readonly sourceLabel: string;
  readonly statusLabel: string;
  readonly attentionRequired: boolean;
  readonly startedAt?: string;
}

export interface RunStatusView extends RunListItemView {
  readonly stageLabel?: string;
  readonly summary: string;
  readonly updatedAt?: string;
  readonly approvalLabel?: string;
  readonly attentionMessage?: string;
  readonly cancellationReason?: string;
  readonly failureMessage?: string;
  readonly progress: readonly Readonly<{ stage: string; status: string }>[];
  readonly suggestedCommands: readonly string[];
  readonly diagnostics: readonly Readonly<{ label: string; value: string }>[];
}

export interface PresentationOptions {
  readonly width?: number;
  readonly verbose?: boolean;
}

interface Column {
  readonly heading: string;
  readonly width: number;
  readonly value: (item: RunListItemView) => string;
  readonly middle?: boolean;
}

const UNSAFE_TERMINAL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u206f]/gu;

export function formatRunList(input: unknown, options: PresentationOptions = {}): string {
  const items = Array.isArray(input) ? input.map(toRunListItemView) : [];
  if (items.length === 0) return "No workflow runs found.\n";
  const width = boundedWidth(options.width);
  const columns = listColumns(width);
  const heading = row(columns, (column) => column.heading);
  const divider = row(columns, (column) => "-".repeat(column.width));
  const rows = items.map((item) => row(columns, (column) => column.value(item), item));
  return `Zentra Runs\n\n${heading}\n${divider}\n${rows.join("\n")}\n\n${items.length} ${items.length === 1 ? "run" : "runs"}\n`;
}

export function formatRunStatus(input: unknown, options: PresentationOptions = {}): string {
  const view = toRunStatusView(input);
  const labels: Array<readonly [string, string | undefined]> = [
    ["Title", view.title],
    ["Project", view.projectDescription === undefined
      ? view.projectName
      : `${view.projectName} - ${view.projectDescription}`],
    ["Workspace", view.workspace],
    ["Run ID", view.runId],
    ["Source", view.sourceLabel],
    ["Status", view.statusLabel],
    ["Current stage", view.stageLabel],
    ["Started", view.startedAt === undefined ? undefined : formatTimestamp(view.startedAt, "long")],
    ["Updated", view.updatedAt === undefined ? undefined : formatTimestamp(view.updatedAt, "long")],
    ["Approval", view.approvalLabel],
    ["Attention", view.attentionMessage ?? "None"],
  ];
  let output = `Run Status\n\n${labelled(labels)}\n\nSummary:\n${view.summary}\n`;
  if (view.progress.length > 0) {
    output += `\nProgress\n\n${labelled(view.progress.map((item) => [item.stage, item.status]))}\n`;
  }
  if (options.verbose === true && view.diagnostics.length > 0) {
    output += `\nDetails\n\n${labelled(view.diagnostics.map((item) => [item.label, item.value]))}\n`;
  }
  if (view.suggestedCommands.length > 0) {
    output += `\nNext:\n${view.suggestedCommands.map((command) => `Run \`${terminalText(command)}\`.`).join("\n")}\n`;
  }
  return output;
}

export function toRunListItemView(input: unknown): RunListItemView {
  const summary = record(input);
  const presentation = record(summary["presentation"]);
  const project = record(summary["project"]);
  const source = record(summary["source"]);
  const lifecycle = text(summary["lifecycle"]);
  const terminalOutcome = nullableText(summary["terminalOutcome"]);
  const projectDescription = optionalSafeValue(presentation["projectDescription"]);
  const workspace = optionalSafeValue(record(source["submittedFrom"])["path"])
    ?? optionalSafeValue(project["repositoryPath"])
    ?? optionalSafeValue(presentation["workspace"]);
  const acceptedAt = optionalSafeValue(summary["acceptedAt"]);
  return {
    runId: safeValue(summary["runId"], "Unknown run"),
    title: safeValue(summary["title"], safeValue(presentation["title"], deriveTitle(summary))),
    projectName: safeValue(project["title"], safeValue(presentation["projectName"], "Unknown project")),
    ...(projectDescription === undefined ? {} : { projectDescription }),
    ...(workspace === undefined ? {} : { workspace }),
    sourceLabel: safeValue(presentation["sourceLabel"], sourceLabel(text(source["kind"]))),
    statusLabel: statusLabel(lifecycle, terminalOutcome),
    attentionRequired: summary["attentionRequired"] === true || lifecycle === "waiting" || lifecycle === "awaiting_approval",
    ...(acceptedAt === undefined ? {} : { startedAt: acceptedAt }),
  };
}

export function toRunStatusView(input: unknown): RunStatusView {
  const detail = record(input);
  const run = record(detail["run"]);
  const presentation = record(detail["presentation"]);
  const summary = toRunListItemView({
    ...run,
    presentation,
    acceptedAt: detail["acceptedAt"],
    attentionRequired: pendingAttention(detail).length > 0,
  });
  const lifecycle = text(run["lifecycle"]);
  const terminalOutcome = nullableText(run["terminalOutcome"]);
  const analysis = record(detail["analysis"]);
  const planning = record(detail["planning"]);
  const attention = pendingAttention(detail);
  const cancellation = record(run["cancellation"]);
  const stage = stageLabel(lifecycle, run, analysis, planning);
  const cancellationReason = cancellationLabel(text(cancellation["reasonCode"]));
  const failureMessage = terminalOutcome === "failed" ? "The workflow ended with a safe internal failure." : undefined;
  const attentionMessage = attentionLabel(attention);
  const approval = approvalLabel(record(run["authority"])["approvalState"]);
  const updatedAt = optionalSafeValue(detail["updatedAt"]);
  return {
    ...summary,
    ...(stage === undefined ? {} : { stageLabel: stage }),
    summary: runSummary(lifecycle, terminalOutcome, stage, cancellationReason, attentionMessage),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(approval === undefined ? {} : { approvalLabel: approval }),
    ...(attentionMessage === undefined ? {} : { attentionMessage }),
    ...(cancellationReason === undefined ? {} : { cancellationReason }),
    ...(failureMessage === undefined ? {} : { failureMessage }),
    progress: progress(detail, lifecycle, terminalOutcome),
    suggestedCommands: nextCommands(summary.runId, lifecycle, terminalOutcome, attention),
    diagnostics: diagnostics(detail),
  };
}

export function formatTimestamp(value: string, style: "short" | "long" = "short"): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown";
  const options: Intl.DateTimeFormatOptions = style === "long"
    ? { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }
    : { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false };
  return new Intl.DateTimeFormat("en-GB", options).format(date).replace(",", " at");
}

export function truncateMiddle(value: string, width: number): string {
  const safe = terminalText(value);
  const characters = Array.from(safe);
  if (characters.length <= width) return safe;
  if (width <= 1) return "…".slice(0, width);
  const left = Math.ceil((width - 1) / 2);
  const right = Math.floor((width - 1) / 2);
  return `${characters.slice(0, left).join("")}…${characters.slice(characters.length - right).join("")}`;
}

export function formatWorkspace(value: string, width: number): string {
  return truncateMiddle(value, width);
}

export function supportsColour(input: { readonly isTTY: boolean; readonly noColor?: string }): boolean {
  return input.isTTY && input.noColor === undefined;
}

function listColumns(width: number): readonly Column[] {
  if (width >= 156) return [
    column("STATUS", 12, (item) => item.statusLabel),
    column("TITLE", 28, (item) => item.title),
    column("PROJECT", 18, (item) => item.projectName),
    column("SOURCE", 16, (item) => item.sourceLabel),
    column("WORKSPACE", 28, (item) => item.workspace ?? "-", true),
    column("STARTED", 17, (item) => item.startedAt === undefined ? "-" : formatTimestamp(item.startedAt)),
    column("ATTENTION", 10, (item) => item.attentionRequired ? "Required" : "None"),
    column("RUN ID", 20, (item) => item.runId, true),
  ];
  if (width >= 110) return [
    column("STATUS", 12, (item) => item.statusLabel),
    column("TITLE", 25, (item) => item.title),
    column("PROJECT", 15, (item) => item.projectName),
    column("SOURCE", 13, (item) => item.sourceLabel),
    column("STARTED", 15, (item) => item.startedAt === undefined ? "-" : formatTimestamp(item.startedAt)),
    column("RUN ID", Math.max(20, width - 90), (item) => item.runId, true),
  ];
  if (width >= 80) return [
    column("STATUS", 12, (item) => item.statusLabel),
    column("TITLE", 25, (item) => item.title),
    column("PROJECT", 16, (item) => item.projectName),
    column("RUN ID", Math.max(20, width - 59), (item) => item.runId, true),
  ];
  return [
    column("STATUS", 11, (item) => item.statusLabel),
    column("TITLE", Math.max(12, Math.floor((width - 14) * 0.55)), (item) => item.title),
    column("RUN ID", Math.max(12, width - 16 - Math.max(12, Math.floor((width - 14) * 0.55))), (item) => item.runId, true),
  ];
}

function column(heading: string, width: number, value: Column["value"], middle = false): Column {
  return { heading, width, value, ...(middle ? { middle: true } : {}) };
}

function row(columns: readonly Column[], get: (column: Column) => string, item?: RunListItemView): string {
  return columns.map((column) => {
    const raw = item === undefined ? get(column) : column.value(item);
    const value = column.middle === true ? truncateMiddle(raw, column.width) : truncateEnd(raw, column.width);
    return value.padEnd(column.width);
  }).join("  ").trimEnd();
}

function truncateEnd(value: string, width: number): string {
  const safe = terminalText(value);
  const characters = Array.from(safe);
  if (characters.length <= width) return safe;
  if (width <= 1) return "…".slice(0, width);
  return `${characters.slice(0, width - 1).join("")}…`;
}

function labelled(items: readonly (readonly [string, string | undefined])[]): string {
  const present = items.filter((item): item is readonly [string, string] => item[1] !== undefined);
  const width = Math.max(...present.map(([label]) => label.length), 0) + 2;
  return present.map(([label, value]) => `${`${label}:`.padEnd(width)}${terminalText(value)}`).join("\n");
}

function progress(detail: Readonly<Record<string, unknown>>, lifecycle: string, terminalOutcome: string | null): RunStatusView["progress"] {
  const intakeStatus = text(record(detail["intake"])["status"]);
  const analysisStatus = text(record(detail["analysis"])["status"]);
  const planningStatus = text(record(detail["planning"])["status"]);
  const approvalState = text(record(record(detail["run"])["authority"])["approvalState"]);
  return [
    { stage: "Intake", status: stageStatus(intakeStatus, lifecycle === "intake" || lifecycle === "preflighting") },
    { stage: "Analysis", status: stageStatus(analysisStatus, lifecycle === "analyzing" || lifecycle === "waiting") },
    { stage: "Planning", status: planningStatus === "proposed" ? "Complete" : stageStatus(planningStatus, lifecycle === "planning") },
    { stage: "Approval", status: approvalState === "approval_pending" ? "Waiting" : approvalState === "approved" ? "Complete" : approvalState === "rejected" ? "Rejected" : "Not requested" },
    { stage: "Execution", status: terminalOutcome === "completed" ? "Complete" : lifecycle === "approved_and_ready_for_execution" ? "Ready" : terminalOutcome === null ? "Not started" : titleCase(terminalOutcome) },
  ];
}

function stageStatus(value: string, active: boolean): string {
  if (value === "closed" || value === "completed") return "Complete";
  if (value === "awaiting_answer") return "Waiting for answer";
  if (value === "budget_exhausted") return "Budget exhausted";
  if (value === "reconciliation_required") return "Needs reconciliation";
  if (["cancelled", "timed_out", "failed", "rejected"].includes(value)) return titleCase(value);
  if (value === "running" || active) return "Running";
  return "Not started";
}

function diagnostics(detail: Readonly<Record<string, unknown>>): RunStatusView["diagnostics"] {
  const run = record(detail["run"]);
  const intake = record(detail["intake"]);
  const attention = pendingAttention(detail);
  const values = [
    { label: "Lifecycle", value: titleCase(text(run["lifecycle"])) },
    { label: "Terminal outcome", value: nullableText(run["terminalOutcome"]) === null ? "None" : titleCase(text(run["terminalOutcome"])) },
    { label: "Project ID", value: safeValue(run["projectId"], "Unknown") },
    { label: "Stream version", value: Number.isSafeInteger(run["streamVersion"]) ? String(run["streamVersion"]) : "Unknown" },
    { label: "Accepted sources", value: Number.isSafeInteger(intake["sourceCount"]) ? String(intake["sourceCount"]) : "Unknown" },
    { label: "Rejected sources", value: Number.isSafeInteger(intake["rejectedCount"]) ? String(intake["rejectedCount"]) : "Unknown" },
    { label: "Pending decisions", value: String(attention.length) },
  ];
  return values;
}

function pendingAttention(detail: Readonly<Record<string, unknown>>): readonly Readonly<Record<string, unknown>>[] {
  const values = Array.isArray(detail["attention"]) ? detail["attention"] : [];
  return values.map(record).filter((item) => item["status"] === "pending");
}

function attentionLabel(attention: readonly Readonly<Record<string, unknown>>[]): string | undefined {
  if (attention.some((item) => item["kind"] === "approval")) return "Approval required";
  if (attention.some((item) => item["kind"] === "question" && item["material"] === true)) return "Question requires a response";
  if (attention.length > 0) return "Review requested";
  return undefined;
}

function nextCommands(runId: string, lifecycle: string, outcome: string | null, attention: readonly Readonly<Record<string, unknown>>[]): readonly string[] {
  if (attention.length > 0) return [`zentra status ${runId} --verbose`];
  if (outcome !== null) return ["zentra run \"<goal>\""];
  if (lifecycle === "approved_and_ready_for_execution") return [`zentra status ${runId}`];
  return [`zentra status ${runId}`];
}

function runSummary(lifecycle: string, outcome: string | null, stage: string | undefined, cancellation: string | undefined, attention: string | undefined): string {
  if (outcome === "cancelled") return `The run was cancelled${cancellation === undefined ? "" : ` ${cancellation}`}${stage === undefined ? "" : ` during ${stage.toLowerCase()}`}.`;
  if (outcome === "failed") return `The run failed${stage === undefined ? "" : ` during ${stage.toLowerCase()}`}. Internal diagnostics are hidden from terminal output.`;
  if (outcome === "completed") return "The run completed successfully.";
  if (outcome === "timed_out") return `The run timed out${stage === undefined ? "" : ` during ${stage.toLowerCase()}`}.`;
  if (outcome === "denied") return "The run ended because authority was denied.";
  if (attention !== undefined) return `The run is waiting. ${attention}.`;
  if (lifecycle === "blocked") return `The run is blocked${stage === undefined ? "" : ` during ${stage.toLowerCase()}`}.`;
  return `The run is ${statusLabel(lifecycle, null).toLowerCase()}${stage === undefined ? "" : ` in ${stage.toLowerCase()}`}.`;
}

function stageLabel(lifecycle: string, run: Readonly<Record<string, unknown>>, analysis: Readonly<Record<string, unknown>>, planning: Readonly<Record<string, unknown>>): string | undefined {
  const effective = lifecycle === "waiting" || lifecycle === "blocked" ? text(run["suspendedFrom"]) : lifecycle;
  if (["accepted", "preflighting", "intake"].includes(effective)) return "Intake";
  if (effective === "analyzing" || text(analysis["status"]) === "awaiting_answer") return "Analysis";
  if (effective === "planning") return "Planning";
  if (effective === "awaiting_approval") return "Approval";
  if (effective === "approved_and_ready_for_execution") return "Execution";
  if (lifecycle === "terminal") {
    const cancellation = record(run["cancellation"]);
    const observed = text(cancellation["observedLifecycle"]);
    if (observed !== "") return stageLabel(observed, {}, analysis, planning);
    if (text(planning["status"]) !== "not_started" && text(planning["status"]) !== "") return "Planning";
    if (text(analysis["status"]) !== "not_started" && text(analysis["status"]) !== "") return "Analysis";
  }
  return undefined;
}

function deriveTitle(summary: Readonly<Record<string, unknown>>): string {
  const source = record(summary["source"]);
  const candidate = optionalSafeValue(source["title"])
    ?? optionalSafeValue(summary["projectName"]);
  return candidate ?? "Untitled run";
}

function statusLabel(lifecycle: string, outcome: string | null): string {
  if (lifecycle === "terminal" && outcome !== null) return titleCase(outcome);
  const labels: Readonly<Record<string, string>> = {
    accepted: "Accepted",
    preflighting: "Starting",
    intake: "Intake",
    analyzing: "Running",
    waiting: "Waiting",
    blocked: "Blocked",
    planning: "Planning",
    awaiting_approval: "Awaiting approval",
    approved_and_ready_for_execution: "Ready",
    terminal: "Finished",
  };
  return labels[lifecycle] ?? titleCase(lifecycle || "unknown");
}

function approvalLabel(value: unknown): string | undefined {
  const labels: Readonly<Record<string, string>> = {
    not_proposed: "Not requested",
    approval_pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
  };
  return labels[text(value)];
}

function cancellationLabel(value: string): string | undefined {
  const labels: Readonly<Record<string, string>> = {
    operator_requested: "by the operator",
    service_shutdown: "when the service shut down",
    source_withdrawn: "because its source was withdrawn",
    superseded: "because it was superseded",
  };
  return labels[value];
}

function sourceLabel(kind: string): string {
  if (kind === "inline_goal") return "Inline goal";
  if (kind === "ticket_directory") return "Tickets";
  return "Unknown source";
}

function titleCase(value: string): string {
  return terminalText(value.replaceAll("_", " ")).replace(/^./u, (first) => first.toUpperCase());
}

function terminalText(value: string): string {
  return value.replace(UNSAFE_TERMINAL_CHARACTERS, " ").replace(/\s+/gu, " ").trim();
}

function safeValue(value: unknown, fallback: string): string {
  const safe = optionalSafeValue(value);
  return safe === undefined ? fallback : safe;
}

function optionalSafeValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const safe = terminalText(value);
  return safe === "" ? undefined : safe;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function boundedWidth(value: number | undefined): number {
  return Number.isSafeInteger(value) ? Math.min(240, Math.max(40, value!)) : 120;
}
