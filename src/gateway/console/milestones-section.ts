export const MILESTONES_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Milestones"><section class="workspace" data-columns="2" aria-label="Milestones"><section class="panel"><h2>Milestones</h2><div id="milestones-list" class="stack"></div></section><section class="panel"><h2>Milestone detail</h2><div id="milestone-detail"></div></section></section></div>`;

export const MILESTONES_SCRIPT = String.raw`let milestonesState=[];let milestonesLoadFailed=false;let milestoneSelectedId=null;let milestoneDetail=null;let milestoneDetailLoadFailed=false;
const loadMilestones=async()=>{
  try{const result=await request("/api/v1/zentra/milestones");milestonesState=list(result,["milestones"]);milestonesLoadFailed=false}
  catch{milestonesState=[];milestonesLoadFailed=true}
  if(milestoneSelectedId&&!milestonesState.some(milestone=>milestone.milestoneId===milestoneSelectedId)){milestoneSelectedId=null;milestoneDetail=null}
  renderMilestones();
};
const selectMilestone=async(id)=>{
  milestoneSelectedId=id;
  try{const result=await request("/api/v1/zentra/milestones/"+encodeURIComponent(id));if(milestoneSelectedId!==id)return;milestoneDetail=result;milestoneDetailLoadFailed=false}
  catch{if(milestoneSelectedId!==id)return;milestoneDetail=null;milestoneDetailLoadFailed=true}
  renderMilestones();
};
const renderMilestonesList=()=>{
  const host=$("milestones-list");host.replaceChildren();
  if(!milestonesState.length){const empty=document.createElement("p");empty.className="empty";setText(empty,milestonesLoadFailed?"Milestones unavailable.":"No milestones yet.");host.append(empty);return}
  for(const milestone of milestonesState){
    const button=document.createElement("button");button.type="button";button.className="run-card";
    button.dataset.selected=String(milestone.milestoneId===milestoneSelectedId);
    const title=document.createElement("strong");setText(title,milestone.title);
    const meta=document.createElement("span");setText(meta,milestone.milestoneId+" · "+milestone.taskCount+" tasks");
    button.append(title,meta,badge(label(milestone.lifecycle)));
    button.addEventListener("click",()=>selectMilestone(milestone.milestoneId));
    host.append(button);
  }
};
const renderMilestoneDetail=()=>{
  const host=$("milestone-detail");host.replaceChildren();
  if(!milestoneSelectedId){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select a milestone to inspect its plan, tasks, and history.");host.append(empty);return}
  const milestone=milestoneDetail;
  if(!milestone){const empty=document.createElement("p");empty.className="empty";setText(empty,milestoneDetailLoadFailed?"Milestone detail unavailable.":"Loading milestone detail.");host.append(empty);return}
  const heading=document.createElement("h3");setText(heading,milestone.title);
  const facts=document.createElement("dl");facts.className="facts";
  const taskCount=Object.keys(milestone.tasks||{}).length;
  facts.append(
    field("Milestone",milestone.milestoneId),
    field("Project",milestone.projectId),
    field("Title",milestone.title),
    field("Lifecycle",label(milestone.lifecycle)),
    field("Terminal outcome",milestone.terminalOutcome?label(milestone.terminalOutcome):"Not terminal"),
    field("Tasks",String(taskCount)),
    field("Trace ID",milestone.traceId),
    field("Trace path",milestone.tracePath||"None"),
  );
  host.append(heading,facts);
  appendJson(host,"Plan",milestone.plan);
  appendJson(host,"Tasks",milestone.tasks);
  appendJson(host,"Historical tasks",milestone.historicalTasks);
  appendJson(host,"Writer ownership",milestone.writerOwnership);
  appendJson(host,"Revisions",milestone.revisions);
  appendJson(host,"Attention",milestone.attention);
  appendJson(host,"Replanning attention",milestone.replanningAttention);
  appendJson(host,"Authority envelope",milestone.authorityEnvelope);
  appendJson(host,"Result",milestone.result);
  appendJson(host,"Release operation",milestone.releaseOperation);
};
const renderMilestones=()=>{renderMilestonesList();renderMilestoneDetail()};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.milestones={render:renderMilestones,load:loadMilestones};`;
