export const TRAIL_MARKUP = `<div style="flex:1;min-height:0;display:flex;flex-direction:column" data-screen-label="Trail">
  <div id="agenttrail-status" class="agenttrail-status" data-tone="ok" role="status" aria-live="polite">AgentTrail is live and read-only.</div>
  <iframe id="agenttrail-frame" class="agenttrail-frame" title="AgentTrail evidence views" style="flex:1;min-height:0;border:0"></iframe>
</div>`;

export const TRAIL_SCRIPT = String.raw`const applyGatewayChange=(change)=>{const node=$("agenttrail-status");if(change.type==="gateway.degraded"){node.dataset.tone="error";setText(node,"AgentTrail unavailable. Zentra controls remain available while recovery is verified.")}if(change.type==="gateway.backfill_target"){node.dataset.tone="waiting";setText(node,"AgentTrail replacement is backfilling durable evidence.")}if(change.type==="gateway.recovered"){node.dataset.tone="ok";setText(node,"AgentTrail recovered from durable evidence and is live.");$("agenttrail-frame").contentWindow?.location.reload()}};`;
