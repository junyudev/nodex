/* tslint:disable */
/* eslint-disable */

/**
 * One line per Block, keeping each text's own line breaks.
 */
export function blockLines(blocks_json: string): string;

/**
 * All of the Blocks' words on one line.
 */
export function plainText(blocks_json: string): string;

/**
 * The start of plain text, as previews show it.
 */
export function preview(plain_text: string): string;

/**
 * Reads Nodex Markdown as BlockNote JSON text. A refused exact write throws a JSON text
 * `{"line": number, "message": string}`.
 */
export function read(markdown: string, mode: string): string;

/**
 * Reads one line of inline Nodex Markdown, as a Page title is written, as inline content JSON
 * text. A refused exact read throws like `read`.
 */
export function readInline(text: string, mode: string): string;

/**
 * The exact text of Blocks given as BlockNote JSON text.
 */
export function write(blocks_json: string): string;

/**
 * The one-line text of inline content given as BlockNote JSON text.
 */
export function writeInline(inline_json: string): string;

/**
 * Portable Markdown of Blocks, as JSON text `{"markdown": string, "exact": boolean}`.
 * `page_titles_json` maps Page ids to the titles that name mentions of them.
 */
export function writePortable(blocks_json: string, line_breaks: string, page_titles_json: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly blockLines: (a: number, b: number) => [number, number, number, number];
    readonly plainText: (a: number, b: number) => [number, number, number, number];
    readonly preview: (a: number, b: number) => [number, number];
    readonly read: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly readInline: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly write: (a: number, b: number) => [number, number, number, number];
    readonly writeInline: (a: number, b: number) => [number, number, number, number];
    readonly writePortable: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
