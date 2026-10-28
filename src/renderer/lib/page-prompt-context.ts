import { materializePagePromptInput } from "./page-prompt-input";
import type { CodexPromptInput } from "@/lib/types";
import { buildPageDeepLink } from "@/lib/page-deeplink";
import { readMarkdown } from "../../shared/nodex-markdown";
import { materializePageDocument } from "../../shared/block-documents/block-document-codec";
import type { OwnedDocumentDescriptor } from "../../shared/block-documents/contracts";
import type { ContentRoutingContext } from "../../shared/content-routing-context";
import {
  createDocumentSyncAdapterForContentRouting,
  prepareOwnedBlockDocumentForContentRouting,
} from "./api";
import {
  BlockDocumentSurfaceRuntime,
  type BlockDocumentSurfaceRuntimeOptions,
} from "./block-document-surface-runtime";
import type { DocumentSyncAdapter } from "./nodex-y-provider";
import { unwrapOwnedBlockDocumentPreparationResult } from "./owned-block-document";
import { buildCodexPromptInputFromMarkdownBlocks } from "./codex-prompt-input";
import type { PagePromptContext } from "./page-chat-actions";

export interface BuildPagePromptContextInput {
  readonly projectId: string;
  readonly pageId: string;
  readonly pageKey?: string;
  readonly title: string;
  readonly markdown: string;
  readonly source?: string;
}

export type PageDocumentMaterialization = ReturnType<typeof materializePageDocument>;

interface PageDocumentRuntimeFactoryInput {
  readonly routingContext: ContentRoutingContext;
  readonly descriptor: OwnedDocumentDescriptor;
  readonly createRuntime?: (
    options: BlockDocumentSurfaceRuntimeOptions,
  ) => BlockDocumentSurfaceRuntime;
  readonly createAdapter?: (routingContext: ContentRoutingContext) => DocumentSyncAdapter;
}

/** Connects one prepared Page Document, reads its canonical content, and always closes it. */
export async function materializePreparedPageDocument({
  routingContext,
  descriptor,
  createRuntime,
  createAdapter = createDocumentSyncAdapterForContentRouting,
}: PageDocumentRuntimeFactoryInput): Promise<PageDocumentMaterialization> {
  const runtimeFactory = createRuntime ?? ((options) => new BlockDocumentSurfaceRuntime(options));
  const runtime = createPageDocumentRuntime(
    descriptor,
    routingContext,
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
  readonly routingContext: ContentRoutingContext;
  readonly pageId: string;
  readonly createRuntime?: (
    options: BlockDocumentSurfaceRuntimeOptions,
  ) => BlockDocumentSurfaceRuntime;
  readonly createAdapter?: (routingContext: ContentRoutingContext) => DocumentSyncAdapter;
}): Promise<PageDocumentMaterialization> {
  const descriptor = unwrapOwnedBlockDocumentPreparationResult(
    await prepareOwnedBlockDocumentForContentRouting(input.routingContext, input.pageId),
  );
  return await materializePreparedPageDocument({
    routingContext: input.routingContext,
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
  markdown,
  source = buildPageDeepLink({ pageId }),
}: BuildPagePromptContextInput): PagePromptContext {
  const normalizedTitle = title.trim() || "Untitled Page";
  const normalizedPageKey = pageKey?.trim() || undefined;
  const basePrompt = buildCodexPromptInputFromMarkdownBlocks(readMarkdown(markdown));
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
  readonly createAdapter?: (routingContext: ContentRoutingContext) => DocumentSyncAdapter;
}): Promise<PagePromptContext> {
  const materialized = await loadPageDocumentMaterialization({
    ...input,
    routingContext: { kind: "project", projectId: input.projectId },
  });
  const context = buildPagePromptContext({
    projectId: input.projectId,
    pageId: input.pageId,
    pageKey: input.pageKey,
    title: materialized.title.trim() || input.titleSnapshot || "Untitled Page",
    markdown: materialized.markdown,
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
  routingContext: ContentRoutingContext,
  runtimeFactory: (options: BlockDocumentSurfaceRuntimeOptions) => BlockDocumentSurfaceRuntime,
  createAdapter: (routingContext: ContentRoutingContext) => DocumentSyncAdapter,
): BlockDocumentSurfaceRuntime {
  return runtimeFactory({
    descriptor,
    adapter: createAdapter(routingContext),
    localCheckpointStore: null,
  });
}
