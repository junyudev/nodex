import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { authorizedReadStampFixture } from "../../shared/testing/authorized-read-stamp-fixture";
import { parseDatabaseId } from "../../shared/database-identities";
import { upgradeDatabaseViewConfigV2 } from "../../shared/database-view-presentation";
import type { CoreGenerationClient } from "../core-client/core-generation-client";
import { createFakeCoreHandshake, FakeCoreClient } from "../core-client/testing/fake-core-client";
import type { DatabaseReadSnapshot } from "../core-client/types";
import { CoreAuthority, CoreSessionAccess } from "../core-runtime/CoreAuthority";
import { DatabaseModule, live } from "./DatabaseModule";

const identity = {
  profileId: "profile:test",
  libraryId: "library:test",
  storeEpoch: "epoch:test",
} as const;
const projectId = "project:test";

const coreDatabase = () => ({
  database_id: "database:test",
  library_id: identity.libraryId,
  name: "Tasks",
  lifecycle: "active" as const,
  default_view_id: "view:test",
  access_revision: 1,
  metadata_revision: 1,
  created_at: "2026-08-23T00:00:00.000Z",
  updated_at: "2026-08-23T00:00:00.000Z",
});

const enqueueDatabaseDescriptor = (client: FakeCoreClient, commitHead: number): void => {
  client.enqueueDatabaseRead({
    contract_version: 4,
    store_epoch: identity.storeEpoch,
    commit_head: commitHead,
    authorization: null,
    value: { kind: "database", value: { database: coreDatabase() } },
  });
  client.enqueueDatabaseRead({
    contract_version: 4,
    store_epoch: identity.storeEpoch,
    commit_head: commitHead,
    authorization: null,
    value: {
      kind: "data_source_window",
      data_sources: {
        items: [],
        next_cursor: null,
        authority: { projection_revision: commitHead },
      },
    },
  });
  client.enqueueDatabaseRead({
    contract_version: 4,
    store_epoch: identity.storeEpoch,
    commit_head: commitHead,
    authorization: null,
    value: {
      kind: "view_descriptor_window",
      views: { items: [], next_cursor: null, authority: { projection_revision: commitHead } },
    },
  });
};

const viewGroupsSnapshot = (commitHead: number): DatabaseReadSnapshot => ({
  contract_version: 4,
  store_epoch: identity.storeEpoch,
  commit_head: commitHead,
  authorization: authorizedReadStampFixture({
    deliveryAddress: {
      kind: "project",
      library_id: identity.libraryId,
      project_id: projectId,
    },
    subject: { kind: "view", view_id: "view:test" },
    storeEpoch: identity.storeEpoch,
    commitSeq: commitHead,
  }),
  value: {
    kind: "view_groups",
    value: {
      database_id: "database:test",
      data_source_id: "source:test",
      view_id: "view:test",
      projection: {
        scope: {
          schema_version: 1,
          canonical_key: "scope:view:test",
          scope: {
            kind: "database_view",
            project_id: projectId,
            database_id: "database:test",
            data_source_id: "source:test",
            view_id: "view:test",
          },
        },
        revision: commitHead,
        covered_commit_seq: commitHead,
        effect_hash: String(commitHead).padStart(64, "a").slice(-64),
      },
      grouped: true,
      subgrouped: false,
      total_rows: 7,
      total_groups: 2,
      group_limit: 200,
      truncated: false,
      groups: [
        { group_key: "triage", subgroup_key: null, total_rows: 4 },
        { group_key: null, subgroup_key: null, total_rows: 3 },
      ],
    },
  },
});

const rowDetailSnapshot = (commitHead: number): DatabaseReadSnapshot => ({
  contract_version: 4,
  store_epoch: identity.storeEpoch,
  commit_head: commitHead,
  authorization: authorizedReadStampFixture({
    deliveryAddress: {
      kind: "project",
      library_id: identity.libraryId,
      project_id: projectId,
    },
    subject: { kind: "page", page_id: "page:test" },
    storeEpoch: identity.storeEpoch,
    commitSeq: commitHead,
  }),
  value: {
    kind: "row_detail",
    value: {
      body_nfm: "Canonical details",
      summary: {
        created_at: "2026-08-23T00:00:00.000Z",
        database_value_revisions: { status: 1 },
        database_values: { status: "ship" },
        description_length: 17,
        description_preview: "Canonical details",
        document_generation: 1,
        document_head_seq: 1,
        document_id: "document:test",
        has_description: true,
        intrinsic_properties: {
          "schedule.isAllDay": false,
          "recurrence.config": null,
          "reminders.config": [],
          "schedule.timezone": null,
          "run.target": "localProject",
          "run.localPath": null,
          "run.baseBranch": null,
          "run.worktreePath": null,
          "run.environmentPath": null,
        },
        lifecycle: "active",
        membership_created_at: "2026-08-23T00:00:00.000Z",
        membership_id: "membership:test",
        membership_revision: 1,
        metadata_revision: 2,
        page_id: "page:test",
        page_key: "TASK-1",
        parent_revision: 1,
        rich_title: [],
        task_parent_value_revision: 1,
        title: "Release",
        updated_at: "2026-08-23T00:00:00.000Z",
      },
    },
  },
});

const enqueueDatabaseViewReference = (client: FakeCoreClient): void => {
  const commitHead = 23;
  const authorization = authorizedReadStampFixture({
    deliveryAddress: {
      kind: "project",
      library_id: identity.libraryId,
      project_id: projectId,
    },
    subject: { kind: "view", view_id: "view:test" },
    storeEpoch: identity.storeEpoch,
    commitSeq: commitHead,
  });
  const config = upgradeDatabaseViewConfigV2({
    schemaKey: "nodex.database-view",
    schemaVersion: 2,
    filter: { kind: "group", operator: "and", children: [] },
    sort: [{ field: { kind: "manual" }, direction: "asc", nulls: "last" }],
    group: null,
    display: { propertyIds: [], showTitle: true },
  });
  const base = {
    contract_version: 10 as const,
    store_epoch: identity.storeEpoch,
    commit_head: commitHead,
  };
  client.enqueueDatabaseRead({
    ...base,
    authorization,
    value: {
      kind: "view_window",
      value: {
        database_id: "database:test",
        data_source_id: "source:test",
        view_id: "view:test",
        projection: {
          scope: {
            schema_version: 1,
            canonical_key: "scope:view:test",
            scope: {
              kind: "database_view",
              project_id: projectId,
              database_id: "database:test",
              data_source_id: "source:test",
              view_id: "view:test",
            },
          },
          revision: commitHead,
          covered_commit_seq: commitHead,
          effect_hash: "a".repeat(64),
        },
        rows: {
          items: [],
          next_cursor: null,
          authority: { projection_revision: commitHead },
        },
      },
    },
  });
  client.enqueueDatabaseRead({
    ...base,
    authorization,
    value: {
      kind: "view",
      value: {
        view_id: "view:test",
        database_id: "database:test",
        data_source_id: "source:test",
        name: "All tasks",
        layout: "list",
        definition: { rules: config.rules, presentation: config.presentation },
        is_default: true,
        revision: 2,
        rank_key: "a",
        lifecycle: "active",
        created_at: "2026-08-23T00:00:00.000Z",
        updated_at: "2026-08-23T00:00:00.000Z",
      },
    },
  });
  client.enqueueDatabaseRead({
    ...base,
    authorization: null,
    value: { kind: "database", value: { database: coreDatabase() } },
  });
  client.enqueueDatabaseRead({
    ...base,
    authorization: null,
    value: {
      kind: "data_source_window",
      data_sources: {
        items: [],
        next_cursor: null,
        authority: { projection_revision: commitHead },
      },
    },
  });
  client.enqueueDatabaseRead({
    ...base,
    authorization: null,
    value: {
      kind: "view_descriptor_window",
      views: { items: [], next_cursor: null, authority: { projection_revision: commitHead } },
    },
  });
  client.enqueueDatabaseRead({
    ...base,
    authorization: null,
    value: {
      kind: "data_source",
      value: {
        data_source: {
          data_source_id: "source:test",
          library_id: identity.libraryId,
          home_database_id: "database:test",
          name: "Tasks",
          schema_key: "nodex.database",
          schema_revision: 1,
          lifecycle: "active",
          rank_key: "a",
          created_at: "2026-08-23T00:00:00.000Z",
          updated_at: "2026-08-23T00:00:00.000Z",
        },
      },
    },
  });
  client.enqueueDatabaseRead({
    ...base,
    authorization: null,
    value: {
      kind: "property_window",
      properties: { items: [], next_cursor: null, authority: { projection_revision: commitHead } },
    },
  });
};

const withDatabaseModule = <A, E, R>(
  client: FakeCoreClient,
  run: (
    database: DatabaseModule["Service"],
    projectScopes: Array<string | undefined>,
  ) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const projectScopes: Array<string | undefined> = [];
    const handshake = createFakeCoreHandshake(identity);
    const generationClient = Object.assign(client, {
      handshake,
      forProject: () => generationClient,
      health: () =>
        Promise.resolve({
          pid: 1,
          start_nonce: handshake.generation.start_nonce,
          status: "ready" as const,
        }),
      shutdown: () => Promise.resolve({ status: "draining" as const }),
    }) as unknown as CoreGenerationClient;
    const access = CoreSessionAccess.of({
      use: (_operation, task, options) =>
        Effect.promise((signal) => {
          projectScopes.push(options?.projectId);
          return task(generationClient, signal);
        }),
      handshake: Effect.succeed(handshake),
    });
    const authority = CoreAuthority.of({ identity } as CoreAuthority["Service"]);
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      live.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(CoreAuthority, authority),
            Layer.succeed(CoreSessionAccess, access),
          ),
        ),
      ),
      scope,
    );
    const database = Context.get(context, DatabaseModule);
    const result = yield* run(database, projectScopes);
    yield* Scope.close(scope, Exit.void);
    return result;
  });

it.effect("routes canonical Project and Library reads through their exact Core scopes", () => {
  const client = new FakeCoreClient();
  enqueueDatabaseDescriptor(client, 1);
  enqueueDatabaseDescriptor(client, 2);

  return withDatabaseModule(client, (database, projectScopes) =>
    Effect.gen(function* () {
      const project = yield* database.read({
        projectId,
        read: { target: { kind: "project_default" }, mode: "database" },
      });
      const library = yield* database.readLibrary({
        read: {
          target: { kind: "database", databaseId: parseDatabaseId("database:test") },
          mode: "database",
        },
      });

      assert.deepEqual(projectScopes, [projectId, undefined]);
      assert.isTrue(project.ok);
      if (project.ok) assert.strictEqual(project.value.projectId, projectId);
      assert.isTrue(library.ok);
      if (library.ok) {
        assert.deepEqual(library.value.accessContext, { kind: "library" });
        assert.strictEqual(library.value.commitSeq, 2);
      }
    }),
  );
});

it.effect("waits for the causal commit before projecting bounded View groups", () => {
  const client = new FakeCoreClient();
  client.enqueueDatabaseRead(viewGroupsSnapshot(1));
  client.enqueueDatabaseRead(viewGroupsSnapshot(3));

  return withDatabaseModule(client, (database, projectScopes) =>
    Effect.gen(function* () {
      const fiber = yield* database
        .viewGroups(
          { kind: "project", projectId },
          {
            databaseViewId: "view:test",
            minimumCommitCursor: { storeEpoch: identity.storeEpoch, commitSeq: 3 },
          },
        )
        .pipe(Effect.forkChild);

      yield* TestClock.adjust("5 millis");
      const groups = yield* Fiber.join(fiber);

      assert.deepEqual(projectScopes, [projectId, projectId]);
      assert.strictEqual(groups.commitSeq, 3);
      assert.strictEqual(groups.totalRows, 7);
      assert.deepEqual(groups.groups, [
        { groupKey: "triage", subgroupKey: null, totalRows: 4 },
        { groupKey: null, subgroupKey: null, totalRows: 3 },
      ]);
    }),
  );
});

it.effect("resolves a Database View reference from one bounded authoritative window", () => {
  const client = new FakeCoreClient();
  enqueueDatabaseViewReference(client);

  return withDatabaseModule(client, (database, projectScopes) =>
    Effect.gen(function* () {
      const reference = yield* database.resolveDatabaseViewReference({
        accessContext: { kind: "project", projectId },
        databaseViewId: "view:test",
      });

      assert.isNotNull(reference);
      if (reference === null) return;
      assert.strictEqual(reference.commitSeq, 23);
      assert.strictEqual(reference.dataSourceId, "source:test");
      assert.strictEqual(reference.view.id, "view:test");
      assert.strictEqual(reference.view.databaseBlockId, "database:test");
      assert.strictEqual(reference.view.projectId, projectId);
      assert.strictEqual(reference.view.name, "All tasks");
      assert.isTrue(reference.view.isPrimary);
      assert.deepEqual(reference.rows, []);
      assert.deepEqual(projectScopes, [projectId, projectId, projectId, projectId]);
      assert.deepEqual(
        client.databaseReads.map(({ kind }) => kind),
        [
          "view_window",
          "view",
          "database",
          "data_source_window",
          "view_descriptor_window",
          "data_source",
          "property_window",
        ],
      );
    }),
  );
});

it.effect("reads a causally fenced Database row through the Project authority", () => {
  const client = new FakeCoreClient();
  client.enqueueDatabaseRead(rowDetailSnapshot(31));

  return withDatabaseModule(client, (database, projectScopes) =>
    Effect.gen(function* () {
      const page = yield* database.readRowPage({
        projectId,
        pageId: "page:test",
        status: "ship",
        minimumCommitCursor: { storeEpoch: identity.storeEpoch, commitSeq: 31 },
      });

      assert.isNotNull(page);
      assert.strictEqual(page?.id, "page:test");
      assert.strictEqual(page?.description, "Canonical details");
      assert.strictEqual(page?.status, "ship");
      assert.deepEqual(projectScopes, [projectId]);
      assert.deepEqual(
        client.databaseReads.map(({ kind }) => kind),
        ["row_detail"],
      );
    }),
  );
});
