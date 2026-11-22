import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { ProcessTelemetryHostMessage } from "../../process-telemetry/process-telemetry-protocol";
import { createProcessTelemetryClient, type ProcessTelemetryWorker } from "./ProcessTelemetry";

function fakeWorkers() {
  const workers: {
    sent: ProcessTelemetryHostMessage[];
    terminated: boolean;
    reply: (message: unknown) => void;
    fail: (error: Error) => void;
  }[] = [];
  const create = (): ProcessTelemetryWorker => {
    let onMessage: (message: unknown) => void = () => undefined;
    let onError: (error: Error) => void = () => undefined;
    const worker = {
      sent: [] as ProcessTelemetryHostMessage[],
      terminated: false,
      reply: (message: unknown) => onMessage(message),
      fail: (error: Error) => onError(error),
    };
    workers.push(worker);
    return {
      send: (message) => worker.sent.push(message),
      onMessage: (listener) => (onMessage = listener),
      onError: (listener) => (onError = listener),
      onExit: () => undefined,
      terminate: () => {
        worker.terminated = true;
      },
    };
  };
  return { workers, create };
}

const request = { baseline: "terminals", maxAgeMs: 0, groups: [] };
const sample = { sampledAtMs: 1, groups: [] };

describe("process telemetry client", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  test("starts one worker on demand and releases it once idle", async () => {
    const { workers, create } = fakeWorkers();
    const client = createProcessTelemetryClient({ create, idleReleaseMs: 1_000 });
    expect(workers).toHaveLength(0);

    const first = client.sample(request);
    const second = client.sample(request);
    expect(workers).toHaveLength(1);
    for (const message of workers[0]!.sent)
      workers[0]!.reply({ type: "sampled", id: message.id, sample });
    await expect(Promise.all([first, second])).resolves.toEqual([sample, sample]);

    await vi.advanceTimersByTimeAsync(999);
    expect(workers[0]!.terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(workers[0]!.terminated).toBe(true);

    const restarted = client.sample(request);
    expect(workers).toHaveLength(2);
    client.close();
    await expect(restarted).rejects.toThrow("shutting down");
  });

  test("fails waiting samples when the worker breaks and starts a new one next time", async () => {
    const { workers, create } = fakeWorkers();
    const client = createProcessTelemetryClient({ create, sampleTimeoutMs: 5_000 });

    const broken = client.sample(request);
    workers[0]!.fail(new Error("worker crashed"));
    await expect(broken).rejects.toThrow("worker crashed");
    expect(workers[0]!.terminated).toBe(true);

    const silent = client.sample(request);
    expect(workers).toHaveLength(2);
    const rejected = expect(silent).rejects.toThrow("did not answer");
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;

    const refused = client.sample(request);
    workers[2]!.reply({ type: "failed", id: workers[2]!.sent[0]!.id, message: "ps failed" });
    await expect(refused).rejects.toThrow("ps failed");

    client.close();
    expect(workers[2]!.terminated).toBe(true);
    await expect(client.sample(request)).rejects.toThrow("shutting down");
  });
});
