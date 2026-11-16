import type { IpcMainInvokeEvent } from "electron";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { z } from "zod";
import {
  ProviderKeyConnectInputSchema,
  ProviderKeyIdInputSchema,
  ProviderKeyUpdateInputSchema,
  type ProviderKeyResult,
  type ProviderKeySettings,
} from "../../../shared/provider-keys";
import { AgentRuntimeProviderConfiguration } from "../../agent-runtime/AgentRuntimeProviderConfiguration";
import { MainConfig } from "../../app/MainConfig";
import { safeBroadcastToWindows } from "../../ipc-safe-send";
import { ElectronIpc } from "../../platform/electron/ElectronIpc";
import { requireTrustedAppRendererSender } from "../../platform/electron/TrustedRendererSender";
import { providerKeyModelDiscovery } from "../../platform/node/ProviderKeyModelDiscovery";
import { makeProviderKeys } from "../../provider-keys/ProviderKeys";
import { ApplicationSettings } from "../../settings/ApplicationSettings";
import { WindowRuntime } from "../../window-runtime/WindowRuntime";

export const make = (discover = providerKeyModelDiscovery()) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const settings = yield* ApplicationSettings;
      const runtime = yield* AgentRuntimeProviderConfiguration;
      const config = yield* MainConfig;
      const ipc = yield* ElectronIpc;
      const windows = yield* WindowRuntime;
      const keys = makeProviderKeys(settings, discover);
      // Serialize the check, save and publication across windows; a late refresh cannot overwrite a new key.
      const writes = yield* Semaphore.make(1);
      const trusted = (event: IpcMainInvokeEvent) =>
        Effect.try({
          try: () =>
            requireTrustedAppRendererSender(event, "API key connections", config.rendererUrl),
          catch: () => new Error("API key connections require a trusted Nodex window."),
        });
      const parse = <A>(schema: z.ZodType<A>, input: unknown) =>
        Effect.suspend(() => {
          const parsed = schema.safeParse(input);
          // Validation errors can contain submitted input, including the key.
          return parsed.success
            ? Effect.succeed(parsed.data)
            : Effect.fail(new Error("Check the API key connection fields and try again."));
        });
      const publish = (snapshot: ProviderKeySettings) =>
        runtime.refresh.pipe(
          Effect.catch(() =>
            Effect.logWarning(
              "API key connections were saved; execution configuration could not refresh.",
            ),
          ),
          Effect.andThen(
            Effect.sync(() => {
              safeBroadcastToWindows(windows.all(), "provider-keys:changed", [snapshot]);
            }),
          ),
        );
      const publishResult = (result: ProviderKeyResult) =>
        result.ok ? publish(result.settings) : Effect.void;

      yield* ipc.handleQuery("provider-keys:read", (event) =>
        trusted(event).pipe(Effect.andThen(keys.read)),
      );
      yield* ipc.handlePlainCommand("provider-keys:connect", (event, input) =>
        trusted(event).pipe(
          Effect.andThen(parse(ProviderKeyConnectInputSchema, input)),
          Effect.flatMap((parsed) =>
            writes.withPermit(keys.connect(parsed).pipe(Effect.tap(publishResult))),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("provider-keys:update", (event, input) =>
        trusted(event).pipe(
          Effect.andThen(parse(ProviderKeyUpdateInputSchema, input)),
          Effect.flatMap((parsed) =>
            writes.withPermit(keys.update(parsed).pipe(Effect.tap(publishResult))),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("provider-keys:refresh-models", (event, input) =>
        trusted(event).pipe(
          Effect.andThen(parse(ProviderKeyIdInputSchema, input)),
          Effect.flatMap(({ id }) =>
            writes.withPermit(keys.refreshModels(id).pipe(Effect.tap(publishResult))),
          ),
        ),
      );
      yield* ipc.handlePlainCommand("provider-keys:remove", (event, input) =>
        trusted(event).pipe(
          Effect.andThen(parse(ProviderKeyIdInputSchema, input)),
          Effect.flatMap(({ id }) => writes.withPermit(keys.remove(id).pipe(Effect.tap(publish)))),
        ),
      );
    }),
  );

export const live = make();
