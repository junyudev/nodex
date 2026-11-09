import { readFile } from "node:fs/promises";
import path from "node:path";
import { createUuidV7 } from "../../../src/shared/uuid-v7";
import {
  parseScenarioFacts,
  type ScenarioDomainRecipe,
  type ScenarioFacts,
  type ScenarioManifest,
  type ScenarioSeedPort,
} from "../contracts";

export const PAGE_FILE_PROVENANCE_SCENARIO_ID = "page/file-provenance" as const;
export const PAGE_FILE_PROVENANCE_SCENARIO_REVISION = 2 as const;
export const PAGE_FILE_PROVENANCE_REPORT_PAGE_KEY = "coldStart" as const;
export const PAGE_FILE_PROVENANCE_MIXED_PAGE_KEY = "settings" as const;
export const PAGE_FILE_PROVENANCE_REPORT_CHAT_KEY = "coldStartChat" as const;
export const PAGE_FILE_PROVENANCE_MIXED_CHAT_KEY = "settingsChat" as const;

const FIXTURES = path.resolve("scripts/scenarios/fixtures/page-files");

/**
 * One Agent's report beside its Page, and a Page whose Files came from you, an Agent and its body.
 * Each body also refers to one of its Files inline, as a person or Agent writing about it would.
 */
export interface PageFileProvenanceScenarioFacts extends ScenarioFacts {
  readonly reportPageId: string;
  readonly mixedPageId: string;
  readonly reportChatId: string;
  readonly mixedChatId: string;
  readonly reportPaths: readonly string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const requirePageFileProvenanceScenarioFacts = (
  value: unknown,
): PageFileProvenanceScenarioFacts => {
  const envelope = parseScenarioFacts(value);
  if (
    !isRecord(value) ||
    envelope.scenarioId !== PAGE_FILE_PROVENANCE_SCENARIO_ID ||
    envelope.scenarioRevision !== PAGE_FILE_PROVENANCE_SCENARIO_REVISION ||
    typeof value.reportPageId !== "string" ||
    typeof value.mixedPageId !== "string" ||
    typeof value.reportChatId !== "string" ||
    typeof value.mixedChatId !== "string" ||
    !Array.isArray(value.reportPaths)
  ) {
    throw new Error("page/file-provenance facts are invalid");
  }
  return value as unknown as PageFileProvenanceScenarioFacts;
};

const COLD_START_BODY = [
  "Profile the dashboard's cold start and report the three biggest costs. Don't change code.",
  "",
  "## Findings",
  "",
  "1. Hydrating the whole workspace tree before first paint — 1.1 s",
  "2. The charts bundle isn't split (840 KB) — 0.6 s",
  "3. The font request blocks render — 0.3 s",
].join("\n");

const SETTINGS_BODY = [
  "Contrast on surfaces and secondary text in dark mode.",
  "",
  "Current light theme for reference:",
].join("\n");

const BRIEF = [
  "# Settings dark mode",
  "",
  "- Secondary text keeps 4.5:1 contrast on every surface.",
  "- Raised surfaces stay distinguishable without borders.",
  "- Keep the light theme unchanged.",
  "",
].join("\n");

interface FileFixture {
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

const attachmentDirective = (fileId: string, name: string, mimeType: string): string =>
  `:attachment{kind="file" source="nodex://files/${fileId}" name="${name}" mime="${mimeType}"}`;

const fixture = async (relative: string, mimeType: string): Promise<FileFixture> => ({
  path: relative,
  mimeType,
  bytes: new Uint8Array(await readFile(path.join(FIXTURES, relative))),
});

const materializePageFileProvenance = async (
  port: ScenarioSeedPort,
  workspace: string,
): Promise<ScenarioManifest> => {
  const project = await port.createProject({ name: "lumen-web", sources: [workspace] });
  if (!project.defaultDatabaseViewId) throw new Error("lumen-web has no default Database View");

  const reportPageId = createUuidV7();
  const mixedPageId = createUuidV7();
  await port.createPage({
    key: PAGE_FILE_PROVENANCE_REPORT_PAGE_KEY,
    pageId: reportPageId,
    operationId: createUuidV7(),
    projectId: project.id,
    status: "review",
    title: "Dashboard cold start",
    markdown: COLD_START_BODY,
  });
  await port.createPage({
    key: PAGE_FILE_PROVENANCE_MIXED_PAGE_KEY,
    pageId: mixedPageId,
    operationId: createUuidV7(),
    projectId: project.id,
    status: "doing",
    title: "Settings dark mode",
    markdown: SETTINGS_BODY,
  });

  const reportChat = await port.createRelatedChat({
    projectId: project.id,
    relatedPageIds: [reportPageId],
    noThreadFallbackTitle: "Dashboard cold start",
    thread: {
      threadId: createUuidV7(),
      threadName: "Dashboard cold start",
      threadPreview: "Profiling the dashboard's cold start",
      statusType: "idle",
      statusActiveFlags: [],
      unread: false,
    },
  });
  const mixedChat = await port.createRelatedChat({
    projectId: project.id,
    relatedPageIds: [mixedPageId],
    noThreadFallbackTitle: "Settings dark mode",
  });

  let revision = { [reportPageId]: 0, [mixedPageId]: 0 };
  const attach = async (
    pageId: string,
    file: FileFixture,
    attachedByAgent?: { readonly sessionId: string; readonly backend: "codex" | "claude" },
  ) => {
    const fileId = createUuidV7();
    await port.createLibraryFile({
      operationId: createUuidV7(),
      projectId: project.id,
      fileId,
      defaultName: path.basename(file.path),
      mimeType: file.mimeType,
      bytes: file.bytes,
    });
    const receipt = await port.addPageFileEntry({
      operationId: createUuidV7(),
      projectId: project.id,
      pageId,
      fileId,
      logicalPath: file.path,
      expectedManifestRevision: revision[pageId] ?? 0,
      ...(attachedByAgent ? { attachedByAgent } : {}),
    });
    revision = { ...revision, [pageId]: receipt.manifest_revision };
    return fileId;
  };

  // The profiling chat's Agent attaches its report, flame graph and raw trace together.
  const reportFiles = [
    await fixture("cold-start/report.html", "text/html"),
    await fixture("cold-start/flamegraph.png", "image/png"),
    await fixture("cold-start/trace.json", "application/json"),
  ].map((file) => ({ ...file, path: `profile/${path.basename(file.path)}` }));
  const reportFileIds: string[] = [];
  for (const file of reportFiles) {
    reportFileIds.push(
      await attach(reportPageId, file, { sessionId: reportChat.sessionId, backend: "codex" }),
    );
  }
  const reportBody = await port.replaceOwnedDocument({
    mutationId: createUuidV7(),
    operationId: createUuidV7(),
    clientSessionId: `scenario:${PAGE_FILE_PROVENANCE_SCENARIO_ID}`,
    projectId: project.id,
    pageId: reportPageId,
    markdown: `${COLD_START_BODY}\n\nFull write-up: ${attachmentDirective(reportFileIds[0]!, "report.html", "text/html")}`,
  });

  // Mixed origins: your brief, the design chat's mockup, and an image placed in the body.
  const briefFileId = await attach(mixedPageId, {
    path: "brief.md",
    mimeType: "text/markdown",
    bytes: new TextEncoder().encode(BRIEF),
  });
  const dark = await fixture("settings/settings-dark.png", "image/png");
  await attach(
    mixedPageId,
    { ...dark, path: "mockups/settings-dark.png" },
    { sessionId: mixedChat.sessionId, backend: "claude" },
  );
  const light = await fixture("settings/settings-light.png", "image/png");
  const lightFileId = createUuidV7();
  await port.createLibraryFile({
    operationId: createUuidV7(),
    projectId: project.id,
    fileId: lightFileId,
    defaultName: "settings-light.png",
    mimeType: light.mimeType,
    bytes: light.bytes,
  });
  const body = await port.replaceOwnedDocument({
    mutationId: createUuidV7(),
    operationId: createUuidV7(),
    clientSessionId: `scenario:${PAGE_FILE_PROVENANCE_SCENARIO_ID}`,
    projectId: project.id,
    pageId: mixedPageId,
    markdown: [
      `Requirements are in ${attachmentDirective(briefFileId, "brief.md", "text/markdown")}.`,
      "",
      SETTINGS_BODY,
      "",
      `![Settings, light](nodex://files/${lightFileId})`,
    ].join("\n"),
  });

  return {
    version: 1,
    scenarioId: PAGE_FILE_PROVENANCE_SCENARIO_ID,
    scenarioRevision: PAGE_FILE_PROVENANCE_SCENARIO_REVISION,
    projectId: project.id,
    databaseViewId: project.defaultDatabaseViewId,
    pageIdsByKey: {
      [PAGE_FILE_PROVENANCE_REPORT_PAGE_KEY]: reportPageId,
      [PAGE_FILE_PROVENANCE_MIXED_PAGE_KEY]: mixedPageId,
    },
    entityIdsByKey: {
      [PAGE_FILE_PROVENANCE_REPORT_CHAT_KEY]: reportChat.sessionId,
      [PAGE_FILE_PROVENANCE_MIXED_CHAT_KEY]: mixedChat.sessionId,
    },
    minimumCommitSeq: Math.max(reportBody.commitSeq, body.commitSeq),
    materializedAt: new Date().toISOString(),
  };
};

const inspectPageFileProvenance = async (
  port: ScenarioSeedPort,
  manifest: ScenarioManifest,
): Promise<PageFileProvenanceScenarioFacts> => {
  const reportPageId = manifest.pageIdsByKey[PAGE_FILE_PROVENANCE_REPORT_PAGE_KEY];
  const mixedPageId = manifest.pageIdsByKey[PAGE_FILE_PROVENANCE_MIXED_PAGE_KEY];
  const reportChatId = manifest.entityIdsByKey?.[PAGE_FILE_PROVENANCE_REPORT_CHAT_KEY];
  const mixedChatId = manifest.entityIdsByKey?.[PAGE_FILE_PROVENANCE_MIXED_CHAT_KEY];
  if (!reportPageId || !mixedPageId || !reportChatId || !mixedChatId) {
    throw new Error("page/file-provenance manifest is incomplete");
  }
  const [report, mixed] = await Promise.all([
    port.readPageFileInventory(manifest.projectId, reportPageId),
    port.readPageFileInventory(manifest.projectId, mixedPageId),
  ]);
  const agentOf = (item: (typeof report.files)[number]) =>
    item.attachment?.attached_by.type === "agent" ? item.attachment.attached_by.session_id : null;
  if (
    report.files.length !== 3 ||
    !report.files.every((item) => agentOf(item) === reportChatId) ||
    mixed.files.length !== 3 ||
    mixed.files.find((item) => item.logical_path === "brief.md")?.attachment?.attached_by.type !==
      "member" ||
    agentOf(mixed.files.find((item) => item.logical_path === "mockups/settings-dark.png")!) !==
      mixedChatId ||
    mixed.files.filter((item) => item.attachment === null && item.body_count === 1).length !== 1
  ) {
    throw new Error("page/file-provenance attachments do not match the scenario contract");
  }
  return {
    scenarioId: manifest.scenarioId,
    scenarioRevision: manifest.scenarioRevision,
    reportPageId,
    mixedPageId,
    reportChatId,
    mixedChatId,
    reportPaths: report.files.flatMap((item) => (item.logical_path ? [item.logical_path] : [])),
  };
};

export const pageFileProvenanceScenario: ScenarioDomainRecipe = {
  id: PAGE_FILE_PROVENANCE_SCENARIO_ID,
  revision: PAGE_FILE_PROVENANCE_SCENARIO_REVISION,
  materialize: materializePageFileProvenance,
  inspect: inspectPageFileProvenance,
  parseFacts: requirePageFileProvenanceScenarioFacts,
};
