import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import WebSocket from "ws";
import { isSupportedCodexAppServerVersion } from "../../../shared/codex-app-server-version";
import type { CodexRuntimeError } from "../../codex-runtime/CodexRuntimeError";
import type { CodexSessionTransportHandle } from "./CodexSessionTransport";
import { openCodexWebSocket } from "./CodexWebSocketTransport";

export interface CodexLocalDaemonConfig {
  readonly codexHome: string;
  readonly platform: string;
  readonly resourcesPath?: string;
  readonly configOverrides: readonly string[];
  readonly commandOverride?: boolean;
}
const execute = promisify(execFile);
export const canUseCodexLocalDaemon = (
  config: CodexLocalDaemonConfig,
  env: Readonly<Record<string, string | undefined>>,
): boolean =>
  config.platform !== "win32" &&
  config.configOverrides.length === 0 &&
  env.CODEX_APP_SERVER_USE_LOCAL_DAEMON === "1" &&
  env.CODEX_APP_SERVER_FORCE_CLI !== "1" &&
  !env.CODEX_CLI_PATH?.trim() &&
  !config.commandOverride &&
  !(
    config.platform === "darwin" &&
    config.resourcesPath &&
    existsSync(join(config.resourcesPath, "git", "bin", "git"))
  );

/** A daemon is selected only after its own version probe succeeds; selection never starts a daemon. */
export const openCodexLocalDaemon = Effect.fn("openCodexLocalDaemon")(function* (input: {
  readonly config: CodexLocalDaemonConfig;
  readonly command: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly hostId: string;
  readonly generation: number;
  readonly probe?: () => Effect.Effect<unknown>;
  readonly connect?: (
    socketPath: string,
  ) => Effect.Effect<CodexSessionTransportHandle, CodexRuntimeError, Scope.Scope>;
}) {
  if (!canUseCodexLocalDaemon(input.config, input.env)) return undefined;
  const response: unknown = yield* input.probe
    ? input.probe()
    : Effect.tryPromise({
        try: (signal) =>
          execute(input.command, ["app-server", "daemon", "version"], {
            signal,
            env: { ...input.env },
            timeout: 2500,
            encoding: "utf8",
          }),
        catch: () => undefined,
      }).pipe(
        Effect.flatMap((result) =>
          Schema.decodeEffect(
            Schema.fromJsonString(Schema.Struct({ appServerVersion: Schema.String })),
          )(result.stdout),
        ),
        Effect.orElseSucceed(() => null),
      );
  if (
    !response ||
    typeof response !== "object" ||
    !("appServerVersion" in response) ||
    typeof response.appServerVersion !== "string" ||
    !isSupportedCodexAppServerVersion(response.appServerVersion)
  )
    return undefined;
  const socketPath = join(input.config.codexHome, "app-server-control", "app-server-control.sock");
  if (input.connect) return yield* input.connect(socketPath);
  return yield* openCodexWebSocket({
    hostId: input.hostId,
    generation: input.generation,
    createSocket: () =>
      new WebSocket("ws://localhost/rpc", {
        perMessageDeflate: false,
        createConnection: () => createConnection(socketPath),
      }),
  });
});
