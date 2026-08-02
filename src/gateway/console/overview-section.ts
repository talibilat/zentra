import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const OVERVIEW_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Overview" id="overview-root"></div>`;

export const OVERVIEW_SCRIPT = String.raw`
const overviewTile=(metricLabel)=>{
  const tile=document.createElement("div");
  tile.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px";
  const labelEl=document.createElement("div");
  labelEl.style.cssText='font:500 10px ${CONSOLE_FONT_STACK_MONO};color:var(--faint);letter-spacing:1px';
  setText(labelEl,metricLabel);
  const valueRow=document.createElement("div");
  valueRow.style.cssText="display:flex;align-items:baseline;gap:7px;margin-top:8px";
  const valueEl=document.createElement("span");
  valueEl.style.cssText='font:600 26px ${CONSOLE_FONT_STACK_MONO};color:var(--faint)';
  setText(valueEl,"—");
  valueRow.append(valueEl);
  const subEl=document.createElement("div");
  subEl.style.cssText='font:400 10.5px ${CONSOLE_FONT_STACK_MONO};color:var(--faint);margin-top:6px';
  setText(subEl,"Available in a later phase");
  tile.append(labelEl,valueRow,subEl);
  return tile;
};
const renderOverview=()=>{
  const host=$("overview-root");if(!host)return;host.replaceChildren();
  const run=currentRun();
  if(!run){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select a run to see its overview.");host.append(empty);return}

  const heading=document.createElement("h1");
  heading.style.cssText='margin:0;font:700 22px ${CONSOLE_FONT_STACK_SANS}';
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
  narrativeHeading.style.cssText='margin:0 0 4px;font:600 14px ${CONSOLE_FONT_STACK_SANS}';
  setText(narrativeHeading,"What happened");
  const narrativeCaption=document.createElement("p");
  narrativeCaption.style.cssText='margin:0 0 16px;font:400 12px ${CONSOLE_FONT_STACK_SANS};color:var(--dim)';
  setText(narrativeCaption,"Pending and resolved operator decisions for this run.");
  const narrativeList=document.createElement("div");
  narrativeList.style.cssText="display:flex;flex-direction:column;gap:10px";
  const timeline=[
    ...(state.attention||[]).map((item)=>({item,resolved:false})),
    ...(state.history||[]).map((item)=>({item,resolved:true})),
  ].sort((a,b)=>value(a.item,["streamVersion"],0)-value(b.item,["streamVersion"],0));
  for(const {item,resolved} of timeline){
    const row=document.createElement("div");
    row.style.cssText="border-left:2px solid var(--line);padding:0 0 4px 16px;margin-left:6px";
    const statusEl=document.createElement("span");
    statusEl.style.cssText='display:block;font:500 10.5px ${CONSOLE_FONT_STACK_MONO};color:var(--faint)';
    setText(statusEl,resolved?("Resolved · "+label(String(value(item,["status","state"],"unknown")))):"Pending");
    const titleEl=document.createElement("span");
    titleEl.style.cssText='display:block;margin-top:4px;font:400 13px/1.55 ${CONSOLE_FONT_STACK_SANS};color:var(--text)';
    const summary=value(item.packet||{},["summary","question"],value(item,["message","kind"],"Decision"));
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
  outcomeHeading.style.cssText='margin:0 0 12px;font:600 14px ${CONSOLE_FONT_STACK_SANS}';
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
    const kEl=document.createElement("span");kEl.style.cssText='font:500 11.5px ${CONSOLE_FONT_STACK_SANS};color:var(--dim)';setText(kEl,k);
    const vEl=document.createElement("span");vEl.style.cssText='font:600 12px ${CONSOLE_FONT_STACK_MONO};color:var(--text)';setText(vEl,v);
    row.append(kEl,vEl);
    outcomeSection.append(row);
  }

  const warningsSection=document.createElement("section");
  warningsSection.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px";
  const warningsHeading=document.createElement("h2");
  warningsHeading.style.cssText='margin:0 0 10px;font:600 14px ${CONSOLE_FONT_STACK_SANS}';
  setText(warningsHeading,"Top warnings");
  const warningsEmpty=document.createElement("p");
  warningsEmpty.className="empty";
  setText(warningsEmpty,"Warning triage has no real backend yet - the Warnings section shows a static preview.");
  warningsSection.append(warningsHeading,warningsEmpty);

  sidebar.append(outcomeSection,warningsSection);
  body.append(narrativeSection,sidebar);
  host.append(head,metricsRow,body);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.overview={render:renderOverview};`;
