# Agent Rail Console Phase 2 Step 1: Shell Restyle + Real Overview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the Agent Rail Console's sidebar nav and add a topbar (run switcher, search box, live badge) matching `Console.dc.html`'s mockup, and rebuild the Overview section with real run data where it exists and an honest placeholder where it doesn't.

**Architecture:** All console UI ships as template-literal strings (`SHELL_MARKUP`/`SHELL_SCRIPT`, `OVERVIEW_MARKUP`/`OVERVIEW_SCRIPT`, etc.) that `console-ui.ts` concatenates into one hash-pinned inline `<script>`. Every section's script shares one JS scope (an IIFE), so `overview-section.ts` and the new topbar code in `shell.ts` read `state`, `currentRun()`, `value()`, `label()`, `badge()`, and `$()` directly from `controls-section.ts` without any import — that's the existing pattern, not a new one.

**Tech Stack:** TypeScript (Node ESM), vitest (`environment: "node"`, so no DOM in unit tests — DOM behavior is verified only by the existing real-Chromium e2e harness), plain browser JS embedded in template strings (no framework, no CDN).

## Global Constraints

- No external network calls from the console script (no CDN, no fonts.googleapis.com) — `SECURITY.md`'s local-only guarantee, already enforced by an existing test (`shell.test.ts`: "never loads a font from an external host").
- No `innerHTML` with interpolated data anywhere in these files — every existing helper builds DOM via `createElement`/`textContent` (`setText`). Continue that pattern; do not introduce a new one.
- Controls' own markup, ids, and behavior are unchanged except for the two additive hook calls described in Task 2.
- No new backend endpoints or network calls in this phase. Overview and the topbar read only `state` fields `controls-section.ts` already populates from `/api/v1/zentra/runs` and `/api/v1/zentra/runs/:id`.

---

## Task 1: Restyle sidebar nav and add topbar markup/CSS

**Files:**
- Modify: `src/gateway/console/shell.ts`
- Test: `tests/gateway/console/shell.test.ts`

**Interfaces:**
- Consumes: nothing new (still exports `SHELL_MARKUP`, `SHELL_SCRIPT` per existing signature).
- Produces: `SHELL_MARKUP` now contains nav-item icon spans, a `<header class="topbar">` containing `#run-switcher-button`, `#run-switcher-dot`, `#run-switcher-title`, `#run-switcher-menu`, `#run-switcher-rows`, `#console-search`, and the relocated `#connection`. Task 2 wires behavior to these ids; their exact names are load-bearing for that task.

- [ ] **Step 1: Write the failing tests**

Add to `tests/gateway/console/shell.test.ts` (append inside the existing `describe("console shell", ...)` block, before the closing `});`):

```ts
  it("gives every nav item the mockup's icon glyph", () => {
    const icons: Record<string, string> = {
      controls: "▶", overview: "◉", trail: "⬡", warnings: "△", security: "⛨", cost: "◔",
      compare: "⑂", imports: "⇥", pods: "⬢", milestones: "⊕", github: "⎇", journal: "≣", policies: "⚙",
    };
    for (const [id, icon] of Object.entries(icons)) {
      const marker = `data-nav-id="${id}"`;
      const start = SHELL_MARKUP.indexOf(marker);
      expect(start).toBeGreaterThan(-1);
      const buttonEnd = SHELL_MARKUP.indexOf("</button>", start);
      expect(SHELL_MARKUP.slice(start, buttonEnd)).toContain(`<span class="nav-icon">${icon}</span>`);
    }
  });

  it("adds a topbar with a run switcher, an inert search box, and the relocated connection badge", () => {
    for (const marker of [
      '<header class="topbar"',
      'id="run-switcher-button"',
      'id="run-switcher-dot"',
      'id="run-switcher-title"',
      'id="run-switcher-menu"',
      'id="run-switcher-rows"',
      'id="console-search"',
      'id="connection"',
    ]) {
      expect(SHELL_MARKUP).toContain(marker);
    }
    // connection now lives inside the topbar, not as a standalone paragraph
    const topbarStart = SHELL_MARKUP.indexOf('<header class="topbar"');
    const topbarEnd = SHELL_MARKUP.indexOf("</header>");
    expect(SHELL_MARKUP.indexOf('id="connection"')).toBeGreaterThan(topbarStart);
    expect(SHELL_MARKUP.indexOf('id="connection"')).toBeLessThan(topbarEnd);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/gateway/console/shell.test.ts`
Expected: the two new tests FAIL (no `nav-icon` spans or topbar markup exist yet); the pre-existing tests in this file still PASS.

- [ ] **Step 3: Implement**

Replace the entire contents of `src/gateway/console/shell.ts` with:

```ts
import { CONSOLE_DESIGN_TOKENS, CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";
import { CONTROLS_MARKUP } from "./controls-section.js";
import { TRAIL_MARKUP } from "./trail-section.js";
import { OVERVIEW_MARKUP } from "./overview-section.js";

interface NavItem { readonly id: string; readonly label: string; readonly icon: string; readonly enabled: boolean; }
interface NavGroup { readonly label: string; readonly items: readonly NavItem[]; }

const NAV_GROUPS: readonly NavGroup[] = [
  { label: "OPERATE", items: [{ id: "controls", label: "Controls", icon: "▶", enabled: true }] },
  { label: "OBSERVE", items: [
    { id: "overview", label: "Overview", icon: "◉", enabled: true },
    { id: "trail", label: "Trail", icon: "⬡", enabled: true },
    { id: "warnings", label: "Warnings", icon: "△", enabled: false },
    { id: "security", label: "Security", icon: "⛨", enabled: false },
    { id: "cost", label: "Cost", icon: "◔", enabled: false },
  ] },
  { label: "ANALYZE", items: [
    { id: "compare", label: "Compare runs", icon: "⑂", enabled: false },
    { id: "imports", label: "Imports", icon: "⇥", enabled: false },
  ] },
  { label: "ZENTRA", items: [
    { id: "pods", label: "Pods", icon: "⬢", enabled: false },
    { id: "milestones", label: "Milestones", icon: "⊕", enabled: false },
    { id: "github", label: "GitHub broker", icon: "⎇", enabled: false },
    { id: "journal", label: "Journal", icon: "≣", enabled: false },
  ] },
  { label: "CONFIG", items: [{ id: "policies", label: "Warning policies", icon: "⚙", enabled: false }] },
];

function renderNav(): string {
  return NAV_GROUPS.map((group) => {
    const items = group.items.map((item) => item.enabled
      ? `<button type="button" class="nav-item" data-nav-id="${item.id}"><span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span></button>`
      : `<button type="button" class="nav-item" data-nav-id="${item.id}" disabled aria-disabled="true"><span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span><span class="badge">Phase 2</span></button>`
    ).join("");
    return `<div class="nav-group-label">${group.label}</div>${items}`;
  }).join("");
}

export const SHELL_MARKUP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Zentra Agent Rail Console</title>
<style>
${CONSOLE_DESIGN_TOKENS}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:${CONSOLE_FONT_STACK_SANS}}
.shell{display:flex;width:100vw;height:100vh}
.sidebar{width:216px;flex:none;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--line);overflow-y:auto}
.nav-group-label{font:600 9px ${CONSOLE_FONT_STACK_MONO};color:var(--faint);letter-spacing:1.4px;padding:12px 10px 5px}
.nav-item{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:none;border-radius:7px;cursor:pointer;font:500 12.5px ${CONSOLE_FONT_STACK_SANS};text-align:left;background:transparent;color:var(--dim)}
.nav-item[data-active=true]{background:rgba(122,162,255,.13);color:var(--accent)}
.nav-item:disabled{cursor:not-allowed;opacity:.55}
.nav-item .badge{font:600 9px ${CONSOLE_FONT_STACK_MONO};background:var(--warn);color:#0a0e17;border-radius:8px;padding:1px 7px}
.nav-icon{width:16px;text-align:center;font-size:13px;flex:none;display:inline-block}
.nav-label{flex:1;text-align:left}
.content{flex:1;min-width:0;display:flex;flex-direction:column}
.section{display:none}
.section[data-active=true]{display:flex;flex:1;min-height:0;flex-direction:column}
#status{border-left:3px solid var(--line);padding:.8rem 1rem;background:#0d1814}
#status[data-tone=ok]{border-color:var(--accent)}
#status[data-tone=error]{border-color:var(--err);color:#ffd3cf}
.topbar{height:54px;flex:none;display:flex;align-items:center;gap:14px;padding:0 18px;border-bottom:1px solid var(--line);background:var(--panel)}
.topbar-spacer{flex:1}
.run-switcher{position:relative}
.run-switcher-button{display:flex;align-items:center;gap:9px;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:7px 12px;cursor:pointer;color:var(--text);max-width:360px;font:inherit}
.run-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--faint);display:inline-block}
.run-switcher-title{font:600 13px ${CONSOLE_FONT_STACK_SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.run-switcher-caret{color:var(--dim);font-size:10px}
.run-switcher-menu{position:absolute;top:44px;left:0;width:340px;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:6px;box-shadow:0 18px 40px rgba(0,0,0,.5);z-index:40}
.run-switcher-menu[hidden]{display:none}
.run-switcher-menu-label{font:600 9px ${CONSOLE_FONT_STACK_MONO};color:var(--faint);letter-spacing:1px;padding:6px 8px 4px}
.run-switcher-row{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:8px 9px;border:none;border-radius:7px;background:transparent;cursor:pointer;font:inherit;color:var(--text)}
.run-switcher-row:hover,.run-switcher-row[data-selected=true]{background:var(--panel2)}
.run-switcher-row-title{font:600 12.5px ${CONSOLE_FONT_STACK_SANS};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run-switcher-empty{padding:8px 9px;color:var(--dim);font:400 12px ${CONSOLE_FONT_STACK_SANS}}
.search-box{width:250px;display:flex;align-items:center;gap:8px;padding:7px 11px;border:1px solid var(--line);border-radius:7px;background:var(--panel2)}
.search-box .search-icon{color:var(--faint);font-size:12px}
.search-box input{min-width:0;width:100%;border:0;outline:0;background:transparent;color:var(--text);font:400 12px ${CONSOLE_FONT_STACK_MONO}}
.connection{font:500 10px ${CONSOLE_FONT_STACK_MONO};color:var(--faint);border:1px solid var(--line);padding:3px 8px;border-radius:4px;white-space:nowrap}
.connection[data-connected=true]{color:var(--accent)}
.intake{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.panel{background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:14px;padding:1.25rem;box-shadow:0 20px 60px #0004}
.panel h2{font-size:.8rem;letter-spacing:.15em;text-transform:uppercase;color:var(--dim);margin:0 0 1rem}
.field-label{display:block;font-weight:700;margin-bottom:.4rem}
textarea,input,select{width:100%;border:1px solid #3c554b;border-radius:8px;background:#08110e;color:var(--text);padding:.75rem}
textarea{min-height:7rem;resize:vertical}
.form-row{display:flex;gap:.75rem;align-items:end}
.form-row>div{flex:1}
.primary,.secondary,.danger{border:0;border-radius:999px;padding:.7rem 1.1rem;font-weight:800}
.primary{background:var(--accent);color:#10200f}
.secondary{background:#2a3d35;color:var(--text)}
.danger{background:#512622;color:#ffd7d2}
.workspace{display:grid;grid-template-columns:minmax(15rem,.65fr) minmax(24rem,1.35fr) minmax(19rem,.8fr);gap:1rem;margin-top:1rem;align-items:start}
.stack{display:grid;gap:.75rem}
.run-card,.attention-card{width:100%;text-align:left;color:var(--text);background:#0b1512;border:1px solid var(--line);border-radius:10px;padding:.8rem;display:grid;gap:.3rem}
.run-card[data-selected=true]{border-color:var(--accent)}
.run-card span,.attention-card span{color:var(--dim);font-size:.82rem}
.badge{display:inline-block!important;width:max-content;color:#bceba0!important;border:1px solid #3c6549;border-radius:999px;padding:.12rem .45rem;text-transform:uppercase;letter-spacing:.08em;font-size:.65rem!important}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem}
.fact{border-top:1px solid var(--line);padding-top:.5rem}
.fact dt{color:var(--dim);font-size:.72rem;text-transform:uppercase}
.fact dd{margin:0;overflow-wrap:anywhere}
.empty,.recommendation{color:var(--dim)}
.recommendation{border:1px solid #685d32;background:#251f0f;padding:.8rem;border-radius:8px}
.notice{color:var(--warn);border-left:3px solid var(--warn);padding-left:.75rem}
details{border-top:1px solid var(--line);padding:.7rem 0}
summary{cursor:pointer;font-weight:700}
pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#bed0c8;background:#07100d;padding:.8rem;border-radius:8px}
.decision-actions{display:grid;gap:.8rem;margin-top:1rem}
.digest{font-family:ui-monospace,monospace;overflow-wrap:anywhere;color:var(--accent)}
.actions{display:flex;gap:.6rem;flex-wrap:wrap}
.actions form{flex:1;min-width:12rem}
.history-card{padding:.75rem 0;border-top:1px solid var(--line)}
.history-card strong{display:block}
.history-card .badge{margin:.35rem 0}
.history-card p{margin:0;color:var(--dim);font-size:.85rem}
@media(max-width:980px){.workspace{grid-template-columns:1fr 1fr}.workspace>.panel:last-child{grid-column:1/-1}.intake{grid-template-columns:1fr}}
@media(max-width:620px){.workspace{grid-template-columns:1fr}.workspace>.panel:last-child{grid-column:auto}.facts{grid-template-columns:1fr}.form-row{display:grid}.panel{padding:1rem;border-radius:10px}.actions{display:grid}.actions form{min-width:0}}
</style></head><body>
<div class="shell" data-ready="false">
  <aside class="sidebar" role="navigation" aria-label="Console sections">${renderNav()}</aside>
  <div class="content">
    <p id="status" role="status" aria-live="polite">Establishing secure local session.</p>
    <header class="topbar" aria-label="Run context">
      <div class="run-switcher">
        <button type="button" id="run-switcher-button" class="run-switcher-button" aria-haspopup="true" aria-expanded="false">
          <span id="run-switcher-dot" class="run-dot"></span>
          <span id="run-switcher-title" class="run-switcher-title">No runs yet</span>
          <span class="run-switcher-caret">▾</span>
        </button>
        <div id="run-switcher-menu" class="run-switcher-menu" hidden>
          <div class="run-switcher-menu-label">RUNS ON THIS MACHINE</div>
          <div id="run-switcher-rows"></div>
        </div>
      </div>
      <span class="topbar-spacer"></span>
      <label class="search-box">
        <span class="search-icon">⌕</span>
        <input id="console-search" type="search" placeholder="filter events, actors, kinds…">
      </label>
      <div id="connection" class="connection" role="status">Connecting</div>
    </header>
    <section class="section" data-section-id="controls">${CONTROLS_MARKUP}</section>
    <section class="section" data-section-id="overview">${OVERVIEW_MARKUP}</section>
    <section class="section" data-section-id="trail">${TRAIL_MARKUP}</section>
  </div>
</div>
</body></html>`;

export const SHELL_SCRIPT = String.raw`
const setActiveSection=(id)=>{
  for(const button of document.querySelectorAll(".nav-item")) button.dataset.active=String(button.dataset.navId===id);
  for(const section of document.querySelectorAll(".section")) section.dataset.active=String(section.dataset.sectionId===id);
};
for(const button of document.querySelectorAll(".nav-item:not(:disabled)")){
  button.addEventListener("click",()=>setActiveSection(button.dataset.navId));
}
setActiveSection("controls");
async function handoff(){
  const fragment=location.hash;history.replaceState(null,"","/");document.documentElement.dataset.location=location.href;
  const token=fragment.startsWith("#token=")?decodeURIComponent(fragment.slice(7)):"";
  if(!token){status("This page needs a fresh one-time launch link.","error");return}
  try{
    const session=await fetch("/api/v1/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token}),credentials:"same-origin",cache:"no-store"});
    const result=await session.json();if(!session.ok)throw new Error(result.error||"session_failed");
    window.__consoleSections=window.__consoleSections||{};
    window.__consoleSections.controls?.setSession?.(result.bearerToken,result.csrfToken);
    document.getElementById("agenttrail-frame").src="/agenttrail/";
    await window.__consoleSections.controls?.refresh?.();
    status("Secure local session established.","ok");
    document.querySelector(".shell").dataset.ready="true";document.documentElement.dataset.ready="true";
    void window.__consoleSections.controls?.connect?.();
  }catch(error){status("Session unavailable: "+error.message+".","error")}
}
void handoff();`;
```

Note: this step does not yet change `SHELL_SCRIPT` beyond what's shown above (still identical to before) — the topbar elements just added to the markup have no behavior wired yet. That's Task 2.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test -- tests/gateway/console/shell.test.ts`
Expected: all tests in the file PASS, including the two new ones.

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/shell.ts tests/gateway/console/shell.test.ts
git commit -m "Restyle Agent Rail Console nav and add topbar chrome"
```

---

## Task 2: Wire topbar behavior and hook it into Controls' refresh cycle

**Files:**
- Modify: `src/gateway/console/shell.ts` (only the `SHELL_SCRIPT` export)
- Modify: `src/gateway/console/controls-section.ts`
- Test: `tests/gateway/console/shell.test.ts`

**Interfaces:**
- Consumes: `state`, `currentRun()`, `value()`, `label()`, `$()`, `selectRun()` — all already defined in `controls-section.ts`'s shared scope (unchanged signatures).
- Produces: `window.__consoleSections.shell = { render: renderTopbar }`, following the exact same convention as `window.__consoleSections.overview` and `window.__consoleSections.controls`. `renderTopbar()` takes no arguments and returns nothing; it re-reads `state` and re-renders the run switcher in place.

- [ ] **Step 1: Write the failing tests**

Add to `tests/gateway/console/shell.test.ts`:

```ts
  it("renders the topbar via window.__consoleSections.shell and picking a run switcher row calls the existing selectRun", () => {
    expect(SHELL_SCRIPT).toContain("window.__consoleSections.shell={render:renderTopbar}");
    const renderTopbarBody = SHELL_SCRIPT.slice(SHELL_SCRIPT.indexOf("const renderTopbar="), SHELL_SCRIPT.indexOf('$("run-switcher-button")?.addEventListener("click"'));
    expect(renderTopbarBody).toContain("row.addEventListener(\"click\",()=>{");
    expect(renderTopbarBody).toContain("selectRun(id)");
  });
```

Add to `tests/gateway/console/controls-section.ts` test coverage — since no `controls-section.test.ts` exists yet, add this to `tests/gateway/console/shell.test.ts` instead (it asserts on `CONTROLS_SCRIPT`, exported from `controls-section.ts`, so import it too):

```ts
import { CONTROLS_SCRIPT } from "../../../src/gateway/console/controls-section.js";
```

(add this import at the top of the file, alongside the existing `shell.js` import)

```ts
  it("refreshes the topbar every time Controls loads or switches a run", () => {
    const refreshBody = CONTROLS_SCRIPT.slice(CONTROLS_SCRIPT.indexOf("const refresh=async"), CONTROLS_SCRIPT.indexOf("const selectRun="));
    expect(refreshBody).toContain("window.__consoleSections.shell?.render?.()");
    const selectRunBody = CONTROLS_SCRIPT.slice(CONTROLS_SCRIPT.indexOf("const selectRun=async"), CONTROLS_SCRIPT.indexOf("const loadDecision="));
    expect(selectRunBody).toContain("window.__consoleSections.shell?.render?.()");
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test -- tests/gateway/console/shell.test.ts`
Expected: the three new tests FAIL (`renderTopbar` doesn't exist yet, and the two hook calls aren't in `controls-section.ts` yet).

- [ ] **Step 3: Implement — replace `SHELL_SCRIPT` in `shell.ts`**

Replace the `SHELL_SCRIPT` export (the whole `export const SHELL_SCRIPT = String.raw\`...\`;` block from Task 1) with:

```ts
export const SHELL_SCRIPT = String.raw`
const setActiveSection=(id)=>{
  for(const button of document.querySelectorAll(".nav-item")) button.dataset.active=String(button.dataset.navId===id);
  for(const section of document.querySelectorAll(".section")) section.dataset.active=String(section.dataset.sectionId===id);
};
for(const button of document.querySelectorAll(".nav-item:not(:disabled)")){
  button.addEventListener("click",()=>setActiveSection(button.dataset.navId));
}
setActiveSection("controls");
const dotColorForLifecycle=(lifecycle)=>{
  const name=String(lifecycle||"").toLowerCase();
  if(name.includes("error")||name.includes("failed")||name.includes("rejected"))return "var(--err)";
  if(name.includes("terminal")||name.includes("ended")||name.includes("done"))return "var(--ok)";
  if(name.includes("degraded")||name.includes("waiting")||name.includes("stale"))return "var(--warn)";
  return "var(--run)";
};
const renderTopbar=()=>{
  const button=$("run-switcher-button");if(!button)return;
  const titleEl=$("run-switcher-title");const dotEl=$("run-switcher-dot");const rows=$("run-switcher-rows");
  const run=currentRun();
  setText(titleEl,run?value(run,["runId","id"],"Run"):"No runs yet");
  dotEl.style.background=run?dotColorForLifecycle(value(run,["lifecycle","state","status"],"")):"var(--faint)";
  rows.replaceChildren();
  if(!state.runs.length){
    const empty=document.createElement("div");empty.className="run-switcher-empty";
    setText(empty,"No runs on this machine yet.");rows.append(empty);return;
  }
  for(const candidate of state.runs){
    const id=value(candidate,["runId","id"],"Unknown run");
    const row=document.createElement("button");row.type="button";row.className="run-switcher-row";
    row.dataset.selected=String(Boolean(run)&&value(run,["runId","id"])===id);
    const dot=document.createElement("span");dot.className="run-dot";
    dot.style.background=dotColorForLifecycle(value(candidate,["lifecycle","state","status"],""));
    const titleSpan=document.createElement("span");titleSpan.className="run-switcher-row-title";setText(titleSpan,id);
    row.append(dot,titleSpan);
    row.addEventListener("click",()=>{$("run-switcher-menu").hidden=true;button.setAttribute("aria-expanded","false");selectRun(id)});
    rows.append(row);
  }
};
$("run-switcher-button")?.addEventListener("click",()=>{
  const menu=$("run-switcher-menu");const opening=menu.hidden;
  menu.hidden=!opening;$("run-switcher-button").setAttribute("aria-expanded",String(opening));
});
document.addEventListener("click",(event)=>{
  const menu=$("run-switcher-menu");const wrap=$("run-switcher-button")?.closest(".run-switcher");
  if(!menu||menu.hidden||!wrap||wrap.contains(event.target))return;
  menu.hidden=true;$("run-switcher-button").setAttribute("aria-expanded","false");
});
$("console-search")?.addEventListener("input",(event)=>{
  // Placeholder for forward compatibility: nothing filters on state.search yet.
  // Trail (Phase 2 of the Agent Rail Console redesign) is what will read this.
  state.search=event.target.value;
});
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.shell={render:renderTopbar};
renderTopbar();
async function handoff(){
  const fragment=location.hash;history.replaceState(null,"","/");document.documentElement.dataset.location=location.href;
  const token=fragment.startsWith("#token=")?decodeURIComponent(fragment.slice(7)):"";
  if(!token){status("This page needs a fresh one-time launch link.","error");return}
  try{
    const session=await fetch("/api/v1/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token}),credentials:"same-origin",cache:"no-store"});
    const result=await session.json();if(!session.ok)throw new Error(result.error||"session_failed");
    window.__consoleSections=window.__consoleSections||{};
    window.__consoleSections.controls?.setSession?.(result.bearerToken,result.csrfToken);
    document.getElementById("agenttrail-frame").src="/agenttrail/";
    await window.__consoleSections.controls?.refresh?.();
    status("Secure local session established.","ok");
    document.querySelector(".shell").dataset.ready="true";document.documentElement.dataset.ready="true";
    void window.__consoleSections.controls?.connect?.();
  }catch(error){status("Session unavailable: "+error.message+".","error")}
}
void handoff();`;
```

- [ ] **Step 4: Implement — hook `controls-section.ts` into the topbar**

In `src/gateway/console/controls-section.ts`, line 3, change:

```ts
export const CONTROLS_SCRIPT = String.raw`const state={bearer:"",csrf:"",runs:[],selected:null,attention:[],history:[],decision:null,sourceTexts:{},cursor:0,connected:false};
```

to:

```ts
export const CONTROLS_SCRIPT = String.raw`const state={bearer:"",csrf:"",runs:[],selected:null,attention:[],history:[],decision:null,sourceTexts:{},cursor:0,connected:false,search:""};
```

Then find this line inside `refresh` (currently the last line of the `refresh` arrow function, right before its closing backtick-semicolon-adjacent `const selectRun=`):

```ts
const refresh=async()=>{const interaction=captureInteraction();const result=await request("/api/v1/zentra/runs");state.runs=list(result,["runs","items"]);renderRuns();if(state.selected){const id=value(currentRun(),["runId","id"]);await selectRun(id,false,interaction.decisionId)}else if(state.runs.length){await selectRun(value(state.runs[0],["runId","id"]),false,interaction.decisionId)}restoreInteraction(interaction);window.__consoleSections.overview?.render?.()};
```

Replace it with (adding one call at the end):

```ts
const refresh=async()=>{const interaction=captureInteraction();const result=await request("/api/v1/zentra/runs");state.runs=list(result,["runs","items"]);renderRuns();if(state.selected){const id=value(currentRun(),["runId","id"]);await selectRun(id,false,interaction.decisionId)}else if(state.runs.length){await selectRun(value(state.runs[0],["runId","id"]),false,interaction.decisionId)}restoreInteraction(interaction);window.__consoleSections.overview?.render?.();window.__consoleSections.shell?.render?.()};
```

Then find `selectRun`:

```ts
const selectRun=async(id,announce=true,decisionId=null)=>{const base="/api/v1/zentra/runs/"+encodeURIComponent(id);state.selected=await request(base);state.attention=list(state.selected,["attention"]).filter(item=>item.status==="pending");state.history=list(state.selected,["decisions"]).filter(item=>item.status!=="pending");renderRuns();renderRun();renderAttention();renderHistory();state.decision=decisionId?await request("/api/v1/zentra/decisions/"+encodeURIComponent(decisionId)).catch(()=>null):null;renderDecision();window.__consoleSections.overview?.render?.();if(announce)status("Loaded run "+id+".","ok")};
```

Replace it with:

```ts
const selectRun=async(id,announce=true,decisionId=null)=>{const base="/api/v1/zentra/runs/"+encodeURIComponent(id);state.selected=await request(base);state.attention=list(state.selected,["attention"]).filter(item=>item.status==="pending");state.history=list(state.selected,["decisions"]).filter(item=>item.status!=="pending");renderRuns();renderRun();renderAttention();renderHistory();state.decision=decisionId?await request("/api/v1/zentra/decisions/"+encodeURIComponent(decisionId)).catch(()=>null):null;renderDecision();window.__consoleSections.overview?.render?.();window.__consoleSections.shell?.render?.();if(announce)status("Loaded run "+id+".","ok")};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test -- tests/gateway/console/shell.test.ts`
Expected: all tests PASS, including the three new ones.

- [ ] **Step 6: Full unit suite still green**

Run: `pnpm test`
Expected: all existing tests still PASS (this confirms the `controls-section.ts` edits didn't break anything Controls-related).

- [ ] **Step 7: Commit**

```bash
git add src/gateway/console/shell.ts src/gateway/console/controls-section.ts tests/gateway/console/shell.test.ts
git commit -m "Wire Agent Rail Console topbar run switcher into Controls' refresh cycle"
```

---

## Task 3: Rebuild Overview with real data and honest placeholders

**Files:**
- Modify: `src/gateway/console/overview-section.ts`
- Test: `tests/gateway/console/overview-section.test.ts` (new file)

**Interfaces:**
- Consumes: `state`, `currentRun()`, `value()`, `label()`, `badge()`, `setText()`, `$()` from `controls-section.ts`'s shared scope.
- Produces: `window.__consoleSections.overview = { render: renderOverview }` — same signature as today, callers (`controls-section.ts`, unchanged) don't need to change.
- `OVERVIEW_MARKUP` is unchanged (`<div ... id="overview-root"></div>`); all new structure is built at runtime by `renderOverview()`.

- [ ] **Step 1: Write the failing test**

Create `tests/gateway/console/overview-section.test.ts`:

```ts
// tests/gateway/console/overview-section.test.ts
import { describe, expect, it } from "vitest";

import { OVERVIEW_MARKUP, OVERVIEW_SCRIPT } from "../../../src/gateway/console/overview-section.js";

describe("overview section", () => {
  it("keeps a single root container for renderOverview to populate", () => {
    expect(OVERVIEW_MARKUP).toContain('id="overview-root"');
  });

  it("shows an honest placeholder for the five metric tiles instead of fabricated numbers", () => {
    for (const metricLabel of ["AGENTS", "EVENTS", "TOKENS", "COST", "WARNINGS"]) {
      expect(OVERVIEW_SCRIPT).toContain(`"${metricLabel}"`);
    }
    expect(OVERVIEW_SCRIPT).toContain("Available in a later phase");
    expect((OVERVIEW_SCRIPT.match(/Available in a later phase/g) || []).length).toBeGreaterThanOrEqual(1);
  });

  it("shows an honest placeholder for top warnings instead of fabricated warning cards", () => {
    expect(OVERVIEW_SCRIPT).toContain("Warning triage lands in a later phase.");
  });

  it("builds the narrative from state.attention and state.history, not from fabricated demo data", () => {
    expect(OVERVIEW_SCRIPT).toContain("state.attention");
    expect(OVERVIEW_SCRIPT).toContain("state.history");
    expect(OVERVIEW_SCRIPT).not.toMatch(/DATA\.runs/);
  });

  it("never builds DOM with innerHTML, matching the rest of the console's XSS-safe pattern", () => {
    expect(OVERVIEW_SCRIPT).not.toContain("innerHTML");
  });

  it("registers itself under window.__consoleSections.overview.render", () => {
    expect(OVERVIEW_SCRIPT).toContain("window.__consoleSections.overview={render:renderOverview}");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test -- tests/gateway/console/overview-section.test.ts`
Expected: FAIL (metric tiles, placeholders, and `state.attention`/`state.history` usage don't exist in the current 21-line file).

- [ ] **Step 3: Implement**

Replace the entire contents of `src/gateway/console/overview-section.ts` with:

```ts
export const OVERVIEW_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Overview" id="overview-root"></div>`;

export const OVERVIEW_SCRIPT = String.raw`
const overviewTile=(metricLabel)=>{
  const tile=document.createElement("div");
  tile.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px";
  const labelEl=document.createElement("div");
  labelEl.style.cssText="font:500 10px 'IBM Plex Mono',monospace;color:var(--faint);letter-spacing:1px";
  setText(labelEl,metricLabel);
  const valueRow=document.createElement("div");
  valueRow.style.cssText="display:flex;align-items:baseline;gap:7px;margin-top:8px";
  const valueEl=document.createElement("span");
  valueEl.style.cssText="font:600 26px 'IBM Plex Mono',monospace;color:var(--faint)";
  setText(valueEl,"—");
  valueRow.append(valueEl);
  const subEl=document.createElement("div");
  subEl.style.cssText="font:400 10.5px 'IBM Plex Mono',monospace;color:var(--faint);margin-top:6px";
  setText(subEl,"Available in a later phase");
  tile.append(labelEl,valueRow,subEl);
  return tile;
};
const renderOverview=()=>{
  const host=$("overview-root");if(!host)return;host.replaceChildren();
  const run=currentRun();
  if(!run){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select a run to see its overview.");host.append(empty);return}

  const heading=document.createElement("h1");
  heading.style.cssText="margin:0;font:700 22px 'IBM Plex Sans',sans-serif";
  setText(heading,value(run,["title","goal","summary"],value(run,["runId","id"],"Run")));
  const badgeEl=badge(label(String(value(run,["lifecycle","state","status"],"unknown"))));
  const head=document.createElement("div");
  head.style.cssText="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap";
  head.append(heading,badgeEl);

  const metricsRow=document.createElement("div");
  metricsRow.style.cssText="display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-top:22px";
  for(const metricLabel of ["AGENTS","EVENTS","TOKENS","COST","WARNINGS"]){
    metricsRow.append(overviewTile(metricLabel));
  }

  const body=document.createElement("div");
  body.style.cssText="display:grid;grid-template-columns:minmax(0,1.6fr) minmax(280px,1fr);gap:16px;margin-top:24px;align-items:start";

  const narrativeSection=document.createElement("section");
  narrativeSection.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:20px 22px";
  const narrativeHeading=document.createElement("h2");
  narrativeHeading.style.cssText="margin:0 0 4px;font:600 14px 'IBM Plex Sans',sans-serif";
  setText(narrativeHeading,"What happened");
  const narrativeCaption=document.createElement("p");
  narrativeCaption.style.cssText="margin:0 0 16px;font:400 12px 'IBM Plex Sans',sans-serif;color:var(--dim)";
  setText(narrativeCaption,"Pending and resolved operator decisions for this run.");
  const narrativeList=document.createElement("div");
  narrativeList.style.cssText="display:flex;flex-direction:column;gap:10px";
  const timeline=[
    ...(state.attention||[]).map((item)=>({item,resolved:false})),
    ...(state.history||[]).map((item)=>({item,resolved:true})),
  ];
  for(const {item,resolved} of timeline){
    const row=document.createElement("div");
    row.style.cssText="border-left:2px solid var(--line);padding:0 0 4px 16px;margin-left:6px";
    const statusEl=document.createElement("span");
    statusEl.style.cssText="display:block;font:500 10.5px 'IBM Plex Mono',monospace;color:var(--faint)";
    setText(statusEl,(resolved?"Resolved":"Pending")+" · "+label(String(value(item,["status","state"],resolved?"unknown":"pending"))));
    const titleEl=document.createElement("span");
    titleEl.style.cssText="display:block;margin-top:4px;font:400 13px/1.55 'IBM Plex Sans',sans-serif;color:var(--text)";
    const summary=resolved
      ? value(item.packet||{},["summary","question"],value(item,["title","question","kind"],"Decision"))
      : value(item,["title","question","kind"],"Decision");
    setText(titleEl,summary);
    row.append(statusEl,titleEl);
    narrativeList.append(row);
  }
  if(timeline.length===0){const emptyRow=document.createElement("p");emptyRow.className="empty";setText(emptyRow,"No attention history yet for this run.");narrativeList.append(emptyRow)}
  narrativeSection.append(narrativeHeading,narrativeCaption,narrativeList);

  const sidebar=document.createElement("div");
  sidebar.style.cssText="display:flex;flex-direction:column;gap:16px";

  const outcomeSection=document.createElement("section");
  outcomeSection.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px";
  const outcomeHeading=document.createElement("h2");
  outcomeHeading.style.cssText="margin:0 0 12px;font:600 14px 'IBM Plex Sans',sans-serif";
  setText(outcomeHeading,"Observed outcome");
  const readiness=state.selected?.planning?.readiness||{};
  const terminalOutcome=value(run,["terminalOutcome"],null);
  const outcomeRows=[
    ["Lifecycle",label(String(value(run,["lifecycle","state","status"],"unknown")))],
    ["Terminal outcome",terminalOutcome===null?"Not terminal":label(String(terminalOutcome))],
    ["Readiness",readiness.ready===true?"Ready":"Waiting"],
    ["Approval",label(readiness.approvalState,"Waiting")],
  ];
  outcomeSection.append(outcomeHeading);
  for(const [k,v] of outcomeRows){
    const row=document.createElement("div");
    row.style.cssText="display:flex;justify-content:space-between;gap:10px;padding:8px 0;border-bottom:1px solid var(--line)";
    const kEl=document.createElement("span");kEl.style.cssText="font:500 11.5px 'IBM Plex Sans',sans-serif;color:var(--dim)";setText(kEl,k);
    const vEl=document.createElement("span");vEl.style.cssText="font:600 12px 'IBM Plex Mono',monospace;color:var(--text)";setText(vEl,v);
    row.append(kEl,vEl);
    outcomeSection.append(row);
  }

  const warningsSection=document.createElement("section");
  warningsSection.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px";
  const warningsHeading=document.createElement("h2");
  warningsHeading.style.cssText="margin:0 0 10px;font:600 14px 'IBM Plex Sans',sans-serif";
  setText(warningsHeading,"Top warnings");
  const warningsEmpty=document.createElement("p");
  warningsEmpty.className="empty";
  setText(warningsEmpty,"Warning triage lands in a later phase.");
  warningsSection.append(warningsHeading,warningsEmpty);

  sidebar.append(outcomeSection,warningsSection);
  body.append(narrativeSection,sidebar);
  host.append(head,metricsRow,body);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.overview={render:renderOverview};`;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test -- tests/gateway/console/overview-section.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Run the full unit suite**

Run: `pnpm test`
Expected: all tests PASS, including `console-ui.test.ts` (which checks `id="overview-root"` still appears in the composed document — unaffected, since `OVERVIEW_MARKUP` didn't change).

- [ ] **Step 6: Commit**

```bash
git add src/gateway/console/overview-section.ts tests/gateway/console/overview-section.test.ts
git commit -m "Rebuild Overview with real run data and honest placeholders for unbuilt metrics"
```

---

## Task 4: Extend real-browser e2e coverage for the topbar and Overview

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: `ChromiumWorkflowDriver` (existing helper — `.open()`, `.click()`, `.waitFor()`, `.evaluate()`, `.submitGoal()`), `consoleShellWorkflow()` (existing local helper in this file), `label()` (existing local helper in this file).
- Produces: nothing new — this task only adds test cases.

This task adds tests for behavior that Tasks 1–3 already implemented and the fast unit suite already covers structurally. Unlike the earlier tasks, there's no red step here: the existing e2e suite in this file follows the same pattern (see its own comment on the `handoff()` test — unit coverage was added referencing an already-passing e2e assertion). A 60-second real-Chromium harness isn't suited to red/green per line; it's the trust-but-verify layer confirming the DOM actually behaves as unit-tested, not the layer driving each edit.

- [ ] **Step 1: Add the two new test cases**

Add inside the existing `describe.skipIf(acceptanceBrowser === null)("console shell, real browser", () => { ... })` block in `tests/ui/console-shell.e2e.test.ts`, after the last existing `it(...)` and before the closing `});`:

```ts
  it("shows the submitted run in the topbar run switcher and lists it in the dropdown", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-topbar-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const runId = await driver.submitGoal("Confirm the topbar run switcher shows the real run");

      const switcherTitle = await driver.evaluate<string>(`document.getElementById("run-switcher-title")?.textContent || ""`);
      expect(switcherTitle).toBe(runId);

      await driver.click("#run-switcher-button");
      await driver.waitFor(`document.getElementById("run-switcher-menu")?.hidden === false`);
      const rowText = await driver.evaluate<string>(`document.getElementById("run-switcher-rows")?.textContent || ""`);
      expect(rowText).toContain(runId);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);

  it("renders Overview's metric tiles as an honest placeholder, not fabricated numbers", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-overview-metrics-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      await driver.submitGoal("Confirm Overview metric tiles are honest placeholders");
      await driver.click('[data-nav-id="overview"]');
      await driver.waitFor(`document.querySelector('[data-section-id="overview"]')?.dataset.active === "true"`);

      const placeholderCount = await driver.evaluate<number>(
        `Array.from(document.querySelectorAll("#overview-root")[0].querySelectorAll("div")).filter(el => el.textContent === "—").length`
      );
      expect(placeholderCount).toBeGreaterThanOrEqual(5);

      const warningsText = await driver.evaluate<string>(`document.getElementById("overview-root")?.textContent || ""`);
      expect(warningsText).toContain("Warning triage lands in a later phase.");
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

- [ ] **Step 2: Run the e2e suite**

Run: `pnpm test -- tests/ui/console-shell.e2e.test.ts`
Expected: all 5 tests in this file PASS (the 3 pre-existing plus the 2 new ones). If `acceptanceBrowser` is `null` in this environment (no Chromium available), the suite is skipped entirely (`describe.skipIf`) rather than failing — that's expected and not a blocker for this task, but if a browser is available it must be green.

- [ ] **Step 3: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Add e2e coverage for the Agent Rail Console topbar and honest Overview placeholders"
```

---

## Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full test suite**

Run: `pnpm test`
Expected: PASS, 0 failures.

- [ ] **Step 2: Typecheck**

Run: `pnpm check`
Expected: PASS, no TypeScript errors. (Note: the console script bodies are plain-JS template-literal strings, not type-checked by `tsc` — this step verifies the `.ts` files themselves, e.g. the `NavItem`/`NavGroup` interface changes in `shell.ts`, still type-check cleanly.)

- [ ] **Step 3: Confirm the CSP hash test still passes on its own**

Run: `pnpm test -- tests/gateway/console/console-ui.test.ts`
Expected: PASS. This is the test that recomputes `CONSOLE_SCRIPT_SHA256` from the live concatenated script and compares it to the exported constant — since that constant is derived with `createHash(...).update(CONSOLE_SCRIPT, "utf8").digest("base64")` at module load time (not hardcoded), it self-updates and requires no manual edit when the script body changes.

- [ ] **Step 4: Manual smoke check (documented, not automated)**

Run `pnpm start -- start` against a trusted test project, open the printed session URL, and confirm:
- The sidebar shows all 13 items (Controls + the 12 mockup items) with icons, only Controls/Overview/Trail clickable.
- The topbar shows a run switcher, search box, and live badge; submitting a goal makes the switcher show it and lists it in the dropdown.
- Overview shows the real run title/badge/narrative/outcome, and honest `—` placeholders for the 5 metric tiles and "Warning triage lands in a later phase." for Top Warnings.

This step has no exit code to assert on — it's a human sanity check before considering Phase 2 Step 1 done, since the automated suite validates markup/script content and real-Chromium DOM behavior, but a operator's actual visual impression is still worth one manual pass.
