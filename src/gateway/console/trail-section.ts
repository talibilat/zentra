import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const TRAIL_MARKUP = `<div style="flex:1;min-height:0;display:flex;flex-direction:column" data-screen-label="Trail">
  <div id="agenttrail-status" class="agenttrail-status" data-tone="ok" role="status" aria-live="polite">AgentTrail is live and read-only.</div>
  <div style='flex:none;display:flex;align-items:center;gap:14px;padding:10px 18px;border-bottom:1px solid var(--line);background:var(--panel);flex-wrap:wrap'>
    <div style='display:flex;gap:4px'>
      <button type="button" data-trail-view="graph" disabled aria-disabled="true" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--faint);cursor:not-allowed;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Graph<span class="badge">Phase 2</span></button>
      <button type="button" data-trail-view="tree" disabled aria-disabled="true" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--faint);cursor:not-allowed;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Tree<span class="badge">Phase 2</span></button>
      <button type="button" data-trail-view="swimlane" disabled aria-disabled="true" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--faint);cursor:not-allowed;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Swimlane<span class="badge">Phase 2</span></button>
      <button type="button" data-trail-view="events" aria-current="true" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid var(--accent);background:rgba(122,162,255,.12);color:var(--accent);cursor:default;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Events</button>
    </div>
    <span style='width:1px;height:22px;background:var(--line)'></span>
    <div id="trail-filter-pills" style='display:flex;gap:5px;flex-wrap:wrap;align-items:center'></div>
    <div style='flex:1'></div>
    <span id="trail-event-count" style='font:400 11px ${CONSOLE_FONT_STACK_MONO};color:var(--faint)'></span>
  </div>
  <div style='flex:1;min-height:0;display:flex'>
    <div id="trail-events" style='flex:1;min-width:0;overflow-y:auto;padding:10px 14px;display:flex;flex-direction:column;gap:4px'></div>
    <aside id="trail-inspector" style='width:360px;flex:none;border-left:1px solid var(--line);background:var(--panel);overflow-y:auto'></aside>
  </div>
  <div style='height:52px;flex:none;padding:0 16px;border-top:1px solid var(--line);background:var(--panel);display:flex;align-items:center;gap:14px'>
    <div id="trail-clock" style='font:600 12px ${CONSOLE_FONT_STACK_MONO};color:var(--dim);width:110px;flex:none;text-align:center'></div>
    <input type="range" id="trail-scrub" min="0" max="1000" step="1" value="1000" style='flex:1'>
    <button type="button" id="trail-jump-live" style='height:26px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);cursor:pointer;font:600 11px ${CONSOLE_FONT_STACK_MONO};padding:0 12px'>Jump to live</button>
  </div>
</div>`;

export const TRAIL_SCRIPT = String.raw`const trailFontMono='${CONSOLE_FONT_STACK_MONO}';
const trailFontSans='${CONSOLE_FONT_STACK_SANS}';
const applyGatewayChange=(change)=>{const node=$("agenttrail-status");if(change.type==="gateway.degraded"){node.dataset.tone="error";setText(node,"AgentTrail unavailable. Zentra controls remain available while recovery is verified.")}if(change.type==="gateway.backfill_target"){node.dataset.tone="waiting";setText(node,"AgentTrail replacement is backfilling durable evidence.")}if(change.type==="gateway.recovered"){node.dataset.tone="ok";setText(node,"AgentTrail recovered from durable evidence and is live.");loadTrail()}};
let trailRunId=null;
let trailEvents=[];
let trailActors=[];
let trailSelectedEvent=null;
let trailFilterActor=null;
let trailFilterKind=null;
let trailFailedOnly=false;
let trailScrubT=1;
const trailActorById=(id)=>trailActors.find(actor=>actor.id===id)||{id,role:null,color:"var(--faint)",glyph:"?"};
const trailKindColor=(kind)=>{const palette=["var(--run)","var(--ok)","var(--warn)","var(--accent)","var(--orch)","var(--err)"];const prefix=kind.split(".")[0]||kind;let hash=0;for(let index=0;index<prefix.length;index+=1)hash=(hash*31+prefix.charCodeAt(index))|0;return palette[Math.abs(hash)%palette.length]};
const trailFormatClock=(seconds)=>{const total=Math.max(0,Math.round(seconds));const minutes=Math.floor(total/60);const rest=String(total%60).padStart(2,"0");return minutes+":"+rest};
const trailMaxOffset=()=>trailEvents.reduce((max,event)=>Math.max(max,event.offsetSeconds),0);
const trailVisibleEvents=()=>{const horizon=trailScrubT*trailMaxOffset();const term=state.search.trim().toLowerCase();return trailEvents.filter(event=>event.offsetSeconds<=horizon).filter(event=>!trailFilterActor||event.actorId===trailFilterActor).filter(event=>!trailFilterKind||event.kind.startsWith(trailFilterKind)).filter(event=>!trailFailedOnly||event.failed).filter(event=>!term||(event.name+" "+event.kind+" "+event.actorId+" "+event.summary).toLowerCase().includes(term))};
const trailPill=(labelText,active,onClick,color)=>{const button=document.createElement("button");button.type="button";button.style.cssText="padding:5px 11px;border-radius:999px;cursor:pointer;font:500 10.5px "+trailFontMono+";border:1px solid "+(active?(color||"var(--accent)"):"var(--line)")+";background:"+(active?"rgba(122,162,255,.14)":"var(--panel2)")+";color:"+(active?(color||"var(--accent)"):"var(--dim)");setText(button,labelText);button.addEventListener("click",onClick);return button};
const renderTrailPills=()=>{
  const host=$("trail-filter-pills");if(!host)return;host.replaceChildren();
  for(const actor of trailActors){host.append(trailPill(actor.id,trailFilterActor===actor.id,()=>{trailFilterActor=trailFilterActor===actor.id?null:actor.id;renderTrailView()},actor.color))}
  const kinds=[...new Set(trailEvents.map(event=>event.kind.split(".")[0]))].sort();
  for(const kind of kinds){host.append(trailPill(kind,trailFilterKind===kind,()=>{trailFilterKind=trailFilterKind===kind?null:kind;renderTrailView()}))}
  host.append(trailPill("failed only",trailFailedOnly,()=>{trailFailedOnly=!trailFailedOnly;renderTrailView()},"var(--err)"));
};
const trailInspectorRow=(key,text,color)=>{const row=document.createElement("div");row.style.cssText="display:flex;justify-content:space-between;gap:10px;padding:5px 0;font:400 11px "+trailFontMono+";color:var(--dim)";const k=document.createElement("span");setText(k,key);const v=document.createElement("span");v.style.color=color||"var(--text)";setText(v,text);row.append(k,v);return row};
const trailInspectorLabel=(text)=>{const label=document.createElement("div");label.style.cssText="font:600 10px "+trailFontMono+";color:var(--faint);letter-spacing:1.2px;margin-bottom:11px";setText(label,text);return label};
const renderTrailInspectorDefault=()=>{
  const host=$("trail-inspector");if(!host)return;host.replaceChildren();
  const heading=document.createElement("div");heading.style.cssText="font:600 15px "+trailFontSans+";padding:14px 16px;border-bottom:1px solid var(--line)";setText(heading,"Run");
  const block=document.createElement("div");block.style.cssText="padding:14px 16px";
  block.append(
    trailInspectorRow("trace_id",trailRunId||"—"),
    trailInspectorRow("duration",trailFormatClock(trailMaxOffset())),
    trailInspectorRow("events",String(trailEvents.length)),
    trailInspectorRow("actors",String(trailActors.length)),
  );
  host.append(heading,block);
};
const renderTrailInspectorEvent=(trailEvent)=>{
  const host=$("trail-inspector");if(!host)return;host.replaceChildren();
  const actor=trailActorById(trailEvent.actorId);
  const heading=document.createElement("div");heading.style.cssText="font:600 15px "+trailFontSans+";padding:14px 16px;border-bottom:1px solid var(--line)";setText(heading,trailEvent.name);
  const fieldsBlock=document.createElement("div");fieldsBlock.style.cssText="padding:14px 16px;border-bottom:1px solid var(--line)";
  fieldsBlock.append(
    trailInspectorLabel("EVENT"),
    trailInspectorRow("event_id",trailEvent.id),
    trailInspectorRow("actor",actor.id),
    trailInspectorRow("status",trailEvent.failed?"failed":"ok",trailEvent.failed?"var(--err)":"var(--ok)"),
    trailInspectorRow("sequence",trailEvent.sequence===null?"—":String(trailEvent.sequence)),
  );
  host.append(heading,fieldsBlock);
  if(trailEvent.evidence.length){
    const evidenceBlock=document.createElement("div");evidenceBlock.style.cssText="padding:14px 16px;border-bottom:1px solid var(--line)";
    evidenceBlock.append(trailInspectorLabel("EVIDENCE LINKS"));
    for(const link of trailEvent.evidence){
      const button=document.createElement("button");button.type="button";
      button.style.cssText="display:block;width:100%;border:none;border-left:2px solid var(--accent);background:rgba(122,162,255,.06);padding:10px 12px;margin-bottom:8px;cursor:pointer;text-align:left;border-radius:0 8px 8px 0;color:var(--text);font:600 10px "+trailFontMono;
      setText(button,link.type+" — event "+link.refEventId);
      button.addEventListener("click",()=>{trailSelectedEvent=link.refEventId;renderTrailView()});
      evidenceBlock.append(button);
    }
    host.append(evidenceBlock);
  }
  const payloadBlock=document.createElement("div");payloadBlock.style.cssText="padding:14px 16px";
  payloadBlock.append(trailInspectorLabel("PAYLOAD"));
  const pre=document.createElement("pre");pre.style.cssText="margin:0;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:11px;font:400 11.5px/1.6 "+trailFontMono+";color:var(--text);white-space:pre-wrap;word-break:break-word;max-height:240px;overflow:auto";setText(pre,JSON.stringify(trailEvent.payload,null,2));
  payloadBlock.append(pre);
  host.append(payloadBlock);
};
const renderTrailEvents=()=>{
  const host=$("trail-events");if(!host)return;host.replaceChildren();
  const visible=trailVisibleEvents();
  setText($("trail-event-count"),visible.length+" of "+trailEvents.length+" events");
  if(!visible.length){const empty=document.createElement("p");empty.className="empty";setText(empty,trailRunId?"No events match the current filters.":"Trace evidence unavailable.");host.append(empty);return}
  for(const trailEvent of visible){
    const actor=trailActorById(trailEvent.actorId);
    const row=document.createElement("div");row.style.cssText="display:flex;align-items:stretch;border-radius:9px;border:1px solid "+(trailEvent.id===trailSelectedEvent?"var(--accent)":"var(--line)")+";background:"+(trailEvent.id===trailSelectedEvent?"rgba(122,162,255,.07)":"var(--panel)");
    const rail=document.createElement("span");rail.style.cssText="width:3px;align-self:stretch;border-radius:3px;flex:none;background:"+(trailEvent.failed?"var(--err)":"var(--ok)");
    const button=document.createElement("button");button.type="button";button.style.cssText="display:flex;align-items:center;gap:12px;flex:1;min-width:0;background:transparent;border:none;padding:10px 12px;cursor:pointer;text-align:left;color:var(--text)";
    const time=document.createElement("span");time.style.cssText="font:500 10.5px "+trailFontMono+";color:var(--faint);width:46px;flex:none";setText(time,trailFormatClock(trailEvent.offsetSeconds));
    const kind=document.createElement("span");kind.style.cssText="font:600 9.5px "+trailFontMono+";color:"+trailKindColor(trailEvent.kind)+";background:var(--panel2);padding:3px 7px;border-radius:4px;white-space:nowrap;flex:none";setText(kind,trailEvent.kind);
    const name=document.createElement("span");name.style.cssText="font:600 12.5px "+trailFontSans+";white-space:nowrap;overflow:hidden;text-overflow:ellipsis";setText(name,trailEvent.name);
    const summary=document.createElement("span");summary.style.cssText="flex:1;font:400 11.5px "+trailFontSans+";color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis";setText(summary,trailEvent.summary);
    const actorLabel=document.createElement("span");actorLabel.style.cssText="font:500 10.5px "+trailFontMono+";color:"+actor.color+";flex:none";setText(actorLabel,actor.id);
    button.append(time,kind,name,summary,actorLabel);
    button.addEventListener("click",()=>{trailSelectedEvent=trailEvent.id;renderTrailView()});
    row.append(rail,button);
    host.append(row);
  }
};
const renderTrailScrubber=()=>{
  const maxOffset=trailMaxOffset();
  setText($("trail-clock"),trailFormatClock(trailScrubT*maxOffset)+" / "+trailFormatClock(maxOffset));
  const scrub=$("trail-scrub");if(scrub)scrub.value=String(Math.round(trailScrubT*1000));
};
const renderTrailView=()=>{
  renderTrailPills();
  renderTrailEvents();
  const selected=trailSelectedEvent?trailEvents.find(event=>event.id===trailSelectedEvent):null;
  if(selected)renderTrailInspectorEvent(selected);else renderTrailInspectorDefault();
  renderTrailScrubber();
};
const loadTrail=async()=>{
  const run=currentRun();const id=run?value(run,["runId","id"],null):null;
  if(!id){trailRunId=null;trailEvents=[];trailActors=[];trailSelectedEvent=null;renderTrailView();return}
  trailRunId=id;
  try{
    const result=await request("/api/v1/zentra/runs/"+encodeURIComponent(id)+"/trail");
    trailEvents=list(result,["events"]);trailActors=list(result,["actors"]);
  }catch(error){trailEvents=[];trailActors=[]}
  trailScrubT=1;trailSelectedEvent=null;
  renderTrailView();
};
$("trail-scrub")?.addEventListener("input",(event)=>{trailScrubT=Number(event.target.value)/1000;renderTrailView()});
$("trail-jump-live")?.addEventListener("click",()=>{trailScrubT=1;renderTrailView()});
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.trail={render:loadTrail};
renderTrailView();`;
