import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { BlockNoteEditor } from "@blocknote/core";
import { blocksToYXmlFragment } from "@blocknote/core/yjs";
import { Awareness, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { test } from "vite-plus/test";
import * as Y from "yjs";
import { materializePageDocument, populateBlockDocumentBodyFromNfm } from "./block-document-codec";
import { assertValidBlockDocument } from "./block-structure";
import { createBodyOnlyBlockDocument } from "./body-only-block-document";
import {
  inspectRegisteredOwnedBlockDocument,
  toPersistedBlockDocumentMaterialization,
} from "./document-schema-adapters";
import { createPageDocument } from "./page-document";
import { replaceYTextWithPortableRichText } from "./portable-rich-text";
import { createSyncedBlockDocument } from "./synced-block-document";
import {
  headlessBlockDocumentSchema,
  type HeadlessBlockDocumentPartialBlock,
} from "./headless-blocknote-schema";

const outputRoot = path.resolve("crates/nodex-core/tests/fixtures/yjs-yrs");

const firstXmlText = (node: Y.XmlFragment | Y.XmlElement): Y.XmlText => {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) return child;
    if (!(child instanceof Y.XmlElement)) continue;
    try {
      return firstXmlText(child);
    } catch {
      // Continue with the next branch.
    }
  }
  throw new Error("fixture does not contain Y.XmlText");
};

const cloneFrom = (update: Uint8Array, clientId: number): Y.Doc => {
  const document = new Y.Doc({ guid: "nodex-yjs-yrs-conformance" });
  document.clientID = clientId;
  Y.applyUpdate(document, update);
  return document;
};

const schemaMatrixContent = [
  {
    id: "matrix-paragraph",
    type: "paragraph",
    content: [
      { type: "text", text: "bold", styles: { bold: true } },
      { type: "text", text: " italic", styles: { italic: true } },
      { type: "text", text: " strike", styles: { strike: true } },
      { type: "text", text: " underline", styles: { underline: true } },
      { type: "text", text: " code", styles: { code: true } },
      {
        type: "link",
        href: "https://nodex.local/matrix",
        content: [{ type: "text", text: " link", styles: { bold: true } }],
      },
    ],
  },
  {
    id: "matrix-callout",
    type: "callout",
    props: { icon: "📌" },
    content: [
      { type: "text", text: "Before ", styles: { bold: true } },
      {
        type: "attachment",
        props: {
          kind: "file",
          mode: "materialized",
          source: "nodex://assets/example.txt",
          name: "example.txt",
          mimeType: "text/plain",
          bytes: 12,
          origin: "paste",
        },
      },
      {
        type: "agentConfig",
        props: {
          mode: "agent",
          provider: "openai",
          model: "gpt-5",
          reasoning: "high",
          speed: "fast",
          permission: "auto",
          unknownAttributes: "",
          rawAttributes: "mode=agent",
        },
      },
      {
        type: "dateMention",
        props: {
          start: "2026-07-18T09:00:00+08:00",
          end: "2026-07-18T10:00:00+08:00",
          tz: "Asia/Shanghai",
          format: "datetime",
          timeFormat: "24h",
          reminder: "PT15M",
        },
      },
      { type: "threadMention", props: { uuid: "thread-matrix" } },
      { type: "text", text: " after 😀 中文 e\u0301", styles: { italic: true } },
    ],
  },
  {
    id: "matrix-heading",
    type: "heading",
    props: { level: 2 },
    content: "Heading",
  },
  { id: "matrix-bullet", type: "bulletListItem", content: "Bullet" },
  { id: "matrix-numbered", type: "numberedListItem", content: "Numbered" },
  {
    id: "matrix-check",
    type: "checkListItem",
    props: { checked: true },
    content: "Checked",
  },
  {
    id: "matrix-toggle",
    type: "toggleListItem",
    content: "Toggle",
    children: [{ id: "matrix-toggle-child", type: "paragraph", content: "Nested" }],
  },
  {
    id: "matrix-code",
    type: "codeBlock",
    props: { language: "typescript" },
    content: "const core = 'rust';",
  },
  { id: "matrix-quote", type: "quote", content: "Quote" },
  { id: "matrix-divider", type: "divider" },
  {
    id: "matrix-image",
    type: "image",
    props: {
      url: "nodex://assets/matrix.png",
      caption: "Matrix",
      name: "matrix.png",
    },
  },
  {
    id: "matrix-table",
    type: "table",
    content: {
      type: "tableContent",
      columnWidths: [160, undefined],
      rows: [
        {
          cells: [
            {
              type: "tableCell",
              props: {
                backgroundColor: "default",
                textColor: "default",
                textAlignment: "left",
              },
              content: [{ type: "text", text: "Key", styles: { bold: true } }],
            },
            {
              type: "tableCell",
              props: {
                backgroundColor: "default",
                textColor: "default",
                textAlignment: "left",
              },
              content: [{ type: "text", text: "Value", styles: {} }],
            },
          ],
        },
      ],
    },
  },
  {
    id: "matrix-thread-section",
    type: "threadSection",
    props: { label: "Implementation", threadId: "thread-1" },
  },
  { id: "matrix-page", type: "page" },
  { id: "matrix-database", type: "database" },
  {
    id: "matrix-page-ref",
    type: "pageRef",
    props: { targetBlockId: "page-target" },
  },
  {
    id: "matrix-database-view-ref",
    type: "databaseViewRef",
    props: { databaseViewId: "view-1", displayHint: "Planning" },
  },
  {
    id: "matrix-synced-ref",
    type: "syncedBlockRef",
    props: { sourceBlockId: "synced-source-1" },
  },
  {
    id: "matrix-template-ref",
    type: "templateRef",
    props: { sourceBlockId: "template-source-1", displayHint: "Review" },
  },
] satisfies HeadlessBlockDocumentPartialBlock[];

const createSchemaMatrix = (): {
  readonly document: Y.Doc;
  readonly blockTypes: readonly string[];
} => {
  const editor = BlockNoteEditor.create({
    schema: headlessBlockDocumentSchema,
    initialContent: schemaMatrixContent,
  });
  const document = new Y.Doc({ guid: "nodex-yjs-yrs-schema-matrix" });
  document.clientID = 1_101;
  replaceYTextWithPortableRichText(document.getText("title"), [
    { type: "text", text: "Schema ", styles: { bold: true } },
    {
      type: "link",
      text: "matrix 😀",
      href: "https://nodex.local/schema-matrix",
      styles: { italic: true, color: "blue" },
    },
    { type: "linebreak" },
    { type: "threadMention", uuid: "thread-title-matrix" },
    { type: "text", text: " at ", styles: {} },
    { type: "dateMention", start: "2026-07-18", format: "ll" },
  ]);
  blocksToYXmlFragment(editor, editor.document, document.getXmlFragment("body"));
  const root = document.getXmlFragment("body").get(0);
  if (!(root instanceof Y.XmlElement)) {
    throw new TypeError("schema matrix requires a canonical blockGroup root");
  }
  root.setAttribute("portableProbe", {
    undefinedValue: undefined,
    nullValue: null,
    booleanValue: true,
    numberValue: 42.5,
    stringValue: "portable 😀",
    binaryValue: new Uint8Array([0, 1, 127, 255]),
    arrayValue: [undefined, null, { nested: ["值", 7] }],
  } as unknown as string);
  return {
    document,
    blockTypes: editor.document.map((block) => block.type),
  };
};

const generate = process.env.NODEX_GENERATE_YJS_YRS_FIXTURES === "1" ? test : test.skip;

generate("generates stable Yjs 13 fixtures for the Yrs compatibility corpus", async () => {
  const page = createPageDocument({
    documentId: "nodex-yjs-yrs-conformance",
    initializeBody: false,
  });
  page.document.clientID = 1_001;
  replaceYTextWithPortableRichText(page.title, [
    { type: "text", text: "迁移 😀 e\u0301 ", styles: { bold: true } },
    {
      type: "link",
      text: "Nodex",
      href: "https://nodex.local/core",
      styles: { italic: true },
    },
  ]);
  let blockIndex = 0;
  populateBlockDocumentBodyFromNfm(
    page.body,
    [
      "# Runtime",
      "Parent **bold** with [link](https://nodex.local/spec) 😀 中文 e\u0301",
      "\tNested child",
      "Sibling",
    ].join("\n"),
    () => `fixture-block-${++blockIndex}`,
  );
  const base = Y.encodeStateAsUpdate(page.document);
  const baseVector = Y.encodeStateVector(page.document);

  const first = cloneFrom(base, 1_002);
  first.transact(() => {
    first.getText("title").insert(0, "A ", { underline: true });
    const text = firstXmlText(first.getXmlFragment("body"));
    text.format(0, Math.min(text.length, 7), { code: true });
  }, "first-concurrent-edit");
  const firstUpdate = Y.encodeStateAsUpdate(first, baseVector);

  const second = cloneFrom(base, 1_003);
  second.transact(() => {
    const title = second.getText("title");
    title.insert(title.length, " B");
    const text = firstXmlText(second.getXmlFragment("body"));
    text.insert(text.length, " · concurrent");
  }, "second-concurrent-edit");
  const secondUpdate = Y.encodeStateAsUpdate(second, baseVector);

  const merged = cloneFrom(base, 1_004);
  Y.applyUpdate(merged, firstUpdate);
  Y.applyUpdate(merged, secondUpdate);
  const materialization = materializePageDocument(merged);

  const dependencySource = new Y.Doc({ guid: "missing-dependency" });
  dependencySource.clientID = 1_005;
  dependencySource.getText("title").insert(0, "base");
  const dependencyVector = Y.encodeStateVector(dependencySource);
  dependencySource.getText("title").insert(4, "-missing-base");
  const missingDependency = Y.encodeStateAsUpdate(dependencySource, dependencyVector);

  const matrix = createSchemaMatrix();
  const matrixMaterialization = {
    ...materializePageDocument(matrix.document),
    searchUnits: assertValidBlockDocument(matrix.document.getXmlFragment("body")).map(
      (block, ordinal) => ({
        blockId: block.id,
        parentBlockId: block.parentBlockId,
        ordinal,
        blockType: block.blockType,
        text: block.text,
      }),
    ),
  };
  const matrixBase = Y.encodeStateAsUpdate(matrix.document);
  const matrixStateVector = Y.encodeStateVector(matrix.document);
  const matrixAfter = cloneFrom(matrixBase, 1_102);
  const matrixText = firstXmlText(matrixAfter.getXmlFragment("body"));
  matrixAfter.transact(() => {
    matrixText.delete(0, Math.min(2, matrixText.length));
    matrixText.insert(0, "JS checkpoint edit ");
  }, "matrix-after-checkpoint");
  const matrixAfterUpdate = Y.encodeStateAsUpdate(matrixAfter, matrixStateVector);
  const nfmParserOracle = createPageDocument({
    documentId: "nodex-yjs-yrs-nfm-parser-oracle",
    initializeBody: false,
  });
  let nfmParserBlockIndex = 0;
  populateBlockDocumentBodyFromNfm(
    nfmParserOracle.body,
    matrixMaterialization.nfm,
    () => `oracle-nfm-${++nfmParserBlockIndex}`,
  );
  const nfmParserMaterialization = materializePageDocument(nfmParserOracle.document);

  const emptyPage = createPageDocument({
    documentId: "nodex-yjs-yrs-empty-page",
    initializeBody: false,
  });
  emptyPage.document.clientID = 1_301;
  populateBlockDocumentBodyFromNfm(emptyPage.body, "", () => "empty-page-paragraph");
  const emptyPageMaterialization = materializePageDocument(emptyPage.document);

  const syncedBlock = createSyncedBlockDocument({
    documentId: "nodex-yjs-yrs-empty-synced-block",
    initializeBody: false,
  });
  syncedBlock.document.clientID = 1_302;
  syncedBlock.body.insert(0, [new Y.XmlElement("blockGroup")]);
  const syncedBlockMaterialization = toPersistedBlockDocumentMaterialization(
    inspectRegisteredOwnedBlockDocument(syncedBlock.document, {
      ownerType: "synced_block_source",
      schemaKey: "nodex.synced-block",
      schemaVersion: 2,
    }).materialization,
  );

  const reusableTemplate = createBodyOnlyBlockDocument({
    documentId: "nodex-yjs-yrs-reusable-template",
    initializeBody: false,
    label: "Reusable Template",
  });
  reusableTemplate.document.clientID = 1_303;
  let templateIndex = 0;
  populateBlockDocumentBodyFromNfm(
    reusableTemplate.body,
    "Template **body** 😀",
    () => `template-block-${++templateIndex}`,
  );
  const reusableTemplateMaterialization = toPersistedBlockDocumentMaterialization(
    inspectRegisteredOwnedBlockDocument(reusableTemplate.document, {
      ownerType: "reusable_template_source",
      schemaKey: "nodex.reusable-template",
      schemaVersion: 2,
    }).materialization,
  );

  const awarenessDocument = new Y.Doc({ guid: "nodex-awareness-fixture" });
  awarenessDocument.clientID = 1_201;
  const awareness = new Awareness(awarenessDocument);
  awareness.setLocalState({
    user: { id: "fixture-user", name: "迁移 😀" },
    cursor: { anchor: 3, head: 5 },
  });
  const awarenessAdded = encodeAwarenessUpdate(awareness, [awarenessDocument.clientID]);
  removeAwarenessStates(awareness, [awarenessDocument.clientID], "fixture-disconnect");
  const awarenessRemoved = encodeAwarenessUpdate(awareness, [awarenessDocument.clientID]);
  awareness.destroy();

  await mkdir(outputRoot, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputRoot, "base.bin"), base),
    writeFile(path.join(outputRoot, "first.bin"), firstUpdate),
    writeFile(path.join(outputRoot, "second.bin"), secondUpdate),
    writeFile(path.join(outputRoot, "missing-dependency.bin"), missingDependency),
    writeFile(path.join(outputRoot, "matrix-base.bin"), matrixBase),
    writeFile(path.join(outputRoot, "matrix-state-vector.bin"), matrixStateVector),
    writeFile(path.join(outputRoot, "matrix-after.bin"), matrixAfterUpdate),
    writeFile(path.join(outputRoot, "empty-page.bin"), Y.encodeStateAsUpdate(emptyPage.document)),
    writeFile(
      path.join(outputRoot, "empty-synced-block.bin"),
      Y.encodeStateAsUpdate(syncedBlock.document),
    ),
    writeFile(
      path.join(outputRoot, "reusable-template.bin"),
      Y.encodeStateAsUpdate(reusableTemplate.document),
    ),
    writeFile(
      path.join(outputRoot, "root-materializations.json"),
      `${JSON.stringify(
        {
          emptyPage: emptyPageMaterialization,
          emptySyncedBlock: syncedBlockMaterialization,
          reusableTemplate: reusableTemplateMaterialization,
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(
      path.join(outputRoot, "matrix-materialization.json"),
      `${JSON.stringify(matrixMaterialization, null, 2)}\n`,
    ),
    writeFile(
      path.join(outputRoot, "nfm-parser-oracle.json"),
      `${JSON.stringify(
        {
          input: matrixMaterialization.nfm,
          blockTree: nfmParserMaterialization.blockTree,
          nfm: nfmParserMaterialization.nfm,
        },
        null,
        2,
      )}\n`,
    ),
    writeFile(path.join(outputRoot, "awareness-added.bin"), awarenessAdded),
    writeFile(path.join(outputRoot, "awareness-removed.bin"), awarenessRemoved),
    writeFile(
      path.join(outputRoot, "manifest.json"),
      `${JSON.stringify(
        {
          version: 2,
          yjsVersion: "13.6.31",
          title: merged.getText("title").toString(),
          bodyXml: merged.getXmlFragment("body").toString(),
          nfm: materialization.nfm,
          blockIds: materialization.blockTree.map((block) => block.id),
          matrix: {
            title: matrix.document.getText("title").toString(),
            bodyXml: matrix.document.getXmlFragment("body").toString(),
            blockTypes: matrix.blockTypes,
          },
          awareness: {
            clientId: awarenessDocument.clientID,
            state: {
              user: { id: "fixture-user", name: "迁移 😀" },
              cursor: { anchor: 3, head: 5 },
            },
          },
        },
        null,
        2,
      )}\n`,
    ),
  ]);
});
