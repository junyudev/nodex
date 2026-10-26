import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodexGateway } from "../codex-runtime/CodexGateway";
import type { CodexRuntimeError } from "../codex-runtime/CodexRuntimeError";
import { createPluginInventoryPolicy } from "./PluginInventoryPolicy";
export type PluginRemovalResult =
  | { readonly status: "uninstalled" | "still_installed"; readonly pluginId: string }
  | {
      readonly status:
        | "not_installed"
        | "protected"
        | "cancelled"
        | "inventory_unavailable"
        | "outcome_unavailable";
    }
  | {
      readonly status: "selection_required";
      readonly candidates: readonly { readonly pluginId: string; readonly name: string }[];
    };
export class PluginNativeOperations extends Context.Service<
  PluginNativeOperations,
  {
    readonly uninstall: (input: {
      readonly plugin: string;
      readonly cwds: readonly string[];
      readonly isCurrent: Effect.Effect<boolean>;
    }) => Effect.Effect<PluginRemovalResult, CodexRuntimeError>;
  }
>()("nodex/main/codex-application/PluginNativeOperations") {}
export const live = (options: { readonly runtimeStateHome: string }) =>
  Layer.effect(
    PluginNativeOperations,
    Effect.gen(function* () {
      const gateway = yield* CodexGateway;
      const policy = createPluginInventoryPolicy(options.runtimeStateHome);
      const read = (cwds: readonly string[]) =>
        gateway.requestLocal("plugin/installed", { cwds: cwds.length ? [...cwds] : null });
      return PluginNativeOperations.of({
        uninstall: Effect.fn("PluginNativeOperations.uninstall")(function* (input) {
          yield* gateway.awaitReady(gateway.localHostId);
          if (!(yield* input.isCurrent)) return { status: "cancelled" };
          const inventory = yield* read(input.cwds);
          if (inventory.marketplaceLoadErrors?.length) return { status: "inventory_unavailable" };
          const plugins = [
            ...new Map(
              inventory.marketplaces.flatMap((marketplace) =>
                marketplace.plugins
                  .filter((plugin) => plugin.installed)
                  .map((plugin) => [plugin.id, plugin] as const),
              ),
            ).values(),
          ];
          const query = input.plugin.trim();
          const exact = plugins.find((plugin) => plugin.id === query);
          const matches = exact
            ? [exact]
            : plugins.filter(
                (plugin) =>
                  plugin.name.toLowerCase() === query.toLowerCase() ||
                  plugin.interface?.displayName?.toLowerCase() === query.toLowerCase(),
              );
          if (!(yield* input.isCurrent)) return { status: "cancelled" };
          if (!matches.length) return { status: "not_installed" };
          if (matches.length > 1)
            return {
              status: "selection_required",
              candidates: matches.map((plugin) => ({
                pluginId: plugin.id,
                name: plugin.interface?.displayName ?? plugin.name,
              })),
            };
          const pluginId = matches[0]!.id;
          if (policy.managed(pluginId, gateway.localHostId)) return { status: "protected" };
          yield* gateway.requestLocal("plugin/uninstall", { pluginId });
          const refreshed = yield* read(input.cwds);
          if (refreshed.marketplaceLoadErrors?.length) return { status: "outcome_unavailable" };
          const remains = refreshed.marketplaces.some((marketplace) =>
            marketplace.plugins.some((plugin) => plugin.id === pluginId && plugin.installed),
          );
          return { status: remains ? "still_installed" : "uninstalled", pluginId };
        }),
      });
    }),
  );
