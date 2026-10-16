import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";
import * as OpenCode2Client from "@t3tools/provider-opencode/server/v2/OpenCode2Client";
import * as OpenCode2Server from "@t3tools/provider-opencode/server/v2/OpenCode2Server";
import { probeOpenCodeRuntime } from "../../vendor/provider-opencode/src/server/versionProbe.ts";

export class OpenCodeCatalogError extends Schema.TaggedError<OpenCodeCatalogError>()(
  "OpenCodeCatalogError",
  {
    message: Schema.String,
    authenticationRequired: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {}

const catalogError = (cause: unknown): OpenCodeCatalogError => {
  if (Schema.is(OpenCodeCatalogError)(cause)) return cause;
  const message = OpenCodeRuntime.isOpenCodeRuntimeError(cause)
    ? cause.detail
    : "OpenCode could not load its model metadata.";
  return new OpenCodeCatalogError({
    message,
    authenticationRequired:
      Predicate.isTagged(cause, "UnauthorizedError") ||
      /401|403|rejected.*password/iu.test(message),
    cause,
  });
};

/** Presentation metadata shared by both native OpenCode generations. */
export interface OpenCodeCatalogInventory {
  readonly providers: {
    readonly all: ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly models: Readonly<
        Record<
          string,
          {
            readonly id: string;
            readonly providerID: string;
            readonly name: string;
            readonly capabilities: { readonly input: Readonly<Record<string, boolean>> };
            readonly variants?: Readonly<Record<string, unknown>>;
          }
        >
      >;
    }>;
    readonly connected: ReadonlyArray<string>;
    readonly default: Readonly<Record<string, string>>;
  };
  readonly agents: ReadonlyArray<{
    readonly name: string;
    readonly mode: "primary" | "subagent" | "all";
    readonly hidden?: boolean;
    readonly description?: string;
  }>;
  readonly config: { readonly model?: string; readonly default_agent?: string };
}

interface OpenCodeCatalogInput {
  readonly binaryPath: string;
  readonly serverUrl: string | null;
  readonly serverPassword?: string;
  readonly serverUsername?: string;
  readonly cwd: string;
  readonly profileDirectory: string;
  readonly environment: NodeJS.ProcessEnv;
}

/** A 1.x connection stays with its SDK; 2.x metadata never creates a native session. */
export const makeOpenCodeCatalog = Effect.fn("OpenCodeCatalog.make")(function* (
  input: OpenCodeCatalogInput,
) {
  const probe = probeOpenCodeRuntime(
    {
      binaryPath: input.binaryPath,
      serverUrl: input.serverUrl ?? "",
      serverPassword: input.serverPassword ?? "",
    },
    input.environment,
  );
  const http = yield* HttpClient.HttpClient;
  // External proxies can require their own identity; use it for every metadata request.
  const authenticated =
    input.serverUrl && input.serverUsername
      ? HttpClient.make((request) =>
          http.execute(
            HttpClientRequest.setHeader(
              request,
              "Authorization",
              `Basic ${Buffer.from(`${input.serverUsername}:${input.serverPassword ?? ""}`).toString("base64")}`,
            ),
          ),
        )
      : http;
  const version = yield* probe.pipe(Effect.provideService(HttpClient.HttpClient, authenticated));
  if (version.generation === "v1") return null;

  const client = yield* OpenCode2Client.make.pipe(
    Effect.provideService(HttpClient.HttpClient, authenticated),
  );
  const server = yield* OpenCode2Server.make({
    binaryPath: input.binaryPath,
    serverUrl: input.serverUrl ?? "",
    serverPassword: input.serverPassword ?? "",
    directory: input.cwd,
    environment: input.environment,
  }).pipe(Effect.provideService(OpenCode2Client.OpenCode2Client, client));
  return {
    inventory: server
      .withConnection(({ client }) =>
        Effect.gen(function* () {
          const location = { directory: input.cwd };
          // A new server loads its catalog lazily. Re-read until it is ready before projecting it.
          const models = yield* client.model.list({ location }).pipe(
            Effect.repeat({
              until: (result) => result.data.length > 0,
              schedule: Schedule.spaced("250 millis"),
            }),
            Effect.timeoutOrElse({
              duration: "5 seconds",
              orElse: () => client.model.list({ location }),
            }),
          );
          const [providers, agents, documents] = yield* Effect.all(
            [
              client.provider.list({ location }),
              client.agent.list({ location }),
              client.config.get({ location }),
            ],
            { concurrency: 3 },
          );
          const config = documents.reduce<OpenCodeCatalogInventory["config"]>((current, entry) => {
            if (entry.type !== "document") return current;
            return {
              ...current,
              ...(entry.info.model
                ? { model: `${entry.info.model.providerID}/${entry.info.model.model}` }
                : {}),
              ...(entry.info.default_agent ? { default_agent: entry.info.default_agent } : {}),
            };
          }, {});
          const enabled = models.data.filter((model) => model.enabled);
          const connected = [...new Set(enabled.map((model) => String(model.providerID)))];
          return {
            providers: {
              all: connected.map((id) => ({
                id,
                name: providers.data.find((provider) => provider.id === id)?.name ?? id,
                models: Object.fromEntries(
                  enabled
                    .filter((model) => model.providerID === id)
                    .map((model) => [
                      model.id,
                      {
                        id: model.id,
                        providerID: model.providerID,
                        name: model.name,
                        capabilities: {
                          input: Object.fromEntries(
                            model.capabilities.input.map((name) => [name, true]),
                          ),
                        },
                        variants: Object.fromEntries(
                          model.variants.map((variant) => [variant.id, {}]),
                        ),
                      },
                    ]),
                ),
              })),
              connected,
              default: {},
            },
            agents: agents.data.map((agent) => ({
              name: agent.name,
              mode: agent.mode,
              hidden: agent.hidden,
              ...(agent.description ? { description: agent.description } : {}),
            })),
            config,
          } satisfies OpenCodeCatalogInventory;
        }),
      )
      .pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () =>
            Effect.fail(
              new OpenCodeCatalogError({
                message: "Timed out while loading OpenCode models.",
                authenticationRequired: false,
                cause: undefined,
              }),
            ),
        }),
        Effect.mapError(catalogError),
      ),
  };
}, Effect.mapError(catalogError));

/** Scope-owned host metadata connection; provider execution remains in the Agent Runtime. */
export const openOpenCodeCatalog = Effect.fn("OpenCodeCatalog.open")(function* (
  input: OpenCodeCatalogInput,
) {
  const platform = Layer.merge(NodeServices.layer, FetchHttpClient.layer);
  const services = yield* Layer.build(
    OpenCodeRuntime.layer.pipe(
      Layer.provide(
        OpenCodeServerLedger.layer({
          stateDir: join(input.profileDirectory, "state", "nodex-metadata"),
        }),
      ),
      Layer.provideMerge(platform),
    ),
  );
  return yield* makeOpenCodeCatalog(input).pipe(Effect.provide(services));
}, Effect.mapError(catalogError));
