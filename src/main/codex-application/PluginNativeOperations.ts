import { MAIN_OBSERVATION_EVENT_CAPACITY } from "../runtime-limits";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Ref from "effect/Ref";
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
    readonly changes: Stream.Stream<{ readonly hostId: string }>;
    readonly changed: Effect.Effect<void>;
    readonly observeSkillScope: (input: {
      readonly hostId: string;
      readonly cwds: readonly string[];
    }) => Effect.Effect<void>;
    readonly skillScopes: (hostId: string) => Effect.Effect<readonly (readonly string[])[]>;
    readonly uninstall: (input: {
      readonly plugin: string;
      readonly cwds: readonly string[];
      readonly isCurrent: Effect.Effect<boolean>;
      readonly expectedGeneration?: number;
    }) => Effect.Effect<PluginRemovalResult, CodexRuntimeError>;
  }
>()("nodex/main/codex-application/PluginNativeOperations") {}
export const live = (options: { readonly runtimeStateHome: string }) =>
  Layer.effect(
    PluginNativeOperations,
    Effect.gen(function* () {
      const gateway = yield* CodexGateway;
      const policy = createPluginInventoryPolicy(options.runtimeStateHome);
      // These coalescible observations invalidate native inventory; the newest notification repairs a gap.
      const events = yield* PubSub.sliding<{ readonly hostId: string }>(
        MAIN_OBSERVATION_EVENT_CAPACITY,
      );
      yield* Effect.addFinalizer(() => PubSub.shutdown(events));
      const changed = PubSub.publish(events, { hostId: gateway.localHostId }).pipe(Effect.asVoid);
      const scopes = yield* Ref.make<ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>>(
        new Map(),
      );
      const observeSkillScope: PluginNativeOperations["Service"]["observeSkillScope"] = (input) =>
        Ref.update(scopes, (current) => {
          const cwds = [...new Set(input.cwds.map((cwd) => cwd.trim()).filter(Boolean))];
          const key = cwds.join("\0");
          const previous = current.get(input.hostId) ?? new Map<string, readonly string[]>();
          if (previous.has(key)) return current;
          return new Map(current).set(input.hostId, new Map(previous).set(key, cwds));
        });
      const skillScopes = (hostId: string) =>
        Ref.get(scopes).pipe(Effect.map((current) => [...(current.get(hostId)?.values() ?? [])]));
      yield* gateway.events.pipe(
        Stream.runForEach((event) => {
          const hostId = event.kind === "connection" ? event.value.hostId : event.hostId;
          if (event.kind !== "connection" && event.value.method !== "account/updated")
            return Effect.void;
          return Ref.update(scopes, (current) => {
            const next = new Map(current);
            next.delete(hostId);
            return next;
          });
        }),
        Effect.forkScoped({ startImmediately: true }),
      );
      const read = (cwds: readonly string[], expectedGeneration?: number) =>
        gateway.requestLocal(
          "plugin/installed",
          { cwds: cwds.length ? [...cwds] : null },
          { expectedGeneration },
        );
      return PluginNativeOperations.of({
        changes: Stream.fromPubSub(events),
        changed,
        observeSkillScope,
        skillScopes,
        uninstall: Effect.fn("PluginNativeOperations.uninstall")(function* (input) {
          yield* gateway.awaitReady(gateway.localHostId);
          if (!(yield* input.isCurrent)) return { status: "cancelled" };
          yield* observeSkillScope({ hostId: gateway.localHostId, cwds: input.cwds });
          const inventory = yield* read(input.cwds, input.expectedGeneration);
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
          const selected = matches[0]!;
          const requestId =
            selected.source?.type === "remote" ? (selected.remotePluginId ?? pluginId) : pluginId;
          yield* gateway.requestLocal(
            "plugin/uninstall",
            { pluginId: requestId },
            { expectedGeneration: input.expectedGeneration },
          );
          yield* changed;
          const roots = yield* skillScopes(gateway.localHostId);
          for (const cwds of roots)
            yield* gateway
              .requestLocal(
                "skills/list",
                { cwds: [...cwds], forceReload: true },
                { expectedGeneration: input.expectedGeneration },
              )
              .pipe(Effect.ignore);
          const refreshed = yield* read(input.cwds, input.expectedGeneration);
          if (refreshed.marketplaceLoadErrors?.length) return { status: "outcome_unavailable" };
          const remains = refreshed.marketplaces.some((marketplace) =>
            marketplace.plugins.some((plugin) => plugin.id === pluginId && plugin.installed),
          );
          return { status: remains ? "still_installed" : "uninstalled", pluginId };
        }),
      });
    }),
  );
