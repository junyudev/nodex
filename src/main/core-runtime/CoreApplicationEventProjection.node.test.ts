import { expect, test } from "vitest";
import { createCoreLocalCommitFixture } from "../core-client/testing/local-commit-fixture";
import { projectCoreApplicationEvent } from "./CoreApplicationEventProjection";

const envelope = (packet: ReturnType<typeof createCoreLocalCommitFixture>) => ({
  transport_version: 4 as const,
  packet,
});

test("projects every Core application event through one discriminated boundary", () => {
  const automation = createCoreLocalCommitFixture({
    commitSeq: 1,
    storeEpoch: "epoch:test",
    payload: {
      module: "automation",
      library_id: "library:test",
      project_id: "project:one",
      event: {
        kind: "automation_changed",
        automation_ids: ["automation:one"],
        lease_ids: [],
        run_ids: ["run:one"],
        reminder_lease_ids: [],
        snooze_ids: [],
        page_ids: [],
        document_ids: [],
        database_ids: [],
      },
    },
  });
  const projectDatabase = createCoreLocalCommitFixture({
    commitSeq: 2,
    storeEpoch: "epoch:test",
    operationId: "operation:database",
    payload: {
      module: "database",
      library_id: "library:test",
      event: {
        kind: "database_changed",
        project_id: "project:one",
        database_ids: ["database:one"],
        data_source_ids: [],
        page_ids: [],
        view_ids: [],
      },
    },
  });
  const libraryDatabase = createCoreLocalCommitFixture({
    commitSeq: 3,
    storeEpoch: "epoch:test",
    operationId: "operation:library-database",
    payload: {
      module: "database",
      library_id: "library:test",
      event: {
        kind: "database_changed",
        project_id: null,
        database_ids: ["database:two"],
        data_source_ids: [],
        page_ids: [],
        view_ids: [],
      },
    },
  });
  const workspace = createCoreLocalCommitFixture({
    commitSeq: 4,
    storeEpoch: "epoch:test",
    payload: {
      module: "project_workspace",
      library_id: "library:test",
      event: {
        kind: "workspace_changed",
        project_catalog_change: "created",
        project_ids: ["project:one"],
        session_ids: [],
        thread_ids: [],
        session_summary_scopes: [{ kind: "project", project_id: "project:one" }],
        session_detail_ids: [],
      },
    },
  });
  const administration = createCoreLocalCommitFixture({
    commitSeq: 5,
    storeEpoch: "epoch:test",
    payload: {
      module: "store_administration",
      library_id: "library:test",
      event: {
        kind: "store_administration_changed",
        operation: "create_backup",
        backup_ids: ["backup:one"],
        readiness_changed: true,
      },
    },
  });

  expect(
    projectCoreApplicationEvent(envelope(automation), automation.atoms[0]!, "library:test"),
  ).toEqual({
    kind: "automation",
    value: { automationIds: ["automation:one"], runIds: ["run:one"] },
  });
  expect(
    projectCoreApplicationEvent(
      envelope(projectDatabase),
      projectDatabase.atoms[0]!,
      "library:test",
    )?.kind,
  ).toBe("database");
  expect(
    projectCoreApplicationEvent(
      envelope(libraryDatabase),
      libraryDatabase.atoms[0]!,
      "library:test",
    ),
  ).toMatchObject({
    kind: "library-navigation",
    value: { changeKind: "database", affectedDatabaseIds: ["database:two"] },
  });
  expect(
    projectCoreApplicationEvent(envelope(workspace), workspace.atoms[0]!, "library:test"),
  ).toMatchObject({
    kind: "project-workspace",
    value: {
      projectCatalogChange: "created",
      sessionSummaryScopes: [{ kind: "project", projectId: "project:one" }],
    },
  });
  expect(
    projectCoreApplicationEvent(envelope(administration), administration.atoms[0]!, "library:test"),
  ).toEqual({
    kind: "store-administration",
    value: { backupIds: ["backup:one"], readinessChanged: true },
  });
});

test("repairs historical personal filter drafts before strict renderer parsing", () => {
  const database = createCoreLocalCommitFixture({
    commitSeq: 6,
    storeEpoch: "epoch:test",
    operationId: "operation:personal-filter-draft",
    payload: {
      module: "database",
      library_id: "library:test",
      event: {
        kind: "database_changed",
        project_id: "project:one",
        database_ids: [],
        data_source_ids: [],
        page_ids: [],
        view_ids: [],
        personal_view_changes: [
          {
            kind: "preferences",
            view_id: "view:one",
            value: {
              rules_override: {
                advanced_filter: {
                  kind: "filter",
                  filter: {
                    kind: "group",
                    operator: "and",
                    children: [
                      {
                        kind: "clause",
                        propertyId: "assignee",
                        operator: "select_is",
                      },
                    ],
                  },
                },
              },
              presentation_override: {},
              revision: 1,
            },
          },
        ],
      },
    },
  });

  expect(
    projectCoreApplicationEvent(envelope(database), database.atoms[0]!, "library:test"),
  ).toMatchObject({
    kind: "database",
    value: {
      personalViewChanges: [
        {
          kind: "preferences",
          rulesOverride: {
            advancedFilter: {
              children: [{ propertyId: "assignee", operator: "select_is", value: null }],
            },
          },
        },
      ],
    },
  });
});
