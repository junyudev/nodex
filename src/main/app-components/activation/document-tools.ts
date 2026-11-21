import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { MainConfig } from "../../app/MainConfig";
import { verifyWorkspaceDependencyBundle } from "../../platform/node/WorkspaceDependencyBundle";
import type {
  AppComponentActivator,
  AppComponentActivationResult,
} from "../AppComponentActivation";
import {
  appComponentDefinition,
  appComponentHome,
  type AppComponentPayload,
} from "../AppComponentCatalog";
import { appComponentRoot } from "../AppComponentStore";

export const documentToolsActivator = Effect.gen(function* () {
  const config = yield* MainConfig;
  const definition = appComponentDefinition(config, "document-tools");
  return yield* makeDocumentToolsActivator(
    definition
      ? {
          root: appComponentRoot(appComponentHome(config), definition),
          payload: definition.payload,
        }
      : null,
  );
});

export const makeDocumentToolsActivator = Effect.fnUntraced(function* (
  component: { readonly root: string; readonly payload: AppComponentPayload } | null,
) {
  const active = yield* Ref.make(false);
  return {
    activate: Effect.gen(function* () {
      if (yield* Ref.get(active)) return { status: "active" } as const;
      if (component?.payload.kind !== "document-tools") {
        return {
          status: "rejected",
          message: "Document Tools are unavailable on this build.",
        } as const;
      }
      const { root, payload } = component;
      return yield* Effect.tryPromise((signal) =>
        verifyWorkspaceDependencyBundle(
          { root, platform: "darwin", arch: "arm64" },
          { signal, manifestSha256: payload.manifestSha256, installedComponent: true },
        ),
      ).pipe(
        Effect.andThen(Ref.set(active, true)),
        Effect.match({
          onSuccess: (): AppComponentActivationResult => ({ status: "active" }),
          onFailure: (): AppComponentActivationResult => ({
            status: "rejected",
            message: "Nodex could not verify Document Tools.",
          }),
        }),
      );
    }),
    isActive: Ref.get(active),
  } satisfies AppComponentActivator;
});
