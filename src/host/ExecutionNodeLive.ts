import path from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MainConfig } from "../main/app/MainConfig";
import {
  resolveNodeExecutionRuntime,
  type NodeExecutionRuntime,
} from "../main/platform/node/NodeExecutionRuntime";
import { scenarioAgentRuntimeProjectRoot } from "../main/platform/node/AgentRuntimeEntrypoint";

export class ExecutionNode extends Context.Service<ExecutionNode, NodeExecutionRuntime>()(
  "nodex/host/ExecutionNode",
) {}

export const live = Layer.effect(
  ExecutionNode,
  Effect.gen(function* () {
    const config = yield* MainConfig;
    return yield* Effect.promise((signal) =>
      resolveNodeExecutionRuntime({
        platform: config.platform,
        architecture: config.arch,
        directory: config.isPackaged
          ? path.join(config.resourcesPath, "node-runtime")
          : path.join(
              scenarioAgentRuntimeProjectRoot(config) ?? config.projectRootPath,
              ".generated",
              "node-runtime",
              `${config.platform}-${config.arch}`,
            ),
        signal,
      }),
    );
  }),
);
