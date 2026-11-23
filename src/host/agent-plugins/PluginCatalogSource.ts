import * as Context from "effect/Context";
import type { PluginCatalogCache } from "./PluginCatalogCache";

/** The latest installed plugins available to Agent Sessions on this Host. */
export class PluginCatalogSource extends Context.Service<PluginCatalogSource, PluginCatalogCache>()(
  "nodex/host/agent-plugins/PluginCatalogSource",
) {}
