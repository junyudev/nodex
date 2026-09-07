import { readFile } from "node:fs/promises";
import path from "node:path";
import * as Y from "yjs";
import { createCoreDocumentSyncAdapter } from "../../src/main/core-client/document-sync-adapter";
import {
  materializePageDocument,
  createBlockDocumentNfmContentParitySignature,
  type BlockTreeNode,
  type BlockTreeValue,
} from "../../src/shared/block-documents/block-document-codec";
import { createUuidV7 } from "../../src/shared/uuid-v7";
import type { EvaluationContext } from "./contracts";
import type { CaseAssertion, CaseDefinition, CaseVerification, PreparedCase } from "./contracts";

type Context = EvaluationContext;

/** Raw output omits identity; recover it only from typed selector/parameter arguments. */
function commandReadsPage(args: readonly string[], pageId: string): boolean {
  const valueOptions = new Set([
    "--expect-profile",
    "--project",
    "--database",
    "--page",
    "--output-format",
    "--help-schema",
    "--after",
    "--limit",
    "--format",
    "--param",
    "--bind",
    "--file",
  ]);
  const positional: string[] = [];
  const parameters: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith("-")) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf("=");
    const option = equals < 0 ? argument : argument.slice(0, equals);
    if (!valueOptions.has(option)) continue;
    const value = equals < 0 ? args[++index] : argument.slice(equals + 1);
    if (option === "--param" && value !== undefined) parameters.push(value);
  }
  if (positional[0] === "read") return positional[1] === pageId;
  if (positional[0] === "sed") return positional[2] === pageId;
  if (positional[0] !== "sql" || positional[1] !== "query") return false;
  return parameters.some((parameter) => {
    const equals = parameter.indexOf("=");
    if (equals <= 0) return false;
    try {
      return JSON.parse(parameter.slice(equals + 1)) === pageId;
    } catch {
      return false;
    }
  });
}
const result = (assertions: readonly CaseAssertion[]): CaseVerification => ({
  passed: assertions.every((item) => item.passed),
  assertions,
});
const check = (name: string, passed: boolean): CaseAssertion => ({ name, passed });
const canonical = createBlockDocumentNfmContentParitySignature;

/** Complete authorized Page inventory, including standalone Pages and Source rows. */
async function projectPageIds(context: Context): Promise<string[]> {
  const snapshot = await context.runtime.rootClient.libraryRead({
    kind: "project_page_search_metadata",
    project_ids: [context.manifest.projectId],
    page_ids: null,
  });
  if (snapshot.value.kind !== "project_page_search_metadata")
    throw new Error("Expected Project Page inventory");
  return snapshot.value.items.map((item) => item.page_id).sort();
}

async function database(context: Context) {
  const read = await context.seed.readDatabase({
    projectId: context.manifest.projectId,
    read: { target: { kind: "project_default" }, mode: "database" },
  });
  if (!read.ok) throw new Error(read.error.message);
  if (read.value.value.kind !== "database") throw new Error("Expected Database");
  return read.value.value.value;
}
async function source(context: Context) {
  const item = (await database(context)).dataSources[0];
  if (!item) throw new Error("Expected primary Data Source");
  const read = await context.seed.readDatabase({
    projectId: context.manifest.projectId,
    read: { target: { kind: "data_source", dataSourceId: item.dataSourceId }, mode: "data_source" },
  });
  if (!read.ok) throw new Error(read.error.message);
  if (read.value.value.kind !== "data_source") throw new Error("Expected Data Source");
  return read.value.value.value;
}
async function observe(context: Context, pageId: string) {
  const client = context.runtime.clientForProject(context.manifest.projectId);
  const detail = await client.libraryRead({ kind: "page_detail", page_id: pageId });
  if (detail.value.kind !== "page_detail") throw new Error("Expected Page detail");
  const descriptor = await client.documentRead(createUuidV7(), {
    kind: "descriptor",
    owner_block_id: pageId,
  });
  if (descriptor.value.kind !== "descriptor") throw new Error("Expected Document descriptor");
  const doc = new Y.Doc({ guid: descriptor.value.descriptor.documentId });
  const clientSessionId = createUuidV7();
  const stream = await client.openDocumentEventStream(
    { documentId: doc.guid, clientSessionId },
    () => undefined,
    () => undefined,
    () => undefined,
  );
  try {
    const synced = await createCoreDocumentSyncAdapter(client).sync({
      documentId: doc.guid,
      clientSessionId,
      stateVector: Y.encodeStateVector(doc),
    });
    if (!synced.ok) throw new Error(synced.error.message);
    Y.applyUpdate(doc, synced.value.update);
    const body = materializePageDocument(doc);
    const membership = detail.value.value.data_source_context;
    return {
      title: body.title,
      blockTree: body.blockTree,
      nfm: canonical(body.nfm),
      values:
        membership.kind === "member"
          ? Object.fromEntries(
              Object.entries(membership.values).map(([key, value]) => [
                key,
                readPropertyValue(value),
              ]),
            )
          : {},
    };
  } finally {
    await stream.close();
    doc.destroy();
  }
}
async function createPage(
  context: Context,
  title: string,
  nfm: string,
  status: "build" | "review" = "build",
) {
  const pageId = createUuidV7();
  await context.seed.createPage({
    key: pageId,
    pageId,
    operationId: createUuidV7(),
    projectId: context.manifest.projectId,
    status,
    title,
    nfm,
  });
  return pageId;
}
async function replace(context: Context, pageId: string, nfm: string) {
  await context.seed.replaceOwnedDocument({
    pageId,
    nfm,
    projectId: context.manifest.projectId,
    operationId: createUuidV7(),
    mutationId: createUuidV7(),
    clientSessionId: "agent-eval:fixture",
  });
}
function readPropertyValue(value: unknown): unknown {
  if (typeof value !== "object" || value === null || !("value" in value))
    throw new Error("Invalid property observation");
  return value.value;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
async function unchanged(
  context: Context,
  before: ReadonlyMap<string, Awaited<ReturnType<typeof observe>>>,
) {
  return Promise.all(
    [...before].map(async ([id, value]) =>
      check(`Page ${id} unchanged`, same(value, await observe(context, id))),
    ),
  );
}
/** Preserve the exact rich document while changing the requested text value. */
function mondayValue(value: BlockTreeValue): BlockTreeValue {
  if (typeof value === "string")
    return value === "Release date: Friday." ? "Release date: Monday." : value;
  if (Array.isArray(value)) return value.map(mondayValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mondayValue(item)]));
}
function mondayBlocks(blocks: readonly BlockTreeNode[]): readonly BlockTreeNode[] {
  return blocks.map((block) => ({
    ...block,
    ...(block.content === undefined ? {} : { content: mondayValue(block.content) }),
    children: mondayBlocks(block.children),
  }));
}
const VARIANTS = ["Cedar", "Harbor", "Juniper"] as const;

async function prepare(context: Context, variant: number, id: string): Promise<PreparedCase> {
  const name = VARIANTS[variant];
  if (!name) throw new Error("Case variant must be 0, 1, or 2");
  const meeting = context.manifest.pageIdsByKey.meeting;
  if (!meeting) throw new Error("Missing meeting fixture");
  const title = `${name} release plan`;
  const original = `# ${name} release\n\nRelease date: Friday.\n\n## Rollback\n\nKeep **database snapshots** for seven days.\n\n- Verify backups\n\t- Verify restore procedure\n- Record owner: Mina\n\nTracking code: ${name.toUpperCase()}-42.`;
  const target = await createPage(context, title, original);
  const sentinel = await createPage(
    context,
    `${name} archived plan`,
    "Release date: Friday.\n\nNever edit this archived reference.",
  );
  const before = new Map(
    await Promise.all(
      [meeting, target, sentinel].map(
        async (pageId) => [pageId, await observe(context, pageId)] as const,
      ),
    ),
  );
  const initialPageIds = await projectPageIds(context);
  const samePages = async () =>
    check(
      "Project Page identities preserved",
      same(
        await projectPageIds(context),
        [...new Set([...initialPageIds, ...before.keys()])].sort(),
      ),
    );
  const noChanges = async () => [...(await unchanged(context, before)), await samePages()];
  const promptPrefix = `Work in the current Project. `;
  const expectedBody = async (
    nfm: string,
    verifyBlocks?: (blocks: readonly BlockTreeNode[]) => CaseAssertion,
  ) => {
    const state = await observe(context, target);
    const unaffected = new Map([...before].filter(([key]) => key !== target));
    return result([
      check("Requested body, including all unaffected content", state.nfm === canonical(nfm)),
      ...(verifyBlocks ? [verifyBlocks(state.blockTree)] : []),
      check("Title preserved", state.title === title),
      check("Properties preserved", same(state.values, before.get(target)?.values)),
      ...(await unchanged(context, unaffected)),
      await samePages(),
    ]);
  };
  if (id === "read-detail")
    return {
      prompt: `${promptPrefix}Read “${title}”. What is its tracking code and how long must database snapshots be kept? Include the Page ID so I can find it.`,
      verify: async (answer) =>
        result([
          check("Correct tracking code", answer.includes(`${name.toUpperCase()}-42`)),
          check("Retention answered", /(?:seven|7)\s+days|七天/.test(answer)),
          check("Correct Page citation", answer.includes(target)),
          ...(await noChanges()),
        ]),
    };
  if (id === "exact-edit")
    return {
      prompt: `${promptPrefix}In “${title}”, change the release date from Friday to Monday. Preserve everything else.`,
      verify: () =>
        expectedBody(original.replace("Friday", "Monday"), (blocks) =>
          check(
            "Exact Block identities, topology, properties, and rich content preserved",
            same(blocks, mondayBlocks(before.get(target)!.blockTree)),
          ),
        ),
    };
  if (id === "append-section")
    return {
      prompt: `${promptPrefix}Append a paragraph saying “Sign-off owner: Ravi.” to “${title}”. Preserve all existing content and properties.`,
      verify: () =>
        expectedBody(`${original}\n\nSign-off owner: Ravi.`, (blocks) => {
          const originalBlocks = before.get(target)!.blockTree;
          return check(
            "Existing Block identities, topology, properties, and rich content preserved",
            blocks.length === originalBlocks.length + 1 &&
              same(blocks.slice(0, originalBlocks.length), originalBlocks),
          );
        }),
    };
  if (id === "rename-page")
    return {
      prompt: `${promptPrefix}Rename “${title}” to “${name} launch checklist”. Preserve its body and properties.`,
      verify: async () => {
        const state = await observe(context, target);
        return result([
          check("New title", state.title === `${name} launch checklist`),
          check("Body preserved", state.nfm === before.get(target)?.nfm),
          check("Properties preserved", same(state.values, before.get(target)?.values)),
          ...(await unchanged(context, new Map([...before].filter(([key]) => key !== target)))),
          await samePages(),
        ]);
      },
    };
  if (id === "empty-search")
    return {
      prompt: `${promptPrefix}Find any Pages mentioning “${name}-quantum-migration-absent”. If there are none, tell me; do not create anything.`,
      verify: async (answer) =>
        result([
          check(
            "Explicit empty result",
            /no |none|not found|couldn.t find|did not find|zero|没有|未找到/i.test(answer),
          ),
          ...(await noChanges()),
        ]),
    };
  if (id === "ambiguous-title") {
    const duplicate = await createPage(
      context,
      title,
      "A second active release plan.\n\nRelease date: Thursday.",
    );
    before.set(duplicate, await observe(context, duplicate));
    return {
      prompt: `${promptPrefix}Change the release date in “${title}” to Monday.`,
      verify: async (answer) =>
        result([
          check(
            "Asks which matching Page",
            /which|clarif|choose|specify|哪|确认|选择/i.test(answer),
          ),
          ...(await noChanges()),
        ]),
    };
  }
  if (id === "concurrent-edit") {
    let injected = false;
    const concurrent = original.replace("Friday", "Tuesday");
    return {
      prompt: `${promptPrefix}In “${title}”, change the release date to Monday only if it is still Friday. If another change conflicts, leave it and explain the conflict. Preserve everything else.`,
      afterCommand: async (call) => {
        if (
          injected ||
          call.exitCode !== 0 ||
          (!call.stdout.includes(target) && !commandReadsPage(call.args, target)) ||
          !call.stdout.includes("Friday")
        )
          return;
        injected = true;
        await replace(context, target, concurrent);
      },
      verify: async (answer) =>
        result([
          check("Concurrent writer ran after relevant observation", injected),
          check(
            "Concurrent value preserved",
            (await observe(context, target)).nfm === canonical(concurrent),
          ),
          check(
            "Conflict communicated",
            /conflict|changed|Tuesday|no longer|冲突|周二|已.*改/i.test(answer),
          ),
          ...(await unchanged(context, new Map([...before].filter(([key]) => key !== target)))),
          await samePages(),
        ]),
    };
  }
  if (id === "export-file") {
    const bytes = new TextEncoder().encode(
      `Release evidence for ${name}.\nExact checksum fixture ${variant}.\n`,
    );
    const fileId = createUuidV7();
    await context.seed.createLibraryFile({
      operationId: createUuidV7(),
      projectId: context.manifest.projectId,
      fileId,
      defaultName: `${name}-evidence.txt`,
      mimeType: "text/plain",
      bytes,
    });
    await context.seed.addPageFileEntry({
      operationId: createUuidV7(),
      projectId: context.manifest.projectId,
      pageId: target,
      fileId,
      logicalPath: "evidence/release.txt",
      expectedManifestRevision: 0,
    });
    const inventory = await context.seed.readPageFileInventory(context.manifest.projectId, target);
    return {
      prompt: `${promptPrefix}Export the attached evidence file from “${title}” to release-evidence.txt in the working directory.`,
      verify: async () => {
        let exported: Uint8Array | null = null;
        try {
          exported = await readFile(
            path.join(context.profile.initialProjectsDirectory, "release-evidence.txt"),
          );
        } catch {
          /* A missing output is an assertion failure. */
        }
        return result([
          check(
            "Exact exported bytes",
            exported !== null && Buffer.from(exported).equals(Buffer.from(bytes)),
          ),
          check(
            "Attachment inventory preserved",
            same(
              inventory,
              await context.seed.readPageFileInventory(context.manifest.projectId, target),
            ),
          ),
          ...(await noChanges()),
        ]);
      },
    };
  }
  if (id === "create-risk-property") {
    const initial = await source(context);
    const initialDatabase = await database(context);
    return {
      prompt: `${promptPrefix}Add a text Property named “Risk note” to the task Data Source. Preserve existing Property definitions and Views.`,
      verify: async () => {
        const current = await source(context);
        const added = current.properties.filter(
          (item) => !initial.properties.some((old) => old.propertyId === item.propertyId),
        );
        return result([
          check(
            "One new text Property",
            added.length === 1 &&
              added[0]?.name === "Risk note" &&
              added[0]?.schema.kind === "text",
          ),
          check(
            "Existing definitions preserved",
            initial.properties.every((old) =>
              same(
                old,
                current.properties.find((item) => item.propertyId === old.propertyId),
              ),
            ),
          ),
          check("Views preserved", same(initialDatabase.views, (await database(context)).views)),
          ...(await noChanges()),
        ]);
      },
    };
  }
  if (id === "create-review-view") {
    const reviewId = await createPage(context, `${name} review sample`, "A review task.", "review");
    before.set(reviewId, await observe(context, reviewId));
    const initial = await database(context);
    return {
      prompt: `${promptPrefix}Create a List View named “${name} review queue” showing only tasks whose Status is Review. Preserve existing Views.`,
      verify: async () => {
        const current = await database(context);
        const added = current.views.filter(
          (item) => !initial.views.some((old) => old.viewId === item.viewId),
        );
        const view = added[0];
        const window =
          view?.layout === "list"
            ? await context.runtime.clientForProject(context.manifest.projectId).databaseRead({
                kind: "list_window",
                target: { kind: "view", view_id: view.viewId },
                window: { after: null, first: 100 },
              })
            : null;
        const rows = window?.value.kind === "list_window" ? window.value.value : null;
        const pageIds =
          rows?.rows.items.flatMap((row) => (row.kind === "page" ? [row.summary.page_id] : [])) ??
          [];
        return result([
          check(
            "One named List View",
            added.length === 1 && view?.name === `${name} review queue` && view.layout === "list",
          ),
          check(
            "View returns exactly Review tasks",
            rows?.is_complete === true && same([...new Set(pageIds)].sort(), [reviewId]),
          ),
          check(
            "Original Views preserved",
            initial.views.every((old) =>
              same(
                old,
                current.views.find((item) => item.viewId === old.viewId),
              ),
            ),
          ),
          ...(await noChanges()),
        ]);
      },
    };
  }
  const reviewIds: string[] = [];
  const tokens: string[] = [];
  for (let i = 0; i < variant + 3; i++) {
    const token = `${name.toUpperCase()}-BLOCKER-${i + 1}`;
    const pageId = await createPage(
      context,
      `${name} candidate ${i + 1}`,
      `Open blocker: ${token}.\n\nResolved issue: old-note-${i + 1}.`,
      "review",
    );
    reviewIds.push(pageId);
    tokens.push(token);
    before.set(pageId, await observe(context, pageId));
  }
  if (id === "review-summary")
    return {
      prompt: `${promptPrefix}Find all Review tasks for ${name}, read each task, and list each open blocker with its Page ID. Omit resolved issues.`,
      verify: async (answer) =>
        result([
          ...tokens.map((token) => check(`Blocker ${token}`, answer.includes(token))),
          ...reviewIds.map((pageId) => check(`Citation ${pageId}`, answer.includes(pageId))),
          check("Resolved issues omitted", !answer.includes("old-note-")),
          ...(await noChanges()),
        ]),
    };
  if (id === "bulk-priority")
    return {
      prompt: `${promptPrefix}Set Priority to High for all tasks currently in Review. Leave every other task and Property unchanged.`,
      verify: async () => {
        const assertions: CaseAssertion[] = [];
        for (const [pageId, old] of before) {
          const state = await observe(context, pageId);
          const values = { ...old.values };
          if (reviewIds.includes(pageId)) values.priority = "p1-high";
          assertions.push(
            check(`Exact values for ${pageId}`, same(state.values, values)),
            check(
              `Body and title for ${pageId}`,
              state.nfm === old.nfm && state.title === old.title,
            ),
          );
        }
        return result([...assertions, await samePages()]);
      },
    };
  throw new Error(`Unknown evaluation case: ${id}`);
}

const DEFINITIONS = [
  ["read-detail", "Read and cite a Page"],
  ["review-summary", "Find filtered Pages and summarize full bodies"],
  ["exact-edit", "Edit one body value without collateral changes"],
  ["append-section", "Append content while preserving the document"],
  ["rename-page", "Rename without changing body or Properties"],
  ["bulk-priority", "Update an exact set of task Properties"],
  ["export-file", "Export exact attachment bytes"],
  ["create-risk-property", "Extend a schema while preserving existing definitions"],
  ["create-review-view", "Create a filtered List View"],
  ["empty-search", "Report an empty result without mutation"],
  ["ambiguous-title", "Ask for clarification when Page titles are ambiguous"],
  ["concurrent-edit", "Respect a concurrent change after observation"],
] as const;
export const CASES: readonly CaseDefinition[] = DEFINITIONS.map(([id, prompt], index) => ({
  id,
  prompt,
  group: index >= 10 ? "holdout" : "core",
  prepare: (context, variant) => prepare(context, variant, id),
}));
