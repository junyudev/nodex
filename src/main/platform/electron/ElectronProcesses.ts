import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { app } from "electron";

export type ElectronProcessKind = "renderer" | "gpu" | "utility" | "other";

export interface ElectronProcess {
  readonly pid: number;
  readonly kind: ElectronProcessKind;
}

const kindOf = (type: string): ElectronProcessKind | null => {
  if (type === "Browser") return null;
  if (type === "Tab") return "renderer";
  if (type === "GPU") return "gpu";
  if (type === "Utility") return "utility";
  return "other";
};

/** Electron's own helper processes, and their unexpected exits. */
export class ElectronProcesses extends Context.Service<
  ElectronProcesses,
  {
    /** Helpers only; Main is not one of them. */
    readonly list: Effect.Effect<readonly ElectronProcess[]>;
    readonly onGone: (
      listener: (kind: ElectronProcessKind) => void,
    ) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("nodex/main/platform/electron/ElectronProcesses") {}

export const live: Layer.Layer<ElectronProcesses> = Layer.succeed(
  ElectronProcesses,
  ElectronProcesses.of({
    list: Effect.sync(() =>
      app.getAppMetrics().flatMap((metric) => {
        const kind = kindOf(metric.type);
        return kind === null ? [] : [{ pid: metric.pid, kind }];
      }),
    ),
    onGone: (listener) => {
      const renderer = () => listener("renderer");
      const child = (_event: unknown, details: Electron.Details) => {
        if (details.reason !== "clean-exit") listener(kindOf(details.type) ?? "other");
      };
      return Effect.acquireRelease(
        Effect.sync(() => {
          app.on("render-process-gone", renderer);
          app.on("child-process-gone", child);
        }),
        () =>
          Effect.sync(() => {
            app.removeListener("render-process-gone", renderer);
            app.removeListener("child-process-gone", child);
          }),
      );
    },
  }),
);
