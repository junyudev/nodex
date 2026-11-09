import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexPlatform } from "./ProviderPlatform";
import { MainConfig } from "../main/app/MainConfig";
import { live as configuration } from "../main/codex-application/ExecutionHostConfiguration";
import {
  live as executionHosts,
  type ExecutionHostRuntimeOptions,
} from "../main/codex-application/ExecutionHostRuntime";
import { live as managedWorktrees } from "../main/codex-application/ManagedWorktreeRuntime";
import {
  live as gitWorker,
  type GitWorkerRuntimeOptions,
} from "../main/host-runtime/GitWorkerRuntime";
import { localLive as worktreeWorker } from "../main/host-runtime/WorktreeWorkerRuntime";
import { getLogger } from "../main/logging/logger";

const logger = getLogger({ subsystem: "app" });

/** The embedding process supplies its bundled worker directory, never a client filesystem path. */
export const live = (options: {
  readonly workerDirectory: string;
  readonly rendererLifecycle?: GitWorkerRuntimeOptions["rendererLifecycle"];
  readonly nativeEndpoints?: ExecutionHostRuntimeOptions["nativeEndpoints"];
}) => {
  const local = worktreeWorker({
    hostId: "local",
    workerPath: `${options.workerDirectory}/worktree-worker.js`,
    onInfrastructureError: (error) => {
      logger.error("Worktree worker infrastructure failed", { error: error.message });
    },
  });
  const hosts = Layer.unwrap(
    Effect.gen(function* () {
      const config = yield* MainConfig;
      const codex = yield* CodexPlatform;
      return executionHosts({
        runtimeStateHome: codex.runtimeStateHome,
        codexHome: codex.codexHome,
        nodexHome: config.nodexHome,
        remoteWorktreeWorkerBundlePath: `${options.workerDirectory}/remote-worktree-worker.cjs`,
        nativeEndpoints: options.nativeEndpoints,
      });
    }),
  ).pipe(Layer.provideMerge(Layer.mergeAll(local, configuration)));
  return Layer.merge(
    managedWorktrees.pipe(Layer.provideMerge(hosts)),
    gitWorker({
      workerPath: `${options.workerDirectory}/git-worker.js`,
      ...(options.rendererLifecycle ? { rendererLifecycle: options.rendererLifecycle } : {}),
      onInfrastructureError: (error, context) => {
        logger.error("Git worker infrastructure failed", {
          epoch: context.epoch,
          error: error.message,
          phase: context.phase,
        });
      },
      onPerformanceOperation: (metric) => logger.debug("Git worker operation", metric),
    }),
  );
};
