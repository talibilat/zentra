import type { StreamId } from "./ids.js";

export interface NewEvent<TType extends string, TPayload> {
  readonly streamId: StreamId;
  readonly type: TType;
  readonly payload: TPayload;
  readonly causationId: string | null;
  readonly correlationId: string;
}

export interface StoredEvent<TType extends string = string, TPayload = unknown>
  extends NewEvent<TType, TPayload> {
  readonly eventId: string;
  readonly streamVersion: number;
  readonly globalPosition: number;
  readonly recordedAt: string;
}
