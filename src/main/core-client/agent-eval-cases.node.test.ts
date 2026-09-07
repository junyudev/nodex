import {
  createCustomPropertyId,
  parseDatabaseViewId,
  parseDataSourcePropertyId,
  parseDataSourceOptionId,
} from "../../shared/database-identities";
import { expect, test } from "vite-plus/test";
import { CASES } from "../../../scripts/agent-eval/cases";
import {
  withCoreScenario,
  type CoreScenarioContext,
} from "../../../scripts/scenarios/harness/core-scenario-harness";
import { CoreClient } from "./core-client";
import { createUuidV7 } from "../../shared/uuid-v7";

async function rows(context: CoreScenarioContext) {
  const read = await context.runtime.clientForProject(context.manifest.projectId).databaseRead({
    kind: "view_window",
    target: { kind: "project_default" },
    window: { after: null, first: 100 },
  });
  if (read.value.kind !== "view_window") throw new Error("Expected task rows");
  return read.value.value.rows.items;
}
async function replace(context: CoreScenarioContext, pageId: string, nfm: string) {
  await context.seed.replaceOwnedDocument({
    pageId,
    nfm,
    projectId: context.manifest.projectId,
    operationId: createUuidV7(),
    mutationId: createUuidV7(),
    clientSessionId: "eval-oracle-test",
  });
}

async function patch(
  context: CoreScenarioContext,
  pageId: string,
  oldText: string,
  newText: string,
) {
  const client = await CoreClient.connect({
    nodexHome: context.profile.nodexHome,
    clientKind: "native_cli",
    buildId: "eval-oracle-test",
    projectId: context.manifest.projectId,
  });
  const clientSessionId = "eval-oracle-test";
  const read = await client.documentRead(clientSessionId, {
    kind: "descriptor",
    owner_block_id: pageId,
  });
  if (read.value.kind !== "descriptor") throw new Error("Expected Document descriptor");
  const descriptor = read.value.descriptor;
  await client.documentApply({
    operationId: createUuidV7(),
    clientSessionId,
    intent: {
      kind: "apply_semantic_mutation",
      document_id: descriptor.documentId,
      generation: descriptor.generation,
      expected_head_seq: descriptor.headSeq,
      commands: [
        { kind: "patch_body", old_fragment: oldText, new_fragment: newText, expected_matches: 1 },
      ],
    },
  });
}

test("exact-edit oracle accepts a semantic patch and rejects false completion, collateral edits, and extra Pages", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const prepared = await CASES.find((item) => item.id === "exact-edit")!.prepare(context, 0);
    expect((await prepared.verify("Done")).passed).toBe(false);
    const target = (await rows(context)).find((item) => item.title === "Cedar release plan");
    if (!target) throw new Error("Missing release Page");
    await patch(context, target.page_id, "Release date: Friday.", "Release date: Monday.");
    expect(await prepared.verify("Done")).toMatchObject({ passed: true });
    await patch(context, target.page_id, "Verify restore procedure", "Skip restore procedure");
    expect((await prepared.verify("Done")).passed).toBe(false);
    await patch(context, target.page_id, "Skip restore procedure", "Verify restore procedure");
    expect(await prepared.verify("Done")).toMatchObject({ passed: true });
    await context.seed.createStandalonePage({
      projectId: context.manifest.projectId,
      pageId: createUuidV7(),
      documentId: createUuidV7(),
      operationId: createUuidV7(),
      title: "Unexpected standalone Page",
    });
    expect((await prepared.verify("Done")).passed).toBe(false);
  });
});

test("exact-edit oracle rejects a body-equivalent wholesale replacement that recreates Blocks", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const prepared = await CASES.find((item) => item.id === "exact-edit")!.prepare(context, 1);
    const target = (await rows(context)).find((item) => item.title === "Harbor release plan");
    if (!target) throw new Error("Missing release Page");
    const body =
      "# Harbor release\n\nRelease date: Monday.\n\n## Rollback\n\nKeep **database snapshots** for seven days.\n\n- Verify backups\n\t- Verify restore procedure\n- Record owner: Mina\n\nTracking code: HARBOR-42.";
    await replace(context, target.page_id, body);
    const verification = await prepared.verify("Done");
    expect(verification.passed).toBe(false);
    expect(verification.assertions.filter((assertion) => !assertion.passed)).toEqual([
      {
        category: "preservation",
        name: "Exact Block identities, topology, properties, and rich content preserved",
        passed: false,
      },
    ]);
  });
});

test("append oracle accepts a new paragraph and rejects replacing the original Blocks", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const prepared = await CASES.find((item) => item.id === "append-section")!.prepare(context, 2);
    const target = (await rows(context)).find((item) => item.title === "Juniper release plan");
    if (!target) throw new Error("Missing release Page");
    await patch(
      context,
      target.page_id,
      "Tracking code: JUNIPER-42.",
      "Tracking code: JUNIPER-42.\nSign-off owner: Ravi.",
    );
    expect(await prepared.verify("Done")).toMatchObject({ passed: true });
    await replace(
      context,
      target.page_id,
      "# Juniper release\n\nRelease date: Friday.\n\n## Rollback\n\nKeep **database snapshots** for seven days.\n\n- Verify backups\n\t- Verify restore procedure\n- Record owner: Mina\n\nTracking code: JUNIPER-42.\n\nSign-off owner: Ravi.",
    );
    const verification = await prepared.verify("Done");
    expect(verification.passed).toBe(false);
    expect(verification.assertions.filter((assertion) => !assertion.passed)).toEqual([
      {
        category: "preservation",
        name: "Existing Block identities, topology, properties, and rich content preserved",
        passed: false,
      },
    ]);
  });
});

test("concurrency oracle injects only after an observed body and preserves the writer value", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const prepared = await CASES.find((item) => item.id === "concurrent-edit")!.prepare(context, 0);
    const target = (await rows(context)).find((item) => item.title === "Cedar release plan");
    if (!target) throw new Error("Missing release Page");
    await prepared.afterCommand?.({ args: ["help"], stdout: "Friday", exitCode: 0 });
    expect((await prepared.verify("Conflict")).passed).toBe(false);
    await prepared.afterCommand?.({
      args: ["read", target.page_id],
      stdout: `${target.page_id} Release date: Friday.`,
      exitCode: 0,
    });
    expect(
      await prepared.verify("The date changed to Tuesday; I left it unchanged."),
    ).toMatchObject({ passed: true });
    await prepared.afterCommand?.({
      args: ["read", target.page_id],
      stdout: `${target.page_id} Release date: Friday.`,
      exitCode: 0,
    });
    expect(await prepared.verify("Conflict")).toMatchObject({ passed: true });
  });
});

test("empty-result oracle rejects extra Pages even when the answer claims none", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const prepared = await CASES.find((item) => item.id === "empty-search")!.prepare(context, 1);
    expect(await prepared.verify("No matching Pages.")).toMatchObject({ passed: true });
    await context.seed.createPage({
      key: "unexpected",
      pageId: createUuidV7(),
      operationId: createUuidV7(),
      projectId: context.manifest.projectId,
      status: "build",
      title: "Unexpected Page",
      nfm: "",
    });
    expect((await prepared.verify("No matching Pages.")).passed).toBe(false);
  });
});

async function descriptor(context: CoreScenarioContext) {
  const result = await context.seed.readDatabase({
    projectId: context.manifest.projectId,
    read: { target: { kind: "project_default" }, mode: "database" },
  });
  if (!result.ok) throw new Error(result.error.message);
  if (result.value.value.kind !== "database") throw new Error("Expected Database");
  return result.value.value.value;
}

test("bulk oracle accepts exact public mutation and rejects an extra target", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const prepared = await CASES.find((item) => item.id === "bulk-priority")!.prepare(context, 2);
    const allRows = await rows(context);
    const db = await descriptor(context);
    const dataSourceId = db.dataSources[0]!.dataSourceId;
    const edits = allRows
      .filter((row) => row.database_values.status === "review")
      .map((row) => ({
        pageId: row.page_id,
        dataSourceId,
        propertyId: parseDataSourcePropertyId("priority"),
        edit: {
          kind: "replace" as const,
          expectedValueRevision: row.database_value_revisions.priority ?? 0,
          value: {
            kind: "select" as const,
            optionId: parseDataSourceOptionId({ propertyId: "priority", value: "p1-high" }),
          },
        },
      }));
    const mutation = await context.seed.applyDatabase({
      projectId: context.manifest.projectId,
      storeEpoch: context.runtime.identity.storeEpoch,
      operationId: createUuidV7(),
      actor: { kind: "scenario_seed" },
      operations: [{ kind: "edit_property_values", edits }],
    });
    if (!mutation.ok) throw new Error(mutation.error.message);
    expect(await prepared.verify("Done")).toMatchObject({ passed: true });
    const other = allRows.find((row) => row.database_values.status === "build")!;
    const unwanted = await context.seed.applyDatabase({
      projectId: context.manifest.projectId,
      storeEpoch: context.runtime.identity.storeEpoch,
      operationId: createUuidV7(),
      actor: { kind: "scenario_seed" },
      operations: [
        {
          kind: "edit_property_values",
          edits: [
            {
              ...edits[0]!,
              pageId: other.page_id,
              edit: {
                kind: "replace",
                expectedValueRevision: other.database_value_revisions.priority ?? 0,
                value: {
                  kind: "select",
                  optionId: parseDataSourceOptionId({ propertyId: "priority", value: "p1-high" }),
                },
              },
            },
          ],
        },
      ],
    });
    if (!unwanted.ok) throw new Error(unwanted.error.message);
    expect((await prepared.verify("Done")).passed).toBe(false);
  });
});

test("schema oracle accepts an added Property without treating derived View order as damage", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const prepared = await CASES.find((item) => item.id === "create-risk-property")!.prepare(
      context,
      0,
    );
    const db = await descriptor(context);
    const source = db.dataSources[0]!;
    const mutation = await context.seed.applyDatabase({
      projectId: context.manifest.projectId,
      storeEpoch: context.runtime.identity.storeEpoch,
      operationId: createUuidV7(),
      actor: { kind: "scenario_seed" },
      operations: [
        {
          kind: "put_property",
          dataSourceId: source.dataSourceId,
          propertyId: createCustomPropertyId(),
          expectedDataSourceRevision: source.schemaRevision,
          expectedPropertyRevision: 0,
          name: "Risk note",
          schema: { kind: "text" },
        },
      ],
    });
    if (!mutation.ok) throw new Error(mutation.error.message);
    expect(await prepared.verify("Done")).toMatchObject({ passed: true });
  });
});

test("View oracle queries real membership and rejects an unfiltered View", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const prepared = await CASES.find((item) => item.id === "create-review-view")!.prepare(
      context,
      0,
    );
    const db = await descriptor(context);
    const original = db.views[0]!;
    const viewId = parseDatabaseViewId(createUuidV7());
    const operation = {
      kind: "put_view" as const,
      databaseId: original.databaseId,
      dataSourceId: original.dataSourceId,
      viewId,
      expectedRevision: 0,
      name: "Cedar review queue",
      layout: "list" as const,
      config: original.config,
      isDefault: false,
    };
    const mutation = await context.seed.applyDatabase({
      projectId: context.manifest.projectId,
      storeEpoch: context.runtime.identity.storeEpoch,
      operationId: createUuidV7(),
      actor: { kind: "scenario_seed" },
      operations: [operation],
    });
    if (!mutation.ok) throw new Error(mutation.error.message);
    expect((await prepared.verify("Done")).passed).toBe(false);
    const filtered = await context.seed.applyDatabase({
      projectId: context.manifest.projectId,
      storeEpoch: context.runtime.identity.storeEpoch,
      operationId: createUuidV7(),
      actor: { kind: "scenario_seed" },
      operations: [
        {
          ...operation,
          expectedRevision: 1,
          config: {
            ...original.config,
            rules: {
              ...original.config.rules,
              propertyFilters: [
                {
                  filterId: createUuidV7(),
                  clause: {
                    kind: "clause",
                    propertyId: "status",
                    operator: "select_is",
                    value: "review",
                  },
                },
              ],
            },
          },
        },
      ],
    });
    if (!filtered.ok) throw new Error(filtered.error.message);
    expect(await prepared.verify("Done")).toMatchObject({ passed: true });
  });
});

const rawReadArguments = [
  { name: "read", args: (id: string) => ["--json", "read", id] },
  { name: "sed", args: (id: string) => ["sed", "-n", "1,20p", id] },
  {
    name: "SQL JSON parameter",
    args: (id: string) => [
      "sql",
      "query",
      "SELECT nested_markdown FROM page_documents WHERE page_id = :id",
      "--param",
      `id=${JSON.stringify(id)}`,
      "--raw",
    ],
  },
  {
    name: "SQL equals parameter",
    args: (id: string) => [
      "sql",
      "query",
      "SELECT nested_markdown FROM page_documents WHERE page_id = :id",
      `--param=id=${JSON.stringify(id)}`,
      "--raw",
    ],
  },
];
for (const form of rawReadArguments)
  test(`concurrency injection recognizes ${form.name} identity when raw body omits it`, async () => {
    await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
      const prepared = await CASES.find((item) => item.id === "concurrent-edit")!.prepare(
        context,
        0,
      );
      const target = (await rows(context)).find((item) => item.title === "Cedar release plan")!;
      await prepared.afterCommand?.({
        args: form.args(context.manifest.pageIdsByKey.meeting!),
        stdout: "Release date: Friday.",
        exitCode: 0,
      });
      expect((await prepared.verify("Conflict")).passed).toBe(false);
      await prepared.afterCommand?.({
        args: form.args(target.page_id),
        stdout: "Release date: Friday.",
        exitCode: 1,
      });
      expect((await prepared.verify("Conflict")).passed).toBe(false);
      await prepared.afterCommand?.({
        args: form.args(target.page_id),
        stdout: "Release date: Friday.",
        exitCode: 0,
      });
      expect(
        await prepared.verify("The date changed to Tuesday; I left it unchanged."),
      ).toMatchObject({ passed: true });
    });
  });

test("empty-result oracle rejects an extra standalone Library Page", async () => {
  await withCoreScenario({ scenarioId: "agent/cli-workflow" }, async (context) => {
    const prepared = await CASES.find((item) => item.id === "empty-search")!.prepare(context, 0);
    expect(await prepared.verify("No matching Pages.")).toMatchObject({ passed: true });
    await context.seed.createStandalonePage({
      projectId: context.manifest.projectId,
      pageId: createUuidV7(),
      documentId: createUuidV7(),
      operationId: createUuidV7(),
      title: "Unrequested Library Page",
    });
    expect((await prepared.verify("No matching Pages.")).passed).toBe(false);
  });
});
