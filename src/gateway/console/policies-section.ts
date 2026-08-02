import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const POLICIES_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Warning policies" id="policies-root"></div>`;

export const POLICIES_SCRIPT = String.raw`const policiesFontSans='${CONSOLE_FONT_STACK_SANS}';
const policiesFontMono='${CONSOLE_FONT_STACK_MONO}';
const POLICIES_DEMO_DATA={
  suppressTotal:7,
  rows:[
    {op:"tool.call.run_tests",loop:4,retry:3,count:5,active:true},
    {op:"tool.call.git_status",loop:6,retry:5,count:2,active:false},
  ],
};
const renderPolicies=()=>{
  const host=$("policies-root");if(!host)return;host.replaceChildren();
  const heading=document.createElement("h1");heading.style.cssText="margin:0;font:700 20px "+policiesFontSans;setText(heading,"Warning policies");
  const note=document.createElement("p");note.style.cssText="margin:8px 0 18px;font:400 12.5px "+policiesFontSans+";color:var(--warn)";setText(note,"Preview: static example data, not yet wired to a real backend for this concept.");
  const infoBar=document.createElement("div");infoBar.style.cssText="display:flex;align-items:center;gap:12px;max-width:960px;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 18px;flex-wrap:wrap";
  const fileEl=document.createElement("span");fileEl.style.cssText="font:600 12.5px "+policiesFontMono+";color:var(--accent)";setText(fileEl,"examples/warning-policy.toml");
  const versionEl=document.createElement("span");versionEl.style.cssText="font:400 10.5px "+policiesFontMono+";color:var(--faint)";setText(versionEl,"version 3 · "+POLICIES_DEMO_DATA.suppressTotal+" suppressed findings retained");
  const spacer=document.createElement("span");spacer.style.cssText="flex:1";
  const restartBadge=document.createElement("span");restartBadge.style.cssText="font:600 9.5px "+policiesFontMono+";color:var(--warn);border:1px solid rgba(255,180,84,.45);padding:3px 8px;border-radius:4px";setText(restartBadge,"RESTART REQUIRED ON CHANGE");
  infoBar.append(fileEl,versionEl,spacer,restartBadge);
  const table=document.createElement("div");table.style.cssText="max-width:960px;background:var(--panel);border:1px solid var(--line);border-radius:12px;overflow:hidden;margin-top:14px";
  const headerRow=document.createElement("div");headerRow.style.cssText="display:grid;grid-template-columns:1.4fr .9fr .9fr .9fr .9fr;padding:10px 18px;border-bottom:1px solid var(--line);font:600 10px "+policiesFontMono+";color:var(--faint);letter-spacing:.8px";
  for(const label of ["OPERATION","LOOP ≥","RETRY ≥","SUPPRESSED","RULE"]){const cell=document.createElement("span");if(label!=="OPERATION")cell.style.textAlign="right";setText(cell,label);headerRow.append(cell)}
  table.append(headerRow);
  for(const row of POLICIES_DEMO_DATA.rows){
    const rowEl=document.createElement("div");rowEl.style.cssText="display:grid;grid-template-columns:1.4fr .9fr .9fr .9fr .9fr;padding:12px 18px;border-bottom:1px solid var(--line);align-items:center";
    const opEl=document.createElement("span");opEl.style.cssText="font:600 12.5px "+policiesFontMono;setText(opEl,row.op);
    const loopEl=document.createElement("span");loopEl.style.cssText="text-align:right;font:500 12px "+policiesFontMono+";color:var(--dim)";setText(loopEl,String(row.loop));
    const retryEl=document.createElement("span");retryEl.style.cssText="text-align:right;font:500 12px "+policiesFontMono+";color:var(--dim)";setText(retryEl,String(row.retry));
    const countEl=document.createElement("span");countEl.style.cssText="text-align:right;font:500 12px "+policiesFontMono+";color:var(--warn)";setText(countEl,String(row.count));
    const ruleCell=document.createElement("span");ruleCell.style.cssText="text-align:right";
    const button=document.createElement("button");button.type="button";button.disabled=true;button.style.cssText="opacity:.5;cursor:not-allowed;background:var(--panel2);border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:5px 10px;font:600 10.5px "+policiesFontMono;setText(button,row.active?"Suppressed":"Suppress");
    ruleCell.append(button);
    rowEl.append(opEl,loopEl,retryEl,countEl,ruleCell);
    table.append(rowEl);
  }
  if(table.lastElementChild)table.lastElementChild.style.borderBottom="none";
  host.append(heading,note,infoBar,table);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.policies={render:renderPolicies};
renderPolicies();`;
