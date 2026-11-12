import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { randomUUID } from "node:crypto";
import { MainConfig } from "../../main/app/MainConfig";
import { makeAgentPluginReader } from "./AgentPluginReader";
import { packageFilesNode } from "./PackageFilesNode";
import { makePluginInstallation, PluginInstallation } from "./PluginInstallation";
import { makePluginInstallationStoreNode } from "./PluginInstallationStoreNode";

export const live = Layer.effect(
  PluginInstallation,
  Effect.map(MainConfig, ({ nodexHome }) =>
    makePluginInstallation(
      makeAgentPluginReader(packageFilesNode),
      makePluginInstallationStoreNode(nodexHome),
      randomUUID,
    ),
  ),
);
