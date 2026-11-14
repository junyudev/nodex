import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { PluginCatalogSnapshot } from "./PluginCatalog";

/**
 * The installed plugins Agent Sessions may receive. The host that composes plugin management
 * provides it; a host without plugin management leaves it absent and Sessions get no plugins.
 */
export class PluginCatalogSource extends Context.Service<
  PluginCatalogSource,
  {
    readonly catalog: (projectId: string | null) => Effect.Effect<PluginCatalogSnapshot, unknown>;
    /** Emits whenever the installed plugins or their Project scopes may have changed. */
    readonly changes: Stream.Stream<unknown>;
  }
>()("nodex/host/agent-plugins/PluginCatalogSource") {}
