import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Exit from "effect/Exit";
import * as ScopedCache from "effect/ScopedCache";
import * as Semaphore from "effect/Semaphore";
import { compareSemverVersions } from "../../../packages/agent-runtime/vendor/shared/src/semver";
import {
  LOCAL_AGENTS,
  type LocalAgentDefinition,
  type LocalAgentFound,
  type LocalAgentScan,
  type LocalAgentScanOptions,
} from "../../shared/local-agents";
import { LocalAgentDiscoveryPlatform } from "../platform/node/LocalAgentDiscoveryPlatform";

export class LocalAgentDiscovery extends Context.Service<
  LocalAgentDiscovery,
  { readonly scan: (options?: LocalAgentScanOptions) => Effect.Effect<LocalAgentScan> }
>()("nodex/main/host-runtime/LocalAgentDiscovery") {}

const semver =
  /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[\da-z-]+(?:\.[\da-z-]+)*)?(?:\+[\da-z-]+(?:\.[\da-z-]+)*)?)$/iu;

type VersionEvidence =
  | { readonly status: "unrelated" | "unknown" }
  | { readonly status: "known"; readonly version: string };

const readVersionEvidence = (raw: string | null, agent: LocalAgentDefinition): VersionEvidence => {
  const output = raw?.trim() ?? "";
  if (agent.unrelatedVersionPattern?.test(output)) return { status: "unrelated" };
  const [first = "", second, ...rest] = output.split(/[^\S\r\n]+/u);
  const candidate = second === undefined ? first : agent.commands.includes(first) ? second : "";
  const match = agent.versionPattern
    ? agent.versionPattern.exec(output)?.[1]
    : rest.length === 0
      ? candidate
      : undefined;
  const version = match && semver.exec(match)?.[1];
  return version ? { status: "known", version } : { status: "unknown" };
};

const compareVersions = (left: string, right: string) =>
  compareSemverVersions(left.split("+", 1)[0]!, right.split("+", 1)[0]!);

function bestCandidate(candidates: readonly LocalAgentFound[]): LocalAgentFound | undefined {
  return (
    candidates.find(({ version, supported }) => version !== null && supported) ??
    candidates.reduce<LocalAgentFound | undefined>((best, candidate) => {
      if (candidate.version === null) return best ?? candidate;
      if (best?.version && compareVersions(best.version, candidate.version) >= 0) return best;
      return candidate;
    }, undefined)
  );
}

export const live = Layer.effect(
  LocalAgentDiscovery,
  Effect.gen(function* () {
    const platform = yield* LocalAgentDiscoveryPlatform;
    const probe = (agent: LocalAgentDefinition) =>
      platform.select(
        { ...agent, windowsKind: "native" },
        (candidates, environment) =>
          Effect.forEach(
            candidates,
            Effect.fnUntraced(function* ({ path: executable }) {
              const evidence = readVersionEvidence(
                yield* platform.readVersion(executable, environment),
                agent,
              );
              if (evidence.status === "unrelated") return [];
              const version = evidence.status === "known" ? evidence.version : null;
              return [
                {
                  id: agent.id,
                  executable,
                  version,
                  supported:
                    version === null || compareVersions(version, agent.minimumVersion) >= 0,
                } satisfies LocalAgentFound,
              ];
            }),
            { concurrency: 6 },
          ).pipe(Effect.map((results) => bestCandidate(results.flat()))),
        (result) => result !== undefined && result.supported && result.version !== null,
      );
    const cache = yield* ScopedCache.makeWith<undefined, LocalAgentScan>({
      capacity: 1,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value.agents.length ? "30 seconds" : "0 seconds",
      lookup: () =>
        Effect.forEach(LOCAL_AGENTS, probe, { concurrency: "unbounded" }).pipe(
          Effect.map((results) => ({ agents: results.filter((result) => result !== undefined) })),
        ),
    });

    const refresh = (yield* Semaphore.make(1)).withPermits(1)(
      ScopedCache.refresh(cache, undefined),
    );
    return LocalAgentDiscovery.of({
      scan: (options) => (options?.fresh ? refresh : ScopedCache.get(cache, undefined)),
    });
  }),
);
