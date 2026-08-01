# Agent Rail Console Static Sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build six new console sections (Warnings, Security, Cost, Compare, Imports, Warning policies) matching the Claude design-tool mockup's visual design, with clearly-labeled static example data and every action-implying control rendered disabled, since no real backend exists for any of these six concepts yet.

**Architecture:** One new file per section under `src/gateway/console/`, each following `overview-section.ts`'s exact pattern (markup + script constant pair, DOM built via `document.createElement`/`setText`, single-quoted font-stack interpolation). Each section owns its own small inline hardcoded dataset and self-invokes its render function once at script load, since none of this content depends on which run is selected. `shell.ts` enables the six corresponding nav items and embeds each section's markup; `console-ui.ts` concatenates the six new scripts into the existing IIFE.

**Tech Stack:** TypeScript, Vitest, real-Chromium e2e via the existing `ChromiumWorkflowDriver`.

## Global Constraints

- No `innerHTML`/`outerHTML` with interpolated data anywhere in any new file — build DOM via `document.createElement` and `setText`, matching `overview-section.ts`.
- **Font-stack interpolation safety.** `CONSOLE_FONT_STACK_MONO`/`CONSOLE_FONT_STACK_SANS` contain literal double quotes. Any place `${CONSOLE_FONT_STACK_MONO}` or `${CONSOLE_FONT_STACK_SANS}` appears inside a JS string literal in a `String.raw` template must use single quotes, never double quotes — this broke the entire console script once already in this project. Each section isolates both interpolations into two one-line constants at the top of its `SCRIPT` export (e.g. `warningsFontSans`/`warningsFontMono`), then uses those browser-side variables via ordinary `+` string concatenation everywhere else, exactly like `trail-section.ts` already does.
- No functioning mutation anywhere in these six sections. Every control that implies a real backend action (acknowledge, suppress, import, toggle, pick-a-run-to-compare) renders visibly but `disabled`, with no click handler attached.
- Each section's data is static and identical regardless of which run is selected or whether any run is selected — do not read `state.selected`, `currentRun()`, or fetch anything.
- Each section's heading area carries an explicit note that the content is static example data, not real data.
- Use the literal `→` character directly in source when needed (not a `→` escape — `String.raw` does not interpret escape sequences, so an escape would appear literally in the rendered text).

---

### Task 1: Warnings section

**Files:**
- Create: `src/gateway/console/warnings-section.ts`
- Test: `tests/gateway/console/warnings-section.test.ts`

**Interfaces:**
- Consumes: `CONSOLE_FONT_STACK_MONO`, `CONSOLE_FONT_STACK_SANS` from `./design-tokens.js`; browser-scope helpers already in shared IIFE scope (`$`, `setText`).
- Produces: `export const WARNINGS_MARKUP: string`, `export const WARNINGS_SCRIPT: string`. `window.__consoleSections.warnings={render:renderWarnings}` registered (not consumed by any later task — self-invokes on load).

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/warnings-section.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { WARNINGS_MARKUP, WARNINGS_SCRIPT } from "../../../src/gateway/console/warnings-section.js";

describe("warnings section", () => {
  it("keeps a single root container for renderWarnings to populate", () => {
    expect(WARNINGS_MARKUP).toContain('id="warnings-root"');
  });

  it("shows an explicit preview note, not silently fake data", () => {
    expect(WARNINGS_SCRIPT).toContain("Preview: static example data");
  });

  it("renders at least one example warning card with code, actor, and summary", () => {
    expect(WARNINGS_SCRIPT).toContain("LOOP");
    expect(WARNINGS_SCRIPT).toContain("pod-b");
  });

  it("renders every action button disabled, with no click handler", () => {
    expect(WARNINGS_SCRIPT).toContain("button.disabled=true");
    expect(WARNINGS_SCRIPT).not.toContain("addEventListener");
  });

  it("never builds DOM with innerHTML", () => {
    expect(WARNINGS_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const lines = WARNINGS_SCRIPT.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.warnings.render and self-invokes on load", () => {
    expect(WARNINGS_SCRIPT).toContain("window.__consoleSections.warnings={render:renderWarnings}");
    expect(WARNINGS_SCRIPT.trim().endsWith("renderWarnings();")).toBe(true);
  });

  it("does not depend on the currently selected run", () => {
    expect(WARNINGS_SCRIPT).not.toContain("currentRun()");
    expect(WARNINGS_SCRIPT).not.toContain("state.selected");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/gateway/console/warnings-section.test.ts`
Expected: FAIL — `Cannot find module '../../../src/gateway/console/warnings-section.js'`

- [ ] **Step 3: Implement `warnings-section.ts`**

Create `src/gateway/console/warnings-section.ts`:

```typescript
import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const WARNINGS_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Warnings" id="warnings-root"></div>`;

export const WARNINGS_SCRIPT = String.raw`const warningsFontSans='${CONSOLE_FONT_STACK_SANS}';
const warningsFontMono='${CONSOLE_FONT_STACK_MONO}';
const WARNINGS_DEMO_DATA=[
  {code:"LOOP",actor:"pod-b",category:"heuristic",time:"14:02:11",summary:"Same tool call repeated 4 times with identical arguments inside one operation window.",evidence:"events evt-91, evt-94, evt-97, evt-101"},
  {code:"RETRY",actor:"pod-c",category:"heuristic",time:"14:05:47",summary:"Tool call retried after a transient failure without a backoff change.",evidence:"events evt-118, evt-121"},
  {code:"ORPHAN",actor:"pod-a",category:"structural",time:"14:11:03",summary:"Event references a parent span that was never observed.",evidence:"event evt-142"},
];
const warningsDisabledButton=(text)=>{const button=document.createElement("button");button.type="button";button.disabled=true;button.style.cssText="opacity:.5;cursor:not-allowed;background:var(--panel2);border:1px solid var(--line);color:var(--dim);border-radius:7px;padding:6px 12px;font:600 11px "+warningsFontSans;setText(button,text);return button};
const renderWarnings=()=>{
  const host=$("warnings-root");if(!host)return;host.replaceChildren();
  const heading=document.createElement("h1");heading.style.cssText="margin:0;font:700 20px "+warningsFontSans;setText(heading,"Warning triage");
  const note=document.createElement("p");note.style.cssText="margin:8px 0 18px;font:400 12.5px "+warningsFontSans+";color:var(--warn)";setText(note,"Preview: static example data, not yet wired to a real backend for this concept.");
  const list=document.createElement("div");list.style.cssText="display:flex;flex-direction:column;gap:10px;max-width:900px";
  for(const item of WARNINGS_DEMO_DATA){
    const card=document.createElement("div");card.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px";
    const top=document.createElement("div");top.style.cssText="display:flex;align-items:center;gap:10px;flex-wrap:wrap";
    const codeEl=document.createElement("span");codeEl.style.cssText="font:600 10.5px "+warningsFontMono+";color:var(--warn);background:rgba(255,180,84,.12);padding:3px 8px;border-radius:5px";setText(codeEl,item.code);
    const actorEl=document.createElement("span");actorEl.style.cssText="font:600 13px "+warningsFontMono;setText(actorEl,item.actor);
    const categoryEl=document.createElement("span");categoryEl.style.cssText="font:400 10.5px "+warningsFontMono+";color:var(--faint)";setText(categoryEl,item.category);
    const spacer=document.createElement("span");spacer.style.cssText="flex:1";
    const timeEl=document.createElement("span");timeEl.style.cssText="font:400 10.5px "+warningsFontMono+";color:var(--faint)";setText(timeEl,item.time);
    top.append(codeEl,actorEl,categoryEl,spacer,timeEl);
    const summaryEl=document.createElement("p");summaryEl.style.cssText="margin:9px 0 0;font:400 13px/1.6 "+warningsFontSans+";color:var(--text)";setText(summaryEl,item.summary);
    const evidenceEl=document.createElement("div");evidenceEl.style.cssText="font:400 11px "+warningsFontMono+";color:var(--dim);margin-top:7px";setText(evidenceEl,item.evidence);
    const actions=document.createElement("div");actions.style.cssText="display:flex;gap:8px;margin-top:12px";
    actions.append(warningsDisabledButton("Open evidence →"),warningsDisabledButton("Acknowledge"),warningsDisabledButton("Suppress in policy"));
    card.append(top,summaryEl,evidenceEl,actions);
    list.append(card);
  }
  host.append(heading,note,list);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.warnings={render:renderWarnings};
renderWarnings();`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/gateway/console/warnings-section.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/warnings-section.ts tests/gateway/console/warnings-section.test.ts
git commit -m "Add Warnings console section with static example data"
```

---

### Task 2: Security section

**Files:**
- Create: `src/gateway/console/security-section.ts`
- Test: `tests/gateway/console/security-section.test.ts`

**Interfaces:**
- Consumes: same as Task 1.
- Produces: `export const SECURITY_MARKUP: string`, `export const SECURITY_SCRIPT: string`. `window.__consoleSections.security={render:renderSecurity}`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/security-section.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { SECURITY_MARKUP, SECURITY_SCRIPT } from "../../../src/gateway/console/security-section.js";

describe("security section", () => {
  it("keeps a single root container for renderSecurity to populate", () => {
    expect(SECURITY_MARKUP).toContain('id="security-root"');
  });

  it("shows an explicit preview note", () => {
    expect(SECURITY_SCRIPT).toContain("Preview: static example data");
  });

  it("renders an example taint path with a chain of trust-labeled nodes", () => {
    expect(SECURITY_SCRIPT).toContain("planning-doc.md");
    expect(SECURITY_SCRIPT).toContain("untrusted");
  });

  it("renders chain nodes as disabled buttons, not real navigation", () => {
    expect(SECURITY_SCRIPT).toContain("button.disabled=true");
    expect(SECURITY_SCRIPT).not.toContain("addEventListener");
  });

  it("never builds DOM with innerHTML", () => {
    expect(SECURITY_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const lines = SECURITY_SCRIPT.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.security.render and self-invokes on load", () => {
    expect(SECURITY_SCRIPT).toContain("window.__consoleSections.security={render:renderSecurity}");
    expect(SECURITY_SCRIPT.trim().endsWith("renderSecurity();")).toBe(true);
  });

  it("does not depend on the currently selected run", () => {
    expect(SECURITY_SCRIPT).not.toContain("currentRun()");
    expect(SECURITY_SCRIPT).not.toContain("state.selected");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/gateway/console/security-section.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `security-section.ts`**

Create `src/gateway/console/security-section.ts`:

```typescript
import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const SECURITY_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Security" id="security-root"></div>`;

export const SECURITY_SCRIPT = String.raw`const securityFontSans='${CONSOLE_FONT_STACK_SANS}';
const securityFontMono='${CONSOLE_FONT_STACK_MONO}';
const SECURITY_DEMO_DATA={
  verdictTitle:"1 observed influence path reaches a sensitive capability",
  verdictSub:"Producer-declared trust labels propagated through one explicit influenced_by edge.",
  taintPaths:[
    {verdict:"OBSERVED",title:"Untrusted planning data reached a shell command argument",
     chain:[{label:"planning-doc.md",trust:"untrusted"},{label:"pod-b",trust:"orchestrator"},{label:"shell.run",trust:"sensitive capability"}],
     note:"pod-b read planning-doc.md and passed a derived value into a shell command argument without an intervening sanitization step."},
  ],
  trustLegend:[{label:"untrusted",color:"var(--err)"},{label:"orchestrator",color:"var(--accent)"},{label:"sensitive capability",color:"var(--warn)"}],
};
const securityChainButton=(node)=>{const button=document.createElement("button");button.type="button";button.disabled=true;button.style.cssText="opacity:.7;cursor:not-allowed;text-align:left;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 11px";const labelEl=document.createElement("span");labelEl.style.cssText="display:block;font:600 11.5px "+securityFontMono+";color:var(--text)";setText(labelEl,node.label);const trustEl=document.createElement("span");trustEl.style.cssText="display:block;font:400 9.5px "+securityFontMono+";color:var(--dim);margin-top:2px";setText(trustEl,node.trust);button.append(labelEl,trustEl);return button};
const renderSecurity=()=>{
  const host=$("security-root");if(!host)return;host.replaceChildren();
  const heading=document.createElement("h1");heading.style.cssText="margin:0;font:700 20px "+securityFontSans;setText(heading,"Taint security audit");
  const note=document.createElement("p");note.style.cssText="margin:8px 0 18px;font:400 12.5px "+securityFontSans+";color:var(--warn)";setText(note,"Preview: static example data, not yet wired to a real backend for this concept.");
  const verdict=document.createElement("div");verdict.style.cssText="display:flex;align-items:center;gap:13px;max-width:900px;padding:15px 18px;border-radius:11px;border:1px solid rgba(255,93,108,.45);background:rgba(255,93,108,.06);color:#ff8d99";
  const icon=document.createElement("span");icon.style.cssText="font-size:16px";setText(icon,"⚠");
  const verdictText=document.createElement("span");
  const verdictTitleEl=document.createElement("strong");verdictTitleEl.style.cssText="display:block;font:700 14px "+securityFontSans;setText(verdictTitleEl,SECURITY_DEMO_DATA.verdictTitle);
  const verdictSubEl=document.createElement("span");verdictSubEl.style.cssText="font:400 12px "+securityFontSans+";opacity:.85";setText(verdictSubEl,SECURITY_DEMO_DATA.verdictSub);
  verdictText.append(verdictTitleEl,verdictSubEl);
  verdict.append(icon,verdictText);
  const pathList=document.createElement("div");pathList.style.cssText="display:flex;flex-direction:column;gap:14px;margin-top:18px;max-width:900px";
  for(const path of SECURITY_DEMO_DATA.taintPaths){
    const card=document.createElement("div");card.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px";
    const top=document.createElement("div");top.style.cssText="display:flex;align-items:center;gap:9px;flex-wrap:wrap";
    const badge=document.createElement("span");badge.style.cssText="font:600 9.5px "+securityFontMono+";color:var(--err);border:1px solid var(--err);padding:3px 8px;border-radius:4px";setText(badge,path.verdict);
    const titleEl=document.createElement("span");titleEl.style.cssText="font:600 13px "+securityFontSans;setText(titleEl,path.title);
    top.append(badge,titleEl);
    const chain=document.createElement("div");chain.style.cssText="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px";
    path.chain.forEach((node,index)=>{
      chain.append(securityChainButton(node));
      if(index<path.chain.length-1){const arrow=document.createElement("span");arrow.style.cssText="color:var(--faint);font-size:13px";setText(arrow,"→");chain.append(arrow)}
    });
    const noteEl=document.createElement("p");noteEl.style.cssText="margin:12px 0 0;font:400 12px/1.6 "+securityFontSans+";color:var(--dim)";setText(noteEl,path.note);
    card.append(top,chain,noteEl);
    pathList.append(card);
  }
  const legend=document.createElement("div");legend.style.cssText="display:flex;gap:16px;margin-top:20px;flex-wrap:wrap";
  for(const entry of SECURITY_DEMO_DATA.trustLegend){
    const item=document.createElement("span");item.style.cssText="display:flex;align-items:center;gap:7px";
    const dot=document.createElement("span");dot.style.cssText="width:8px;height:8px;border-radius:50%;background:"+entry.color;
    const labelEl=document.createElement("span");labelEl.style.cssText="font:500 11px "+securityFontSans+";color:var(--dim)";setText(labelEl,entry.label);
    item.append(dot,labelEl);
    legend.append(item);
  }
  host.append(heading,note,verdict,pathList,legend);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.security={render:renderSecurity};
renderSecurity();`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/gateway/console/security-section.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/security-section.ts tests/gateway/console/security-section.test.ts
git commit -m "Add Security console section with static example data"
```

---

### Task 3: Cost section

**Files:**
- Create: `src/gateway/console/cost-section.ts`
- Test: `tests/gateway/console/cost-section.test.ts`

**Interfaces:**
- Consumes: same as Task 1.
- Produces: `export const COST_MARKUP: string`, `export const COST_SCRIPT: string`. `window.__consoleSections.cost={render:renderCost}`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/cost-section.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { COST_MARKUP, COST_SCRIPT } from "../../../src/gateway/console/cost-section.js";

describe("cost section", () => {
  it("keeps a single root container for renderCost to populate", () => {
    expect(COST_MARKUP).toContain('id="cost-root"');
  });

  it("shows an explicit preview note", () => {
    expect(COST_SCRIPT).toContain("Preview: static example data");
  });

  it("renders example cost buckets and per-actor rows", () => {
    expect(COST_SCRIPT).toContain("ATTRIBUTED");
    expect(COST_SCRIPT).toContain("pod-a");
  });

  it("never builds DOM with innerHTML", () => {
    expect(COST_SCRIPT).not.toContain("innerHTML");
  });

  it("has no click handlers on any row (no functioning drill-down)", () => {
    expect(COST_SCRIPT).not.toContain("addEventListener");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const lines = COST_SCRIPT.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.cost.render and self-invokes on load", () => {
    expect(COST_SCRIPT).toContain("window.__consoleSections.cost={render:renderCost}");
    expect(COST_SCRIPT.trim().endsWith("renderCost();")).toBe(true);
  });

  it("does not depend on the currently selected run", () => {
    expect(COST_SCRIPT).not.toContain("currentRun()");
    expect(COST_SCRIPT).not.toContain("state.selected");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/gateway/console/cost-section.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `cost-section.ts`**

Create `src/gateway/console/cost-section.ts`:

```typescript
import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const COST_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Cost" id="cost-root"></div>`;

export const COST_SCRIPT = String.raw`const costFontSans='${CONSOLE_FONT_STACK_SANS}';
const costFontMono='${CONSOLE_FONT_STACK_MONO}';
const COST_DEMO_DATA={
  buckets:[
    {label:"ATTRIBUTED",value:"$4.82",sub:"38 hunks · 4 actors"},
    {label:"PENDING",value:"$0.61",sub:"3 hunks awaiting verification"},
    {label:"UNATTRIBUTED",value:"$0.00",sub:"fully conserved"},
    {label:"TOTAL",value:"$5.43",sub:"across the run"},
  ],
  rows:[
    {actor:"pod-a",tin:"12.4k",tout:"3.1k",cost:"$1.94",share:36},
    {actor:"pod-b",tin:"9.8k",tout:"2.6k",cost:"$1.58",share:29},
    {actor:"pod-c",tin:"7.2k",tout:"2.0k",cost:"$1.30",share:24},
    {actor:"pod-d",tin:"3.1k",tout:"0.9k",cost:"$0.61",share:11},
  ],
  hunks:[
    {path:"src/runs/run-service.ts",range:"L214-L268",cost:"$0.82",meta:"pod-a · verified against 3 test runs"},
  ],
};
const renderCost=()=>{
  const host=$("cost-root");if(!host)return;host.replaceChildren();
  const heading=document.createElement("h1");heading.style.cssText="margin:0;font:700 20px "+costFontSans;setText(heading,"Outcome cost attribution");
  const note=document.createElement("p");note.style.cssText="margin:8px 0 18px;font:400 12.5px "+costFontSans+";color:var(--warn)";setText(note,"Preview: static example data, not yet wired to a real backend for this concept.");
  const bucketsRow=document.createElement("div");bucketsRow.style.cssText="display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;max-width:900px";
  for(const bucket of COST_DEMO_DATA.buckets){
    const tile=document.createElement("div");tile.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px";
    const labelEl=document.createElement("div");labelEl.style.cssText="font:500 10px "+costFontMono+";color:var(--faint);letter-spacing:1px";setText(labelEl,bucket.label);
    const valueEl=document.createElement("div");valueEl.style.cssText="font:600 22px "+costFontMono+";color:var(--warn);margin-top:4px";setText(valueEl,bucket.value);
    const subEl=document.createElement("div");subEl.style.cssText="font:400 10.5px "+costFontMono+";color:var(--dim);margin-top:5px";setText(subEl,bucket.sub);
    tile.append(labelEl,valueEl,subEl);
    bucketsRow.append(tile);
  }
  const actorHeading=document.createElement("h2");actorHeading.style.cssText="margin:26px 0 12px;font:600 14px "+costFontSans;setText(actorHeading,"By actor");
  const actorTable=document.createElement("div");actorTable.style.cssText="max-width:900px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden";
  const maxShare=Math.max(...COST_DEMO_DATA.rows.map((row)=>row.share));
  for(const row of COST_DEMO_DATA.rows){
    const rowEl=document.createElement("div");rowEl.style.cssText="display:grid;grid-template-columns:1.3fr .8fr .8fr .8fr 2fr;gap:0;padding:11px 18px;border-bottom:1px solid var(--line);align-items:center";
    const actorEl=document.createElement("span");actorEl.style.cssText="font:600 12.5px "+costFontMono;setText(actorEl,row.actor);
    const tinEl=document.createElement("span");tinEl.style.cssText="text-align:right;font:500 12px "+costFontMono;setText(tinEl,row.tin);
    const toutEl=document.createElement("span");toutEl.style.cssText="text-align:right;font:500 12px "+costFontMono;setText(toutEl,row.tout);
    const costEl=document.createElement("span");costEl.style.cssText="text-align:right;font:600 12px "+costFontMono+";color:var(--warn)";setText(costEl,row.cost);
    const barWrap=document.createElement("span");barWrap.style.cssText="padding-left:20px;display:block;height:8px;background:var(--panel2);border-radius:4px;overflow:hidden";
    const bar=document.createElement("span");bar.style.cssText="display:block;height:100%;background:var(--accent);width:"+Math.round(row.share/maxShare*100)+"%";
    barWrap.append(bar);
    rowEl.append(actorEl,tinEl,toutEl,costEl,barWrap);
    actorTable.append(rowEl);
  }
  const hunkHeading=document.createElement("h2");hunkHeading.style.cssText="margin:26px 0 12px;font:600 14px "+costFontSans;setText(hunkHeading,"Hunk-level attribution");
  const hunkList=document.createElement("div");hunkList.style.cssText="max-width:900px;display:flex;flex-direction:column;gap:10px";
  for(const hunk of COST_DEMO_DATA.hunks){
    const row=document.createElement("div");row.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:15px 18px";
    const top=document.createElement("div");top.style.cssText="display:flex;align-items:center;gap:10px;flex-wrap:wrap";
    const pathEl=document.createElement("span");pathEl.style.cssText="font:600 12.5px "+costFontMono+";color:var(--accent)";setText(pathEl,hunk.path);
    const rangeEl=document.createElement("span");rangeEl.style.cssText="font:400 10.5px "+costFontMono+";color:var(--faint)";setText(rangeEl,hunk.range);
    const spacer=document.createElement("span");spacer.style.cssText="flex:1";
    const costEl=document.createElement("span");costEl.style.cssText="font:600 13px "+costFontMono+";color:var(--warn)";setText(costEl,hunk.cost);
    top.append(pathEl,rangeEl,spacer,costEl);
    const metaEl=document.createElement("div");metaEl.style.cssText="font:400 11.5px "+costFontSans+";color:var(--dim);margin-top:6px";setText(metaEl,hunk.meta);
    row.append(top,metaEl);
    hunkList.append(row);
  }
  host.append(heading,note,bucketsRow,actorHeading,actorTable,hunkHeading,hunkList);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.cost={render:renderCost};
renderCost();`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/gateway/console/cost-section.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/cost-section.ts tests/gateway/console/cost-section.test.ts
git commit -m "Add Cost console section with static example data"
```

---

### Task 4: Compare section

**Files:**
- Create: `src/gateway/console/compare-section.ts`
- Test: `tests/gateway/console/compare-section.test.ts`

**Interfaces:**
- Consumes: same as Task 1.
- Produces: `export const COMPARE_MARKUP: string`, `export const COMPARE_SCRIPT: string`. `window.__consoleSections.compare={render:renderCompare}`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/compare-section.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { COMPARE_MARKUP, COMPARE_SCRIPT } from "../../../src/gateway/console/compare-section.js";

describe("compare section", () => {
  it("keeps a single root container for renderCompare to populate", () => {
    expect(COMPARE_MARKUP).toContain('id="compare-root"');
  });

  it("shows an explicit preview note", () => {
    expect(COMPARE_SCRIPT).toContain("Preview: static example data");
  });

  it("renders one fixed example comparison, not a functioning run picker", () => {
    expect(COMPARE_SCRIPT).toContain("compare-run-a.jsonl");
    expect(COMPARE_SCRIPT).toContain("compare-run-b.jsonl");
    expect(COMPARE_SCRIPT).not.toContain("addEventListener");
  });

  it("renders added and removed facts columns", () => {
    expect(COMPARE_SCRIPT).toContain("addedFacts");
    expect(COMPARE_SCRIPT).toContain("removedFacts");
  });

  it("never builds DOM with innerHTML", () => {
    expect(COMPARE_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const lines = COMPARE_SCRIPT.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.compare.render and self-invokes on load", () => {
    expect(COMPARE_SCRIPT).toContain("window.__consoleSections.compare={render:renderCompare}");
    expect(COMPARE_SCRIPT.trim().endsWith("renderCompare();")).toBe(true);
  });

  it("does not depend on the currently selected run", () => {
    expect(COMPARE_SCRIPT).not.toContain("currentRun()");
    expect(COMPARE_SCRIPT).not.toContain("state.selected");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/gateway/console/compare-section.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `compare-section.ts`**

Create `src/gateway/console/compare-section.ts`:

```typescript
import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const COMPARE_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Compare" id="compare-root"></div>`;

export const COMPARE_SCRIPT = String.raw`const compareFontSans='${CONSOLE_FONT_STACK_SANS}';
const compareFontMono='${CONSOLE_FONT_STACK_MONO}';
const COMPARE_DEMO_DATA={
  runA:{file:"compare-run-a.jsonl",meta:"42 events · 4 actors · integration tests passed"},
  runB:{file:"compare-run-b.jsonl",meta:"47 events · 4 actors · divergent context and tests"},
  divergenceText:"Both runs share an identical prefix through event evt-58; run B diverges at the context-compaction step that follows.",
  addedFacts:[
    {kind:"change",text:"src/runs/run-service.ts gained a new cancellation branch."},
    {kind:"verification",text:"An additional integration test now covers the cancellation path."},
  ],
  removedFacts:[
    {kind:"tool",text:"A redundant lint invocation was removed from the pre-commit step."},
  ],
  usageDelta:[
    {metric:"tokens in",a:"31.2k",b:"34.6k",delta:"+3.4k"},
    {metric:"tokens out",a:"8.9k",b:"9.7k",delta:"+0.8k"},
    {metric:"cost",a:"$4.61",b:"$5.02",delta:"+$0.41"},
  ],
};
const compareRunCard=(label,color,run)=>{const card=document.createElement("div");card.style.cssText="background:var(--panel);border:1px solid "+color+";border-radius:12px;padding:16px 18px";const labelEl=document.createElement("div");labelEl.style.cssText="font:600 10px "+compareFontMono+";color:"+color+";letter-spacing:1px";setText(labelEl,label);const fileEl=document.createElement("div");fileEl.style.cssText="font:600 15px "+compareFontSans+";margin-top:6px";setText(fileEl,run.file);const metaEl=document.createElement("div");metaEl.style.cssText="font:400 11px "+compareFontMono+";color:var(--dim);margin-top:4px";setText(metaEl,run.meta);card.append(labelEl,fileEl,metaEl);return card};
const compareFactColumn=(title,color,sign,facts)=>{
  const section=document.createElement("section");section.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px 18px";
  const heading=document.createElement("h2");heading.style.cssText="margin:0 0 12px;font:600 13px "+compareFontSans+";color:"+color;setText(heading,title+" ("+facts.length+" facts)");
  for(const fact of facts){
    const row=document.createElement("div");row.style.cssText="display:flex;gap:9px;padding:7px 0;border-bottom:1px solid var(--line);font:400 12px/1.5 "+compareFontSans+";color:var(--text)";
    const signEl=document.createElement("span");signEl.style.cssText="color:"+color+";font-family:"+compareFontMono+";flex:none";setText(signEl,sign);
    const textEl=document.createElement("span");
    const kindEl=document.createElement("span");kindEl.style.cssText="font:600 10px "+compareFontMono+";color:var(--dim)";setText(kindEl,"["+fact.kind+"] ");
    const bodyEl=document.createElement("span");setText(bodyEl,fact.text);
    textEl.append(kindEl,bodyEl);
    row.append(signEl,textEl);
    section.append(row);
  }
  section.prepend(heading);
  return section;
};
const renderCompare=()=>{
  const host=$("compare-root");if(!host)return;host.replaceChildren();
  const heading=document.createElement("h1");heading.style.cssText="margin:0;font:700 20px "+compareFontSans;setText(heading,"Run comparison");
  const note=document.createElement("p");note.style.cssText="margin:8px 0 18px;font:400 12.5px "+compareFontSans+";color:var(--warn)";setText(note,"Preview: static example data, not yet wired to a real backend for this concept.");
  const runRow=document.createElement("div");runRow.style.cssText="display:grid;grid-template-columns:1fr auto 1fr;gap:14px;align-items:stretch;max-width:980px";
  const vs=document.createElement("div");vs.style.cssText="display:flex;align-items:center;font:600 14px "+compareFontMono+";color:var(--faint)";setText(vs,"vs");
  runRow.append(compareRunCard("RUN A","var(--run)",COMPARE_DEMO_DATA.runA),vs,compareRunCard("RUN B","var(--orch)",COMPARE_DEMO_DATA.runB));
  const divergence=document.createElement("div");divergence.style.cssText="display:flex;align-items:center;gap:13px;max-width:980px;padding:14px 18px;border-radius:11px;border:1px solid var(--line);background:var(--panel);margin-top:16px";
  const divIcon=document.createElement("span");divIcon.style.cssText="font-size:15px";setText(divIcon,"⑂");
  const divText=document.createElement("span");
  const divTitle=document.createElement("strong");divTitle.style.cssText="display:block;font:700 13.5px "+compareFontSans;setText(divTitle,"Earliest supported divergence");
  const divSub=document.createElement("span");divSub.style.cssText="font:400 12px "+compareFontSans+";opacity:.9";setText(divSub,COMPARE_DEMO_DATA.divergenceText);
  divText.append(divTitle,divSub);
  divergence.append(divIcon,divText);
  const factsGrid=document.createElement("div");factsGrid.style.cssText="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:16px;max-width:980px";
  factsGrid.append(compareFactColumn("Only in Run B","var(--ok)","+",COMPARE_DEMO_DATA.addedFacts),compareFactColumn("Only in Run A","var(--err)","−",COMPARE_DEMO_DATA.removedFacts));
  const deltaHeading=document.createElement("h2");deltaHeading.style.cssText="margin:24px 0 12px;font:600 14px "+compareFontSans;setText(deltaHeading,"Usage delta");
  const deltaTable=document.createElement("div");deltaTable.style.cssText="max-width:980px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden";
  for(const row of COMPARE_DEMO_DATA.usageDelta){
    const rowEl=document.createElement("div");rowEl.style.cssText="display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;padding:11px 18px;border-bottom:1px solid var(--line);align-items:center";
    const metricEl=document.createElement("span");metricEl.style.cssText="font:500 12px "+compareFontSans;setText(metricEl,row.metric);
    const aEl=document.createElement("span");aEl.style.cssText="text-align:right;font:500 12px "+compareFontMono;setText(aEl,row.a);
    const bEl=document.createElement("span");bEl.style.cssText="text-align:right;font:500 12px "+compareFontMono;setText(bEl,row.b);
    const deltaEl=document.createElement("span");deltaEl.style.cssText="text-align:right;font:600 12px "+compareFontMono+";color:var(--warn)";setText(deltaEl,row.delta);
    rowEl.append(metricEl,aEl,bEl,deltaEl);
    deltaTable.append(rowEl);
  }
  host.append(heading,note,runRow,divergence,factsGrid,deltaHeading,deltaTable);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.compare={render:renderCompare};
renderCompare();`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/gateway/console/compare-section.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/compare-section.ts tests/gateway/console/compare-section.test.ts
git commit -m "Add Compare console section with one static example comparison"
```

---

### Task 5: Imports section

**Files:**
- Create: `src/gateway/console/imports-section.ts`
- Test: `tests/gateway/console/imports-section.test.ts`

**Interfaces:**
- Consumes: same as Task 1.
- Produces: `export const IMPORTS_MARKUP: string`, `export const IMPORTS_SCRIPT: string`. `window.__consoleSections.imports={render:renderImports}`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/imports-section.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { IMPORTS_MARKUP, IMPORTS_SCRIPT } from "../../../src/gateway/console/imports-section.js";

describe("imports section", () => {
  it("keeps a single root container for renderImports to populate", () => {
    expect(IMPORTS_MARKUP).toContain('id="imports-root"');
  });

  it("shows an explicit preview note", () => {
    expect(IMPORTS_SCRIPT).toContain("Preview: static example data");
  });

  it("renders example adapter sources", () => {
    expect(IMPORTS_SCRIPT).toContain("Claude Code session export");
  });

  it("renders the import button disabled, with no click handler", () => {
    expect(IMPORTS_SCRIPT).toContain("button.disabled=true");
    expect(IMPORTS_SCRIPT).not.toContain("addEventListener");
  });

  it("shows the empty state for recent imports, since none are real", () => {
    expect(IMPORTS_SCRIPT).toContain("No imports yet");
  });

  it("never builds DOM with innerHTML", () => {
    expect(IMPORTS_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const lines = IMPORTS_SCRIPT.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.imports.render and self-invokes on load", () => {
    expect(IMPORTS_SCRIPT).toContain("window.__consoleSections.imports={render:renderImports}");
    expect(IMPORTS_SCRIPT.trim().endsWith("renderImports();")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/gateway/console/imports-section.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `imports-section.ts`**

Create `src/gateway/console/imports-section.ts`:

```typescript
import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const IMPORTS_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Imports" id="imports-root"></div>`;

export const IMPORTS_SCRIPT = String.raw`const importsFontSans='${CONSOLE_FONT_STACK_SANS}';
const importsFontMono='${CONSOLE_FONT_STACK_MONO}';
const IMPORTS_DEMO_DATA=[
  {glyph:"◆",name:"Claude Code session export",format:"claude-code.jsonl",desc:"Converts a Claude Code session export into canonical JSONL, preserving tool calls and file edits.",cmd:"zentra import claude-code ./session.jsonl"},
  {glyph:"◇",name:"OpenCode session export",format:"opencode.jsonl",desc:"Converts an OpenCode session export into canonical JSONL.",cmd:"zentra import opencode ./session.jsonl"},
];
const renderImports=()=>{
  const host=$("imports-root");if(!host)return;host.replaceChildren();
  const heading=document.createElement("h1");heading.style.cssText="margin:0;font:700 20px "+importsFontSans;setText(heading,"Session imports");
  const note=document.createElement("p");note.style.cssText="margin:8px 0 18px;font:400 12.5px "+importsFontSans+";color:var(--warn)";setText(note,"Preview: static example data, not yet wired to a real backend for this concept.");
  const grid=document.createElement("div");grid.style.cssText="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;max-width:980px";
  for(const source of IMPORTS_DEMO_DATA){
    const card=document.createElement("div");card.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px";
    const top=document.createElement("div");top.style.cssText="display:flex;align-items:center;gap:10px";
    const iconEl=document.createElement("span");iconEl.style.cssText="width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:var(--panel2);color:var(--accent);font-size:15px";setText(iconEl,source.glyph);
    const nameWrap=document.createElement("span");
    const nameEl=document.createElement("strong");nameEl.style.cssText="display:block;font:600 13.5px "+importsFontSans;setText(nameEl,source.name);
    const formatEl=document.createElement("span");formatEl.style.cssText="font:400 10px "+importsFontMono+";color:var(--faint)";setText(formatEl,source.format);
    nameWrap.append(nameEl,formatEl);
    top.append(iconEl,nameWrap);
    const descEl=document.createElement("p");descEl.style.cssText="margin:11px 0 0;font:400 12px/1.55 "+importsFontSans+";color:var(--dim)";setText(descEl,source.desc);
    const cmdEl=document.createElement("pre");cmdEl.style.cssText="margin:11px 0 0;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:9px 11px;font:400 10px/1.6 "+importsFontMono+";color:var(--dim);white-space:pre-wrap;word-break:break-all";setText(cmdEl,source.cmd);
    const button=document.createElement("button");button.type="button";button.disabled=true;button.style.cssText="margin-top:12px;width:100%;opacity:.5;cursor:not-allowed;background:rgba(122,162,255,.12);border:1px solid var(--accent);color:var(--accent);border-radius:7px;padding:8px;font:600 11.5px "+importsFontSans;setText(button,"Import example session");
    card.append(top,descEl,cmdEl,button);
    grid.append(card);
  }
  const recentHeading=document.createElement("h2");recentHeading.style.cssText="margin:26px 0 12px;font:600 14px "+importsFontSans;setText(recentHeading,"Recent imports");
  const empty=document.createElement("div");empty.style.cssText="font:400 12.5px "+importsFontSans+";color:var(--faint);padding:14px;border:1px dashed var(--line);border-radius:10px;max-width:980px";setText(empty,"No imports yet — run one above, then open it from the run picker.");
  host.append(heading,note,grid,recentHeading,empty);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.imports={render:renderImports};
renderImports();`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/gateway/console/imports-section.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/imports-section.ts tests/gateway/console/imports-section.test.ts
git commit -m "Add Imports console section with static example data"
```

---

### Task 6: Warning policies section

**Files:**
- Create: `src/gateway/console/policies-section.ts`
- Test: `tests/gateway/console/policies-section.test.ts`

**Interfaces:**
- Consumes: same as Task 1.
- Produces: `export const POLICIES_MARKUP: string`, `export const POLICIES_SCRIPT: string`. `window.__consoleSections.policies={render:renderPolicies}`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/policies-section.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { POLICIES_MARKUP, POLICIES_SCRIPT } from "../../../src/gateway/console/policies-section.js";

describe("policies section", () => {
  it("keeps a single root container for renderPolicies to populate", () => {
    expect(POLICIES_MARKUP).toContain('id="policies-root"');
  });

  it("shows an explicit preview note", () => {
    expect(POLICIES_SCRIPT).toContain("Preview: static example data");
  });

  it("renders example policy rows with operation names", () => {
    expect(POLICIES_SCRIPT).toContain("tool.call.run_tests");
  });

  it("renders the suppress toggle disabled, with no click handler", () => {
    expect(POLICIES_SCRIPT).toContain("button.disabled=true");
    expect(POLICIES_SCRIPT).not.toContain("addEventListener");
  });

  it("never builds DOM with innerHTML", () => {
    expect(POLICIES_SCRIPT).not.toContain("innerHTML");
  });

  it("isolates font-stack interpolation inside single-quoted constants, never a double-quoted string", () => {
    const lines = POLICIES_SCRIPT.split("\n").filter((line) => line.includes("CONSOLE_FONT_STACK"));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toMatch(/"[^"]*\$\{CONSOLE_FONT_STACK_(MONO|SANS)\}/);
    }
  });

  it("registers itself under window.__consoleSections.policies.render and self-invokes on load", () => {
    expect(POLICIES_SCRIPT).toContain("window.__consoleSections.policies={render:renderPolicies}");
    expect(POLICIES_SCRIPT.trim().endsWith("renderPolicies();")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/gateway/console/policies-section.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `policies-section.ts`**

Create `src/gateway/console/policies-section.ts`:

```typescript
import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const POLICIES_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Policies" id="policies-root"></div>`;

export const POLICIES_SCRIPT = String.raw`const policiesFontSans='${CONSOLE_FONT_STACK_SANS}';
const policiesFontMono='${CONSOLE_FONT_STACK_MONO}';
const POLICIES_DEMO_DATA={
  suppressTotal:7,
  rows:[
    {op:"tool.call.run_tests",loop:4,retry:3,count:5,active:true},
    {op:"tool.call.git_status",loop:6,retry:5,count:2,active:false},
  ],
};
const renderPolicies=()=>{
  const host=$("policies-root");if(!host)return;host.replaceChildren();
  const heading=document.createElement("h1");heading.style.cssText="margin:0;font:700 20px "+policiesFontSans;setText(heading,"Warning policies");
  const note=document.createElement("p");note.style.cssText="margin:8px 0 18px;font:400 12.5px "+policiesFontSans+";color:var(--warn)";setText(note,"Preview: static example data, not yet wired to a real backend for this concept.");
  const infoBar=document.createElement("div");infoBar.style.cssText="display:flex;align-items:center;gap:12px;max-width:960px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;flex-wrap:wrap";
  const fileEl=document.createElement("span");fileEl.style.cssText="font:600 12.5px "+policiesFontMono+";color:var(--accent)";setText(fileEl,"examples/warning-policy.toml");
  const versionEl=document.createElement("span");versionEl.style.cssText="font:400 10.5px "+policiesFontMono+";color:var(--faint)";setText(versionEl,"version 3 · "+POLICIES_DEMO_DATA.suppressTotal+" suppressed findings retained");
  const spacer=document.createElement("span");spacer.style.cssText="flex:1";
  const restartBadge=document.createElement("span");restartBadge.style.cssText="font:600 9.5px "+policiesFontMono+";color:var(--warn);border:1px solid rgba(255,180,84,.45);padding:3px 8px;border-radius:4px";setText(restartBadge,"RESTART REQUIRED ON CHANGE");
  infoBar.append(fileEl,versionEl,spacer,restartBadge);
  const table=document.createElement("div");table.style.cssText="max-width:960px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:14px";
  const headerRow=document.createElement("div");headerRow.style.cssText="display:grid;grid-template-columns:1.4fr .9fr .9fr .9fr .9fr;padding:10px 18px;border-bottom:1px solid var(--line);font:600 10px "+policiesFontMono+";color:var(--faint);letter-spacing:.8px";
  for(const label of ["OPERATION","LOOP ≥","RETRY ≥","SUPPRESSED","RULE"]){const cell=document.createElement("span");if(label!=="OPERATION")cell.style.textAlign="right";setText(cell,label);headerRow.append(cell)}
  table.append(headerRow);
  for(const row of POLICIES_DEMO_DATA.rows){
    const rowEl=document.createElement("div");rowEl.style.cssText="display:grid;grid-template-columns:1.4fr .9fr .9fr .9fr .9fr;padding:12px 18px;border-bottom:1px solid var(--line);align-items:center";
    const opEl=document.createElement("span");opEl.style.cssText="font:600 12.5px "+policiesFontMono;setText(opEl,row.op);
    const loopEl=document.createElement("span");loopEl.style.cssText="text-align:right;font:500 12px "+policiesFontMono+";color:var(--dim)";setText(loopEl,String(row.loop));
    const retryEl=document.createElement("span");retryEl.style.cssText="text-align:right;font:500 12px "+policiesFontMono+";color:var(--dim)";setText(retryEl,String(row.retry));
    const countEl=document.createElement("span");countEl.style.cssText="text-align:right;font:500 12px "+policiesFontMono+";color:var(--warn)";setText(countEl,String(row.count));
    const ruleCell=document.createElement("span");ruleCell.style.cssText="text-align:right";
    const toggle=document.createElement("button");toggle.type="button";toggle.disabled=true;toggle.style.cssText="opacity:.5;cursor:not-allowed;background:var(--panel2);border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:5px 10px;font:600 10.5px "+policiesFontMono;setText(toggle,row.active?"Suppressed":"Suppress");
    ruleCell.append(toggle);
    rowEl.append(opEl,loopEl,retryEl,countEl,ruleCell);
    table.append(rowEl);
  }
  host.append(heading,note,infoBar,table);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.policies={render:renderPolicies};
renderPolicies();`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/gateway/console/policies-section.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/policies-section.ts tests/gateway/console/policies-section.test.ts
git commit -m "Add Warning policies console section with static example data"
```

---

### Task 7: Wire all six sections into the shell

**Files:**
- Modify: `src/gateway/console/shell.ts`
- Modify: `src/gateway/console/console-ui.ts`
- Modify: `tests/gateway/console/shell.test.ts`
- Modify: `tests/gateway/console/console-ui.test.ts` (if it exists — check first; if not, this repo's coverage for `console-ui.ts` may live in `tests/gateway/loopback-gateway.test.ts`'s served-HTML test instead, in which case update that file's assertions instead)

**Interfaces:**
- Consumes: `WARNINGS_MARKUP`/`WARNINGS_SCRIPT` (Task 1), `SECURITY_MARKUP`/`SECURITY_SCRIPT` (Task 2), `COST_MARKUP`/`COST_SCRIPT` (Task 3), `COMPARE_MARKUP`/`COMPARE_SCRIPT` (Task 4), `IMPORTS_MARKUP`/`IMPORTS_SCRIPT` (Task 5), `POLICIES_MARKUP`/`POLICIES_SCRIPT` (Task 6).
- Produces: nothing new consumed by a later task (last content task before e2e coverage).

- [ ] **Step 1: Write the failing tests**

In `tests/gateway/console/shell.test.ts`, add a new test to the existing `describe` block asserting the six nav items are now enabled (not disabled), and that the six new sections' markup is embedded:

```typescript
  it("enables the Warnings/Security/Cost/Compare/Imports/Warning-policies nav items and embeds their sections", () => {
    for (const id of ["warnings", "security", "cost", "compare", "imports", "policies"]) {
      const start = SHELL_MARKUP.indexOf(`data-nav-id="${id}"`);
      expect(start).toBeGreaterThan(-1);
      const tag = SHELL_MARKUP.slice(start, SHELL_MARKUP.indexOf("</button>", start));
      expect(tag).not.toContain("disabled");
      expect(tag).not.toContain('class="badge"');
    }
    for (const id of ["warnings", "security", "cost", "compare", "imports", "policies"]) {
      expect(SHELL_MARKUP).toContain(`data-section-id="${id}"`);
    }
    expect(SHELL_MARKUP).toContain('id="warnings-root"');
    expect(SHELL_MARKUP).toContain('id="security-root"');
    expect(SHELL_MARKUP).toContain('id="cost-root"');
    expect(SHELL_MARKUP).toContain('id="compare-root"');
    expect(SHELL_MARKUP).toContain('id="imports-root"');
    expect(SHELL_MARKUP).toContain('id="policies-root"');
  });
```

(If `SHELL_MARKUP` is not already imported at the top of this test file, add `import { SHELL_MARKUP, SHELL_SCRIPT } from "../../../src/gateway/console/shell.js";` or extend the existing import statement — check the file first, since prior tasks in this project already import `SHELL_SCRIPT` there.)

Check whether `tests/gateway/console/console-ui.test.ts` exists (`ls tests/gateway/console/console-ui.test.ts`). If it exists, add a test there asserting each new section's `data-screen-label` appears in `consoleHtml()`'s output, following that file's existing pattern. If it does not exist, instead extend the first `it` block in `tests/gateway/loopback-gateway.test.ts` (the one that already asserts on the served HTML page, e.g. `expect(html).toContain('data-nav-id="trail"')`) with:

```typescript
      expect(html).toContain('id="warnings-root"');
      expect(html).toContain('id="policies-root"');
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/gateway/console/shell.test.ts`
Expected: FAIL — the six nav items are still disabled and the new section ids aren't in `SHELL_MARKUP` yet.

- [ ] **Step 3: Wire the sections into `shell.ts`**

In `src/gateway/console/shell.ts`, add the six new imports after the existing `OVERVIEW_MARKUP` import (line 4):

```typescript
import { WARNINGS_MARKUP } from "./warnings-section.js";
import { SECURITY_MARKUP } from "./security-section.js";
import { COST_MARKUP } from "./cost-section.js";
import { COMPARE_MARKUP } from "./compare-section.js";
import { IMPORTS_MARKUP } from "./imports-section.js";
import { POLICIES_MARKUP } from "./policies-section.js";
```

In `NAV_GROUPS`, flip `enabled: false` to `enabled: true` for exactly these six items (leave every other item — `pods`, `milestones`, `github`, `journal` — untouched, they remain `enabled: false` since they're #121's scope, not this plan's):

```typescript
const NAV_GROUPS: readonly NavGroup[] = [
  { label: "OPERATE", items: [{ id: "controls", label: "Controls", icon: "▶", enabled: true }] },
  { label: "OBSERVE", items: [
    { id: "overview", label: "Overview", icon: "◉", enabled: true },
    { id: "trail", label: "Trail", icon: "⬡", enabled: true },
    { id: "warnings", label: "Warnings", icon: "△", enabled: true },
    { id: "security", label: "Security", icon: "⛨", enabled: true },
    { id: "cost", label: "Cost", icon: "◔", enabled: true },
  ] },
  { label: "ANALYZE", items: [
    { id: "compare", label: "Compare runs", icon: "⑂", enabled: true },
    { id: "imports", label: "Imports", icon: "⇥", enabled: true },
  ] },
  { label: "ZENTRA", items: [
    { id: "pods", label: "Pods", icon: "⬢", enabled: false },
    { id: "milestones", label: "Milestones", icon: "⊕", enabled: false },
    { id: "github", label: "GitHub broker", icon: "⎇", enabled: false },
    { id: "journal", label: "Journal", icon: "≣", enabled: false },
  ] },
  { label: "CONFIG", items: [{ id: "policies", label: "Warning policies", icon: "⚙", enabled: true }] },
];
```

Add the six new `<section>` wrappers right after the existing `trail` section (which currently ends the `.content` div's section list at line 144):

```typescript
    <section class="section" data-section-id="controls">${CONTROLS_MARKUP}</section>
    <section class="section" data-section-id="overview">${OVERVIEW_MARKUP}</section>
    <section class="section" data-section-id="trail">${TRAIL_MARKUP}</section>
    <section class="section" data-section-id="warnings">${WARNINGS_MARKUP}</section>
    <section class="section" data-section-id="security">${SECURITY_MARKUP}</section>
    <section class="section" data-section-id="cost">${COST_MARKUP}</section>
    <section class="section" data-section-id="compare">${COMPARE_MARKUP}</section>
    <section class="section" data-section-id="imports">${IMPORTS_MARKUP}</section>
    <section class="section" data-section-id="policies">${POLICIES_MARKUP}</section>
```

- [ ] **Step 4: Wire the scripts into `console-ui.ts`**

Replace the full contents of `src/gateway/console/console-ui.ts` with:

```typescript
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

const CONSOLE_SCRIPT = `(()=>{"use strict";${CONTROLS_SCRIPT}\n${TRAIL_SCRIPT}\n${OVERVIEW_SCRIPT}\n${WARNINGS_SCRIPT}\n${SECURITY_SCRIPT}\n${COST_SCRIPT}\n${COMPARE_SCRIPT}\n${IMPORTS_SCRIPT}\n${POLICIES_SCRIPT}\n${SHELL_SCRIPT}})();`;

export const CONSOLE_SCRIPT_SHA256 = createHash("sha256").update(CONSOLE_SCRIPT, "utf8").digest("base64");

export function consoleHtml(): string {
  return SHELL_MARKUP.replace("</body></html>", `<script>${CONSOLE_SCRIPT}</script></body></html>`);
}
```

(`SHELL_SCRIPT` stays last in the concatenation order, matching the existing convention — it's the one that calls `handoff()` at the very end, and every other section's helpers/state must already be defined by the time it runs.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/gateway/console/shell.test.ts tests/gateway/loopback-gateway.test.ts tests/gateway/console/warnings-section.test.ts tests/gateway/console/security-section.test.ts tests/gateway/console/cost-section.test.ts tests/gateway/console/compare-section.test.ts tests/gateway/console/imports-section.test.ts tests/gateway/console/policies-section.test.ts`
Expected: PASS (every test in all files)

- [ ] **Step 6: Real syntax check of the fully concatenated script**

Given six new scripts are now concatenated together with the existing four, verify the combined script still parses as valid JavaScript before committing — this is exactly the check the project's `console-ui.test.ts` (or `loopback-gateway.test.ts`'s CSP-hash test) already runs at the unit level, but confirm it directly too:

```bash
npx tsx -e "import('./src/gateway/console/console-ui.js').then(m => { const html = m.consoleHtml(); const match = /<script>([\s\S]*)<\/script>/.exec(html); new Function(match[1]); console.log('SCRIPT SYNTAX OK, length', match[1].length); }).catch(e => { console.error('SCRIPT SYNTAX FAILED', e); process.exit(1); })"
```

Expected: `SCRIPT SYNTAX OK, length <some number>`

- [ ] **Step 7: Regenerate the codebase map**

Run: `pnpm docs:codebase-map`

- [ ] **Step 8: Commit**

```bash
git add src/gateway/console/shell.ts src/gateway/console/console-ui.ts tests/gateway/console/shell.test.ts tests/gateway/loopback-gateway.test.ts docs/codebase-map.html
git commit -m "Wire Warnings/Security/Cost/Compare/Imports/Warning-policies into the console shell"
```

(Adjust the `git add` file list if Step 1 instead created/modified `tests/gateway/console/console-ui.test.ts` rather than editing `loopback-gateway.test.ts`.)

---

### Task 8: Real-browser e2e coverage

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: `ChromiumWorkflowDriver`, `LoopbackGateway`, `consoleShellWorkflow` (already defined/imported in this file).
- Produces: nothing consumed by a later task (last content task before final verification).

- [ ] **Step 1: Add the e2e test**

Add a new test to the existing `describe.skipIf(acceptanceBrowser === null)("console shell, real browser", ...)` block in `tests/ui/console-shell.e2e.test.ts`:

```typescript
  it("renders all six static preview sections and confirms their action controls are genuinely inert", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-static-sections-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const sections: Array<[string, string]> = [
        ["warnings", "Warning triage"],
        ["security", "Taint security audit"],
        ["cost", "Outcome cost attribution"],
        ["compare", "Run comparison"],
        ["imports", "Session imports"],
        ["policies", "Warning policies"],
      ];
      for (const [navId, heading] of sections) {
        await driver.click(`[data-nav-id="${navId}"]`);
        await driver.waitFor(`document.querySelector('[data-section-id="${navId}"]')?.dataset.active === "true"`);
        const headingText = await driver.evaluate<string>(`document.querySelector('[data-section-id="${navId}"] h1')?.textContent || ""`);
        expect(headingText).toBe(heading);
      }
      await driver.click('[data-nav-id="warnings"]');
      await driver.waitFor(`document.querySelector('[data-section-id="warnings"]')?.dataset.active === "true"`);
      const ackDisabled = await driver.evaluate<boolean>(`[...document.querySelectorAll('[data-section-id="warnings"] button')].some(button=>button.textContent==="Acknowledge"&&button.disabled===true)`);
      expect(ackDisabled).toBe(true);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

- [ ] **Step 2: Run the test file**

Run: `npx vitest run tests/ui/console-shell.e2e.test.ts`
Expected: PASS (every test in the file, including the new one). If `acceptanceBrowser === null` on this machine, the whole `describe` block is skipped — report this explicitly rather than claiming a pass.

- [ ] **Step 3: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Extend console-shell e2e coverage for the six static preview sections"
```

---

### Task 9: Final verification

**Files:** none (verification only)

**Interfaces:** none

- [ ] **Step 1: Typecheck**

Run: `pnpm run check`
Expected: no errors.

- [ ] **Step 2: Run the full test suite**

Run: `pnpm exec vitest run --reporter=json --outputFile=/tmp/vitest-static-sections.json`

Expected: the same pre-existing infra-dependent baseline failures already known from before this branch existed (Docker-capsule e2e, OpenCode read-only capsule, package-install e2e, AgentTrail fleet reconstruction, multi-writer scheduler e2e, and similar), plus every test touched or added in Tasks 1-8 passing. Compare the failing-file list against what's already known before concluding anything new is a regression. Be alert to parallel-resource-contention flakiness under full-suite load (a file that fails in the full run but passes cleanly in isolation is not a regression) — verify any unfamiliar failure in isolation before treating it as real.

- [ ] **Step 3: Regenerate the codebase map if needed**

Run: `pnpm docs:codebase-map`

If this produces a diff, commit it:

```bash
git add docs/codebase-map.html
git commit -m "Regenerate codebase map after static console sections"
```

- [ ] **Step 4: Confirm the CSP hash / syntax-safety tests are clean**

`tests/gateway/loopback-gateway.test.ts`'s served-page test and `tests/gateway/console/console-ui.test.ts`'s `new vm.Script(...)` syntax guard (added during the Trail rebuild) both exercise the full concatenated script, now including all six new sections. Confirm both passed as part of Step 2's full suite run.
