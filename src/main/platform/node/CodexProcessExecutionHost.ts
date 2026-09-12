import { delimiter as pathDelimiter } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { live as sessionLive } from "../../codex-runtime/CodexAppServerSession";
import type { CodexSessionProcessConfig } from "./CodexSessionTransport";
import type { CodexExecutionHostConfig } from "../../codex-runtime/CodexEndpointMap";
import { codexRuntimeError } from "../../codex-runtime/CodexRuntimeError";
import { codexCliAppServerArgs } from "../../../shared/codex-app-server-launch";
import { supportsCodexAttestationRequests } from "../../codex-application/CodexAttestation";

export interface CodexAppServerClientOptions {
  readonly binaryPath?: string;
  readonly ssh?: CodexSessionProcessConfig["ssh"];
  readonly args?: string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly resolveEnv?: () => NodeJS.ProcessEnv | Promise<NodeJS.ProcessEnv>;
  readonly additionalSearchPaths?: string[];
  readonly missingBinaryMessage?: string;
  readonly initializeTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly logStderr?: boolean;
  readonly expectedCodexHome?: string;
  readonly clientInfo?: { readonly name: string; readonly title: string; readonly version: string };
}

const withSearchPath = (
  env: Readonly<Record<string, string | undefined>>,
  entries: readonly string[],
): Readonly<Record<string, string | undefined>> => {
  const inherited = env.PATH?.split(pathDelimiter).filter(Boolean) ?? [];
  return { ...env, PATH: [...new Set([...entries, ...inherited])].join(pathDelimiter) };
};

const initializeParams = (options: CodexAppServerClientOptions) => ({
  clientInfo: options.clientInfo ?? { name: "nodex", title: "Nodex", version: "0.0.0" },
  capabilities: {
    experimentalApi: true,
    extensions: { "openai/form": {} },
    requestAttestation: supportsCodexAttestationRequests(process.platform),
  },
});

/** Converts an external process launch description into an Effect-owned Codex endpoint. */
export const makeCodexProcessExecutionHost = (
  hostId: string,
  options: CodexAppServerClientOptions,
): CodexExecutionHostConfig => {
  const resolveEnv = () =>
    Effect.tryPromise({
      try: () =>
        options.resolveEnv === undefined
          ? Promise.resolve(options.env ?? process.env)
          : Promise.resolve(options.resolveEnv()),
      catch: (cause) =>
        codexRuntimeError({
          operation: "session.resolve-environment",
          reason: "spawn",
          retryable: false,
          hostId,
          cause,
        }),
    }).pipe(Effect.map((env) => withSearchPath(env, options.additionalSearchPaths ?? [])));

  return {
    kind: hostId === "local" ? "local" : "remote",
    hostId,
    hostKind: options.ssh ? "ssh" : "local",
    transportKind: options.ssh ? "websocket" : "stdio",
    sessionLayer: (generation) =>
      sessionLive({
        hostId,
        generation,
        ...(options.ssh ? { ssh: options.ssh } : {}),
        command: options.binaryPath ?? "codex",
        args: options.args ?? codexCliAppServerArgs(),
        env: {},
        resolveEnv,
        forceTermination: "2 seconds",
        initializeParams: initializeParams(options),
        initializeTimeout: Duration.millis(options.initializeTimeoutMs ?? 20_000),
        ...(options.expectedCodexHome === undefined
          ? {}
          : { expectedCodexHome: options.expectedCodexHome }),
      }),
  };
};
