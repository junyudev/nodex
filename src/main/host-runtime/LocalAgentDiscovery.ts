import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ScopedCache from "effect/ScopedCache";
import { compareSemverVersions } from "../../../packages/agent-runtime/vendor/shared/src/semver";
import { LOCAL_AGENTS, type LocalAgentFound, type LocalAgentScan } from "../../shared/local-agents";
import { LocalAgentDiscoveryPlatform } from "../platform/node/LocalAgentDiscoveryPlatform";

export class LocalAgentDiscovery extends Context.Service<
  LocalAgentDiscovery,
  { readonly scan: Effect.Effect<LocalAgentScan> }
>()("nodex/main/host-runtime/LocalAgentDiscovery") {}

const parseVersion = (output: string | null, commands: readonly string[]): string | null => {
  if (!output) return null;
  const [first = "", second, ...rest] = output.trim().split(/\s+/u);
  const candidate = second === undefined ? first : commands.includes(first) ? second : "";
  if (rest.length > 0) return null;
  return (
    /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?)$/iu.exec(
      candidate,
    )?.[1] ?? null
  );
};

export const live = Layer.effect(
  LocalAgentDiscovery,
  Effect.gen(function* () {
    const platform = yield* LocalAgentDiscoveryPlatform;
    const probe = Effect.fnUntraced(function* (agent: (typeof LOCAL_AGENTS)[number]) {
      const executable = yield* platform.findExecutable(agent);
      if (!executable) return null;
      const version = parseVersion(yield* platform.readVersion(executable), agent.commands);
      return {
        id: agent.id,
        executable,
        version,
        supported:
          version === null ||
          compareSemverVersions(version.split("+", 1)[0]!, agent.minimumVersion) >= 0,
      } satisfies LocalAgentFound;
    });
    const cache = yield* ScopedCache.make<undefined, LocalAgentScan>({
      capacity: 1,
      timeToLive: "30 seconds",
      lookup: () =>
        Effect.forEach(LOCAL_AGENTS, probe).pipe(
          Effect.map((results) => ({ agents: results.filter((result) => result !== null) })),
        ),
    });

    return LocalAgentDiscovery.of({ scan: ScopedCache.get(cache, undefined) });
  }),
);
