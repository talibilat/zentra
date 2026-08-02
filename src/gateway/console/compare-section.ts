import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const COMPARE_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Compare runs" id="compare-root"></div>`;

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
  section.append(heading);
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
  const lastFactRow=section.lastElementChild;
  if(lastFactRow&&lastFactRow!==heading)lastFactRow.style.borderBottom="none";
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
  if(deltaTable.lastElementChild)deltaTable.lastElementChild.style.borderBottom="none";
  host.append(heading,note,runRow,divergence,factsGrid,deltaHeading,deltaTable);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.compare={render:renderCompare};
renderCompare();`;
