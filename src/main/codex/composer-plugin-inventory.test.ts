import { describe, expect, test, afterEach } from "vite-plus/test";
import type {
  PluginInterface,
  PluginMarketplaceEntry,
  PluginSummary,
} from "@nodex/codex-app-server-protocol/v2";
import {
  buildComposerPluginInventory,
  resolveComposerPluginActivation,
} from "../../shared/codex-composer-plugin-inventory";
import type { SkillsListResponse } from "@nodex/codex-app-server-protocol/v2/SkillsListResponse";
import {
  buildComposerSkillInventory,
  hydrateComposerSkillInventoryIcons,
} from "./composer-skill-inventory";
import {
  readCodexThreadUuidV7TimestampMs,
  reconcileCodexThreadTimestamps,
} from "./codex-thread-timestamps";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  codexClientThreadIdentityAtomKey,
  getCodexClientThreadId,
  listCodexClientThreadIdentities,
  resolveCodexThreadIdForClientThreadId,
  setCodexClientThreadIdentity,
  readCodexClientThreadIdentityCandidates,
} from "./codex-client-thread-identity";
import { PersistedAtomStore } from "../local-store/persisted-atoms";
import {
  parseCodexDynamicCreateThreadInput,
  projectCodexDynamicCreateModel,
  validateCodexDynamicCreateModelReasoning,
} from "./codex-dynamic-thread-create";
import {
  mkdtempSync as mkdtempSyncartifacttemplatepicker,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir as tmpdirartifacttemplatepicker } from "node:os";
import path from "node:path";
import type { SkillMetadata } from "@nodex/codex-app-server-protocol/v2/SkillMetadata";
import {
  buildArtifactTemplatePickerConfig,
  resolveArtifactTemplatePickerRuntime,
} from "./artifact-template-picker";
import {
  evaluateCodexThreadHandoffCapability,
  supportsCodexThreadHandoffRuntimeVersion,
  type CodexThreadHandoffCapabilityInput,
} from "./codex-thread-handoff-capability";

describe("composer-plugin-inventory", () => {
  describe("composer-plugin-inventory", () => {
    function createPlugin(
      overrides: Partial<PluginSummary> & Pick<PluginSummary, "id" | "name">,
    ): PluginSummary {
      const { id, name, interface: interfaceOverrides, ...remainingOverrides } = overrides;
      const pluginInterface: PluginInterface = {
        displayName: null,
        shortDescription: null,
        longDescription: null,
        developerName: null,
        category: null,
        capabilities: [],
        websiteUrl: null,
        privacyPolicyUrl: null,
        termsOfServiceUrl: null,
        defaultPrompt: null,
        brandColor: null,
        composerIcon: null,
        composerIconUrl: null,
        logo: null,
        logoDark: null,
        logoUrl: null,
        logoUrlDark: null,
        screenshots: [],
        screenshotUrls: [],
        ...interfaceOverrides,
      };

      return {
        id,
        name,
        remotePluginId: null,
        version: null,
        localVersion: null,
        shareContext: null,
        source: { type: "remote" },
        installed: true,
        installedAt: null,
        enabled: true,
        installPolicy: "AVAILABLE",
        installPolicySource: null,
        mustShowInstallationInterstitial: null,
        authPolicy: "ON_USE",
        availability: "AVAILABLE",
        disabledReason: null,
        eligiblePlanTypes: null,
        keywords: [],
        ...remainingOverrides,
        interface: pluginInterface,
      };
    }

    function createMarketplace(name: string, plugins: PluginSummary[]): PluginMarketplaceEntry {
      return {
        name,
        path: null,
        interface: null,
        plugins,
      };
    }

    describe("composer plugin inventory", () => {
      test("exposes requested local install entrypoints without bypassing policy", () => {
        const response = {
          marketplaces: [
            createMarketplace("openai-bundled", [
              createPlugin({
                id: "browser@openai-bundled",
                name: "browser",
                installed: false,
                enabled: false,
              }),
              createPlugin({
                id: "computer-use@openai-bundled",
                name: "computer-use",
                installed: false,
                enabled: false,
                availability: "DISABLED_BY_ADMIN",
              }),
              createPlugin({
                id: "installed-disabled@example",
                name: "installed-disabled",
                installed: true,
                enabled: false,
              }),
              createPlugin({
                id: "record-and-replay@openai-bundled",
                name: "record-and-replay",
                installed: true,
                enabled: false,
              }),
            ]),
          ],
        };

        expect(buildComposerPluginInventory(response)).toEqual([]);
        expect(
          buildComposerPluginInventory(response, {
            installSuggestionPluginNames: [
              "browser",
              "computer-use",
              "installed-disabled",
              "record-and-replay",
            ],
          }),
        ).toEqual([
          expect.objectContaining({
            id: "browser@openai-bundled",
            name: "Browser",
            path: "plugin://browser@openai-bundled",
          }),
          expect.objectContaining({
            id: "record-and-replay@openai-bundled",
            name: "record-and-replay",
            installed: true,
            enabled: false,
          }),
        ]);
      });

      test("rejects activation when policy or installed state blocks it", () => {
        const response = {
          marketplaces: [
            createMarketplace("openai-bundled", [
              createPlugin({
                id: "admin-disabled@openai-bundled",
                name: "admin-disabled",
                installed: false,
                enabled: false,
                availability: "DISABLED_BY_ADMIN",
              }),
              createPlugin({
                id: "user-disabled@openai-bundled",
                name: "user-disabled",
                enabled: false,
              }),
              createPlugin({
                id: "record-and-replay@openai-bundled",
                name: "record-and-replay",
                enabled: false,
              }),
            ]),
          ],
        };

        expect(() =>
          resolveComposerPluginActivation(response, "admin-disabled@openai-bundled"),
        ).toThrow("disabled by your administrator");
        expect(() =>
          resolveComposerPluginActivation(response, "user-disabled@openai-bundled"),
        ).toThrow("installed but disabled");
        expect(
          resolveComposerPluginActivation(response, "record-and-replay@openai-bundled"),
        ).toEqual({
          kind: "enable",
          params: {
            edits: [
              {
                keyPath: "plugins.record-and-replay@openai-bundled.enabled",
                value: true,
                mergeStrategy: "upsert",
              },
            ],
            filePath: null,
            expectedVersion: null,
            reloadUserConfig: true,
          },
        });
        expect(() => resolveComposerPluginActivation(response, "missing@openai-bundled")).toThrow(
          "no longer available",
        );
      });
    });
  });

  describe("composer-skill-inventory", () => {
    describe("buildComposerSkillInventory", () => {
      test("hydrates local skill icons through app://fs", async () => {
        const response: SkillsListResponse = {
          data: [
            {
              cwd: "/repo",
              errors: [],
              skills: [
                {
                  name: "Browser",
                  description: "Control a browser",
                  interface: {
                    iconSmall: "/skills/browser/icon.svg",
                    iconSmallUrl: null,
                    iconLargeUrl: null,
                    brandColor: "#4b8df8",
                  },
                  path: "/skills/browser/SKILL.md",
                  scope: "system",
                  enabled: true,
                  pluginId: null,
                },
              ],
            },
          ],
        };

        const inventory = await hydrateComposerSkillInventoryIcons(
          response,
          buildComposerSkillInventory(response),
          (filePath) => `app://fs/@fs${filePath}`,
        );

        expect(inventory).toEqual([
          {
            name: "Browser",
            displayName: "Browser",
            description: "Control a browser",
            iconUrl: "app://fs/@fs/skills/browser/icon.svg",
            brandColor: "#4b8df8",
            path: "/skills/browser/SKILL.md",
            scope: "system",
            pluginId: null,
          },
        ]);
      });
    });
  });
});

describe("codex-thread-identity", () => {
  describe("codex-thread-timestamps", () => {
    describe("Codex Thread timestamp reconciliation", () => {
      test("reads the canonical creation instant from a UUIDv7 Thread id", () => {
        const threadId = "019f2321-8ed9-74d0-a2cc-48856e20cf0c";

        expect(readCodexThreadUuidV7TimestampMs(threadId)).toBe(1_783_000_829_657);
        expect(readCodexThreadUuidV7TimestampMs("thread-custom")).toBeNull();
      });

      test("repairs a historical UTC+8 created timestamp from UUIDv7 evidence", () => {
        expect(
          reconcileCodexThreadTimestamps({
            threadId: "019f2321-8ed9-74d0-a2cc-48856e20cf0c",
            observedCreatedAt: 1_783_029_629,
            observedUpdatedAt: 1_783_000_989,
            existing: null,
          }),
        ).toEqual({
          createdAt: 1_783_000_829_000,
          updatedAt: 1_783_000_989_000,
          recencyAt: 1_783_000_989_000,
        });
      });

      test("uses UUIDv7 creation evidence instead of a later live recency observation", () => {
        expect(
          reconcileCodexThreadTimestamps({
            threadId: "019f8b12-45fe-7e53-a8ba-bd0c0d5b4e88",
            observedCreatedAt: 1_784_744_661,
            observedUpdatedAt: 1_784_744_712,
            existing: null,
          }),
        ).toEqual({
          createdAt: 1_784_744_658_000,
          updatedAt: 1_784_744_712_000,
          recencyAt: 1_784_744_712_000,
        });
      });

      test("keeps an existing durable Thread clock monotonic across stale observations", () => {
        expect(
          reconcileCodexThreadTimestamps({
            threadId: "thread-custom",
            observedCreatedAt: 20,
            observedUpdatedAt: 30,
            existing: {
              createdAt: 10_000,
              updatedAt: 40_000,
              recencyAt: 35_000,
            },
          }),
        ).toEqual({
          createdAt: 10_000,
          updatedAt: 40_000,
          recencyAt: 35_000,
        });
      });

      test("uses one safe boundary when a custom Thread reports an inverted pair", () => {
        expect(
          reconcileCodexThreadTimestamps({
            threadId: "thread-custom",
            observedCreatedAt: 20,
            observedUpdatedAt: 10,
            existing: null,
          }),
        ).toEqual({
          createdAt: 10_000,
          updatedAt: 10_000,
          recencyAt: 10_000,
        });
      });

      test("advances recency only from the app-server recency clock", () => {
        expect(
          reconcileCodexThreadTimestamps({
            threadId: "thread-custom",
            observedCreatedAt: undefined,
            observedUpdatedAt: 50,
            observedRecencyAt: 30,
            existing: {
              createdAt: 10_000,
              updatedAt: 40_000,
              recencyAt: 30_000,
            },
          }),
        ).toEqual({
          createdAt: 10_000,
          updatedAt: 50_000,
          recencyAt: 30_000,
        });
      });
    });
  });

  describe("codex-client-thread-identity", () => {
    const tempDirectories: string[] = [];

    function useTempPersistedAtoms(): PersistedAtomStore {
      const directory = mkdtempSync(join(tmpdir(), "nodex-client-thread-identity-"));
      tempDirectories.push(directory);
      return new PersistedAtomStore(join(directory, "persisted-atoms-v1.json"));
    }

    describe("Codex client-thread identity", () => {
      test("retains host/native colon ambiguity as candidates and keeps explicit-host lookups exact", () => {
        const store = useTempPersistedAtoms();
        const clientThreadId = "client-new-thread:hosted";
        setCodexClientThreadIdentity(store, {
          hostId: "ssh:owner",
          threadId: "native:thread",
          clientThreadId,
        });
        expect(readCodexClientThreadIdentityCandidates(store, clientThreadId, "ssh:owner")).toEqual(
          [{ hostId: "ssh:owner", threadId: "native:thread", clientThreadId }],
        );
        expect(readCodexClientThreadIdentityCandidates(store, clientThreadId)).toEqual([
          { hostId: "ssh", threadId: "owner:native:thread", clientThreadId },
          { hostId: "ssh:owner", threadId: "native:thread", clientThreadId },
          { hostId: "ssh:owner:native", threadId: "thread", clientThreadId },
        ]);
        expect(readCodexClientThreadIdentityCandidates(store, clientThreadId, "foreign")).toEqual(
          [],
        );
      });
      afterEach(() => {
        for (const directory of tempDirectories.splice(0)) {
          rmSync(directory, { recursive: true, force: true });
        }
      });

      test("persists the exact conversation-scoped atom and resolves both directions", async () => {
        const store = useTempPersistedAtoms();
        const clientThreadId = "client-new-thread:11111111-1111-4111-8111-111111111111";

        expect(
          setCodexClientThreadIdentity(store, {
            hostId: "local",
            threadId: "conversation with spaces",
            clientThreadId,
          }),
        ).toBe(true);
        expect(codexClientThreadIdentityAtomKey("local", "conversation with spaces")).toBe(
          "thread-client-id-v1:local%3Aconversation%20with%20spaces",
        );
        await store.whenDurable();
        const replacement = new PersistedAtomStore(
          join(tempDirectories.at(-1)!, "persisted-atoms-v1.json"),
        );
        expect(getCodexClientThreadId(replacement, "local", "conversation with spaces")).toBe(
          clientThreadId,
        );
        expect(resolveCodexThreadIdForClientThreadId(replacement, "local", clientThreadId)).toBe(
          "conversation with spaces",
        );
      });

      test("lists only current conversations and ignores invalid persisted client ids", () => {
        const store = useTempPersistedAtoms();
        setCodexClientThreadIdentity(store, {
          hostId: "local",
          threadId: "current",
          clientThreadId: "client-new-thread:current",
        });
        setCodexClientThreadIdentity(store, {
          hostId: "local",
          threadId: "stale",
          clientThreadId: "client-new-thread:stale",
        });
        store.update({
          key: codexClientThreadIdentityAtomKey("local", "invalid"),
          value: "not-a-client-thread",
        });

        expect(
          JSON.stringify(listCodexClientThreadIdentities(store, "local", ["current", "invalid"])),
        ).toBe(
          '[{"hostId":"local","threadId":"current","clientThreadId":"client-new-thread:current"}]',
        );
        expect(getCodexClientThreadId(store, "local", "invalid")).toBe(null);
      });

      test("rejects blank identities and client ids outside the exact namespace", () => {
        const store = useTempPersistedAtoms();
        expect(
          setCodexClientThreadIdentity(store, {
            hostId: "local",
            threadId: "thread",
            clientThreadId: "thread",
          }),
        ).toBe(false);
        expect(
          setCodexClientThreadIdentity(store, {
            hostId: " ",
            threadId: "thread",
            clientThreadId: "client-new-thread:value",
          }),
        ).toBe(false);
      });
    });
  });
});

describe("Codex dynamic create-thread contract", () => {
  test("preserves accepted scalar whitespace and validates every exact target branch", () => {
    expect(
      JSON.stringify(
        parseCodexDynamicCreateThreadInput({
          prompt: "  delegated prompt  ",
          target: {
            type: "project",
            projectId: " project-id ",
            environment: {
              type: "worktree",
              startingState: { type: "branch", branchName: "feature/exact" },
            },
          },
          model: " gpt-exact ",
          thinking: "ultra",
        }),
      ),
    ).toBe(
      JSON.stringify({
        prompt: "  delegated prompt  ",
        target: {
          type: "project",
          projectId: " project-id ",
          environment: {
            type: "worktree",
            startingState: { type: "branch", branchName: "feature/exact" },
          },
        },
        model: " gpt-exact ",
        thinking: "ultra",
      }),
    );

    expect(
      JSON.stringify(
        parseCodexDynamicCreateThreadInput({
          prompt: "projectless",
          target: { type: "projectless", directoryName: " Deliverables " },
          thinking: "none",
        }),
      ),
    ).toBe(
      JSON.stringify({
        prompt: "projectless",
        target: { type: "projectless", directoryName: " Deliverables " },
        thinking: "none",
      }),
    );
  });

  test("rejects empty scalars, invalid environments, starting states, and efforts", () => {
    expect(
      parseCodexDynamicCreateThreadInput({ prompt: "", target: { type: "projectless" } }),
    ).toBe(null);
    expect(
      parseCodexDynamicCreateThreadInput({
        prompt: "x",
        target: { type: "project", projectId: "p", environment: { type: "cloud" } },
      }),
    ).toBe(null);
    expect(
      parseCodexDynamicCreateThreadInput({
        prompt: "x",
        target: {
          type: "project",
          projectId: "p",
          environment: { type: "worktree", startingState: { type: "branch", branchName: "" } },
        },
      }),
    ).toBe(null);
    expect(
      parseCodexDynamicCreateThreadInput({
        prompt: "x",
        target: {
          type: "project",
          projectId: "p",
          // The worker never accepts a branch name with surrounding whitespace.
          environment: {
            type: "worktree",
            startingState: { type: "branch", branchName: " feature/exact " },
          },
        },
      }),
    ).toBe(null);
    expect(
      parseCodexDynamicCreateThreadInput({
        prompt: "x",
        target: { type: "projectless" },
        thinking: "extreme",
      }),
    ).toBe(null);
  });

  test("projects exact model-only and thinking-only launch settings", () => {
    expect(JSON.stringify(projectCodexDynamicCreateModel("gpt-exact", undefined))).toBe(
      JSON.stringify({
        collaborationMode: {
          mode: "default",
          settings: {
            model: "gpt-exact",
            reasoning_effort: "medium",
            developer_instructions: null,
          },
        },
        configOverrides: null,
      }),
    );
    expect(JSON.stringify(projectCodexDynamicCreateModel(undefined, "max"))).toBe(
      JSON.stringify({
        collaborationMode: null,
        configOverrides: { model_reasoning_effort: "max" },
      }),
    );
  });

  test("returns the exact unsupported model/reasoning diagnostics", () => {
    const models = [
      {
        id: "gpt-exact",
        model: "gpt-exact",
        displayName: "Exact",
        description: "",
        modelSpecialty: null,
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "medium" as const,
        supportedReasoningEfforts: [{ reasoningEffort: "high" as const, description: "" }],
        inputModalities: ["text" as const],
        supportsPersonality: false,
        multiAgentVersion: null,
        additionalSpeedTiers: [],
        serviceTiers: [],
        defaultServiceTier: null,
        upgrade: null,
        upgradeInfo: null,
        availabilityNux: null,
      },
    ];
    expect(validateCodexDynamicCreateModelReasoning("gpt-exact", "high", models)).toBe(null);
    expect(validateCodexDynamicCreateModelReasoning("gpt-exact", "low", models)).toBe(
      'create_thread rejected unsupported model/reasoning combination: "gpt-exact" does not support "low". Supported reasoning efforts: high.',
    );
    expect(validateCodexDynamicCreateModelReasoning("missing", "low", models)).toBe(
      'create_thread could not validate reasoning effort "low" for model "missing". Use a model and reasoning combination listed in the tool description, or omit thinking.',
    );
  });
});

describe("artifact-template-picker", () => {
  const mkdtempSync = mkdtempSyncartifacttemplatepicker;
  const tmpdir = tmpdirartifacttemplatepicker;
  const skill = (overrides: Partial<SkillMetadata>): SkillMetadata => ({
    name: "artifact-template-sheet",
    description: "Spreadsheet template",
    path: "/skills/sheet/SKILL.md",
    scope: "user",
    enabled: true,
    pluginId: null,
    ...overrides,
  });

  const runtimeFixture = () => {
    const root = mkdtempSync(path.join(tmpdir(), "nodex-artifact-template-picker-"));
    const serverPath = path.join(root, "server.mjs");
    writeFileSync(serverPath, "export {};\n", "utf8");
    return { nodePath: "/runtime/node", serverPath };
  };

  describe("artifact template picker", () => {
    test("builds the base MCP server even when skill discovery is unavailable", () => {
      const runtime = runtimeFixture();
      expect(buildArtifactTemplatePickerConfig({ runtime })).toEqual({
        "mcp_servers.openai_artifact_template_picker": {
          command: "/runtime/node",
          args: [runtime.serverPath],
          env: {},
        },
      });
    });

    test("filters, prioritizes, deduplicates and bounds published template skills", () => {
      const runtime = runtimeFixture();
      const longDescription = "😀".repeat(700);
      const config = buildArtifactTemplatePickerConfig({
        runtime,
        platform: "win32",
        skills: [
          skill({
            name: "openai-templates:artifact-template-late",
            path: String.raw`C:\skills\late\SKILL.md`,
          }),
          skill({
            name: "vendor:artifact-template-middle",
            path: String.raw`C:\skills\middle\SKILL.md`,
          }),
          skill({
            name: "artifact-template-first",
            path: String.raw`C:\skills\first\SKILL.md`,
            description: longDescription,
          }),
          skill({
            name: "artifact-template-first",
            path: String.raw`C:\skills\duplicate-name\SKILL.md`,
          }),
          skill({
            name: "artifact-template-path-alias",
            path: String.raw`c:\SKILLS\FIRST\skill.md`,
          }),
          skill({ name: "not-an-artifact-template", path: "/skills/nope" }),
          skill({ name: "artifact-template-disabled", enabled: false }),
        ],
      });
      const env = config?.["mcp_servers.openai_artifact_template_picker"] as {
        env: Record<string, string>;
      };
      const published = JSON.parse(env.env.CODEX_ARTIFACT_TEMPLATE_SKILLS ?? "[]") as Array<{
        skillName: string;
        skillPath: string;
        description: string;
      }>;
      expect(published.map((entry) => entry.skillName)).toEqual([
        "artifact-template-first",
        "vendor:artifact-template-middle",
        "openai-templates:artifact-template-late",
      ]);
      expect(Array.from(published[0]?.description ?? "")).toHaveLength(600);
    });

    test("resolves the checked-in development server and packaged server roots", () => {
      const root = mkdtempSync(path.join(tmpdir(), "nodex-artifact-template-runtime-"));
      const resources = path.join(root, "resources");
      mkdirSync(path.join(resources, "artifact-template-picker"), { recursive: true });
      writeFileSync(path.join(resources, "artifact-template-picker", "server.mjs"), "export {};\n");
      expect(
        resolveArtifactTemplatePickerRuntime({
          nodePath: "/runtime/node",
          isPackaged: false,
          projectRootPath: root,
          resourcesPath: "/unused",
        }),
      ).toEqual({
        nodePath: "/runtime/node",
        serverPath: path.join(resources, "artifact-template-picker", "server.mjs"),
      });
    });
  });
});

describe("codex-thread-handoff-capability", () => {
  function capableInput(
    overrides: Partial<CodexThreadHandoffCapabilityInput> = {},
  ): CodexThreadHandoffCapabilityInput {
    return {
      runtimeVersion: "0.146.0",
      appServer: {
        threadSettingsUpdate: true,
        threadResumeLocation: true,
        rolloutPathConsistency: true,
      },
      coreAtomicExecutionLocation: true,
      sourceHost: { available: true, transactionEffects: true },
      destinationHost: { available: true, transactionEffects: true },
      crossHost: false,
      crossHostTransfer: false,
      ...overrides,
    };
  }

  describe("Codex thread handoff capability", () => {
    test("accepts the pinned runtime and later compatible versions", () => {
      expect(supportsCodexThreadHandoffRuntimeVersion("0.145.9")).toBe(false);
      expect(supportsCodexThreadHandoffRuntimeVersion("0.146.0")).toBe(true);
      expect(supportsCodexThreadHandoffRuntimeVersion("codex-app-server 0.147.0")).toBe(true);
      expect(supportsCodexThreadHandoffRuntimeVersion(null)).toBe(false);
      expect(supportsCodexThreadHandoffRuntimeVersion("development")).toBe(false);
    });

    test("requires app-server, Core, and both host transaction boundaries", () => {
      expect(evaluateCodexThreadHandoffCapability(capableInput())).toEqual({
        status: "available",
        mode: "local",
      });
      expect(
        evaluateCodexThreadHandoffCapability(
          capableInput({
            runtimeVersion: null,
            appServer: {
              threadSettingsUpdate: false,
              threadResumeLocation: false,
              rolloutPathConsistency: false,
            },
            coreAtomicExecutionLocation: false,
            sourceHost: { available: false, transactionEffects: false },
            destinationHost: { available: false, transactionEffects: false },
          }),
        ),
      ).toEqual({
        status: "unavailable",
        mode: "local",
        reasons: [
          "app-server-version-unsupported",
          "app-server-settings-update-unavailable",
          "app-server-resume-location-unavailable",
          "app-server-rollout-consistency-unavailable",
          "core-atomic-location-unavailable",
          "source-host-unavailable",
          "destination-host-unavailable",
          "host-transaction-unavailable",
        ],
      });
    });

    test("adds transfer capability only for cross-host movement", () => {
      expect(
        evaluateCodexThreadHandoffCapability(
          capableInput({
            crossHost: true,
            crossHostTransfer: false,
          }),
        ),
      ).toMatchObject({
        status: "unavailable",
        mode: "cross-host",
        reasons: ["cross-host-transfer-unavailable"],
      });
      expect(
        evaluateCodexThreadHandoffCapability(
          capableInput({
            crossHost: true,
            crossHostTransfer: true,
          }),
        ),
      ).toEqual({ status: "available", mode: "cross-host" });
    });
  });
});
