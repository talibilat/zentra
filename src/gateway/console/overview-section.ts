export const OVERVIEW_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Overview" id="overview-root"></div>`;

export const OVERVIEW_SCRIPT = String.raw`const renderOverview=()=>{
  const host=$("overview-root");if(!host)return;host.replaceChildren();
  const run=currentRun();
  if(!run){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select a run to see its overview.");host.append(empty);return}
  const heading=document.createElement("h1");setText(heading,value(run,["title","goal","summary"],value(run,["runId","id"],"Run")));
  const badgeEl=badge(label(String(value(run,["lifecycle","state","status"],"unknown"))));
  const head=document.createElement("div");head.style.cssText="display:flex;align-items:baseline;gap:14px;flex-wrap:wrap";head.append(heading,badgeEl);
  const narrativeHeading=document.createElement("h2");setText(narrativeHeading,"What happened");
  const narrativeList=document.createElement("div");
  for(const item of state.selected?.attention||[]){
    const row=document.createElement("p");
    setText(row,value(item,["title","question","kind"],"Decision")+": "+label(String(value(item,["status","state"],"pending"))));
    narrativeList.append(row);
  }
  if((state.selected?.attention||[]).length===0){const empty=document.createElement("p");empty.className="empty";setText(empty,"No attention history yet for this run.");narrativeList.append(empty)}
  host.append(head,narrativeHeading,narrativeList);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.overview={render:renderOverview};`;
