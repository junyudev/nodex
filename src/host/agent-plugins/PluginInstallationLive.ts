import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { randomUUID } from "node:crypto";
import { delimiter, isAbsolute, join } from "node:path";
import { MainApplicationError } from "../../main/app/MainExit";
import { MainConfig } from "../../main/app/MainConfig";
import {
  pluginDataDirectory,
  pluginPackageDirectory,
} from "../../shared/agent-plugins/installation-registry";
import { makeAgentPluginReader } from "./AgentPluginReader";
import { packageFilesNode } from "./PackageFilesNode";
import {
  makePluginInstallation,
  PluginInstallation,
  type PublishPluginInstallation,
} from "./PluginInstallation";
import { makePluginInstallationStoreNode } from "./PluginInstallationStoreNode";
import { makePluginMcpBroker, PluginMcpBroker, PluginMcpFailure } from "./broker";

const broker = Layer.effect(
  PluginMcpBroker,
  Effect.gen(function* () {
    const { environment } = yield* MainConfig;
    const path = Object.entries(environment).find(([key]) => key.toUpperCase() === "PATH")?.[1];
    return yield* makePluginMcpBroker({
      executableSearchPath: path?.split(delimiter).filter(isAbsolute) ?? [],
      resolveHeaders: ({ declaredHeaderNames }) =>
        declaredHeaderNames.length > 0
          ? Effect.fail(new PluginMcpFailure("invalid_configuration"))
          : Effect.succeed({}),
    });
  }).pipe(
    Effect.mapError(
      (cause) =>
        new MainApplicationError({ phase: "startup", operation: "plugin-mcp-broker", cause }),
    ),
  ),
);

export const live = Layer.effect(
  PluginInstallation,
  Effect.gen(function* () {
    const { nodexHome } = yield* MainConfig;
    const broker = yield* PluginMcpBroker;
    const publish: PublishPluginInstallation = (id, installation) =>
      broker.publishInstallation(
        id,
        installation?.enabled
          ? {
              generation: installation.activeGeneration,
              packageRoot: join(nodexHome, pluginPackageDirectory(installation)),
              dataRoot: join(nodexHome, pluginDataDirectory(id)),
              activeProjects: installation.projects,
              servers: installation.package.mcpServers,
            }
          : null,
      );
    const service = makePluginInstallation(
      makeAgentPluginReader(packageFilesNode),
      makePluginInstallationStoreNode(nodexHome),
      randomUUID,
      publish,
    );
    yield* service.list.pipe(
      Effect.flatMap(({ installations }) =>
        Effect.forEach(installations, (entry) => publish(entry.id, entry), { discard: true }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("Could not load Agent Plugin installations", error),
      ),
    );
    return service;
  }),
).pipe(Layer.provideMerge(broker));
