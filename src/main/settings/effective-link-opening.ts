import * as Effect from "effect/Effect";
import type {
  EffectiveLinkOpeningSettings,
  LinkOpeningSettings,
} from "../../shared/link-opening-settings";
import type { ProjectWorkspaceReadSnapshot } from "../core-client/types";
import type { CoreModules } from "../core-runtime/CoreModules";

export function readEffectiveLinkOpeningSettings(input: {
  readonly preferences: LinkOpeningSettings;
  readonly activeSpaceId: string | undefined;
  readonly personalSpaceId: string;
  readonly workspace: Pick<CoreModules["Service"]["workspace"], "read">;
}): Effect.Effect<EffectiveLinkOpeningSettings> {
  const { preferences, activeSpaceId, personalSpaceId, workspace } = input;
  const defaults = { ...preferences, nativeGitHubHosts: [] };
  if (
    !preferences.openGitHubThreadsInNodex ||
    (activeSpaceId ?? personalSpaceId) !== personalSpaceId
  )
    return Effect.succeed(defaults);

  // Source configuration is enough to choose a destination. This does not verify credentials or poll GitHub.
  return Effect.gen(function* () {
    const hosts = new Set<string>();
    let afterId: string | null = null;
    while (true) {
      const snapshot: ProjectWorkspaceReadSnapshot = yield* workspace.read(
        { kind: "sources", read: { kind: "sources", after_id: afterId, limit: 100 } },
        undefined,
        null,
      );
      if (snapshot.value.kind !== "sources" || snapshot.value.value.kind !== "sources") break;
      const { sources } = snapshot.value.value;
      for (const source of sources) {
        if (source.kind === "github") hosts.add(source.config.host.toLowerCase());
      }
      if (sources.length < 100) break;
      afterId = sources.at(-1)!.id;
    }
    return { ...preferences, nativeGitHubHosts: [...hosts] };
  }).pipe(Effect.catch(() => Effect.succeed(defaults)));
}
