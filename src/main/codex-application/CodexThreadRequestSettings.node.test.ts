import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { CODEX_DESKTOP_THREAD_FEATURE_CONFIG } from "../codex/codex-thread-config";
import type { CodexGateway } from "../codex-runtime/CodexGateway";
import { makeTestApplicationSettings } from "../settings/ApplicationSettings.test-support";
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

it.effect("uses paginated app-server experimental features as workspace-dependency authority", () =>
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

    const materialized = yield* materializeCodexThreadRequestSettings(
      {
        hostId: "local",
        cwd: "/workspace",
        includeDeveloperInstructions: true,
        isNonGitWorkspace: false,
      },
      makeTestApplicationSettings(),
      gateway,
      gitProbe(),
    );

    assert.include(materialized?.developerInstructions ?? "", "### Workspace Dependencies");
    assert.deepEqual(featureRequests, [
      { cursor: null, limit: 100 },
      { cursor: "page-2", limit: 100 },
    ]);
  }),
);

it.effect("resolves host personality before model personality and then friendly", () =>
  Effect.gen(function* () {
    const read = (config: Readonly<Record<string, unknown>>) =>
      materializeCodexThreadRequestSettings(
        {
          hostId: "local",
          cwd: "/workspace",
          includeDeveloperInstructions: false,
          isNonGitWorkspace: false,
        },
        makeTestApplicationSettings(),
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

it.effect("uses ApplicationSettings Git policy and target-host workspace classification", () =>
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

    const instructions = yield* materializeCodexDesktopDeveloperInstructions(
      { hostId: "ssh:builder", cwd: "/remote/workspace" },
      makeTestApplicationSettings({
        branchPrefix: "nodex/",
        commitInstructions: "Commit carefully.",
        pullRequestInstructions: "Keep the PR focused.",
      }),
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
    const gateway = {
      localHostId: "local",
      requestOnHost: (_hostId: string, method: string) =>
        method === "experimentalFeature/list"
          ? Effect.succeed({ data: [], nextCursor: null })
          : Effect.die(`Unexpected ${method}`),
    } as unknown as CodexGateway["Service"];

    const instructions = yield* materializeCodexDesktopDeveloperInstructions(
      { hostId: "local", cwd: "/workspace", isNonGitWorkspace: false },
      makeTestApplicationSettings({ branchPrefix: "codex/" }),
      gateway,
      gitProbe(() => Effect.die("Git probe should not run")),
    );

    assert.include(instructions ?? "", "### Git");
    assert.include(instructions ?? "", "Branch prefix: `codex/`");
  }),
);

it.effect("never imports unknown host or experimental features into execution config", () =>
  Effect.gen(function* () {
    const gateway = {
      localHostId: "local",
      requestOnHost: (_hostId: string, method: string) => {
        if (method === "config/read") {
          return Effect.succeed({
            config: {
              "features.remote_surprise": true,
              "features.unified_exec": true,
            },
            origins: {},
            layers: null,
          });
        }
        if (method === "experimentalFeature/list") {
          return Effect.succeed({
            data: [experimentalFeature("remote_surprise", true)],
            nextCursor: null,
          });
        }
        return Effect.die(`Unexpected ${method}`);
      },
    } as unknown as CodexGateway["Service"];

    const materialized = yield* materializeCodexThreadRequestSettings(
      {
        hostId: "local",
        cwd: "/workspace",
        includeDeveloperInstructions: true,
        isNonGitWorkspace: false,
      },
      makeTestApplicationSettings(),
      gateway,
      gitProbe(),
    );

    assert.deepEqual(materialized?.config, CODEX_DESKTOP_THREAD_FEATURE_CONFIG);
    assert.notProperty(materialized?.config ?? {}, "features.remote_surprise");
    assert.notProperty(materialized?.config ?? {}, "features.unified_exec");
  }),
);

it.effect("adds writing-block instructions only for the product prose detail setting", () =>
  Effect.gen(function* () {
    const gateway = {
      localHostId: "local",
      requestOnHost: (_hostId: string, method: string) => {
        if (method === "config/read") {
          return Effect.succeed({ config: {}, origins: {}, layers: null });
        }
        if (method === "experimentalFeature/list") {
          return Effect.succeed({ data: [], nextCursor: null });
        }
        return Effect.die(`Unexpected ${method}`);
      },
    } as unknown as CodexGateway["Service"];
    const input = {
      hostId: "local",
      cwd: "/workspace",
      includeDeveloperInstructions: true,
      isNonGitWorkspace: false,
    } as const;

    const prose = yield* materializeCodexThreadRequestSettings(
      input,
      makeTestApplicationSettings({ detailLevel: "STEPS_PROSE" }),
      gateway,
      gitProbe(),
    );
    const commands = yield* materializeCodexThreadRequestSettings(
      input,
      makeTestApplicationSettings({ detailLevel: "STEPS_COMMANDS" }),
      gateway,
      gitProbe(),
    );

    assert.include(prose?.developerInstructions ?? "", "### Writing blocks");
    assert.notInclude(commands?.developerInstructions ?? "", "### Writing blocks");
    assert.notInclude(prose?.developerInstructions ?? "", "### Task title checkpoints");
    assert.notInclude(
      prose?.developerInstructions ?? "",
      "### Presentation outline writing blocks",
    );
  }),
);
