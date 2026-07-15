export interface ModelBrokerRequest {
  readonly modelId: string;
  readonly promptArtifactId: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
}

export interface ModelBrokerReceipt {
  readonly outcome: "completed" | "cancelled" | "timed_out" | "failed" | "uncertain";
  readonly responseArtifactId: string | null;
}

export interface ModelBroker {
  execute(request: ModelBrokerRequest, signal: AbortSignal): Promise<ModelBrokerReceipt>;
}

export class DisabledModelBroker implements ModelBroker {
  execute(_request: ModelBrokerRequest, _signal: AbortSignal): Promise<ModelBrokerReceipt> {
    return Promise.resolve({ outcome: "failed", responseArtifactId: null });
  }
}
