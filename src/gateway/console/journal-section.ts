export const JOURNAL_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Journal"><section class="panel"><h2>Retention and recovery</h2><div id="journal-retention"></div></section><section class="panel" style="margin-top:16px"><h2>Live projection</h2><div id="journal-projection"></div></section></div>`;

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
  if(journalLoadFailed)return;
  const projection=journalStatus&&journalStatus.projection;
  if(!projection){const empty=document.createElement("p");empty.className="empty";setText(empty,"Projection status unavailable in this environment.");host.append(empty);return}
  const facts=document.createElement("dl");facts.className="facts";
  facts.append(
    field("Cursor",projection.cursorName),
    field("Position",String(projection.position)),
    field("Lag",String(projection.lag)),
    field("Replay count",String(projection.replayCount)),
    field("Active",projection.active?"Yes":"No"),
  );
  host.append(facts);
};
const renderJournalStatus=()=>{renderJournalRetention();renderJournalProjection()};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.journal={render:renderJournalStatus,load:loadJournalStatus};`;
