import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { emptyCodexExecutionAssignmentValues } from "../../shared/codex-execution-assignments";
import type { CodexGateway } from "../codex-runtime/CodexGateway";
import { makeReadyCodexExecutionAssignments } from "./CodexExecutionAssignments.test-support";
import { CodexGitProbe } from "./CodexGitProbe";
import {
  materializeCodexDesktopDeveloperInstructions,
  materializeCodexThreadRequestSettings,
} from "./CodexThreadRequestSettings";

const experimentalFeature = (name: string, enabled: boolean) => ({
  name,
  stage: "underDevelopment" as const,
  displayName: null,
  description: null,
  announcement: null,
  enabled,
  defaultEnabled: false,
});

const gitProbe = (
  isNonGitWorkspaceOnHost: CodexGitProbe["Service"]["isNonGitWorkspaceOnHost"] = () =>
    Effect.succeed(false),
): CodexGitProbe["Service"] =>
  CodexGitProbe.of({
    readPath: () => Effect.succeed(null),
    isNonGitWorkspace: () => Effect.succeed(false),
    isNonGitWorkspaceOnHost,
  });

it.effect(
  "discovers workspace dependencies through paginated app-server features and caches it",
  () =>
    Effect.gen(function* () {
      const featureRequests: Array<{ cursor: string | null; limit: number }> = [];
      const gateway = {
        localHostId: "local",
        requestOnHost: (_hostId: string, method: string, params: Record<string, unknown>) => {
          if (method === "config/read") {
            return Effect.succeed({ config: {}, origins: {}, layers: null });
          }
          if (method !== "experimentalFeature/list") return Effect.die(`Unexpected ${method}`);
          const cursor = (params.cursor as string | null) ?? null;
          featureRequests.push({ cursor, limit: params.limit as number });
          return Effect.succeed(
            cursor === null
              ? { data: [], nextCursor: "page-2" }
              : {
                  data: [experimentalFeature("workspace_dependencies", true)],
                  nextCursor: null,
                },
          );
        },
      } as unknown as CodexGateway["Service"];
      const assignments = makeReadyCodexExecutionAssignments({ workspace_dependencies: false });
      const input = {
        hostId: "local",
        model: "gpt-test",
        cwd: "/workspace",
        includeDeveloperInstructions: true,
        isNonGitWorkspace: false,
      } as const;

      const first = yield* materializeCodexThreadRequestSettings(
        input,
        assignments,
        gateway,
        gitProbe(),
      );
      assert.include(first?.developerInstructions ?? "", "### Workspace Dependencies");
      assert.deepEqual(featureRequests, [
        { cursor: null, limit: 100 },
        { cursor: "page-2", limit: 100 },
      ]);

      yield* materializeCodexThreadRequestSettings(input, assignments, gateway, gitProbe());
      assert.lengthOf(featureRequests, 2);

      const changedAssignments = makeReadyCodexExecutionAssignments({
        workspace_dependencies: true,
      });
      yield* materializeCodexThreadRequestSettings(input, changedAssignments, gateway, gitProbe());
      assert.deepEqual(featureRequests.slice(2), [
        { cursor: null, limit: 100 },
        { cursor: "page-2", limit: 100 },
      ]);
    }),
);

it.effect("resolves host personality before model personality and the remote default", () =>
  Effect.gen(function* () {
    const assignments = makeReadyCodexExecutionAssignments(
      {},
      {
        values: {
          ...emptyCodexExecutionAssignmentValues(),
          personality: { default_personality: "friendly" },
        },
      },
    );
    const read = (config: Readonly<Record<string, unknown>>) =>
      materializeCodexThreadRequestSettings(
        {
          hostId: "local",
          model: "gpt-test",
          cwd: "/workspace",
          includeDeveloperInstructions: false,
          isNonGitWorkspace: false,
        },
        assignments,
        {
          localHostId: "local",
          requestOnHost: () => Effect.succeed({ config, origins: {}, layers: null }),
        } as unknown as CodexGateway["Service"],
        gitProbe(),
      );

    assert.strictEqual(
      (yield* read({ personality: "pragmatic", model_personality: "none" }))?.personality,
      "pragmatic",
    );
    assert.strictEqual((yield* read({ model_personality: "pragmatic" }))?.personality, "pragmatic");
    assert.strictEqual((yield* read({}))?.personality, "friendly");
  }),
);

it.effect("omits Git guidance after resolving a non-Git workspace on the target host", () =>
  Effect.gen(function* () {
    const methods: string[] = [];
    const probeCalls: Array<{ hostId: string; cwd: string }> = [];
    const gateway = {
      localHostId: "local",
      requestOnHost: (hostId: string, method: string) => {
        methods.push(`${hostId}:${method}`);
        if (method === "experimentalFeature/list") {
          return Effect.succeed({ data: [], nextCursor: null });
        }
        return Effect.die(`Unexpected ${method}`);
      },
    } as unknown as CodexGateway["Service"];
    const assignments = makeReadyCodexExecutionAssignments(
      {},
      {
        gitSettings: {
          branchPrefix: "codex/",
          commitInstructions: "Commit carefully.",
          pullRequestInstructions: "Keep the PR focused.",
        },
      },
    );

    const instructions = yield* materializeCodexDesktopDeveloperInstructions(
      {
        hostId: "ssh:builder",
        model: "gpt-test",
        cwd: "/remote/workspace",
      },
      assignments,
      gateway,
      gitProbe((hostId, cwd) => {
        probeCalls.push({ hostId, cwd });
        return Effect.succeed(true);
      }),
    );

    assert.notInclude(instructions ?? "", "### Git");
    assert.deepEqual(methods, ["ssh:builder:experimentalFeature/list"]);
    assert.deepEqual(probeCalls, [{ hostId: "ssh:builder", cwd: "/remote/workspace" }]);
  }),
);

it.effect("uses an explicit Git-workspace classification without probing the execution host", () =>
  Effect.gen(function* () {
    const methods: string[] = [];
    const gateway = {
      localHostId: "local",
      requestOnHost: (_hostId: string, method: string) => {
        methods.push(method);
        if (method === "experimentalFeature/list") {
          return Effect.succeed({ data: [], nextCursor: null });
        }
        return Effect.die(`Unexpected ${method}`);
      },
    } as unknown as CodexGateway["Service"];
    const assignments = makeReadyCodexExecutionAssignments(
      {},
      {
        gitSettings: {
          branchPrefix: "codex/",
          commitInstructions: "",
          pullRequestInstructions: "",
        },
      },
    );

    const instructions = yield* materializeCodexDesktopDeveloperInstructions(
      {
        hostId: "local",
        model: "gpt-test",
        cwd: "/workspace",
        isNonGitWorkspace: false,
      },
      assignments,
      gateway,
      gitProbe(() => Effect.die("Git probe should not run")),
    );

    assert.include(instructions ?? "", "### Git");
    assert.deepEqual(methods, ["experimentalFeature/list"]);
  }),
);
