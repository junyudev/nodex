import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { MainConfig } from "../main/app/MainConfig";
import { appComponentDefinition } from "../main/app-components/AppComponentCatalog";
import { AppComponents } from "../main/app-components/AppComponents";
import { CodexPlatform } from "./ProviderPlatform";
import { live as workspaceDependencyLive } from "../main/host-runtime/WorkspaceDependencyRuntime";

export const live = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* MainConfig;
    const codex = yield* CodexPlatform;
    const offered = appComponentDefinition(config, "document-tools");
    const components = yield* Effect.serviceOption(AppComponents);
    const node = codex.runtime.nodeRuntime;
    return workspaceDependencyLive(
      {
        root:
          config.isPackaged || offered
            ? null
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
      },
      offered?.payload.kind === "document-tools" && Option.isSome(components)
        ? { ensure: components.value.ensure, manifestSha256: offered.payload.manifestSha256 }
        : undefined,
    );
  }),
);
