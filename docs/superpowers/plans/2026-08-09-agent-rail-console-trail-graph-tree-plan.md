# Trail Graph/Tree View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the disabled "Graph" and "Tree" tabs in Trail with one shared node-link renderer, two layouts (radial vs. hierarchical), showing real actor nodes connected by real parent/child spawn edges, reusing Trail's existing chrome.

**Architecture:** Extend `TrailEvent` with `spanId`/`parentSpanId` and `TrailActor` with `parentId`/`childIds` (all already present in the raw AgentTrail payload, unused so far). Port `buildForest`/`radialLayout`/`treeLayout` from AgentTrail's own bundled dashboard (`agenttrail/upstream/src/agent_tail/web/index.html`) as pure functions. Add node/edge SVG rendering to `trail-section.ts`, extending the `trailActiveView` state machine #125 introduced to a third/fourth value.

**Tech Stack:** TypeScript, Vitest, the existing framework-free console template-literal/shared-IIFE pattern, real-browser (Chromium/CDP) e2e.

## Global Constraints

- No backend or AgentTrail change — every field needed already exists in the raw `run_detail()` payload.
- Node click sets `trailFilterActor` (the same actor-filter-pill state Events/Swimlane already read via `trailVisibleEvents()`) — no new selection state, no new inspector mode.
- Do not port: warning badges, the message-link overlay, pan/zoom/fit-view, dense-mode cutoff, or a separate actor-detail inspector — see the spec's Non-goals for why each is out of scope.
- Full spec: `docs/superpowers/specs/2026-08-09-agent-rail-console-trail-graph-tree-design.md`.

---

### Task 1: Extend `TrailEvent`/`TrailActor` with span and parent-child fields

**Files:**
- Modify: `src/gateway/console/trail-reshape.ts`
- Test: `tests/gateway/console/trail-reshape.test.ts`

**Interfaces:**
- Produces: `TrailEvent.spanId: string | null`, `TrailEvent.parentSpanId: string | null`, `TrailActor.parentId: string | null`, `TrailActor.childIds: readonly string[]`. Consumed by Task 2's `buildForest()`.

- [ ] **Step 1: Write the failing test**

Add to `tests/gateway/console/trail-reshape.test.ts` (read the file's current `RUN_DETAIL` fixture and existing tests first — this only adds new fields to existing fixture entries and new assertions, matching the exact pattern #125's Task 1 already established for this same file):

```ts
describe("reshapeTrail span and parent-child fields", () => {
  it("maps span_id and parent_span_id per event, defaulting to null when absent", () => {
    const view = reshapeTrail({
      ...RUN_DETAIL,
      events: [
        { ...RUN_DETAIL.events[0], span_id: "span-1", parent_span_id: null },
        { ...RUN_DETAIL.events[1], span_id: "span-2", parent_span_id: "span-1" },
        RUN_DETAIL.events[2],
      ],
    });
    expect(view.events[0]!.spanId).toBe("span-1");
    expect(view.events[0]!.parentSpanId).toBeNull();
    expect(view.events[1]!.spanId).toBe("span-2");
    expect(view.events[1]!.parentSpanId).toBe("span-1");
    expect(view.events[2]!.spanId).toBeNull();
    expect(view.events[2]!.parentSpanId).toBeNull();
  });

  it("maps actor parent_id and child_ids, defaulting to null/empty when absent", () => {
    const view = reshapeTrail({
      ...RUN_DETAIL,
      actors: [
        { id: "pod-a", role: "implementation", parent_id: null, child_ids: ["pod-b"] },
        { id: "pod-b", role: null, parent_id: "pod-a" },
      ],
    });
    expect(view.actors[0]!.parentId).toBeNull();
    expect(view.actors[0]!.childIds).toEqual(["pod-b"]);
    expect(view.actors[1]!.parentId).toBe("pod-a");
    expect(view.actors[1]!.childIds).toEqual([]);
  });
});
```

(Adjust the exact spread/fixture mechanics once you see the real current `RUN_DETAIL` shape and #125's actor-detail fixture pattern in the file — the values and assertions above are the source of truth, the literal spread syntax may need adjusting to match reality.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/console/trail-reshape.test.ts -t "span and parent-child"`
Expected: FAIL — fields are `undefined`

- [ ] **Step 3: Implement**

In `src/gateway/console/trail-reshape.ts`, extend `TrailEvent`:

```ts
export interface TrailEvent {
  readonly id: string;
  readonly offsetSeconds: number;
  readonly kind: string;
  readonly name: string;
  readonly summary: string;
  readonly actorId: string;
  readonly failed: boolean;
  readonly sequence: number | null;
  readonly evidence: readonly TrailEvidenceLink[];
  readonly payload: unknown;
  readonly spanId: string | null;
  readonly parentSpanId: string | null;
}
```

Extend `TrailActor`:

```ts
export interface TrailActor {
  readonly id: string;
  readonly role: string | null;
  readonly color: string;
  readonly glyph: string;
  readonly model: string | null;
  readonly status: string;
  readonly usage: TrailActorUsage;
  readonly parentId: string | null;
  readonly childIds: readonly string[];
}
```

In the event-mapping loop inside `reshapeTrail()`, add to the returned object literal:

```ts
      spanId: typeof event["span_id"] === "string" ? event["span_id"] : null,
      parentSpanId: typeof event["parent_span_id"] === "string" ? event["parent_span_id"] : null,
```

In the actor-mapping loop, add:

```ts
    const parentId = typeof actor["parent_id"] === "string" ? actor["parent_id"] : null;
    const childIds = Array.isArray(actor["child_ids"]) ? actor["child_ids"].filter((child): child is string => typeof child === "string") : [];
```

and add `parentId, childIds` to that loop's returned object literal.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/console/trail-reshape.test.ts`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/trail-reshape.ts tests/gateway/console/trail-reshape.test.ts
git commit -m "Extend TrailEvent and TrailActor with span and parent-child fields"
```

---

### Task 2: Layout functions (`buildForest`, `radialLayout`, `treeLayout`)

**Files:**
- Modify: `src/gateway/console/trail-section.ts`
- Test: `tests/gateway/console/trail-section.test.ts`

**Interfaces:**
- Consumes: `TrailActor.parentId`/`.childIds` (Task 1).
- Produces: `buildForest`, `radialLayout`, `treeLayout` script functions — consumed by Task 3's node/edge rendering.

These are pure functions (no DOM), ported from `agenttrail/upstream/src/agent_tail/web/index.html`'s `buildForest`/`radialLayout`/`treeLayout` (read that file's implementation directly before writing this task's code, to confirm the exact current algorithm — the plan brief below transcribes it, but verify against the real source in case it has changed). Adapted here to camelCase field names (`parentId`/`childIds` instead of `parent_id`/`child_ids`).

- [ ] **Step 1: Write the failing test**

This file's existing tests are string-containment checks on `TRAIL_SCRIPT`/`TRAIL_MARKUP` (matching every prior section's test style). For pure functions like these, the strongest test within that style extracts and evaluates the function bodies directly via `new Function(...)`, since they have no DOM dependency. Add to `tests/gateway/console/trail-section.test.ts`:

```ts
function extractFunctions(...names: string[]): Record<string, (...args: any[]) => any> {
  const source = names.map((name) => {
    const start = TRAIL_SCRIPT.indexOf(`const ${name}=`);
    if (start === -1) throw new Error(`function ${name} not found in TRAIL_SCRIPT`);
    let depth = 0;
    let end = start;
    let started = false;
    for (let index = start; index < TRAIL_SCRIPT.length; index += 1) {
      const char = TRAIL_SCRIPT[index];
      if (char === "{" || char === "(") { depth += 1; started = true; }
      if (char === "}" || char === ")") depth -= 1;
      if (started && depth === 0) { end = index + 1; break }
    }
    return TRAIL_SCRIPT.slice(start, end + 1);
  }).join("\n");
  const fn = new Function(`${source}\nreturn {${names.join(",")}};`);
  return fn();
}

describe("trail-section layout functions", () => {
  it("buildForest groups actors into a parent/child tree with computed depth", () => {
    const { buildForest } = extractFunctions("buildForest");
    const actors = [
      { id: "root", parentId: null, childIds: ["child-a", "child-b"] },
      { id: "child-a", parentId: "root", childIds: [] },
      { id: "child-b", parentId: "root", childIds: [] },
    ];
    const forest = buildForest(actors);
    expect(forest.roots).toEqual(["root"]);
    expect(forest.childrenMap.get("root")).toEqual(["child-a", "child-b"]);
    expect(forest.depth.get("root")).toBe(0);
    expect(forest.depth.get("child-a")).toBe(1);
  });

  it("treats an actor whose parentId points at a missing actor as a root", () => {
    const { buildForest } = extractFunctions("buildForest");
    const actors = [{ id: "orphan", parentId: "missing-parent", childIds: [] }];
    const forest = buildForest(actors);
    expect(forest.roots).toEqual(["orphan"]);
  });

  it("radialLayout positions every actor with finite x/y coordinates", () => {
    const { buildForest, radialLayout } = extractFunctions("buildForest", "radialLayout");
    const actors = [
      { id: "root", parentId: null, childIds: ["child-a"] },
      { id: "child-a", parentId: "root", childIds: [] },
    ];
    const layout = radialLayout(buildForest(actors));
    for (const id of ["root", "child-a"]) {
      expect(Number.isFinite(layout.positions[id].x)).toBe(true);
      expect(Number.isFinite(layout.positions[id].y)).toBe(true);
    }
  });

  it("treeLayout positions deeper actors at a greater y than their parent", () => {
    const { buildForest, treeLayout } = extractFunctions("buildForest", "treeLayout");
    const actors = [
      { id: "root", parentId: null, childIds: ["child-a"] },
      { id: "child-a", parentId: "root", childIds: [] },
    ];
    const layout = treeLayout(buildForest(actors));
    expect(layout.positions["child-a"].y).toBeGreaterThan(layout.positions["root"].y);
  });
});
```

(The `extractFunctions` brace-matching helper is a pragmatic approach for this specific test file's string-containment style — if it proves fragile once run against the real `TRAIL_SCRIPT` content, adjust its parsing logic, but keep the same intent: execute the real layout functions from the real script string, not a reimplementation.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/gateway/console/trail-section.test.ts -t "layout functions"`
Expected: FAIL — `buildForest`/`radialLayout`/`treeLayout` not found in `TRAIL_SCRIPT`

- [ ] **Step 3: Implement**

Read `agenttrail/upstream/src/agent_tail/web/index.html`'s `buildForest`/`radialLayout`/`treeLayout` (around lines 1085-1163) directly before writing this, to confirm the exact algorithm. Add to `TRAIL_SCRIPT` in `src/gateway/console/trail-section.ts`, after the existing `trailActorUsageLabel` line and before `renderTrailSwimlane`:

```js
const trailBuildForest=(actors)=>{
  const byId=new Map(actors.map(actor=>[actor.id,actor]));
  const childrenMap=new Map();
  actors.forEach(actor=>childrenMap.set(actor.id,(actor.childIds||[]).filter(id=>byId.has(id))));
  const hasParent=new Set();
  actors.forEach(actor=>{if(actor.parentId&&byId.has(actor.parentId))hasParent.add(actor.id)});
  const roots=actors.filter(actor=>!hasParent.has(actor.id)).map(actor=>actor.id);
  const depth=new Map();
  const assignDepth=(id,d)=>{depth.set(id,d);(childrenMap.get(id)||[]).forEach(c=>assignDepth(c,d+1))};
  roots.forEach(r=>assignDepth(r,0));
  return {byId,childrenMap,roots,depth};
};
const trailLeafCount=(id,childrenMap,leaves)=>{
  const kids=childrenMap.get(id)||[];
  if(!kids.length){leaves[id]=1;return 1}
  let sum=0;kids.forEach(c=>{sum+=trailLeafCount(c,childrenMap,leaves)});
  leaves[id]=sum;return sum;
};
const trailRadialLayout=(forest)=>{
  const {childrenMap,roots}=forest;
  const leaves={};
  roots.forEach(r=>trailLeafCount(r,childrenMap,leaves));
  const totalLeaves=roots.reduce((sum,r)=>sum+(leaves[r]||1),0)||1;
  const cx=560,cy=380,step=132;
  const positions={};
  const place=(id,a0,a1,depth)=>{
    const mid=(a0+a1)/2;
    const r=depth*step;
    positions[id]={x:cx+r*Math.cos(mid),y:cy+r*Math.sin(mid)};
    const kids=childrenMap.get(id)||[];
    if(kids.length){
      let a=a0;
      kids.forEach(child=>{
        const frac=(leaves[child]||1)/(leaves[id]||1);
        const next=a+(a1-a0)*frac;
        place(child,a,next,depth+1);
        a=next;
      });
    }
  };
  let a0=-Math.PI/2;
  const sweep=Math.PI*2;
  roots.forEach(root=>{
    const frac=(leaves[root]||1)/totalLeaves;
    const a1=a0+sweep*frac;
    place(root,a0,a1,roots.length>1?0.7:0);
    a0=a1;
  });
  return {positions,world:{w:1120,h:760}};
};
const trailTreeLayout=(forest)=>{
  const {childrenMap,roots}=forest;
  const positions={};
  let leafIdx=0;
  const rowH=118,colW=120;
  const walk=(id,depth)=>{
    const kids=childrenMap.get(id)||[];
    let x;
    if(!kids.length){x=leafIdx++}
    else{
      const xs=kids.map(c=>walk(c,depth+1));
      x=(xs[0]+xs[xs.length-1])/2;
    }
    positions[id]={gx:x,y:60+depth*rowH};
    return x;
  };
  roots.forEach(r=>walk(r,0));
  const total=Math.max(leafIdx,1);
  const width=Math.max(total*colW,720);
  Object.values(positions).forEach(p=>{p.x=60+(p.gx+0.5)*(width/total)});
  const maxDepth=Math.max(0,...[...forest.depth.values()]);
  return {positions,world:{w:width+120,h:60+(maxDepth+1)*rowH+80}};
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run tests/gateway/console/trail-section.test.ts`
Expected: all tests pass (existing tests unaffected)

- [ ] **Step 5: Commit**

```bash
git add src/gateway/console/trail-section.ts tests/gateway/console/trail-section.test.ts
git commit -m "Add Graph/Tree layout functions ported from AgentTrail's bundled dashboard"
```

---

### Task 3: Node/edge rendering and tab enablement

**Files:**
- Modify: `src/gateway/console/trail-section.ts`
- Test: `tests/gateway/console/trail-section.test.ts`

**Interfaces:**
- Consumes: `trailBuildForest`/`trailRadialLayout`/`trailTreeLayout` (Task 2); `TrailActor.parentId` (Task 1); existing `trailVisibleEvents()`, `trailFilterActor`, `trailActorById`, `label`.
- Produces: enabled Graph and Tree tabs, `renderTrailGraphTree(layoutKind)`.

- [ ] **Step 1: Write the failing tests**

Read the current `TRAIL_MARKUP`'s Graph/Tree buttons (mirroring exactly how #125's equivalent test worked for the Swimlane tab). Update the "renders all four target tabs" test (or whatever it's now titled after #125's edit — read the actual current test) to drop `graph`/`tree` from the still-disabled list, and add:

```ts
  it("enables the Graph and Tree tabs", () => {
    for (const view of ["graph", "tree"]) {
      const start = TRAIL_MARKUP.indexOf(`data-trail-view="${view}"`);
      expect(start).toBeGreaterThan(-1);
      const tag = TRAIL_MARKUP.slice(start, TRAIL_MARKUP.indexOf("</button>", start));
      expect(tag).not.toContain("disabled");
      expect(tag).not.toContain('class="badge"');
    }
  });
```

Add to the script test block:

```ts
  it("renders graph/tree nodes and sets trailFilterActor on click, not a new selection variable", () => {
    const graphTreeIndex = TRAIL_SCRIPT.indexOf("const renderTrailGraphTree=");
    expect(graphTreeIndex).toBeGreaterThan(-1);
    const nextConst = TRAIL_SCRIPT.indexOf("\nconst ", graphTreeIndex + 1);
    const body = TRAIL_SCRIPT.slice(graphTreeIndex, nextConst > -1 ? nextConst : undefined);
    expect(body).toContain("trailFilterActor=");
    expect(body).not.toContain("trailSelectedActor");
  });

  it("dispatches to the graph/tree renderer for both new tabs", () => {
    const dispatchIndex = TRAIL_SCRIPT.indexOf("const renderTrailView=");
    const nextConst = TRAIL_SCRIPT.indexOf("\nconst ", dispatchIndex + 1);
    const body = TRAIL_SCRIPT.slice(dispatchIndex, nextConst > -1 ? nextConst : undefined);
    expect(body).toContain('trailActiveView==="graph"');
    expect(body).toContain('trailActiveView==="tree"');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run tests/gateway/console/trail-section.test.ts`
Expected: FAIL — tabs still disabled, `renderTrailGraphTree` doesn't exist

- [ ] **Step 3: Enable the tabs in `TRAIL_MARKUP`**

Change the Graph and Tree buttons (currently disabled) to the enabled shape, mirroring exactly how #125 enabled the Swimlane button (inactive-but-enabled style — `border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer`):

```ts
      <button type="button" data-trail-view="graph" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Graph</button>
      <button type="button" data-trail-view="tree" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Tree</button>
```

- [ ] **Step 4: Add the node/edge renderer to `TRAIL_SCRIPT`**

Add after Task 2's layout functions and before `renderTrailSwimlane`:

```js
const trailActorStatusColor=(status)=>{
  const normalized=(status||"").toLowerCase();
  if(normalized==="failed"||normalized==="error"||normalized==="errored")return "var(--err)";
  if(normalized==="completed"||normalized==="done")return "var(--ok)";
  if(normalized==="running"||normalized==="waiting")return "var(--warn)";
  return "var(--line)";
};
const renderTrailGraphTree=(layoutKind)=>{
  const host=$("trail-events");if(!host)return;host.replaceChildren();
  const visible=trailVisibleEvents();
  setText($("trail-event-count"),visible.length+" of "+trailEvents.length+" events");
  if(!visible.length){const empty=document.createElement("p");empty.className="empty";setText(empty,trailLoadFailed?"Trace evidence unavailable.":!trailRunId?"Select a run to see its trail.":"No events match the current filters.");host.append(empty);return}
  const visibleActorIds=new Set(visible.map(event=>event.actorId));
  const actors=trailActors.filter(actor=>visibleActorIds.has(actor.id));
  if(!actors.length){const empty=document.createElement("p");empty.className="empty";setText(empty,"No events match the current filters.");host.append(empty);return}
  const forest=trailBuildForest(actors);
  const layout=layoutKind==="graph"?trailRadialLayout(forest):trailTreeLayout(forest);
  const positions=layout.positions;
  const world=layout.world;
  const positionedIds=new Set(actors.filter(actor=>positions[actor.id]).map(actor=>actor.id));

  const canvas=document.createElement("div");
  canvas.style.cssText="position:relative;width:"+world.w+"px;height:"+world.h+"px";

  const svgNamespace="http://www.w3.org/2000/svg";
  const svg=document.createElementNS(svgNamespace,"svg");
  svg.setAttribute("width",String(world.w));
  svg.setAttribute("height",String(world.h));
  svg.style.cssText="position:absolute;top:0;left:0";
  for(const actor of actors){
    if(!actor.parentId||!positionedIds.has(actor.parentId)||!positionedIds.has(actor.id))continue;
    const p=positions[actor.id],pp=positions[actor.parentId];
    const path=document.createElementNS(svgNamespace,"path");
    let d;
    if(layoutKind==="tree"){
      const my=(p.y+pp.y)/2;
      d="M "+pp.x+" "+(pp.y+22)+" C "+pp.x+" "+my+", "+p.x+" "+my+", "+p.x+" "+(p.y-22);
    }else{
      d="M "+pp.x+" "+pp.y+" L "+p.x+" "+p.y;
    }
    path.setAttribute("d",d);
    path.setAttribute("stroke","var(--line)");
    path.setAttribute("stroke-width","1.4");
    path.setAttribute("fill","none");
    svg.append(path);
  }
  canvas.append(svg);

  for(const actor of actors){
    const p=positions[actor.id];if(!p)continue;
    const isRoot=forest.depth.get(actor.id)===0;
    const size=isRoot?58:44;
    const color=trailActorStatusColor(actor.status);
    const node=document.createElement("button");node.type="button";
    node.style.cssText="position:absolute;left:"+p.x+"px;top:"+p.y+"px;transform:translate(-50%,-50%);display:flex;flex-direction:column;align-items:center;gap:4px;background:transparent;border:none;cursor:pointer;padding:0";
    const dot=document.createElement("div");
    dot.style.cssText="width:"+size+"px;height:"+size+"px;border-radius:"+(isRoot?"14px":"50%")+";display:flex;align-items:center;justify-content:center;font:700 13px "+trailFontMono+";color:#0a0e17;background:"+actor.color+";border:2px solid "+(actor.id===trailFilterActor?"var(--accent)":color);
    setText(dot,actor.glyph);
    const idLabel=document.createElement("span");idLabel.style.cssText="font:500 10px "+trailFontMono+";color:var(--faint);max-width:80px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis";setText(idLabel,actor.id);
    node.append(dot,idLabel);
    node.addEventListener("click",()=>{trailFilterActor=trailFilterActor===actor.id?null:actor.id;renderTrailView()});
    canvas.append(node);
  }

  const scroller=document.createElement("div");scroller.style.cssText="overflow:auto;width:100%;height:100%";
  scroller.append(canvas);
  host.append(scroller);
};
```

- [ ] **Step 5: Update `renderTrailView()`'s dispatch**

Change `renderTrailView()` from:

```js
const renderTrailView=()=>{
  renderTrailPills();
  if(trailActiveView==="swimlane")renderTrailSwimlane();else renderTrailEvents();
  ...
```

to:

```js
const renderTrailView=()=>{
  renderTrailPills();
  if(trailActiveView==="swimlane")renderTrailSwimlane();
  else if(trailActiveView==="graph")renderTrailGraphTree("graph");
  else if(trailActiveView==="tree")renderTrailGraphTree("tree");
  else renderTrailEvents();
  ...
```

(keep the rest of the function body — the inspector/scrubber calls after this dispatch — unchanged)

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm exec vitest run tests/gateway/console/trail-section.test.ts`
Expected: all pass

- [ ] **Step 7: Run the console-ui parse-check**

Run: `pnpm exec vitest run tests/gateway/console/console-ui.test.ts`
Expected: all pass — confirms the whole concatenated script is still syntactically valid

- [ ] **Step 8: Commit**

```bash
git add src/gateway/console/trail-section.ts tests/gateway/console/trail-section.test.ts
git commit -m "Add Graph/Tree node/edge rendering and enable both tabs"
```

---

### Task 4: e2e coverage

**Files:**
- Modify: `tests/ui/console-shell.e2e.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-3, exercised end-to-end through a real browser.

- [ ] **Step 1: Write the failing test**

Read the existing Swimlane e2e test (from #125) as the structural model. Extend the `fakeAgentTrailForE2e` fixture's actors so `pod-b`'s raw payload includes `parent_id: "pod-a"` and `pod-a` includes `child_ids: ["pod-b"]` (check the fixture's current exact shape first — #125 already extended `pod-a` with model/status/usage, this task adds the parent/child relationship on top of that, or to whichever actors make sense given the current fixture state). Add:

```ts
  it("switches to Graph and shows connected actor nodes, then confirms Tree renders the same data", async () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "zentra-console-shell-trail-graph-e2e-")));
    temporaryDirectories.push(root);
    const fixture = await consoleShellWorkflow(root);
    const gateway = new LoopbackGateway({ workflow: fixture.workflow });
    const session = await gateway.start();
    gateway.setReadiness("ready");
    let upstream: Awaited<ReturnType<typeof fakeAgentTrailForE2e>> | null = null;
    try {
      const driver = await ChromiumWorkflowDriver.open(session.url, root);
      const submittedRunId = await driver.submitGoal("Prove Graph/Tree renders connected actor nodes");
      upstream = await fakeAgentTrailForE2e(submittedRunId);
      gateway.setAgentTrailAddress(upstream.address);
      await driver.click('[data-nav-id="trail"]');
      await driver.waitFor(`document.querySelector('[data-section-id="trail"]')?.dataset.active === "true"`);
      await driver.evaluate(`window.__consoleSections.trail.load()`);
      await driver.click('[data-trail-view="graph"]');
      const graphNodeCount = await driver.evaluate<number>(`document.querySelectorAll("#trail-events button").length`);
      expect(graphNodeCount).toBe(2);
      const edgeCount = await driver.evaluate<number>(`document.querySelectorAll("#trail-events svg path").length`);
      expect(edgeCount).toBe(1);
      await driver.click('[data-trail-view="tree"]');
      const treeNodeCount = await driver.evaluate<number>(`document.querySelectorAll("#trail-events button").length`);
      expect(treeNodeCount).toBe(2);
      // Clicking a node sets trailFilterActor, which the shared filter-pill state already
      // reflects visually - confirm via the event count line narrowing, not a new selection concept.
      await driver.evaluate(`document.querySelectorAll("#trail-events button")[0]?.click()`);
      const filteredCount = await driver.evaluate<string>(`document.getElementById("trail-event-count")?.textContent || ""`);
      expect(filteredCount).toMatch(/^1 of \d+ events$/);
    } finally {
      await gateway.close();
      fixture.journal.close();
    }
  }, 60_000);
```

Adjust the exact node/edge count assertions once you see the real fixture's actor/event data (the brief above assumes a two-actor, one-parent-child-edge fixture; match to whatever the real fixture ends up seeding).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "Graph and shows connected"`
Expected: FAIL if Tasks 1-3 haven't landed yet in your working tree — treat as a formality if they already have, diagnose against the wiring instead if it fails unexpectedly

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts -t "Graph and shows connected"`
Expected: PASS

- [ ] **Step 4: Run the full e2e file to confirm no regressions**

Run: `pnpm exec vitest run tests/ui/console-shell.e2e.test.ts`
Expected: all tests pass

- [ ] **Step 5: Commit**

```bash
git add tests/ui/console-shell.e2e.test.ts
git commit -m "Add e2e coverage for the Graph/Tree view"
```

---

### Task 5: Verify, merge, push, close #126

Executed by the controller directly, matching the pattern used for every prior step's final task.

- [ ] **Step 1:** Confirm `docs/codebase-map.html` freshness and regenerate/commit if stale — treat this as certain to be needed, per the standing lesson, not a maybe.
- [ ] **Step 2:** Run the full test suite solo (`pnpm test`) — compare against the documented pre-existing environmental baseline; isolate-and-rerun anything outside it before treating it as a regression, including files this branch's own diff touches.
- [ ] **Step 3:** Run `pnpm build`. Must be clean.
- [ ] **Step 4:** Dispatch a final whole-branch code review (most capable available model), explicitly briefed to check for design-quality gaps given this was also built without interactive review — per the lesson from #125. Address findings with a fix subagent, re-review, re-verify the codebase map as the literal last commit.
- [ ] **Step 5:** Merge to `main`, push to `origin`.
- [ ] **Step 6:** `gh issue close 126` with a summary comment.
- [ ] **Step 7:** Update project memory — this closes out all of Trail's three internal sub-steps (#119 in full), and only #127 remains of Phase 2's tracked scope.
