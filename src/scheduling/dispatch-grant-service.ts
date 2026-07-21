import type { NewEvent, StoredEvent } from "../contracts/event.js";
import { readStreamEvents, type AtomicAppend, type EventJournal } from "../journal/journal.js";
import { canonicalJson, SchedulerControlIdentitySchema, type SchedulerControlIdentity } from "./scheduler-contracts.js";
import { createHash } from "node:crypto";
import { z } from "zod";

const GrantPayload = z.strictObject({
  schemaVersion: z.literal(1), grantId: z.string().min(1), audience: z.string().min(1),
  dispatchIntentSha256: z.string().regex(/^[a-f0-9]{64}$/), expiresAtMs: z.number().int().positive(),
  issuerId: z.string().min(1), controlIdentitySha256: z.string().regex(/^[a-f0-9]{64}$/),
  issuedAtMs: z.number().int().nonnegative(),
});
const ConsumedPayload = z.strictObject({
  schemaVersion: z.literal(1), grantId: z.string().min(1), dispatchId: z.string().uuid(),
  schedulerId: z.string().min(1), processIncarnation: z.string().min(1), consumedAtMs: z.number().int().nonnegative(),
  dispatchIntentSha256: z.string().regex(/^[a-f0-9]{64}$/), expiresAtMs: z.number().int().positive(),
});

export interface DispatchGrantView extends z.infer<typeof GrantPayload> {
  readonly consumed: boolean;
  readonly streamVersion: number;
}

export class DispatchGrantService {
  constructor(private readonly journal: EventJournal, readonly identity: SchedulerControlIdentity,
    private readonly issuerId: string, private readonly now: () => number = Date.now) {}

  issue(input: { readonly grantId: string; readonly audience: string;
    readonly dispatchIntentSha256: string; readonly expiresAtMs: number }): DispatchGrantView {
    const streamId = dispatchGrantStreamId(this.identity, input.grantId);
    const payload = GrantPayload.parse({ schemaVersion: 1, ...input, issuerId: this.issuerId,
      controlIdentitySha256: controlIdentitySha256(this.identity), issuedAtMs: this.now() });
    if (payload.expiresAtMs <= payload.issuedAtMs) throw new Error("dispatch grant must expire in the future");
    const event: NewEvent<string, unknown> = { streamId, type: "dispatch_grant.issued", payload,
      causationId: null, correlationId: input.grantId };
    this.journal.append(streamId, 0, [event]);
    return this.inspect(input.grantId)!;
  }

  inspect(grantId: string): DispatchGrantView | null {
    return projectDispatchGrant(readStreamEvents(this.journal, dispatchGrantStreamId(this.identity, grantId)));
  }

  consumptionWrite(grantId: string, input: Omit<z.input<typeof ConsumedPayload>,
    "schemaVersion" | "consumedAtMs" | "expiresAtMs">): AtomicAppend {
    const view = this.inspect(grantId);
    if (view === null) throw new Error("independently issued dispatch grant is missing");
    if (view.consumed) throw new Error("dispatch grant is already consumed");
    const consumedAtMs = this.now();
    if (consumedAtMs < view.issuedAtMs || consumedAtMs >= view.expiresAtMs) {
      throw new Error("dispatch grant expired before atomic consumption");
    }
    const event: NewEvent<string, unknown> = { streamId: dispatchGrantStreamId(this.identity, grantId),
      type: "dispatch_grant.consumed", payload: ConsumedPayload.parse({ schemaVersion: 1, ...input,
        consumedAtMs, expiresAtMs: view.expiresAtMs }), causationId: null,
      correlationId: grantId };
    return { streamId: event.streamId, expectedVersion: view.streamVersion, events: [event] };
  }
}

export function projectDispatchGrant(events: readonly StoredEvent[]): DispatchGrantView | null {
  let view: DispatchGrantView | null = null;
  for (const event of events) {
    if (event.type === "dispatch_grant.issued") {
      if (view !== null) throw new Error("dispatch grant was issued more than once");
      view = { ...GrantPayload.parse(event.payload), consumed: false, streamVersion: event.streamVersion };
    } else if (event.type === "dispatch_grant.consumed") {
      if (view === null || view.consumed) throw new Error("dispatch grant consumption is invalid");
      const consumed = ConsumedPayload.parse(event.payload);
      if (consumed.grantId !== view.grantId || consumed.dispatchIntentSha256 !== view.dispatchIntentSha256) {
        throw new Error("dispatch grant consumption does not match the issued grant");
      }
      if (consumed.expiresAtMs !== view.expiresAtMs || consumed.consumedAtMs < view.issuedAtMs ||
        consumed.consumedAtMs >= view.expiresAtMs) throw new Error("dispatch grant consumption timestamp or expiry is invalid");
      const issued = view as DispatchGrantView;
      view = { ...issued, consumed: true, streamVersion: event.streamVersion };
    } else throw new Error(`unknown dispatch grant event ${event.type}`);
  }
  return view === null ? null : Object.freeze(view);
}

export function dispatchGrantStreamId(identity: SchedulerControlIdentity, grantId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,255}$/.test(grantId)) throw new Error("grant identity is invalid");
  return `dispatch-grant:${controlIdentitySha256(identity)}:${grantId}`;
}
export function controlIdentitySha256(identity: SchedulerControlIdentity): string {
  return createHash("sha256").update(canonicalJson(SchedulerControlIdentitySchema.parse(identity)), "utf8").digest("hex");
}
