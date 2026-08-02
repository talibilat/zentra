import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const SECURITY_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Security" id="security-root"></div>`;

export const SECURITY_SCRIPT = String.raw`const securityFontSans='${CONSOLE_FONT_STACK_SANS}';
const securityFontMono='${CONSOLE_FONT_STACK_MONO}';
const SECURITY_DEMO_DATA={
  verdictTitle:"1 observed influence path reaches a sensitive capability",
  verdictSub:"Producer-declared trust labels propagated through one explicit influenced_by edge.",
  taintPaths:[
    {verdict:"OBSERVED",title:"Untrusted planning data reached a shell command argument",
     chain:[{label:"planning-doc.md",trust:"untrusted"},{label:"pod-b",trust:"orchestrator"},{label:"shell.run",trust:"sensitive capability"}],
     note:"pod-b read planning-doc.md and passed a derived value into a shell command argument without an intervening sanitization step."},
  ],
  trustLegend:[{label:"untrusted",color:"var(--err)"},{label:"orchestrator",color:"var(--accent)"},{label:"sensitive capability",color:"var(--warn)"}],
};
const securityChainButton=(node)=>{const button=document.createElement("button");button.type="button";button.disabled=true;button.style.cssText="opacity:.7;cursor:not-allowed;text-align:left;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 11px";const labelEl=document.createElement("span");labelEl.style.cssText="display:block;font:600 11.5px "+securityFontMono+";color:var(--text)";setText(labelEl,node.label);const trustEl=document.createElement("span");trustEl.style.cssText="display:block;font:400 9.5px "+securityFontMono+";color:var(--dim);margin-top:2px";setText(trustEl,node.trust);button.append(labelEl,trustEl);return button};
const renderSecurity=()=>{
  const host=$("security-root");if(!host)return;host.replaceChildren();
  const heading=document.createElement("h1");heading.style.cssText="margin:0;font:700 20px "+securityFontSans;setText(heading,"Taint security audit");
  const note=document.createElement("p");note.style.cssText="margin:8px 0 18px;font:400 12.5px "+securityFontSans+";color:var(--warn)";setText(note,"Preview: static example data, not yet wired to a real backend for this concept.");
  const verdict=document.createElement("div");verdict.style.cssText="display:flex;align-items:center;gap:13px;max-width:900px;padding:15px 18px;border-radius:11px;border:1px solid rgba(255,93,108,.45);background:rgba(255,93,108,.06);color:#ff8d99";
  const icon=document.createElement("span");icon.style.cssText="font-size:16px";setText(icon,"⚠");
  const verdictText=document.createElement("span");
  const verdictTitleEl=document.createElement("strong");verdictTitleEl.style.cssText="display:block;font:700 14px "+securityFontSans;setText(verdictTitleEl,SECURITY_DEMO_DATA.verdictTitle);
  const verdictSubEl=document.createElement("span");verdictSubEl.style.cssText="font:400 12px "+securityFontSans+";opacity:.85";setText(verdictSubEl,SECURITY_DEMO_DATA.verdictSub);
  verdictText.append(verdictTitleEl,verdictSubEl);
  verdict.append(icon,verdictText);
  const pathList=document.createElement("div");pathList.style.cssText="display:flex;flex-direction:column;gap:14px;margin-top:18px;max-width:900px";
  for(const path of SECURITY_DEMO_DATA.taintPaths){
    const card=document.createElement("div");card.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px 20px";
    const top=document.createElement("div");top.style.cssText="display:flex;align-items:center;gap:9px;flex-wrap:wrap";
    const badge=document.createElement("span");badge.style.cssText="font:600 9.5px "+securityFontMono+";color:var(--err);border:1px solid var(--err);padding:3px 8px;border-radius:4px";setText(badge,path.verdict);
    const titleEl=document.createElement("span");titleEl.style.cssText="font:600 13px "+securityFontSans;setText(titleEl,path.title);
    top.append(badge,titleEl);
    const chain=document.createElement("div");chain.style.cssText="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:14px";
    path.chain.forEach((node,index)=>{
      chain.append(securityChainButton(node));
      if(index<path.chain.length-1){const arrow=document.createElement("span");arrow.style.cssText="color:var(--faint);font-size:13px";setText(arrow,"→");chain.append(arrow)}
    });
    const noteEl=document.createElement("p");noteEl.style.cssText="margin:12px 0 0;font:400 12px/1.6 "+securityFontSans+";color:var(--dim)";setText(noteEl,path.note);
    card.append(top,chain,noteEl);
    pathList.append(card);
  }
  const legend=document.createElement("div");legend.style.cssText="display:flex;gap:16px;margin-top:20px;flex-wrap:wrap";
  for(const entry of SECURITY_DEMO_DATA.trustLegend){
    const item=document.createElement("span");item.style.cssText="display:flex;align-items:center;gap:7px";
    const dot=document.createElement("span");dot.style.cssText="width:8px;height:8px;border-radius:50%;background:"+entry.color;
    const labelEl=document.createElement("span");labelEl.style.cssText="font:500 11px "+securityFontSans+";color:var(--dim)";setText(labelEl,entry.label);
    item.append(dot,labelEl);
    legend.append(item);
  }
  host.append(heading,note,verdict,pathList,legend);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.security={render:renderSecurity};
renderSecurity();`;
