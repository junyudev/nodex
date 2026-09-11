import { materializePagePromptInput } from "./page-prompt-input";
import type { CodexPromptInput } from "@/lib/types";
import { buildPageDeepLink } from "@/lib/page-deeplink";
import { parseNfm } from "@/lib/nfm";
import { materializePageDocument } from "../../shared/block-documents/block-document-codec";
import type { OwnedDocumentDescriptor } from "../../shared/block-documents/contracts";
import type { ContentAccessContext } from "../../shared/content-access-context";
import {
  createDocumentSyncAdapterForContentAccess,
  prepareOwnedBlockDocumentForContentAccess,
} from "./api";
import {
  BlockDocumentSurfaceRuntime,
  type BlockDocumentSurfaceRuntimeOptions,
} from "./block-document-surface-runtime";
import type { DocumentSyncAdapter } from "./nodex-y-provider";
import { unwrapOwnedBlockDocumentPreparationResult } from "./owned-block-document";
import { buildCodexPromptInputFromNfmBlocks } from "./codex-prompt-input";
import type { PagePromptContext } from "./page-chat-actions";

export interface BuildPagePromptContextInput {
  readonly projectId: string;
  readonly pageId: string;
  readonly pageKey?: string;
  readonly title: string;
  readonly nfm: string;
  readonly source?: string;
}

export type PageDocumentMaterialization = ReturnType<typeof materializePageDocument>;

interface PageDocumentRuntimeFactoryInput {
  readonly accessContext: ContentAccessContext;
  readonly descriptor: OwnedDocumentDescriptor;
  readonly createRuntime?: (
    options: BlockDocumentSurfaceRuntimeOptions,
  ) => BlockDocumentSurfaceRuntime;
  readonly createAdapter?: (accessContext: ContentAccessContext) => DocumentSyncAdapter;
}

/** Connects one prepared Page Document, reads its canonical content, and always closes it. */
export async function materializePreparedPageDocument({
  accessContext,
  descriptor,
  createRuntime,
  createAdapter = createDocumentSyncAdapterForContentAccess,
}: PageDocumentRuntimeFactoryInput): Promise<PageDocumentMaterialization> {
  const runtimeFactory = createRuntime ?? ((options) => new BlockDocumentSurfaceRuntime(options));
  const runtime = createPageDocumentRuntime(
    descriptor,
    accessContext,
    runtimeFactory,
    createAdapter,
  );

  try {
    await runtime.connect();
    await runtime.whenReady();
    return materializePageDocument(runtime.document);
  } finally {
    await runtime.close();
  }
}

export async function loadPageDocumentMaterialization(input: {
  readonly accessContext: ContentAccessContext;
  readonly pageId: string;
  readonly createRuntime?: (
    options: BlockDocumentSurfaceRuntimeOptions,
  ) => BlockDocumentSurfaceRuntime;
  readonly createAdapter?: (accessContext: ContentAccessContext) => DocumentSyncAdapter;
}): Promise<PageDocumentMaterialization> {
  const descriptor = unwrapOwnedBlockDocumentPreparationResult(
    await prepareOwnedBlockDocumentForContentAccess(input.accessContext, input.pageId),
  );
  return await materializePreparedPageDocument({
    accessContext: input.accessContext,
    descriptor,
    createRuntime: input.createRuntime,
    createAdapter: input.createAdapter,
  });
}

export function buildPagePromptContext({
  projectId,
  pageId,
  pageKey,
  title,
  nfm,
  source = buildPageDeepLink({ pageId }),
}: BuildPagePromptContextInput): PagePromptContext {
  const normalizedTitle = title.trim() || "Untitled Page";
  const normalizedPageKey = pageKey?.trim() || undefined;
  const basePrompt = buildCodexPromptInputFromNfmBlocks(parseNfm(nfm));
  const promptText = [
    `Page: ${normalizedTitle}`,
    ...(normalizedPageKey ? [`Page key: ${normalizedPageKey}`] : []),
    `Source: ${source}`,
    "",
    basePrompt.text,
  ]
    .join("\n")
    .trim();
  const promptInput: CodexPromptInput = {
    ...basePrompt,
    text: promptText,
  };

  return {
    projectId,
    pageId,
    ...(normalizedPageKey ? { pageKey: normalizedPageKey } : {}),
    title: normalizedTitle,
    source,
    promptInput,
  };
}

export async function loadPagePromptContext(input: {
  readonly projectId: string;
  readonly pageId: string;
  readonly pageKey?: string;
  readonly titleSnapshot?: string;
  readonly createRuntime?: (
    options: BlockDocumentSurfaceRuntimeOptions,
  ) => BlockDocumentSurfaceRuntime;
  readonly createAdapter?: (accessContext: ContentAccessContext) => DocumentSyncAdapter;
}): Promise<PagePromptContext> {
  const materialized = await loadPageDocumentMaterialization({
    ...input,
    accessContext: { kind: "project", projectId: input.projectId },
  });
  const context = buildPagePromptContext({
    projectId: input.projectId,
    pageId: input.pageId,
    pageKey: input.pageKey,
    title: materialized.title.trim() || input.titleSnapshot || "Untitled Page",
    nfm: materialized.nfm,
  });
  return {
    ...context,
    promptInput: (await materializePagePromptInput(
      { kind: "project", projectId: input.projectId },
      input.pageId,
      context.promptInput,
    ))!,
  };
}

function createPageDocumentRuntime(
  descriptor: OwnedDocumentDescriptor,
  accessContext: ContentAccessContext,
  runtimeFactory: (options: BlockDocumentSurfaceRuntimeOptions) => BlockDocumentSurfaceRuntime,
  createAdapter: (accessContext: ContentAccessContext) => DocumentSyncAdapter,
): BlockDocumentSurfaceRuntime {
  return runtimeFactory({
    descriptor,
    adapter: createAdapter(accessContext),
    localCheckpointStore: null,
  });
}
