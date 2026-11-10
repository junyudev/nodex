import { DEFAULT_CODEX_HOST_ID } from "../../../shared/codex-host";
import { useEffect, useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  projectIdFromContentRoutingContext,
  type ContentRoutingContext,
} from "../../../shared/content-routing-context";
import { localProjectSourceRoots } from "../../../shared/project-sources";
import { isSkillMentionName } from "../../../shared/rich-text/skill-mention";
import {
  codexComposerSkillsListQueryOptions,
  projectDetailQueryOptions,
} from "@/lib/query-options";
import { agentBackendRuntime } from "@/lib/agent-backend-runtime";
import { agentRuntimeProvidersQueryOptions } from "@/lib/use-agent-runtime-providers";
import { readClaudeAgentSettings } from "@/lib/workbench-settings-runtime";
import { isRemoteSpace, spaceQueryKey } from "@/lib/renderer-space";
import { resolveRendererTransport } from "@/lib/renderer-transport";
import { humanizeComposerSkillName } from "@/lib/skill-mention-presentation";

export interface PageSkillLocation {
  readonly path: string;
  readonly hostId: string;
  readonly provider: "Codex" | "Claude";
  readonly scope: string;
}

interface SkillSource extends PageSkillLocation {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  readonly iconUrl?: string | null;
  readonly brandColor?: string | null;
}

export interface PageSkillMention {
  readonly name: string;
  readonly displayName: string;
  readonly description?: string;
  readonly iconUrl?: string | null;
  readonly brandColor?: string | null;
  readonly locations: readonly PageSkillLocation[];
}

export function groupPageSkillMentions(sources: readonly SkillSource[]): PageSkillMention[] {
  const grouped = new Map<string, SkillSource[]>();
  for (const skill of sources) {
    if (!isSkillMentionName(skill.name) || !/(?:^|[\\/])SKILL\.md$/u.test(skill.path)) continue;
    const entries = grouped.get(skill.name) ?? [];
    if (
      entries.some(
        (entry) =>
          entry.path === skill.path &&
          entry.hostId === skill.hostId &&
          entry.provider === skill.provider,
      )
    )
      continue;
    entries.push(skill);
    grouped.set(skill.name, entries);
  }
  return Array.from(grouped, ([name, locations]) => {
    const first = locations[0]!;
    return {
      name,
      displayName: first.displayName?.trim() || humanizeComposerSkillName(name),
      description: first.description,
      iconUrl: first.iconUrl,
      brandColor: first.brandColor,
      locations,
    };
  }).sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName) || left.name.localeCompare(right.name),
  );
}

export const pageSkillLocationLabel = ({ provider, scope }: PageSkillLocation) =>
  `${provider} · ${scope}`;

export const pageSkillLocationsLabel = (locations: readonly PageSkillLocation[]) =>
  [...new Set(locations.map(pageSkillLocationLabel))].join(" / ");

function scopeLabel(scope: string | undefined, path: string, roots: readonly string[]) {
  if (scope === "system") return "System";
  if (scope === "admin") return "Admin installed";
  const normalizedPath = path.replaceAll("\\", "/");
  const root = roots.find((root) =>
    normalizedPath.startsWith(`${root.replaceAll("\\", "/").replace(/\/+$/u, "")}/`),
  );
  if (scope === "repo" || (!scope && root))
    return root?.split(/[\\/]/u).filter(Boolean).at(-1) ?? "Project";
  return "Personal";
}

const settingsKey = () => spaceQueryKey(["page-skill-mentions", "claude-settings"] as const);
const claudeKey = () => spaceQueryKey(["page-skill-mentions", "claude"] as const);

function useLocalClaudeSkills(
  projectId: string | null,
  roots: readonly string[],
  enabled: boolean,
) {
  const client = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    return resolveRendererTransport().subscribeClaudeAgentSettingsChanges(() => {
      void client.invalidateQueries({ queryKey: settingsKey() });
      void client.invalidateQueries({ queryKey: claudeKey() });
    });
  }, [client, enabled]);
  const settings = useQuery({
    queryKey: settingsKey(),
    queryFn: readClaudeAgentSettings,
    staleTime: 60_000,
    enabled,
  });
  const scopes = [
    { projectId: null },
    ...roots.map((sourceDirectory) => ({ projectId, sourceDirectory })),
  ];
  return useQueries({
    queries: enabled
      ? (settings.data?.instances ?? [])
          .filter((instance) => instance.enabled)
          .flatMap((instance) =>
            scopes.map((scope) => ({
              queryKey: [
                ...claudeKey(),
                instance.id,
                scope.projectId,
                "sourceDirectory" in scope ? scope.sourceDirectory : null,
              ],
              queryFn: ({ signal }: { signal: AbortSignal }) =>
                agentBackendRuntime.claudeDiscovery(
                  {
                    scope: { ...scope, kind: "project", instanceConfigId: instance.id },
                  },
                  signal,
                ),
              staleTime: 60_000,
              retry: false,
            })),
          )
      : [],
    combine: (results) =>
      results.flatMap(
        ({ data }) => data?.skills.filter((skill) => skill.enabled && skill.userInvocable) ?? [],
      ),
  });
}

/** The Page routing context determines the roots. A beside chat's cwd is independent. */
export function usePageSkillMentions(
  context: ContentRoutingContext,
  hostId: string,
  enabled: boolean,
): readonly PageSkillMention[] {
  const projectId = projectIdFromContentRoutingContext(context);
  const remote = isRemoteSpace();
  const candidateHostId = remote ? hostId : DEFAULT_CODEX_HOST_ID;
  const project = useQuery({
    ...projectDetailQueryOptions(projectId ?? ""),
    enabled: enabled && !!projectId,
  });
  const roots = useMemo(
    () =>
      project.data?.lifecycle === "active" ? localProjectSourceRoots(project.data.sources) : [],
    [project.data],
  );
  const codex = useQuery({
    ...codexComposerSkillsListQueryOptions(roots, candidateHostId),
    enabled: enabled && !remote,
  });
  const claude = useLocalClaudeSkills(projectId, roots, enabled && !remote);
  const hosted = useQuery({ ...agentRuntimeProvidersQueryOptions(), enabled: enabled && remote });
  return useMemo(
    () =>
      groupPageSkillMentions([
        ...(remote
          ? []
          : (codex.data ?? [])
              .filter((skill) => roots.length > 0 || skill.scope !== "repo")
              .map((skill): SkillSource => ({
                ...skill,
                provider: "Codex",
                hostId: candidateHostId,
                scope: scopeLabel(skill.scope, skill.path, roots),
              }))),
        ...claude.map((skill): SkillSource => ({
          ...skill,
          provider: "Claude",
          hostId: candidateHostId,
          scope: scopeLabel(undefined, skill.path, roots),
        })),
        ...(hosted.data ?? []).flatMap((agent): SkillSource[] => {
          if (
            !remote ||
            !agent.enabled ||
            (agent.driver !== "codex" && agent.driver !== "claudeAgent")
          )
            return [];
          const provider = agent.driver === "codex" ? "Codex" : "Claude";
          const skills = [
            ...agent.skills.filter((skill) => skill.scope !== "repo" && skill.scope !== "project"),
            ...(agent.workspaceSnapshots ?? [])
              .filter(({ cwd }) => roots.includes(cwd))
              .flatMap(({ skills }) => skills),
          ];
          return skills
            .filter((skill) => skill.enabled && skill.userInvocable !== false)
            .map((skill) => ({
              ...skill,
              provider,
              hostId: candidateHostId,
              scope:
                skill.scope === "project"
                  ? scopeLabel("repo", skill.path, roots)
                  : scopeLabel(skill.scope, skill.path, roots),
            }));
        }),
      ]),
    [candidateHostId, claude, codex.data, hosted.data, remote, roots],
  );
}
