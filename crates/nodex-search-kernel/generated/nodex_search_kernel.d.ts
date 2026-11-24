/* tslint:disable */
/* eslint-disable */

export interface IndexedFileMatch {
    readonly root_slot: number;
    readonly path: string;
    readonly match_type: "file" | "directory";
    readonly file_name: string;
    readonly score: number;
    readonly indices: readonly number[];
}



export type SearchTextKind = "metadata" | "long_text";
export type SearchField = readonly [text: string, kind: SearchTextKind];
export interface SearchRowMatch { index: number; rank: number; }
/** Half-open UTF-16 offsets in the original input. */
export interface SearchLiteralRange { start: number; end: number; }
export type SearchMatchQuality = "exact" | "prefix" | "joined" | "stem" | "typo" | "infix";
export interface SearchTextMatch {
    quality: SearchMatchQuality;
    parts: { text: string; highlighted: boolean }[];
}
export interface SearchQueryWord { segments: string[]; stem: string | null; allowsPrefix: boolean; }
export interface SearchFieldEvidence {
    words: (SearchTextMatch | null)[];
    ordered: boolean;
    orderedRange: SearchLiteralRange | null;
}
export interface ChatMetadataEvidence {
    title: SearchTextMatch["parts"];
    hint: { label: string; text: string; parts: SearchTextMatch["parts"] } | null;
}



export class ChatMetadataSearchIndex {
    free(): void;
    [Symbol.dispose](): void;
    applyDelta(upserts: any, removals: string[]): void;
    candidates(query: string): string[];
    evidence(query: string, ids: string[]): ChatMetadataEvidence[];
    constructor();
    strongMatches(query: string): [string, number, boolean][];
}

export class FileNameIndex {
    free(): void;
    [Symbol.dispose](): void;
    addBatch(paths: string, entries: number, path_units: number): boolean;
    finishBuilding(): void;
    hasDirectory(path: string): boolean;
    hasFile(path: string): boolean;
    indexedAncestor(path: string): string;
    constructor(windows_paths: boolean);
    removeTree(path: string): void;
    remove(path: string): boolean;
    subdirectories(path: string): string[];
    readonly pathUnits: number;
    readonly size: number;
}

export class FileNameRanking {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    addRoot(root_slot: number, index: FileNameIndex): void;
    advance(root_slot: number, batch: number): boolean;
    results(): IndexedFileMatch[];
    readonly dirty: boolean;
    readonly hasMatches: boolean;
}

export class FileNameRefresh {
    free(): void;
    [Symbol.dispose](): void;
    apply(index: FileNameIndex, directory: string, tree: boolean, entries: number, path_units: number): boolean;
    collect(index: FileNameIndex, paths: string, entries: number, path_units: number): boolean;
    constructor();
}

export class FileNameSearch {
    free(): void;
    [Symbol.dispose](): void;
    clear(): void;
    constructor();
    reparse(query: string): void;
    start(): FileNameRanking;
}

export class PageSearchPreviewIndex {
    free(): void;
    [Symbol.dispose](): void;
    applyDelta(upserts: any, removals: any): void;
    constructor(documents: any);
    replace(documents: any): void;
    search(request: any): any;
}

export class SearchTextQuery {
    free(): void;
    [Symbol.dispose](): void;
    classify(word: number, terms: string[], allow_typo: boolean): (SearchMatchQuality | null)[];
    evidence(text: string, kind: SearchTextKind, allow_typo: boolean): SearchFieldEvidence;
    constructor(query: string);
    words(): SearchQueryWord[];
}

export function analyzerVersion(): number;

export function findLiteralRanges(query: string, text: string): SearchLiteralRange[];

export function foldText(text: string): string;

/**
 * A compact representation for SQLite's exact-token tokenizer.
 */
export function indexText(text: string): string;

export function matchTextRows(query: string, rows: readonly (readonly SearchField[])[]): SearchRowMatch[];

/**
 * Rank within a corpus whose field order is the same in both tiers.
 */
export function rankMatch(quality: SearchMatchQuality, field: number, fields: number): number;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_chatmetadatasearchindex_free: (a: number, b: number) => void;
    readonly __wbg_filenameindex_free: (a: number, b: number) => void;
    readonly __wbg_filenameranking_free: (a: number, b: number) => void;
    readonly __wbg_filenamerefresh_free: (a: number, b: number) => void;
    readonly __wbg_filenamesearch_free: (a: number, b: number) => void;
    readonly __wbg_pagesearchpreviewindex_free: (a: number, b: number) => void;
    readonly __wbg_searchtextquery_free: (a: number, b: number) => void;
    readonly analyzerVersion: () => number;
    readonly chatmetadatasearchindex_applyDelta: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly chatmetadatasearchindex_candidates: (a: number, b: number, c: number, d: number) => void;
    readonly chatmetadatasearchindex_evidence: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly chatmetadatasearchindex_new: () => number;
    readonly chatmetadatasearchindex_strongMatches: (a: number, b: number, c: number, d: number) => void;
    readonly filenameindex_addBatch: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly filenameindex_finishBuilding: (a: number) => void;
    readonly filenameindex_hasDirectory: (a: number, b: number, c: number) => number;
    readonly filenameindex_hasFile: (a: number, b: number, c: number) => number;
    readonly filenameindex_indexedAncestor: (a: number, b: number, c: number, d: number) => void;
    readonly filenameindex_new: (a: number) => number;
    readonly filenameindex_pathUnits: (a: number) => number;
    readonly filenameindex_remove: (a: number, b: number, c: number) => number;
    readonly filenameindex_removeTree: (a: number, b: number, c: number) => void;
    readonly filenameindex_size: (a: number) => number;
    readonly filenameindex_subdirectories: (a: number, b: number, c: number, d: number) => void;
    readonly filenameranking_addRoot: (a: number, b: number, c: number) => void;
    readonly filenameranking_advance: (a: number, b: number, c: number) => number;
    readonly filenameranking_dirty: (a: number) => number;
    readonly filenameranking_hasMatches: (a: number) => number;
    readonly filenameranking_results: (a: number, b: number) => void;
    readonly filenamerefresh_apply: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => number;
    readonly filenamerefresh_collect: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
    readonly filenamerefresh_new: () => number;
    readonly filenamesearch_clear: (a: number) => void;
    readonly filenamesearch_new: () => number;
    readonly filenamesearch_reparse: (a: number, b: number, c: number) => void;
    readonly filenamesearch_start: (a: number) => number;
    readonly findLiteralRanges: (a: number, b: number, c: number, d: number, e: number) => void;
    readonly foldText: (a: number, b: number, c: number) => void;
    readonly indexText: (a: number, b: number, c: number) => void;
    readonly matchTextRows: (a: number, b: number, c: number, d: number) => void;
    readonly pagesearchpreviewindex_applyDelta: (a: number, b: number, c: number, d: number) => void;
    readonly pagesearchpreviewindex_new: (a: number, b: number) => void;
    readonly pagesearchpreviewindex_replace: (a: number, b: number, c: number) => void;
    readonly pagesearchpreviewindex_search: (a: number, b: number, c: number) => void;
    readonly rankMatch: (a: number, b: number, c: number, d: number) => void;
    readonly searchtextquery_classify: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly searchtextquery_evidence: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly searchtextquery_new: (a: number, b: number) => number;
    readonly searchtextquery_words: (a: number, b: number) => void;
    readonly __wbindgen_export: (a: number, b: number) => number;
    readonly __wbindgen_export2: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_export3: (a: number) => void;
    readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
    readonly __wbindgen_export4: (a: number, b: number, c: number) => void;
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
