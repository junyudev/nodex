import { parentPort } from "node:worker_threads";
import { createProcessSampler, readProcessTable } from "./process-sampler";
import type {
  ProcessTelemetryHostMessage,
  ProcessTelemetryWorkerMessage,
} from "./process-telemetry-protocol";

const port = parentPort;
if (!port) throw new Error("Process telemetry worker requires a parent message port");

const sampler = createProcessSampler({ read: () => readProcessTable(process.platform) });
const post = (message: ProcessTelemetryWorkerMessage) => {
  port.postMessage(message);
};

port.on("message", (message: ProcessTelemetryHostMessage) => {
  if (message?.type !== "sample") return;
  sampler.sample(message.request).then(
    (sample) => post({ type: "sampled", id: message.id, sample }),
    (error: unknown) =>
      post({
        type: "failed",
        id: message.id,
        message: error instanceof Error ? error.message : String(error),
      }),
  );
});
