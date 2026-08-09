import { CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const JOURNAL_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Journal">
  <div style='display:flex;gap:4px;margin-bottom:16px'>
    <button type="button" data-journal-view="status" aria-current="true" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid var(--accent);background:rgba(122,162,255,.12);color:var(--accent);cursor:default;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Status</button>
    <button type="button" data-journal-view="events" style='display:flex;align-items:center;gap:6px;padding:7px 13px;border-radius:8px;border:1px solid transparent;background:transparent;color:var(--dim);cursor:pointer;font:600 12px ${CONSOLE_FONT_STACK_SANS}'>Events</button>
  </div>
  <div data-journal-panel="status"><section class="panel"><h2>Retention and recovery</h2><div id="journal-retention"></div></section><section class="panel" style="margin-top:16px"><h2>Live projection</h2><div id="journal-projection"></div></section></div>
  <div data-journal-panel="events" style="display:none">
    <div style='display:flex;gap:10px;align-items:center;margin-bottom:12px'>
      <input type="text" id="journal-events-stream-filter" placeholder="Stream prefix" style='flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text)'>
      <input type="text" id="journal-events-type-filter" placeholder="Type prefix" style='flex:1;padding:6px 10px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text)'>
      <button type="button" id="journal-events-apply-filter" style='padding:6px 14px;border-radius:6px;background:var(--panel2);border:1px solid var(--line);color:var(--dim);cursor:pointer'>Apply</button>
    </div>
    <section class="workspace" data-columns="2" aria-label="Journal events"><section class="panel"><h2>Events</h2><div id="journal-events-list" class="stack"></div><button type="button" id="journal-events-load-more" style="margin-top:10px">Load more</button></section><section class="panel"><h2>Event detail</h2><div id="journal-event-detail"></div></section></section>
  </div>
</div>`;

export const JOURNAL_SCRIPT = String.raw`let journalStatus=null;let journalLoadFailed=false;
const loadJournalStatus=async()=>{
  try{journalStatus=await request("/api/v1/zentra/journal");journalLoadFailed=false}
  catch{journalStatus=null;journalLoadFailed=true}
  renderJournalStatus();
};
const renderJournalRetention=()=>{
  const host=$("journal-retention");host.replaceChildren();
  if(journalLoadFailed){const empty=document.createElement("p");empty.className="empty";setText(empty,"Journal status unavailable.");host.append(empty);return}
  const retention=journalStatus&&journalStatus.retention;
  if(!retention){const empty=document.createElement("p");empty.className="empty";setText(empty,"Retention status unavailable in this environment.");host.append(empty);return}
  const facts=document.createElement("dl");facts.className="facts";
  facts.append(
    field("Retained through",String(retention.retainedThroughPosition)),
    field("Archive head",String(retention.archiveHeadPosition)),
    field("Archive segments",String(retention.archiveSegmentCount)),
    field("Retention policy",label(retention.policyMode)),
    field("Recovery",retention.recoveryOutcome==="clean"?"Clean":label(retention.recoveryKind)+": "+label(retention.recoveryState)),
  );
  host.append(facts);
};
const renderJournalProjection=()=>{
  const host=$("journal-projection");host.replaceChildren();
  if(journalLoadFailed){const empty=document.createElement("p");empty.className="empty";setText(empty,"Journal status unavailable.");host.append(empty);return}
  const projection=journalStatus&&journalStatus.projection;
  if(!projection){const empty=document.createElement("p");empty.className="empty";setText(empty,"Projection status unavailable in this environment.");host.append(empty);return}
  const facts=document.createElement("dl");facts.className="facts";
  facts.append(
    field("Cursor",projection.cursorName),
    field("Position",String(projection.position)),
    field("High water",String(projection.highWaterPosition)),
    field("Lag",String(projection.lag)),
    field("Replay count",String(projection.replayCount)),
    field("Active",projection.active?"Yes":"No"),
  );
  host.append(facts);
};
const renderJournalStatus=()=>{renderJournalRetention();renderJournalProjection()};
let journalActiveView="status";
let journalEvents=[];
let journalEventsNextPosition=0;
let journalEventsHasMore=false;
let journalEventsLoadFailed=false;
let journalSelectedEventId=null;
let journalStreamFilter="";
let journalTypeFilter="";
const journalEventsQueryString=(afterPosition)=>{
  const params=new URLSearchParams();
  if(afterPosition!==undefined)params.set("afterPosition",String(afterPosition));
  if(journalStreamFilter)params.set("streamPrefix",journalStreamFilter);
  if(journalTypeFilter)params.set("typePrefix",journalTypeFilter);
  return params.toString();
};
const loadJournalEvents=async(append)=>{
  try{
    const afterPosition=append?journalEventsNextPosition:undefined;
    const page=await request("/api/v1/zentra/journal/events?"+journalEventsQueryString(afterPosition));
    journalEvents=append?[...journalEvents,...page.events]:page.events;
    journalEventsNextPosition=page.nextPosition;
    journalEventsHasMore=page.hasMore;
    journalEventsLoadFailed=false;
  }catch{
    if(!append){journalEvents=[];journalEventsNextPosition=0;journalEventsHasMore=false}
    journalEventsLoadFailed=true;
  }
  renderJournalEvents();
};
const renderJournalEventsList=()=>{
  const host=$("journal-events-list");if(!host)return;host.replaceChildren();
  if(journalEventsLoadFailed&&!journalEvents.length){const empty=document.createElement("p");empty.className="empty";setText(empty,"Journal events unavailable.");host.append(empty);return}
  if(!journalEvents.length){const empty=document.createElement("p");empty.className="empty";setText(empty,journalEventsHasMore?"No matching events in this range.":"No events found.");host.append(empty);return}
  for(const event of journalEvents){
    const row=document.createElement("button");row.type="button";row.className="run-card";
    row.dataset.selected=String(event.eventId===journalSelectedEventId);
    const position=document.createElement("span");setText(position,String(event.globalPosition));
    const stream=document.createElement("strong");setText(stream,event.streamId);
    const type=document.createElement("span");setText(type,event.type);
    const recordedAt=document.createElement("span");setText(recordedAt,event.recordedAt);
    row.append(position,stream,type,recordedAt);
    row.addEventListener("click",()=>{journalSelectedEventId=event.eventId;renderJournalEvents()});
    host.append(row);
  }
  if(journalEventsLoadFailed){const failure=document.createElement("p");failure.className="empty";setText(failure,"Journal events unavailable.");host.append(failure)}
  const loadMore=$("journal-events-load-more");
  if(loadMore)loadMore.style.display=journalEventsHasMore?"block":"none";
};
const renderJournalEventDetail=()=>{
  const host=$("journal-event-detail");if(!host)return;host.replaceChildren();
  const event=journalEvents.find(candidate=>candidate.eventId===journalSelectedEventId);
  if(!event){const empty=document.createElement("p");empty.className="empty";setText(empty,"Select an event to inspect it.");host.append(empty);return}
  const facts=document.createElement("dl");facts.className="facts";
  facts.append(
    field("Position",String(event.globalPosition)),
    field("Stream",event.streamId),
    field("Type",event.type),
    field("Recorded at",event.recordedAt),
  );
  host.append(facts);
  appendJson(host,"Payload",event.payload);
};
const renderJournalEvents=()=>{renderJournalEventsList();renderJournalEventDetail()};
const renderJournalView=()=>{
  const statusPanel=document.querySelector('[data-journal-panel="status"]');
  const eventsPanel=document.querySelector('[data-journal-panel="events"]');
  if(statusPanel)statusPanel.style.display=journalActiveView==="status"?"block":"none";
  if(eventsPanel)eventsPanel.style.display=journalActiveView==="events"?"block":"none";
};
for(const button of document.querySelectorAll("[data-journal-view]")){
  button.addEventListener("click",()=>{
    journalActiveView=button.dataset.journalView;
    for(const other of document.querySelectorAll("[data-journal-view]")){
      const active=other===button;
      other.setAttribute("aria-current",String(active));
      other.style.border=active?"1px solid var(--accent)":"1px solid transparent";
      other.style.background=active?"rgba(122,162,255,.12)":"transparent";
      other.style.color=active?"var(--accent)":"var(--dim)";
      other.style.cursor=active?"default":"pointer";
    }
    renderJournalView();
    if(journalActiveView==="events"&&!journalEvents.length&&!journalEventsLoadFailed)loadJournalEvents(false);
  });
}
$("journal-events-apply-filter")?.addEventListener("click",()=>{
  journalStreamFilter=$("journal-events-stream-filter")?.value.trim()||"";
  journalTypeFilter=$("journal-events-type-filter")?.value.trim()||"";
  journalSelectedEventId=null;
  loadJournalEvents(false);
});
$("journal-events-load-more")?.addEventListener("click",()=>loadJournalEvents(true));
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.journal={render:renderJournalStatus,load:loadJournalStatus};`;
