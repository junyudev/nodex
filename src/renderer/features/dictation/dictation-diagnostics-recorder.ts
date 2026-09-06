import type {
  DictationDiagnostics,
  DictationHttpDiagnostics,
  DictationPhase,
  DictationStreamDiagnostics,
} from "../../../shared/dictation-diagnostics";

/** Capture-surface measurements use one monotonic clock; remote timings stay in their own lanes. */
export class DictationDiagnosticsRecorder {
  readonly #origin: number;
  readonly #value: DictationDiagnostics;

  constructor(
    private readonly now: () => number,
    delivery: DictationDiagnostics["delivery"],
    source: DictationDiagnostics["source"] = "capture",
    attempt = 1,
  ) {
    this.#origin = now();
    this.#value = {
      version: 1,
      attempt,
      source,
      delivery,
      outcome: "failed",
      transport: "none",
      phases: [],
      requests: [],
    };
    if (source !== "capture") this.stopped();
  }

  get attempt(): number {
    return this.#value.attempt;
  }

  phase(stage: DictationPhase["stage"]): (outcome?: DictationPhase["outcome"]) => void {
    const startedAt = this.now();
    let ended = false;
    return (outcome = "completed") => {
      if (ended) return;
      ended = true;
      this.#value.phases.push({
        stage,
        outcome,
        offsetMs: Math.max(0, startedAt - this.#origin),
        durationMs: Math.max(0, this.now() - startedAt),
      });
    };
  }

  async measure<A>(stage: DictationPhase["stage"], task: () => Promise<A>): Promise<A> {
    const finish = this.phase(stage);
    try {
      const result = await task();
      finish();
      return result;
    } catch (error) {
      finish("failed");
      throw error;
    }
  }

  stopped(): void {
    this.#value.stopOffsetMs ??= Math.max(0, this.now() - this.#origin);
  }
  useTransport(transport: DictationDiagnostics["transport"]): void {
    this.#value.transport = transport;
  }
  readonly request = (diagnostics: DictationHttpDiagnostics): void => {
    this.#value.requests = [
      ...this.#value.requests.filter((entry) => entry.operation !== diagnostics.operation),
      diagnostics,
    ];
  };

  delivered(clipboardRestoreMs = 0): void {
    const stopOffset = this.#value.stopOffsetMs;
    if (stopOffset === undefined) return;
    const elapsed = Math.max(0, this.now() - this.#origin - stopOffset);
    this.#value.stopToCompletionMs = elapsed;
    this.#value.stopToTextMs = Math.max(0, elapsed - clipboardRestoreMs);
    if (this.#value.delivery === "global") this.#value.clipboardRestoreMs = clipboardRestoreMs;
  }

  snapshot(
    outcome: DictationDiagnostics["outcome"],
    streaming?: DictationStreamDiagnostics,
  ): DictationDiagnostics {
    return structuredClone({ ...this.#value, outcome, ...(streaming ? { streaming } : {}) });
  }
}
