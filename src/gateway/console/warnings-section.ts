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
