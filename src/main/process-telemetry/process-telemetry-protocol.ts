import type { ProcessSample, ProcessSampleRequest } from "./process-sampler";

export type ProcessTelemetryHostMessage = {
  readonly type: "sample";
  readonly id: number;
  readonly request: ProcessSampleRequest;
};

export type ProcessTelemetryWorkerMessage =
  | { readonly type: "sampled"; readonly id: number; readonly sample: ProcessSample }
  | { readonly type: "failed"; readonly id: number; readonly message: string };

export function isProcessTelemetryWorkerMessage(
  value: unknown,
): value is ProcessTelemetryWorkerMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (typeof message.id !== "number") return false;
  if (message.type === "failed") return typeof message.message === "string";
  if (message.type !== "sampled" || !message.sample || typeof message.sample !== "object")
    return false;
  const sample = message.sample as Record<string, unknown>;
  return typeof sample.sampledAtMs === "number" && Array.isArray(sample.groups);
}
