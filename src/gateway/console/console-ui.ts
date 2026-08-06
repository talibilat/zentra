import { createHash } from "node:crypto";

import { SHELL_MARKUP, SHELL_SCRIPT } from "./shell.js";
import { CONTROLS_SCRIPT } from "./controls-section.js";
import { TRAIL_SCRIPT } from "./trail-section.js";
import { OVERVIEW_SCRIPT } from "./overview-section.js";
import { WARNINGS_SCRIPT } from "./warnings-section.js";
import { SECURITY_SCRIPT } from "./security-section.js";
import { COST_SCRIPT } from "./cost-section.js";
import { COMPARE_SCRIPT } from "./compare-section.js";
import { IMPORTS_SCRIPT } from "./imports-section.js";
import { POLICIES_SCRIPT } from "./policies-section.js";
import { PODS_SCRIPT } from "./pods-section.js";
import { MILESTONES_SCRIPT } from "./milestones-section.js";
import { GITHUB_BROKER_SCRIPT } from "./github-broker-section.js";

const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${WARNINGS_SCRIPT}\n${SECURITY_SCRIPT}\n${COST_SCRIPT}\n${COMPARE_SCRIPT}\n${IMPORTS_SCRIPT}\n${POLICIES_SCRIPT}\n${PODS_SCRIPT}\n${MILESTONES_SCRIPT}\n${GITHUB_BROKER_SCRIPT}\n${SHELL_SCRIPT}})();`;

export const CONSOLE_SCRIPT_SHA256 = createHash("sha256").update(CONSOLE_SCRIPT, "utf8").digest("base64");

export function consoleHtml(): string {
  return SHELL_MARKUP.replace("</body></html>", `<script>${CONSOLE_SCRIPT}</script></body></html>`);
}
