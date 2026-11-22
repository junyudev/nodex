import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vite-plus/test";
import { makePersistedAtomStore } from "../../../src/main/local-store/persisted-atoms";
import {
  getAgentProfiles,
  getModelPolicy,
} from "../../../src/main/settings/application-settings-persistence";
import {
  AGENT_RUNTIME_COMPOSER_CHOICES_STORAGE_KEY,
  agentRuntimeChoiceKey,
  AgentRuntimeComposerChoiceSchema,
} from "../../../src/shared/agent-runtime-composer-choice-storage";
import { CODEX_BINDING } from "../../../src/shared/agents/codex";
import { isModelOn } from "../../../src/shared/model-policy";
import { spaceStorageKeyFor } from "../../../src/shared/space-personal-state";
import { SCENARIO_MANIFEST_VERSION } from "../contracts";
import {
  crossProviderRuntimeRoot,
  prepareCrossProviderDelegationRuntime,
} from "./cross-provider-delegation";

it("seeds both composer choices and enables the delegated model on its configured Agent", () => {
  const runRoot = mkdtempSync(path.join(tmpdir(), "nodex-cross-provider-seed-"));
  const nodexHome = path.join(runRoot, "profile");
  const projectId = "project";
  const spaceId = "library";
  const parentSession = "passkeys";
  const releaseNotesSession = "release-notes";
  try {
    prepareCrossProviderDelegationRuntime({
      nodexHome,
      spaceId,
      manifest: {
        version: SCENARIO_MANIFEST_VERSION,
        scenarioId: "cross-provider-delegation",
        scenarioRevision: 1,
        projectId,
        databaseViewId: "view",
        pageIdsByKey: {},
        entityIdsByKey: { parentSession, releaseNotesSession },
        minimumCommitSeq: 0,
        materializedAt: "2026-01-01T00:00:00.000Z",
      },
    });

    const settings = { settingsPath: path.join(nodexHome, "config.toml"), environment: {} };
    const profiles = getAgentProfiles(settings);
    const claude = profiles.find(({ driver }) => driver === "claudeAgent");
    const openCode = profiles.find(({ driver }) => driver === "opencode");
    expect(claude?.enabled).toBe(true);
    expect(openCode?.enabled).toBe(true);

    const key = spaceStorageKeyFor(
      { spaceId, memberId: null },
      AGENT_RUNTIME_COMPOSER_CHOICES_STORAGE_KEY,
    );
    const entries = makePersistedAtomStore(nodexHome).readState()[key] as Record<string, unknown>;
    const selection = (sessionId: string) =>
      AgentRuntimeComposerChoiceSchema.parse(
        entries[agentRuntimeChoiceKey.draft(sessionId, projectId)],
      ).selection;
    expect(selection(parentSession)).toEqual({
      binding: { driver: "claudeAgent", instanceId: claude?.id },
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(selection(releaseNotesSession)).toEqual({
      binding: CODEX_BINDING,
      model: "gpt-6.1-sol",
      options: [{ id: "reasoningEffort", value: "high" }],
    });

    const plan = JSON.parse(
      readFileSync(path.join(crossProviderRuntimeRoot(nodexHome), "plan.json"), "utf8"),
    ) as { children: { key: string; target: { providerInstanceId: string; model: string } }[] };
    const target = plan.children.find(({ key }) => key === "docs")?.target;
    if (!target || !openCode) throw new Error("The OpenCode delegation was not seeded");
    expect(target.providerInstanceId).toBe(openCode.id);
    expect(
      isModelOn(
        getModelPolicy(settings),
        { driver: openCode.driver, instanceId: openCode.id },
        target.model,
      ),
    ).toBe(true);
  } finally {
    rmSync(runRoot, { recursive: true, force: true });
  }
});
