import { randomUUID } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import {
  PROVIDER_KEY_LIMIT,
  providerKeyBaseUrl,
  providerKeyDefaultName,
  providerKeyHint,
  providerKeyTarget,
  type ProviderKeyConnectInput,
  type ProviderKeyConnection,
  type ProviderKeyModel,
  type ProviderKeyTarget,
  type ProviderKeyResult,
  type ProviderKeyUpdateInput,
} from "../../shared/provider-keys";
import type {
  ApplicationSettings,
  ProviderKeySettingsMutation,
} from "../settings/ApplicationSettings";
import { getMainIntl } from "../i18n/main-intl";

const storageFailure = () =>
  ({
    ok: false,
    reason: "storage",
    message: getMainIntl().formatMessage({
      id: "main.providerKeys.storageUnavailable",
      defaultMessage: "Couldn’t access secure storage. Unlock your system keychain and try again.",
    }),
  }) as const;

function uniqueName(connections: readonly ProviderKeyConnection[], base: string): string {
  const names = new Set(connections.map(({ displayName }) => displayName));
  if (!names.has(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = ` ${index}`;
    const name = base.slice(0, 128 - suffix.length).trimEnd() + suffix;
    if (!names.has(name)) return name;
  }
}

export type ProviderKeyDiscovery = (
  target: ProviderKeyTarget,
  key: Redacted.Redacted,
  manualModels?: readonly ProviderKeyModel[],
) => Effect.Effect<
  | { readonly ok: true; readonly models: readonly ProviderKeyModel[] }
  | Extract<ProviderKeyResult, { ok: false }>
>;

export function makeProviderKeys(
  settings: ApplicationSettings["Service"],
  discover: ProviderKeyDiscovery,
) {
  const read = settings.snapshot().pipe(Effect.map((snapshot) => snapshot.providerKeys));
  const commit = (input: ProviderKeySettingsMutation) =>
    settings
      .update({ type: "update-provider-keys", input })
      .pipe(Effect.map((snapshot) => snapshot.providerKeys));
  const save = (connection: ProviderKeyConnection, key?: Redacted.Redacted) =>
    commit({ connection, key }).pipe(
      Effect.map((settings): ProviderKeyResult => ({
        ok: true,
        settings,
        connectionId: connection.id,
      })),
      Effect.catch(() => Effect.sync(storageFailure)),
    );
  const find = (id: string) =>
    read.pipe(
      Effect.flatMap(({ connections }) => {
        const connection = connections.find((item) => item.id === id);
        return connection
          ? Effect.succeed(connection)
          : Effect.fail(
              new Error(
                getMainIntl().formatMessage({
                  id: "main.providerKeys.connectionGone",
                  defaultMessage: "This API key connection no longer exists.",
                }),
              ),
            );
      }),
    );

  return {
    read,
    connect: Effect.fn("ProviderKeys.connect")(function* (input: ProviderKeyConnectInput) {
      const { connections } = yield* read;
      if (connections.length >= PROVIDER_KEY_LIMIT)
        return yield* Effect.fail(
          new Error(
            getMainIntl().formatMessage(
              {
                id: "main.providerKeys.limitReached",
                defaultMessage: "You can save up to {limit} API key connections.",
              },
              { limit: PROVIDER_KEY_LIMIT },
            ),
          ),
        );
      const { target, apiKey, displayName } = input;
      const key = Redacted.make(apiKey);
      const found = yield* discover(target, key, input.models);
      if (!found.ok) return found;
      return yield* save(
        {
          id: randomUUID(),
          preset: target.preset,
          agent: target.agent,
          endpoint: target.preset === "custom" ? null : target.endpoint,
          baseUrl: target.preset === "custom" ? providerKeyBaseUrl(target) : null,
          displayName: uniqueName(
            connections,
            (displayName ?? providerKeyDefaultName(target)).slice(0, 128),
          ),
          enabled: true,
          models: found.models,
          keyHint: providerKeyHint(apiKey),
        },
        key,
      );
    }),
    update: Effect.fn("ProviderKeys.update")(function* (input: ProviderKeyUpdateInput) {
      const current = yield* find(input.id);
      const updated = {
        ...current,
        displayName: input.displayName ?? current.displayName,
        enabled: input.enabled ?? current.enabled,
        models: input.models ?? current.models,
      };
      if (!input.apiKey) return yield* save(updated);
      const key = Redacted.make(input.apiKey);
      const found = yield* discover(providerKeyTarget(current), key, updated.models);
      if (!found.ok) return found;
      return yield* save(
        {
          ...updated,
          models: input.models ?? found.models,
          keyHint: providerKeyHint(input.apiKey),
        },
        key,
      );
    }),
    refreshModels: Effect.fn("ProviderKeys.refreshModels")(function* (id: string) {
      const current = yield* find(id);
      const key = yield* Effect.result(settings.providerKeySecret(id));
      if (Result.isFailure(key)) return storageFailure();
      const found = yield* discover(providerKeyTarget(current), key.success);
      if (!found.ok) return found;
      return yield* save({ ...current, models: found.models });
    }),
    remove: (id: string) => commit({ removeId: id }),
  };
}
