import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadSecuritySheet,
  parseSecuritySheetMarkdown,
  publicSecuritySheetSummary,
  SecuritySheetError,
} from "../../src/policy/security-sheet.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixtureRepository(): string {
  const directory = mkdtempSync(path.join(tmpdir(), "zentra-security-repo-"));
  temporaryDirectories.push(directory);
  return realpathSync.native(directory);
}

function validSheet(repository = fixtureRepository()): string {
  return `# Zentra Security Sheet

## Allowed Repositories
- ${repository}

## Allowed File Scopes
- src/**
- tests/**

## Forbidden Paths
- .env
- secrets/**

## Network
Default: denied
Allowed Destinations:
- https://api.github.com

## Secret Handling
- Workers must not receive raw parent environment secrets.
- Use handles instead of credential values.

## Approval Required Operations
- external_effect
- publish_release

## Release Boundary
local_preparation_only

## Stop And Ask Conditions
- missing_authority
- undeclared_network
- forbidden_file_scope
`;
}

describe("security sheet parser", () => {
  it("parses the operator Markdown sheet into typed policy constraints", () => {
    const repository = fixtureRepository();
    const parsed = parseSecuritySheetMarkdown(validSheet(repository));

    expect(parsed.allowedRepositories).toEqual([repository]);
    expect(parsed.allowedFileScopes).toEqual(["src/**", "tests/**"]);
    expect(parsed.forbiddenPaths).toEqual([".env", "secrets/**"]);
    expect(parsed.network).toEqual({
      default: "denied",
      allowedDestinations: ["https://api.github.com"],
    });
    expect(parsed.secretHandling).toHaveLength(2);
    expect(parsed.approvalRequiredOperations).toEqual(["external_effect", "publish_release"]);
    expect(parsed.releaseBoundary).toBe("local_preparation_only");
    expect(parsed.stopAndAskConditions).toEqual([
      "missing_authority",
      "undeclared_network",
      "forbidden_file_scope",
    ]);
  });

  it("loads a Markdown security sheet from disk", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "zentra-security-sheet-"));
    temporaryDirectories.push(directory);
    const sheetPath = path.join(directory, "SECURITY-SHEET.md");
    writeFileSync(sheetPath, validSheet(), "utf8");

    expect(loadSecuritySheet(sheetPath).releaseBoundary).toBe("local_preparation_only");
  });

  it("defaults network to denied when the network section is omitted", () => {
    const parsed = parseSecuritySheetMarkdown(validSheet().replace(
      /\n## Network\nDefault: denied\nAllowed Destinations:\n- https:\/\/api\.github\.com\n/,
      "\n",
    ));

    expect(parsed.network).toEqual({ default: "denied", allowedDestinations: [] });
  });

  it("fails closed with a stable code when a required section is missing", () => {
    const sheet = validSheet();
    expect(() => parseSecuritySheetMarkdown(sheet.replace(/## Release Boundary[\s\S]*?\n## Stop And Ask Conditions/, "## Stop And Ask Conditions")))
      .toThrow(SecuritySheetError);
    try {
      parseSecuritySheetMarkdown(sheet.replace(/## Release Boundary[\s\S]*?\n## Stop And Ask Conditions/, "## Stop And Ask Conditions"));
    } catch (error) {
      expect(error).toMatchObject({ code: "SECURITY_SHEET_MISSING_SECTION" });
    }
  });

  it("fails closed on duplicate or unknown sections", () => {
    const sheet = validSheet();
    expectErrorCode(
      () => parseSecuritySheetMarkdown(`${sheet}\n## Forbidden Paths\n- other\n`),
      "SECURITY_SHEET_DUPLICATE_SECTION",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(`${sheet}\n## Surprise Authority\n- yes\n`),
      "SECURITY_SHEET_UNKNOWN_SECTION",
    );
  });

  it("rejects unsafe repository, scope, and forbidden path values", () => {
    const repository = fixtureRepository();
    const sheet = validSheet(repository);
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace(repository, "relative/repo")),
      "SECURITY_SHEET_INVALID_REPOSITORY",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("src/**", "../outside")),
      "SECURITY_SHEET_INVALID_PATH_SCOPE",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("secrets/**", "/absolute/secret")),
      "SECURITY_SHEET_INVALID_PATH_SCOPE",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("src/**", "/**")),
      "SECURITY_SHEET_INVALID_PATH_SCOPE",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("src/**", "")),
      "SECURITY_SHEET_INVALID_PATH_SCOPE",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace(repository, `${repository}/..`)),
      "SECURITY_SHEET_INVALID_REPOSITORY",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("src/**", "**")),
      "SECURITY_SHEET_INVALID_PATH_SCOPE",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("src/**", "src/*.ts")),
      "SECURITY_SHEET_INVALID_PATH_SCOPE",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("src/**", "src/?")),
      "SECURITY_SHEET_INVALID_PATH_SCOPE",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("src/**", "src/[abc]")),
      "SECURITY_SHEET_INVALID_PATH_SCOPE",
    );
  });

  it("rejects unsafe network policy ambiguity", () => {
    const sheet = validSheet();
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("Default: denied", "Default: maybe")),
      "SECURITY_SHEET_INVALID_NETWORK_POLICY",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("https://api.github.com", "http://api.github.com")),
      "SECURITY_SHEET_INVALID_NETWORK_DESTINATION",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("Default: denied", "Default: allowed")),
      "SECURITY_SHEET_INVALID_NETWORK_POLICY",
    );
  });

  it("rejects invalid approval operations, release boundaries, and stop conditions", () => {
    const sheet = validSheet();
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("external_effect", "anything_goes")),
      "SECURITY_SHEET_INVALID_APPROVAL_OPERATION",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("local_preparation_only", "publish_everything")),
      "SECURITY_SHEET_INVALID_RELEASE_BOUNDARY",
    );
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("missing_authority", "ignore_security")),
      "SECURITY_SHEET_INVALID_STOP_CONDITION",
    );
  });

  it("rejects an allowed scope that overlaps a forbidden path", () => {
    const sheet = validSheet();
    expectErrorCode(
      () => parseSecuritySheetMarkdown(sheet.replace("src/**", "secrets/**")),
      "SECURITY_SHEET_CONTRADICTORY_SCOPE",
    );
  });

  it("wraps file access failures in stable public errors", () => {
    expectErrorCode(
      () => loadSecuritySheet("/path/that/does/not/exist.md"),
      "SECURITY_SHEET_READ_FAILED",
    );
  });

  it("summarizes parsed constraints without exposing secret handling prose", () => {
    const parsed = parseSecuritySheetMarkdown(validSheet().replace(
      "Workers must not receive raw parent environment secrets.",
      "API token sk-live-SECRET must never be printed.",
    ));

    const summary = publicSecuritySheetSummary(parsed);

    expect(summary.secretHandlingRules).toBe(2);
    expect("secretHandlingDigest" in summary).toBe(false);
    expect(JSON.stringify(summary)).not.toContain("sk-live-SECRET");
    expect(summary).toMatchObject({
      allowedRepositoryCount: 1,
      allowedFileScopeCount: 2,
      forbiddenPathCount: 2,
      network: { default: "denied", allowedDestinationCount: 1 },
      releaseBoundary: "local_preparation_only",
    });
  });
});

function expectErrorCode(
  operation: () => unknown,
  code: SecuritySheetError["code"],
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(SecuritySheetError);
    expect((error as SecuritySheetError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}
