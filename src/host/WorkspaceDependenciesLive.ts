import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MainConfig } from "../main/app/MainConfig";
import { CodexPlatform } from "./ProviderPlatform";
import { live as workspaceDependencyLive } from "../main/host-runtime/WorkspaceDependencyRuntime";

export const live = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    const node = codex.runtime.nodeRuntime;
    return workspaceDependencyLive({
      root: config.isPackaged
        ? `${config.resourcesPath}/workspace-runtime`
        : `${config.projectRootPath}/.generated/workspace-runtime/${config.arch}`,
      platform: config.platform,
      arch: config.arch,
      node:
        node.status === "available"
          ? {
              executable: node.executable,
              version: node.version,
            }
          : null,
    });
  }),
);
