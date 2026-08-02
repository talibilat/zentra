import { CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";

export const IMPORTS_MARKUP = `<div style="flex:1;overflow-y:auto;padding:26px 30px" data-screen-label="Imports" id="imports-root"></div>`;

export const IMPORTS_SCRIPT = String.raw`const importsFontSans='${CONSOLE_FONT_STACK_SANS}';
const importsFontMono='${CONSOLE_FONT_STACK_MONO}';
const IMPORTS_DEMO_DATA=[
  {glyph:"◆",name:"Claude Code session export",format:"claude-code.jsonl",desc:"Converts a Claude Code session export into canonical JSONL, preserving tool calls and file edits.",cmd:"zentra import claude-code ./session.jsonl"},
  {glyph:"◇",name:"OpenCode session export",format:"opencode.jsonl",desc:"Converts an OpenCode session export into canonical JSONL.",cmd:"zentra import opencode ./session.jsonl"},
];
const renderImports=()=>{
  const host=$("imports-root");if(!host)return;host.replaceChildren();
  const heading=document.createElement("h1");heading.style.cssText="margin:0;font:700 20px "+importsFontSans;setText(heading,"Session imports");
  const note=document.createElement("p");note.style.cssText="margin:8px 0 18px;font:400 12.5px "+importsFontSans+";color:var(--warn)";setText(note,"Preview: static example data, not yet wired to a real backend for this concept.");
  const grid=document.createElement("div");grid.style.cssText="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px;max-width:980px";
  for(const source of IMPORTS_DEMO_DATA){
    const card=document.createElement("div");card.style.cssText="background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:18px";
    const top=document.createElement("div");top.style.cssText="display:flex;align-items:center;gap:10px";
    const iconEl=document.createElement("span");iconEl.style.cssText="width:34px;height:34px;border-radius:9px;display:flex;align-items:center;justify-content:center;background:var(--panel2);color:var(--accent);font-size:15px";setText(iconEl,source.glyph);
    const nameWrap=document.createElement("span");
    const nameEl=document.createElement("strong");nameEl.style.cssText="display:block;font:600 13.5px "+importsFontSans;setText(nameEl,source.name);
    const formatEl=document.createElement("span");formatEl.style.cssText="font:400 10px "+importsFontMono+";color:var(--faint)";setText(formatEl,source.format);
    nameWrap.append(nameEl,formatEl);
    top.append(iconEl,nameWrap);
    const descEl=document.createElement("p");descEl.style.cssText="margin:11px 0 0;font:400 12px/1.55 "+importsFontSans+";color:var(--dim)";setText(descEl,source.desc);
    const cmdEl=document.createElement("pre");cmdEl.style.cssText="margin:11px 0 0;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:9px 11px;font:400 10px/1.6 "+importsFontMono+";color:var(--dim);white-space:pre-wrap;word-break:break-all";setText(cmdEl,source.cmd);
    const button=document.createElement("button");button.type="button";button.disabled=true;button.style.cssText="margin-top:12px;width:100%;opacity:.5;cursor:not-allowed;background:rgba(122,162,255,.12);border:1px solid var(--accent);color:var(--accent);border-radius:7px;padding:8px;font:600 11.5px "+importsFontSans;setText(button,"Import example session");
    card.append(top,descEl,cmdEl,button);
    grid.append(card);
  }
  const recentHeading=document.createElement("h2");recentHeading.style.cssText="margin:26px 0 12px;font:600 14px "+importsFontSans;setText(recentHeading,"Recent imports");
  const empty=document.createElement("div");empty.style.cssText="font:400 12.5px "+importsFontSans+";color:var(--faint);padding:14px;border:1px dashed var(--line);border-radius:10px;max-width:980px";setText(empty,"No imports yet — run one above, then open it from the run picker.");
  host.append(heading,note,grid,recentHeading,empty);
};
window.__consoleSections=window.__consoleSections||{};
window.__consoleSections.imports={render:renderImports};
renderImports();`;
