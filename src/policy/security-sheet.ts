import { closeSync, fstatSync, openSync, readSync, realpathSync } from "node:fs";

const MAX_SECURITY_SHEET_BYTES = 256 * 1024;
const MAX_TEXT_BYTES = 4096;

const SECTION_NAMES = new Set([
  "Allowed Repositories",
  "Allowed File Scopes",
  "Forbidden Paths",
  "Network",
  "Secret Handling",
  "Approval Required Operations",
  "Release Boundary",
  "Stop And Ask Conditions",
]);

const REQUIRED_SECTIONS = [
  "Allowed Repositories",
  "Allowed File Scopes",
  "Forbidden Paths",
  "Secret Handling",
  "Approval Required Operations",
  "Release Boundary",
  "Stop And Ask Conditions",
] as const;

const APPROVAL_OPERATIONS = new Set([
  "external_effect",
  "publish_release",
  "push_branch",
  "create_pull_request",
  "create_tag",
  "access_secret",
  "network_access",
  "modify_protected_path",
]);

const RELEASE_BOUNDARIES = new Set([
  "local_preparation_only",
  "approval_required_for_remote",
  "no_release_operations",
]);

const STOP_AND_ASK_CONDITIONS = new Set([
  "missing_authority",
  "undeclared_network",
  "forbidden_file_scope",
  "release_boundary",
  "budget_exceeded",
  "uncertain_effect",
  "plan_not_ready",
]);

export type SecuritySheetErrorCode =
  | "SECURITY_SHEET_TOO_LARGE"
  | "SECURITY_SHEET_READ_FAILED"
  | "SECURITY_SHEET_MISSING_SECTION"
  | "SECURITY_SHEET_DUPLICATE_SECTION"
  | "SECURITY_SHEET_UNKNOWN_SECTION"
  | "SECURITY_SHEET_INVALID_REPOSITORY"
  | "SECURITY_SHEET_INVALID_PATH_SCOPE"
  | "SECURITY_SHEET_INVALID_NETWORK_POLICY"
  | "SECURITY_SHEET_INVALID_NETWORK_DESTINATION"
  | "SECURITY_SHEET_INVALID_APPROVAL_OPERATION"
  | "SECURITY_SHEET_INVALID_RELEASE_BOUNDARY"
  | "SECURITY_SHEET_INVALID_STOP_CONDITION"
  | "SECURITY_SHEET_CONTRADICTORY_SCOPE";

export class SecuritySheetError extends Error {
  constructor(readonly code: SecuritySheetErrorCode) {
    super(publicSecuritySheetErrorMessage(code));
    this.name = "SecuritySheetError";
  }
}

export interface NetworkPolicy {
  readonly default: "denied";
  readonly allowedDestinations: readonly string[];
}

export interface SecuritySheet {
  readonly allowedRepositories: readonly string[];
  readonly allowedFileScopes: readonly string[];
  readonly forbiddenPaths: readonly string[];
  readonly network: NetworkPolicy;
  readonly secretHandling: readonly string[];
  readonly approvalRequiredOperations: readonly string[];
  readonly releaseBoundary: string;
  readonly stopAndAskConditions: readonly string[];
}

export interface PublicSecuritySheetSummary {
  readonly allowedRepositoryCount: number;
  readonly allowedFileScopeCount: number;
  readonly forbiddenPathCount: number;
  readonly network: {
    readonly default: "denied";
    readonly allowedDestinationCount: number;
  };
  readonly secretHandlingRules: number;
  readonly approvalRequiredOperations: readonly string[];
  readonly releaseBoundary: string;
  readonly stopAndAskConditions: readonly string[];
}

export function loadSecuritySheet(sheetPath: string): SecuritySheet {
  let file: number | null = null;
  try {
    file = openSync(sheetPath, "r");
    const stat = fstatSync(file);
    if (!stat.isFile()) throw new SecuritySheetError("SECURITY_SHEET_READ_FAILED");
    if (stat.size > MAX_SECURITY_SHEET_BYTES) {
      throw new SecuritySheetError("SECURITY_SHEET_TOO_LARGE");
    }
    const buffer = Buffer.alloc(MAX_SECURITY_SHEET_BYTES + 1);
    const bytesRead = readSync(file, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_SECURITY_SHEET_BYTES) {
      throw new SecuritySheetError("SECURITY_SHEET_TOO_LARGE");
    }
    return parseSecuritySheetMarkdown(buffer.subarray(0, bytesRead).toString("utf8"));
  } catch (error) {
    if (error instanceof SecuritySheetError) throw error;
    throw new SecuritySheetError("SECURITY_SHEET_READ_FAILED");
  } finally {
    if (file !== null) closeSync(file);
  }
}

export function parseSecuritySheetMarkdown(markdown: string): SecuritySheet {
  if (Buffer.byteLength(markdown, "utf8") > MAX_SECURITY_SHEET_BYTES) {
    throw new SecuritySheetError("SECURITY_SHEET_TOO_LARGE");
  }

  const sections = parseSections(markdown);
  for (const section of REQUIRED_SECTIONS) {
    if (!sections.has(section)) {
      throw new SecuritySheetError("SECURITY_SHEET_MISSING_SECTION");
    }
  }

  const allowedRepositories = parseAllowedRepositories(required(sections, "Allowed Repositories"));
  const allowedFileScopes = parsePathScopes(required(sections, "Allowed File Scopes"));
  const forbiddenPaths = parsePathScopes(required(sections, "Forbidden Paths"));
  assertNoScopeContradictions(allowedFileScopes, forbiddenPaths);

  return Object.freeze({
    allowedRepositories: Object.freeze(allowedRepositories),
    allowedFileScopes: Object.freeze(allowedFileScopes),
    forbiddenPaths: Object.freeze(forbiddenPaths),
    network: Object.freeze(parseNetwork(sections.get("Network") ?? [])),
    secretHandling: Object.freeze(unique(bulletValues(
      required(sections, "Secret Handling"),
      "SECURITY_SHEET_MISSING_SECTION",
    ))),
    approvalRequiredOperations: Object.freeze(parseEnumList(
      required(sections, "Approval Required Operations"),
      APPROVAL_OPERATIONS,
      "SECURITY_SHEET_INVALID_APPROVAL_OPERATION",
    )),
    releaseBoundary: parseReleaseBoundary(required(sections, "Release Boundary")),
    stopAndAskConditions: Object.freeze(parseEnumList(
      required(sections, "Stop And Ask Conditions"),
      STOP_AND_ASK_CONDITIONS,
      "SECURITY_SHEET_INVALID_STOP_CONDITION",
    )),
  });
}

export function publicSecuritySheetSummary(sheet: SecuritySheet): PublicSecuritySheetSummary {
  return Object.freeze({
    allowedRepositoryCount: sheet.allowedRepositories.length,
    allowedFileScopeCount: sheet.allowedFileScopes.length,
    forbiddenPathCount: sheet.forbiddenPaths.length,
    network: Object.freeze({
      default: sheet.network.default,
      allowedDestinationCount: sheet.network.allowedDestinations.length,
    }),
    secretHandlingRules: sheet.secretHandling.length,
    approvalRequiredOperations: Object.freeze([...sheet.approvalRequiredOperations]),
    releaseBoundary: sheet.releaseBoundary,
    stopAndAskConditions: Object.freeze([...sheet.stopAndAskConditions]),
  });
}

function parseSections(markdown: string): Map<string, readonly string[]> {
  const sections = new Map<string, string[]>();
  let current: string | null = null;
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      const name = heading[1]!;
      if (!SECTION_NAMES.has(name)) throw new SecuritySheetError("SECURITY_SHEET_UNKNOWN_SECTION");
      if (sections.has(name)) throw new SecuritySheetError("SECURITY_SHEET_DUPLICATE_SECTION");
      sections.set(name, []);
      current = name;
      continue;
    }
    if (current === null || line.trim() === "" || line.startsWith("# ")) continue;
    if (Buffer.byteLength(line, "utf8") > MAX_TEXT_BYTES) {
      throw new SecuritySheetError("SECURITY_SHEET_UNKNOWN_SECTION");
    }
    sections.get(current)!.push(line.trim());
  }
  return sections;
}

function required(
  sections: ReadonlyMap<string, readonly string[]>,
  section: string,
): readonly string[] {
  const lines = sections.get(section);
  if (lines === undefined) throw new SecuritySheetError("SECURITY_SHEET_MISSING_SECTION");
  return lines;
}

function bulletValues(lines: readonly string[], code: SecuritySheetErrorCode): string[] {
  const values: string[] = [];
  for (const line of lines) {
    if (!line.startsWith("- ")) throw new SecuritySheetError(code);
    const value = line.slice(2).trim();
    if (value === "") throw new SecuritySheetError(code);
    values.push(value);
  }
  if (values.length === 0) throw new SecuritySheetError(code);
  return values;
}

function parseAllowedRepositories(lines: readonly string[]): string[] {
  return unique(bulletValues(lines, "SECURITY_SHEET_INVALID_REPOSITORY").map((repository) => {
    let canonicalRepository: string;
    try {
      canonicalRepository = realpathSync.native(repository);
    } catch {
      throw new SecuritySheetError("SECURITY_SHEET_INVALID_REPOSITORY");
    }
    if (
      repository !== canonicalRepository ||
      repository.includes("\0") ||
      repository.includes("\n")
    ) {
      throw new SecuritySheetError("SECURITY_SHEET_INVALID_REPOSITORY");
    }
    return repository;
  }));
}

function parsePathScopes(lines: readonly string[]): string[] {
  return unique(bulletValues(lines, "SECURITY_SHEET_INVALID_PATH_SCOPE").map((scope) => {
    if (!isSafeLogicalGlob(scope)) throw new SecuritySheetError("SECURITY_SHEET_INVALID_PATH_SCOPE");
    return scope;
  }));
}

function parseEnumList(
  lines: readonly string[],
  allowed: ReadonlySet<string>,
  code: SecuritySheetErrorCode,
): string[] {
  return unique(bulletValues(lines, code).map((value) => {
    if (!allowed.has(value)) throw new SecuritySheetError(code);
    return value;
  }));
}

function parseReleaseBoundary(lines: readonly string[]): string {
  const values = lines.map((line) => line.startsWith("- ") ? line.slice(2).trim() : line.trim())
    .filter((line) => line !== "");
  if (values.length !== 1 || !RELEASE_BOUNDARIES.has(values[0]!)) {
    throw new SecuritySheetError("SECURITY_SHEET_INVALID_RELEASE_BOUNDARY");
  }
  return values[0]!;
}

function parseNetwork(lines: readonly string[]): NetworkPolicy {
  let defaultPolicy: string | null = null;
  let readingDestinations = false;
  const destinations: string[] = [];
  for (const line of lines) {
    if (line.startsWith("Default:")) {
      if (defaultPolicy !== null) throw new SecuritySheetError("SECURITY_SHEET_INVALID_NETWORK_POLICY");
      defaultPolicy = line.slice("Default:".length).trim();
      readingDestinations = false;
      continue;
    }
    if (line === "Allowed Destinations:") {
      readingDestinations = true;
      continue;
    }
    if (readingDestinations && line.startsWith("- ")) {
      destinations.push(normalizeNetworkDestination(line.slice(2).trim()));
      continue;
    }
    throw new SecuritySheetError("SECURITY_SHEET_INVALID_NETWORK_POLICY");
  }
  if (defaultPolicy === null) defaultPolicy = "denied";
  if (defaultPolicy !== "denied") throw new SecuritySheetError("SECURITY_SHEET_INVALID_NETWORK_POLICY");
  return { default: "denied", allowedDestinations: unique(destinations) };
}

function normalizeNetworkDestination(destination: string): string {
  let url: URL;
  try {
    url = new URL(destination);
  } catch {
    throw new SecuritySheetError("SECURITY_SHEET_INVALID_NETWORK_DESTINATION");
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    throw new SecuritySheetError("SECURITY_SHEET_INVALID_NETWORK_DESTINATION");
  }
  if (url.href !== `${url.origin}/`) {
    throw new SecuritySheetError("SECURITY_SHEET_INVALID_NETWORK_DESTINATION");
  }
  return url.origin;
}

function assertNoScopeContradictions(
  allowedScopes: readonly string[],
  forbiddenPaths: readonly string[],
): void {
  for (const allowedScope of allowedScopes) {
    for (const forbiddenPath of forbiddenPaths) {
      if (scopesOverlap(allowedScope, forbiddenPath)) {
        throw new SecuritySheetError("SECURITY_SHEET_CONTRADICTORY_SCOPE");
      }
    }
  }
}

function scopesOverlap(first: string, second: string): boolean {
  const firstBase = scopeBase(first);
  const secondBase = scopeBase(second);
  return firstBase === secondBase ||
    firstBase.startsWith(`${secondBase}/`) ||
    secondBase.startsWith(`${firstBase}/`);
}

function scopeBase(scope: string): string {
  return scope.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
}

function isSafeLogicalGlob(candidate: string): boolean {
  if (
    candidate.includes("\0") ||
    candidate.includes("\n") ||
    candidate.includes("\r") ||
    candidate.includes("\\")
  ) return false;
  if (candidate.includes("*")) {
    if (!candidate.endsWith("/**") || candidate.slice(0, -3).includes("*")) return false;
  }
  const withoutTrailingGlob = candidate.endsWith("/**") ? candidate.slice(0, -3) : candidate;
  if (/[?\[\]{}()!+@]/.test(withoutTrailingGlob)) return false;
  const segments = candidate.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function publicSecuritySheetErrorMessage(code: SecuritySheetErrorCode): string {
  const messages: Record<SecuritySheetErrorCode, string> = {
    SECURITY_SHEET_TOO_LARGE: "Security sheet is too large.",
    SECURITY_SHEET_READ_FAILED: "Security sheet could not be read.",
    SECURITY_SHEET_MISSING_SECTION: "Security sheet is missing a required section.",
    SECURITY_SHEET_DUPLICATE_SECTION: "Security sheet contains a duplicate section.",
    SECURITY_SHEET_UNKNOWN_SECTION: "Security sheet contains an unknown section.",
    SECURITY_SHEET_INVALID_REPOSITORY: "Security sheet contains an invalid repository entry.",
    SECURITY_SHEET_INVALID_PATH_SCOPE: "Security sheet contains an invalid path scope.",
    SECURITY_SHEET_INVALID_NETWORK_POLICY: "Security sheet network policy is invalid.",
    SECURITY_SHEET_INVALID_NETWORK_DESTINATION: "Security sheet network destination is invalid.",
    SECURITY_SHEET_INVALID_APPROVAL_OPERATION: "Security sheet approval operation is invalid.",
    SECURITY_SHEET_INVALID_RELEASE_BOUNDARY: "Security sheet release boundary is invalid.",
    SECURITY_SHEET_INVALID_STOP_CONDITION: "Security sheet stop-and-ask condition is invalid.",
    SECURITY_SHEET_CONTRADICTORY_SCOPE: "Security sheet contains contradictory file scope.",
  };
  return messages[code];
}
