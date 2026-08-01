import { CONSOLE_DESIGN_TOKENS, CONSOLE_FONT_STACK_MONO, CONSOLE_FONT_STACK_SANS } from "./design-tokens.js";
import { CONTROLS_MARKUP } from "./controls-section.js";
import { TRAIL_MARKUP } from "./trail-section.js";
import { OVERVIEW_MARKUP } from "./overview-section.js";

interface NavItem { readonly id: string; readonly label: string; readonly icon: string; readonly enabled: boolean; }
interface NavGroup { readonly label: string; readonly items: readonly NavItem[]; }

const NAV_GROUPS: readonly NavGroup[] = [
  { label: "OPERATE", items: [{ id: "controls", label: "Controls", icon: "▶", enabled: true }] },
  { label: "OBSERVE", items: [
    { id: "overview", label: "Overview", icon: "◉", enabled: true },
    { id: "trail", label: "Trail", icon: "⬡", enabled: true },
    { id: "warnings", label: "Warnings", icon: "△", enabled: false },
    { id: "security", label: "Security", icon: "⛨", enabled: false },
    { id: "cost", label: "Cost", icon: "◔", enabled: false },
  ] },
  { label: "ANALYZE", items: [
    { id: "compare", label: "Compare runs", icon: "⑂", enabled: false },
    { id: "imports", label: "Imports", icon: "⇥", enabled: false },
  ] },
  { label: "ZENTRA", items: [
    { id: "pods", label: "Pods", icon: "⬢", enabled: false },
    { id: "milestones", label: "Milestones", icon: "⊕", enabled: false },
    { id: "github", label: "GitHub broker", icon: "⎇", enabled: false },
    { id: "journal", label: "Journal", icon: "≣", enabled: false },
  ] },
  { label: "CONFIG", items: [{ id: "policies", label: "Warning policies", icon: "⚙", enabled: false }] },
];

function renderNav(): string {
  return NAV_GROUPS.map((group) => {
    const items = group.items.map((item) => item.enabled
      ? `<button type="button" class="nav-item" data-nav-id="${item.id}"><span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span></button>`
      : `<button type="button" class="nav-item" data-nav-id="${item.id}" disabled aria-disabled="true"><span class="nav-icon">${item.icon}</span><span class="nav-label">${item.label}</span><span class="badge">Phase 2</span></button>`
    ).join("");
    return `<div class="nav-group-label">${group.label}</div>${items}`;
  }).join("");
}

export const SHELL_MARKUP = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Zentra Agent Rail Console</title>
<style>
${CONSOLE_DESIGN_TOKENS}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:${CONSOLE_FONT_STACK_SANS}}
.shell{display:flex;width:100vw;height:100vh}
.sidebar{width:216px;flex:none;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--line);overflow-y:auto}
.nav-group-label{font:600 9px ${CONSOLE_FONT_STACK_MONO};color:var(--faint);letter-spacing:1.4px;padding:12px 10px 5px}
.nav-item{display:flex;align-items:center;gap:9px;width:100%;padding:8px 10px;border:none;border-radius:7px;cursor:pointer;font:500 12.5px ${CONSOLE_FONT_STACK_SANS};text-align:left;background:transparent;color:var(--dim)}
.nav-item[data-active=true]{background:rgba(122,162,255,.13);color:var(--accent)}
.nav-item:disabled{cursor:not-allowed;opacity:.55}
.nav-item .badge{font:600 9px ${CONSOLE_FONT_STACK_MONO};background:var(--warn);color:#0a0e17;border-radius:8px;padding:1px 7px}
.nav-icon{width:16px;text-align:center;font-size:13px;flex:none;display:inline-block}
.nav-label{flex:1;text-align:left}
.content{flex:1;min-width:0;display:flex;flex-direction:column}
.section{display:none}
.section[data-active=true]{display:flex;flex:1;min-height:0;flex-direction:column}
#status{border-left:3px solid var(--line);padding:.8rem 1rem;background:#0d1814}
#status[data-tone=ok]{border-color:var(--accent)}
#status[data-tone=error]{border-color:var(--err);color:#ffd3cf}
.topbar{height:54px;flex:none;display:flex;align-items:center;gap:14px;padding:0 18px;border-bottom:1px solid var(--line);background:var(--panel)}
.topbar-spacer{flex:1}
.run-switcher{position:relative}
.run-switcher-button{display:flex;align-items:center;gap:9px;background:var(--panel2);border:1px solid var(--line);border-radius:7px;padding:7px 12px;cursor:pointer;color:var(--text);max-width:360px;font:inherit}
.run-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--faint);display:inline-block}
.run-switcher-title{font:600 13px ${CONSOLE_FONT_STACK_SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.run-switcher-caret{color:var(--dim);font-size:10px}
.run-switcher-menu{position:absolute;top:44px;left:0;width:340px;background:var(--panel);border:1px solid var(--line);border-radius:9px;padding:6px;box-shadow:0 18px 40px rgba(0,0,0,.5);z-index:40}
.run-switcher-menu[hidden]{display:none}
.run-switcher-menu-label{font:600 9px ${CONSOLE_FONT_STACK_MONO};color:var(--faint);letter-spacing:1px;padding:6px 8px 4px}
.run-switcher-row{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:8px 9px;border:none;border-radius:7px;background:transparent;cursor:pointer;font:inherit;color:var(--text)}
.run-switcher-row:hover,.run-switcher-row[data-selected=true]{background:var(--panel2)}
.run-switcher-row-title{font:600 12.5px ${CONSOLE_FONT_STACK_SANS};overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run-switcher-empty{padding:8px 9px;color:var(--dim);font:400 12px ${CONSOLE_FONT_STACK_SANS}}
.search-box{width:250px;display:flex;align-items:center;gap:8px;padding:7px 11px;border:1px solid var(--line);border-radius:7px;background:var(--panel2)}
.search-box .search-icon{color:var(--faint);font-size:12px}
.search-box input{min-width:0;width:100%;border:0;outline:0;background:transparent;color:var(--text);font:400 12px ${CONSOLE_FONT_STACK_MONO}}
.connection{font:500 10px ${CONSOLE_FONT_STACK_MONO};color:var(--faint);border:1px solid var(--line);padding:3px 8px;border-radius:4px;white-space:nowrap}
.connection[data-connected=true]{color:var(--accent)}
.intake{display:grid;grid-template-columns:1fr 1fr;gap:1rem}
.panel{background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:14px;padding:1.25rem;box-shadow:0 20px 60px #0004}
.panel h2{font-size:.8rem;letter-spacing:.15em;text-transform:uppercase;color:var(--dim);margin:0 0 1rem}
.field-label{display:block;font-weight:700;margin-bottom:.4rem}
textarea,input,select{width:100%;border:1px solid #3c554b;border-radius:8px;background:#08110e;color:var(--text);padding:.75rem}
textarea{min-height:7rem;resize:vertical}
.form-row{display:flex;gap:.75rem;align-items:end}
.form-row>div{flex:1}
.primary,.secondary,.danger{border:0;border-radius:999px;padding:.7rem 1.1rem;font-weight:800}
.primary{background:var(--accent);color:#10200f}
.secondary{background:#2a3d35;color:var(--text)}
.danger{background:#512622;color:#ffd7d2}
.workspace{display:grid;grid-template-columns:minmax(15rem,.65fr) minmax(24rem,1.35fr) minmax(19rem,.8fr);gap:1rem;margin-top:1rem;align-items:start}
.stack{display:grid;gap:.75rem}
.run-card,.attention-card{width:100%;text-align:left;color:var(--text);background:#0b1512;border:1px solid var(--line);border-radius:10px;padding:.8rem;display:grid;gap:.3rem}
.run-card[data-selected=true]{border-color:var(--accent)}
.run-card span,.attention-card span{color:var(--dim);font-size:.82rem}
.badge{display:inline-block!important;width:max-content;color:#bceba0!important;border:1px solid #3c6549;border-radius:999px;padding:.12rem .45rem;text-transform:uppercase;letter-spacing:.08em;font-size:.65rem!important}
.facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem}
.fact{border-top:1px solid var(--line);padding-top:.5rem}
.fact dt{color:var(--dim);font-size:.72rem;text-transform:uppercase}
.fact dd{margin:0;overflow-wrap:anywhere}
.empty,.recommendation{color:var(--dim)}
.recommendation{border:1px solid #685d32;background:#251f0f;padding:.8rem;border-radius:8px}
.notice{color:var(--warn);border-left:3px solid var(--warn);padding-left:.75rem}
details{border-top:1px solid var(--line);padding:.7rem 0}
summary{cursor:pointer;font-weight:700}
pre{white-space:pre-wrap;overflow-wrap:anywhere;color:#bed0c8;background:#07100d;padding:.8rem;border-radius:8px}
.decision-actions{display:grid;gap:.8rem;margin-top:1rem}
.digest{font-family:ui-monospace,monospace;overflow-wrap:anywhere;color:var(--accent)}
.actions{display:flex;gap:.6rem;flex-wrap:wrap}
.actions form{flex:1;min-width:12rem}
.history-card{padding:.75rem 0;border-top:1px solid var(--line)}
.history-card strong{display:block}
.history-card .badge{margin:.35rem 0}
.history-card p{margin:0;color:var(--dim);font-size:.85rem}
@media(max-width:980px){.workspace{grid-template-columns:1fr 1fr}.workspace>.panel:last-child{grid-column:1/-1}.intake{grid-template-columns:1fr}}
@media(max-width:620px){.workspace{grid-template-columns:1fr}.workspace>.panel:last-child{grid-column:auto}.facts{grid-template-columns:1fr}.form-row{display:grid}.panel{padding:1rem;border-radius:10px}.actions{display:grid}.actions form{min-width:0}}
</style></head><body>
<div class="shell" data-ready="false">
  <aside class="sidebar" role="navigation" aria-label="Console sections">${renderNav()}</aside>
  <div class="content">
    <p id="status" role="status" aria-live="polite">Establishing secure local session.</p>
    <header class="topbar" aria-label="Run context">
      <div class="run-switcher">
        <button type="button" id="run-switcher-button" class="run-switcher-button" aria-haspopup="true" aria-expanded="false">
          <span id="run-switcher-dot" class="run-dot"></span>
          <span id="run-switcher-title" class="run-switcher-title">No runs yet</span>
          <span class="run-switcher-caret">▾</span>
        </button>
        <div id="run-switcher-menu" class="run-switcher-menu" hidden>
          <div class="run-switcher-menu-label">RUNS ON THIS MACHINE</div>
          <div id="run-switcher-rows"></div>
        </div>
      </div>
      <span class="topbar-spacer"></span>
      <label class="search-box">
        <span class="search-icon">⌕</span>
        <input id="console-search" type="search" placeholder="filter events, actors, kinds…">
      </label>
      <div id="connection" class="connection" role="status">Connecting</div>
    </header>
    <section class="section" data-section-id="controls">${CONTROLS_MARKUP}</section>
    <section class="section" data-section-id="overview">${OVERVIEW_MARKUP}</section>
    <section class="section" data-section-id="trail">${TRAIL_MARKUP}</section>
  </div>
</div>
</body></html>`;

export const SHELL_SCRIPT = String.raw`
const setActiveSection=(id)=>{
  for(const button of document.querySelectorAll(".nav-item")) button.dataset.active=String(button.dataset.navId===id);
  for(const section of document.querySelectorAll(".section")) section.dataset.active=String(section.dataset.sectionId===id);
};
for(const button of document.querySelectorAll(".nav-item:not(:disabled)")){
  button.addEventListener("click",()=>setActiveSection(button.dataset.navId));
}
setActiveSection("controls");
async function handoff(){
  const fragment=location.hash;history.replaceState(null,"","/");document.documentElement.dataset.location=location.href;
  const token=fragment.startsWith("#token=")?decodeURIComponent(fragment.slice(7)):"";
  if(!token){status("This page needs a fresh one-time launch link.","error");return}
  try{
    const session=await fetch("/api/v1/session",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token}),credentials:"same-origin",cache:"no-store"});
    const result=await session.json();if(!session.ok)throw new Error(result.error||"session_failed");
    window.__consoleSections=window.__consoleSections||{};
    window.__consoleSections.controls?.setSession?.(result.bearerToken,result.csrfToken);
    document.getElementById("agenttrail-frame").src="/agenttrail/";
    await window.__consoleSections.controls?.refresh?.();
    status("Secure local session established.","ok");
    document.querySelector(".shell").dataset.ready="true";document.documentElement.dataset.ready="true";
    void window.__consoleSections.controls?.connect?.();
  }catch(error){status("Session unavailable: "+error.message+".","error")}
}
void handoff();`;
