import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { MainConfig } from "../../app/MainConfig";
import type { AppComponentPayload } from "../AppComponentCatalog";
import { admitClaudeCode } from "../../platform/node/stage-claude-code";
import type {
  AppComponentActivator,
  AppComponentActivationResult,
} from "../AppComponentActivation";
import { appComponentDefinition, appComponentHome } from "../AppComponentCatalog";
import { appComponentRoot } from "../AppComponentStore";

export const claudeCodeActivator = Effect.gen(function* () {
  const config = yield* MainConfig;
  const definition = appComponentDefinition(config, "claude-code");
  return yield* makeClaudeCodeActivator(
    definition
      ? {
          root: appComponentRoot(appComponentHome(config), definition),
          payload: definition.payload,
        }
      : null,
  );
});

export const makeClaudeCodeActivator = Effect.fnUntraced(function* (
  component: { readonly root: string; readonly payload: AppComponentPayload } | null,
) {
  const active = yield* Ref.make(false);
  return {
    activate: Effect.gen(function* () {
      if (yield* Ref.get(active)) return { status: "active" } as const;
      if (component?.payload.kind !== "claude-code") {
        return {
          status: "rejected",
          message: "Claude Code is unavailable on this build.",
        } as const;
      }
      const { root, payload } = component;
      return yield* Effect.tryPromise((signal) => admitClaudeCode(root, payload, signal)).pipe(
        Effect.andThen(Ref.set(active, true)),
        Effect.match({
          onSuccess: (): AppComponentActivationResult => ({ status: "active" }),
          onFailure: (): AppComponentActivationResult => ({
            status: "rejected",
            message: "Nodex could not verify the Claude Code executable.",
          }),
        }),
      );
    }),
    isActive: Ref.get(active),
  } satisfies AppComponentActivator;
});
