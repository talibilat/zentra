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
