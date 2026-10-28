import init, * as wasm from "../generated/nodex-markdown-wasm/nodex_markdown";
import type { InitInput, SyncInitInput } from "../generated/nodex-markdown-wasm/nodex_markdown";

/** BlockNote JSON is the language boundary; identities belong to the document/editor. */
export interface MarkdownInline {
  readonly type: string;
  readonly text?: string;
  readonly href?: string;
  readonly styles?: Readonly<Record<string, boolean | string>>;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: readonly MarkdownInline[] | string;
}

export interface MarkdownBlock {
  readonly id?: string;
  readonly type: string;
  readonly props?: Readonly<Record<string, unknown>>;
  readonly content?: unknown;
  readonly children?: readonly MarkdownBlock[];
}

export type MarkdownReadMode = "exact" | "boundary" | "document";
export interface PortableMarkdown {
  readonly markdown: string;
  readonly exact: boolean;
}
export interface PortableMarkdownOptions {
  readonly lineBreaks?: "comment" | "document";
  readonly pageTitles?: Readonly<Record<string, string>>;
}

export class MarkdownRefusal extends Error {
  constructor(
    public readonly line: number,
    message: string,
  ) {
    super(message);
    this.name = "MarkdownRefusal";
  }
}

let initialized = false;
let initialization: Promise<void> | undefined;

/**
 * Initialize once before rendering or accepting synchronous content operations. The caller names
 * the module (a bundler asset URL, or bytes), so the loader works in every module format.
 */
export function initMarkdown(input: InitInput): Promise<void> {
  if (initialized) return Promise.resolve();
  initialization ??= init({ module_or_path: input })
    .then(() => {
      initialized = true;
    })
    .catch((error: unknown) => {
      initialization = undefined;
      throw error;
    });
  return initialization;
}

/** Main, scripts and test runtimes load the same committed module from file bytes. */
export function initMarkdownSync(module: SyncInitInput): void {
  if (initialized) return;
  wasm.initSync({ module });
  initialized = true;
}

function ready(): void {
  if (initialized) return;
  throw new Error(
    "Nodex Markdown is not initialized. Await initMarkdown() before using its synchronous API.",
  );
}

function readValue<T>(read: () => string): T {
  ready();
  try {
    return JSON.parse(read()) as T;
  } catch (error) {
    if (typeof error !== "string") throw error;
    let refusal: { line?: unknown; message?: unknown };
    try {
      refusal = JSON.parse(error) as typeof refusal;
    } catch {
      throw new Error(error, { cause: error });
    }
    if (typeof refusal.line === "number" && typeof refusal.message === "string") {
      throw new MarkdownRefusal(refusal.line, refusal.message);
    }
    throw new Error(error, { cause: error });
  }
}

export const readMarkdown = (text: string, mode: MarkdownReadMode = "boundary"): MarkdownBlock[] =>
  readValue(() => wasm.read(text, mode));
export const readInlineMarkdown = (
  text: string,
  mode: MarkdownReadMode = "boundary",
): MarkdownInline[] => readValue(() => wasm.readInline(text, mode));
export function writeMarkdown(blocks: readonly MarkdownBlock[]): string {
  ready();
  return wasm.write(JSON.stringify(blocks));
}
export function writeInlineMarkdown(inline: readonly MarkdownInline[]): string {
  ready();
  return wasm.writeInline(JSON.stringify(inline));
}
export const writePortableMarkdown = (
  blocks: readonly MarkdownBlock[],
  options: PortableMarkdownOptions = {},
): PortableMarkdown =>
  readValue(() =>
    wasm.writePortable(
      JSON.stringify(blocks),
      options.lineBreaks ?? "comment",
      JSON.stringify(options.pageTitles ?? {}),
    ),
  );
export function markdownPlainText(blocks: readonly MarkdownBlock[]): string {
  ready();
  return wasm.plainText(JSON.stringify(blocks));
}
export function markdownBlockLines(blocks: readonly MarkdownBlock[]): string {
  ready();
  return wasm.blockLines(JSON.stringify(blocks));
}
export function markdownPreview(plainText: string): string {
  ready();
  return wasm.preview(plainText);
}

export function extractMarkdownText(text: string, maximumLength?: number): string {
  const plain = markdownPlainText(readMarkdown(text));
  if (maximumLength === undefined || plain.length <= maximumLength) return plain;
  return `${plain.slice(0, maximumLength).trimEnd()}...`;
}
