import { renderHook, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { TestQueryProvider } from "@/test/query";
import {
  libraryContentRoute,
  projectContentRoute,
  type ContentRoutingContext,
} from "../../../shared/content-routing-context";
import { usePageSkillMentions } from "./use-page-skill-mentions";

const ports = vi.hoisted(() => ({
  codex: vi.fn(async (roots: readonly string[]) => [
    {
      name: "review",
      displayName: "Review",
      scope: "user",
      path: "/home/.agents/skills/review/SKILL.md",
    },
    ...roots.map((root) => ({
      name: "review",
      scope: "repo",
      path: `${root}/.agents/skills/review/SKILL.md`,
    })),
  ]),
  claude: vi.fn(async ({ scope }: { scope: { sourceDirectory?: string } }) => ({
    skills: [
      {
        name: "review",
        enabled: true,
        userInvocable: true,
        path: `${scope.sourceDirectory ?? "/home"}/.claude/skills/review/SKILL.md`,
      },
      {
        name: "disabled",
        enabled: false,
        userInvocable: true,
        path: "/home/.claude/skills/disabled/SKILL.md",
      },
      {
        name: "agent-only",
        enabled: true,
        userInvocable: false,
        path: "/home/.claude/skills/agent-only/SKILL.md",
      },
    ],
  })),
}));
vi.mock("@/lib/query-options", () => ({
  projectDetailQueryOptions: (projectId: string) => ({
    queryKey: ["project", projectId],
    queryFn: async () => ({
      lifecycle: "active",
      sources: [
        { kind: "directory", path: "/work/api" },
        { kind: "directory", path: "/work/web" },
        { kind: "repository", remote: "https://example.test/repo" },
      ],
    }),
  }),
  codexComposerSkillsListQueryOptions: (roots: readonly string[], hostId: string) => ({
    queryKey: ["codex", hostId, ...roots],
    queryFn: () => ports.codex(roots),
  }),
}));
vi.mock("@/lib/agent-backend-runtime", () => ({
  agentBackendRuntime: { claudeDiscovery: ports.claude },
}));
vi.mock("@/lib/workbench-settings-runtime", () => ({
  readClaudeAgentSettings: async () => ({ instances: [{ id: "claude", enabled: true }] }),
}));
vi.mock("@/lib/renderer-transport", () => ({
  resolveRendererTransport: () => ({ subscribeClaudeAgentSettingsChanges: () => () => {} }),
}));

test("merges personal and Project skills by name and fences inventory when the Page route changes", async () => {
  const initialProps: { context: ContentRoutingContext } = {
    context: projectContentRoute("project"),
  };
  const { result, rerender } = renderHook(
    ({ context }: { context: ContentRoutingContext }) =>
      usePageSkillMentions(context, "local", true),
    { wrapper: TestQueryProvider, initialProps },
  );
  await waitFor(() => expect(result.current[0]?.locations).toHaveLength(6));
  expect(result.current.map(({ name }) => name)).toEqual(["review"]);
  expect(result.current[0]?.locations.map(({ provider, scope }) => [provider, scope])).toEqual([
    ["Codex", "Personal"],
    ["Codex", "api"],
    ["Codex", "web"],
    ["Claude", "Personal"],
    ["Claude", "api"],
    ["Claude", "web"],
  ]);
  expect(ports.codex).toHaveBeenCalledWith(["/work/api", "/work/web"]);

  rerender({ context: libraryContentRoute });
  await waitFor(() => expect(result.current[0]?.locations).toHaveLength(2));
  expect(result.current[0]?.locations.every(({ scope }) => scope === "Personal")).toBe(true);
});
