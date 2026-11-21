import { AntigravityUsage } from "../provider/Drivers/AntigravityUsage.ts";
import { AntigravitySettings } from "@nodex/runtime-contracts";
import { mergeProviderInstanceEnvironment } from "@nodex/provider-core/server/instanceEnvironment";
import { ProviderSetupInput, ProviderSetupError } from "@nodex/runtime-contracts";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";
import { ProviderInstanceRegistry } from "../provider/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "../provider/ProviderRegistry.ts";
import { ProviderPolicy } from "./ProviderConfiguration.ts";

const request = <M extends string, S extends Schema.Constraint>(method: M, input: S) =>
  Schema.Struct({ id: Schema.String, method: Schema.Literal(method), input });
export const Request = Schema.Union([
  request("providers.models.refresh", ProviderSetupInput),
  request(
    "providers.usage.scan",
    Schema.Struct({ ...ProviderSetupInput.fields, sinceMs: Schema.Finite, untilMs: Schema.Finite }),
  ),
]);

/** Reads are point-in-time snapshots; native controllers own progress and cancellation across requests. */
export const make = Effect.fn("ProviderManagement.make")(function* () {
  const instances = yield* ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry;
  const policy = yield* ProviderPolicy;
  const usage = yield* AntigravityUsage;
  return {
    execute: Effect.fn("ProviderManagement.execute")(function* (request: typeof Request.Type) {
      const { input, method } = request;
      const current = (yield* policy.snapshot).config[input.instanceId];
      const wanted = (yield* policy.desired)[input.instanceId];
      const startsWork = method === "providers.models.refresh";
      if (!current || (startsWork && !Equal.equals(current, wanted))) {
        return yield* new ProviderSetupError({
          instanceId: input.instanceId,
          operation: request.method,
          detail: "Wait for the provider configuration to apply before managing it.",
        });
      }
      switch (method) {
        case "providers.usage.scan": {
          if (current.driver !== "antigravity" || input.untilMs <= input.sinceMs) {
            return yield* new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "usage",
              detail: "This provider does not support this usage history read.",
            });
          }
          const config = yield* Schema.decodeUnknownEffect(AntigravitySettings)(
            current.config ?? {},
          );
          const scans = yield* usage.scan({
            instances: [
              {
                instanceId: input.instanceId,
                config,
                configured: true,
                environment: yield* mergeProviderInstanceEnvironment(current.environment),
              },
            ],
            windowStartMs: input.sinceMs,
          });
          return scans.map((scan) => ({
            ...scan,
            files:
              scan.files?.map((file) => ({
                ...file,
                records: file.records.filter(
                  (record) =>
                    record.timestampMs >= input.sinceMs && record.timestampMs < input.untilMs,
                ),
              })) ?? null,
          }));
        }
        case "providers.models.refresh": {
          const instance = yield* instances.getInstance(input.instanceId);
          if (!instance?.enabled || !instance.refreshModels)
            return yield* new ProviderSetupError({
              instanceId: input.instanceId,
              operation: "refreshModels",
              detail: "This provider does not support model discovery.",
            });
          yield* instance.refreshModels();
          yield* providers.refreshInstance(input.instanceId, { fresh: true });
          return null;
        }
      }
    }),
  };
});
