import type { AppInfo } from "@nodex/codex-app-server-protocol/v2/AppInfo";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { normalizeCodexAppInfoLogos } from "../../shared/codex-app-info";
import type { CodexServerNotification } from "../codex-runtime/CodexApplicationProtocol";
import { CodexApplicationEventHub } from "./CodexApplicationEventHub";

export interface CodexProtocolNotificationProjectionConfig {
  readonly supportsChatGptApps: boolean;
}

export class CodexProtocolNotificationProjection extends Context.Service<
  CodexProtocolNotificationProjection,
  {
    /** Projects process-wide side effects; returns whether no conversation projection remains. */
    readonly observe: (notification: CodexServerNotification) => Effect.Effect<boolean>;
  }
>()("nodex/main/codex-application/CodexProtocolNotificationProjection") {}

const record = (value: unknown): Readonly<Record<string, unknown>> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;

/** Process-wide protocol projections that do not belong to any Thread aggregate. */
export const live = (
  config: CodexProtocolNotificationProjectionConfig,
): Layer.Layer<CodexProtocolNotificationProjection, never, CodexApplicationEventHub> =>
  Layer.effect(
    CodexProtocolNotificationProjection,
    Effect.gen(function* () {
      const events = yield* CodexApplicationEventHub;
      return CodexProtocolNotificationProjection.of({
        observe: (notification) =>
          Effect.sync(() => {
            if (notification.method === "skills/changed") {
              events.publish({ kind: "codex", value: { type: "skillsChanged" } });
              return true;
            }
            if (notification.method === "app/list/updated") {
              if (config.supportsChatGptApps) {
                const payload = record(notification.params);
                if (payload && Array.isArray(payload.data) && payload.data.every(record)) {
                  events.publish({
                    kind: "codex",
                    value: {
                      type: "appsUpdated",
                      apps: normalizeCodexAppInfoLogos(payload.data as AppInfo[]),
                    },
                  });
                }
              }
              return true;
            }
            if (notification.method !== "error") return false;
            const payload = record(notification.params);
            const error = record(payload?.error);
            events.publish({
              kind: "codex",
              value: {
                type: "error",
                message: typeof error?.message === "string" ? error.message : "Codex error",
                ...(typeof error?.additionalDetails === "string"
                  ? { detail: error.additionalDetails }
                  : {}),
              },
            });
            return false;
          }),
      });
    }),
  );
