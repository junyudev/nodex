/* @effect-diagnostics asyncFunction:off -- Verifies team source identity at the real Core boundary. */
import { expect, test } from "vite-plus/test";
import { withCoreScenario } from "../../../scripts/scenarios/harness/core-scenario-harness";
import { DOCUMENT_SYNC_RECOVERY_SCENARIO_ID } from "../../../scripts/scenarios/scenarios/document-sync-recovery";
import { CoreClient } from "./core-client";
import { createBoundedOperationId } from "../../shared/operation-identity";

test("team Projects publish repository identities and refuse host-local source paths", async () => {
  await withCoreScenario(
    { scenarioId: DOCUMENT_SYNC_RECOVERY_SCENARIO_ID },
    async ({ client, manifest, profile }) => {
      const host = await CoreClient.connect({
        nodexHome: profile.nodexHome,
        clientKind: "electron_host",
        buildId: "repository-test",
      });
      const before = await client.workspaceRead({
        kind: "project",
        project_id: manifest.projectId,
      });
      if (before.value.kind !== "project") throw new Error("Missing Project");
      const update = (sources: string[], revision: number) =>
        client.workspaceApply({
          operationId: createBoundedOperationId("project.repository"),
          intent: {
            kind: "update_project",
            project_id: manifest.projectId,
            expected_binding_revision: revision,
            name: null,
            description: null,
            appearance: null,
            source_roots: sources,
          },
        });
      await update(["https://git.example/acme/repo"], before.value.project.binding_revision);
      const after = await client.workspaceRead({ kind: "project", project_id: manifest.projectId });
      if (after.value.kind !== "project") throw new Error("Missing Project");
      expect(after.value.project.sources).toEqual([
        { kind: "repository", remote: "https://git.example/acme/repo", order: 0 },
      ]);
      expect(after.value.project.primary_workspace_root).toBeNull();
      await expect(
        update([profile.projectsDirectory], after.value.project.binding_revision),
      ).rejects.toThrow(/canonical HTTPS/u);
      await expect(
        update(["https://user:secret@git.example/repo"], after.value.project.binding_revision),
      ).rejects.toThrow(/canonical HTTPS/u);
      await expect(
        update(["git@git.example:acme/repo.git"], after.value.project.binding_revision),
      ).rejects.toThrow(/canonical HTTPS/u);
    },
  );
});
