export const GITHUB_BROKER_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="GitHub broker"><section class="workspace" data-columns="2" aria-label="GitHub broker"><section class="panel"><h2>GitHub broker</h2><div id="github-broker-list" class="stack"></div></section><section class="panel"><h2>Activity detail</h2><div id="github-broker-detail"></div></section></section></div>`;

export const GITHUB_BROKER_SCRIPT = String.raw`let githubBrokerState=[];let githubBrokerLoadFailed=false;let githubBrokerSelectedId=null;
const loadGitHubBrokerActivity=async()=>{
  try{const result=await request("/api/v1/zentra/github-broker");githubBrokerState=list(result,["activity"]);githubBrokerLoadFailed=false}
  catch{githubBrokerState=[];githubBrokerLoadFailed=true}
  if(githubBrokerSelectedId&&!githubBrokerState.some(entry=>entry.grantId===githubBrokerSelectedId))githubBrokerSelectedId=null;
  renderGitHubBroker();
};
const githubBrokerSelect=(grantId)=>{githubBrokerSelectedId=grantId;renderGitHubBroker()};
const githubBrokerOperationLabel=(operation)=>operation==="create_pull_request"?"Create pull request":"Push";
const renderGitHubBrokerList=()=>{
  const host=$("github-broker-list");host.replaceChildren();
  if(!githubBrokerState.length){const empty=document.createElement("p");empty.className="empty";setText(empty,githubBrokerLoadFailed?"GitHub broker activity unavailable.":"No GitHub broker activity yet.");host.append(empty);return}
  for(const entry of githubBrokerState){
    const button=document.createElement("button");button.type="button";button.className="run-card";
    button.dataset.selected=String(entry.grantId===githubBrokerSelectedId);
    const title=document.createElement("strong");setText(title,entry.repository);
    const meta=document.createElement("span");setText(meta,githubBrokerOperationLabel(entry.operation)+" · "+entry.grantId);
    button.append(title,meta,badge(label(entry.status)));
    button.addEventListener("click",()=>githubBrokerSelect(entry.grantId));
    host.append(button);
  }
};
const renderGitHubBrokerDetail=()=>{
  const host=$("github-broker-detail");host.replaceChildren();
  const entry=githubBrokerState.find(candidate=>candidate.grantId===githubBrokerSelectedId);
  if(!entry){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select an activity entry to inspect its detail.");host.append(empty);return}
  const heading=document.createElement("h3");setText(heading,entry.repository);
  const facts=document.createElement("dl");facts.className="facts";
  facts.append(
    field("Grant ID",entry.grantId),
    field("Request ID",entry.requestId),
    field("Operation",githubBrokerOperationLabel(entry.operation)),
    field("Repository",entry.repository),
    field("Status",label(entry.status)),
    entry.operation==="push"?field("Target ref",entry.detail.targetRef||"Unknown"):field("Head ref",entry.detail.headRef||"Unknown"),
    entry.operation==="push"?field("Source commit",entry.detail.sourceCommit||"Unknown"):field("Base",entry.detail.base||"Unknown"),
  );
  if(entry.operation==="create_pull_request")facts.append(field("Draft",entry.detail.draft?"Yes":"No"));
  host.append(heading,facts);
  appendJson(host,"Detail",entry.detail);
};
const renderGitHubBroker=()=>{renderGitHubBrokerList();renderGitHubBrokerDetail()};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.github={render:renderGitHubBroker,load:loadGitHubBrokerActivity};`;
