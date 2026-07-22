import { createHash } from "node:crypto";

import { SHELL_MARKUP, SHELL_SCRIPT } from "./shell.js";
import { CONTROLS_SCRIPT } from "./controls-section.js";
import { TRAIL_SCRIPT } from "./trail-section.js";
import { OVERVIEW_SCRIPT } from "./overview-section.js";

const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${SHELL_SCRIPT}})();`;

export const CONSOLE_SCRIPT_SHA256 = createHash("sha256").update(CONSOLE_SCRIPT, "utf8").digest("base64");

export function consoleHtml(): string {
  return SHELL_MARKUP.replace("</body></html>", `<script>${CONSOLE_SCRIPT}</script></body></html>`);
}
