export const PODS_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Pods"><section class="workspace" aria-label="Pods"><section class="panel"><h2>Pods</h2><div id="pods-list" class="stack"></div></section><section class="panel"><h2>Pod detail</h2><div id="pod-detail"></div></section></section></div>`;

export const PODS_SCRIPT = String.raw`let podsState=[];let podsSelectedId=null;let podsLoadFailed=false;
const loadPods=async()=>{
  try{const result=await request("/api/v1/zentra/pods");podsState=list(result,["pods"]);podsLoadFailed=false}
  catch(error){podsState=[];podsLoadFailed=true}
  if(podsSelectedId&&!podsState.some(pod=>pod.podId===podsSelectedId))podsSelectedId=null;
  renderPods();
};
const podsSelect=(podId)=>{podsSelectedId=podId;renderPods()};
const renderPodsList=()=>{
  const host=$("pods-list");host.replaceChildren();
  if(!podsState.length){const empty=document.createElement("p");empty.className="empty";setText(empty,podsLoadFailed?"Pods unavailable.":"No pods yet.");host.append(empty);return}
  for(const pod of podsState){
    const button=document.createElement("button");button.type="button";button.className="run-card";
    button.dataset.selected=String(pod.podId===podsSelectedId);
    const title=document.createElement("strong");setText(title,pod.podId);
    const meta=document.createElement("span");setText(meta,"Revision "+pod.revision);
    button.append(title,meta,badge(label(pod.lifecycle)));
    button.addEventListener("click",()=>podsSelect(pod.podId));
    host.append(button);
  }
};
const renderPodDetail=()=>{
  const host=$("pod-detail");host.replaceChildren();
  const pod=podsState.find(candidate=>candidate.podId===podsSelectedId);
  if(!pod){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select a pod to inspect its charter, assignments, and evidence.");host.append(empty);return}
  const heading=document.createElement("h3");setText(heading,pod.podId);
  const facts=document.createElement("dl");facts.className="facts";
  const assignmentCount=Object.keys(pod.assignments||{}).length;
  const checkpointCount=Object.keys(pod.checkpoints||{}).length;
  facts.append(
    field("Pod",pod.podId),
    field("Project",pod.projectId),
    field("Lifecycle",label(pod.lifecycle)),
    field("Revision",String(pod.revision)),
    field("Outcome",pod.charter&&pod.charter.outcome||"Unknown"),
    field("Assignments",String(assignmentCount)),
    field("Checkpoints",String(checkpointCount)),
    field("Attention",pod.attention?pod.attention.reason:"None"),
    field("Terminal outcome",pod.terminal?label(pod.terminal.outcome):"Not terminal"),
  );
  host.append(heading,facts);
  appendJson(host,"Charter",pod.charter);
  appendJson(host,"Assignments",pod.assignments);
  appendJson(host,"Checkpoints",pod.checkpoints);
  appendJson(host,"Evidence",pod.evidence);
  appendJson(host,"Attention",pod.attention);
  appendJson(host,"Reconciliation",pod.reconciliation);
};
const renderPods=()=>{renderPodsList();renderPodDetail()};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.pods={render:renderPods,load:loadPods};`;
