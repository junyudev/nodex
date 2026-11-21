import type { FileSearchResult } from "../../shared/file-search";

/** One searchable name below a root; paths are root-relative and `/`-separated. */
export type IndexedPath = Pick<FileSearchResult, "path" | "file_name" | "match_type">;

export interface FileIndexCapacity {
  readonly entries: number;
  readonly pathUnits: number;
}

export type FileIndexAddResult = "added" | "present" | "full";

interface DirectoryRecord {
  /** Null for the root itself, which is never a result. */
  readonly entry: IndexedPath | null;
  readonly files: Map<string, IndexedPath>;
  readonly directories: Set<string>;
}

export const parentDirectory = (path: string): string => {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
};

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);
const childPath = (directory: string, name: string) => (directory ? `${directory}/${name}` : name);
const emptyRoot = (): DirectoryRecord => ({
  entry: null,
  files: new Map(),
  directories: new Set(),
});

/**
 * The searchable names below one root: every listed file plus each directory that contains
 * one. Ranking reads an immutable entry list; edits after the first listing produce a new one.
 */
export class WorkspaceFileIndex {
  private readonly directories = new Map<string, DirectoryRecord>([["", emptyRoot()]]);
  /** Append-only while the first listing runs, so rankers can follow it as it grows. */
  private building: IndexedPath[] | null = [];
  private snapshot: readonly IndexedPath[] | null = null;
  private entryCount = 0;
  private units = 0;
  private version = 0;

  constructor(private readonly windowsPaths: boolean) {}

  get size(): number {
    return this.entryCount;
  }

  /** UTF-16 code units retained by entry paths. */
  get pathUnits(): number {
    return this.units;
  }

  /** Changes whenever the searchable names change after the first listing. */
  get revision(): number {
    return this.version;
  }

  /** The current entries; while building, the same array grows until `finishBuilding`. */
  entries(): readonly IndexedPath[] {
    if (this.building) return this.building;
    if (this.snapshot) return this.snapshot;
    const entries: IndexedPath[] = [];
    for (const record of this.directories.values()) {
      if (record.entry) entries.push(record.entry);
      for (const file of record.files.values()) entries.push(file);
    }
    this.snapshot = entries;
    return entries;
  }

  finishBuilding(): void {
    if (!this.building) return;
    this.snapshot = this.building;
    this.building = null;
  }

  /** Converts one ripgrep record into an index path, or null when it has no usable name. */
  normalize(listed: string): string | null {
    const path = this.windowsPaths ? listed.replaceAll("\\", "/") : listed;
    if (!path || path.includes("\uFFFD")) return null;
    return path;
  }

  hasFile(path: string): boolean {
    return this.directories.get(parentDirectory(path))?.files.has(baseName(path)) ?? false;
  }

  hasDirectory(directory: string): boolean {
    return this.directories.has(directory);
  }

  /** The nearest directory above `path` that holds searchable names, or the root. */
  indexedAncestor(path: string): string {
    let directory = parentDirectory(path);
    while (directory && !this.directories.has(directory)) directory = parentDirectory(directory);
    return directory;
  }

  subdirectories(directory: string): string[] {
    const record = this.directories.get(directory);
    return record ? [...record.directories].map((name) => childPath(directory, name)) : [];
  }

  /** Adds one listed file and the directories it newly makes searchable. */
  add(path: string, capacity: FileIndexCapacity): FileIndexAddResult {
    const parentPath = parentDirectory(path);
    const name = baseName(path);
    if (this.directories.get(parentPath)?.files.has(name) || this.directories.has(path))
      return "present";
    const missing: string[] = [];
    let units = path.length;
    for (
      let directory = parentPath;
      directory && !this.directories.has(directory);
      directory = parentDirectory(directory)
    ) {
      missing.push(directory);
      units += directory.length;
    }
    if (
      this.entryCount + 1 + missing.length > capacity.entries ||
      this.units + units > capacity.pathUnits
    )
      return "full";
    const file: IndexedPath = { path, file_name: name, match_type: "file" };
    const added: IndexedPath[] = [file];
    for (let index = missing.length - 1; index >= 0; index--) {
      const directory = missing[index]!;
      const entry: IndexedPath = {
        path: directory,
        file_name: baseName(directory),
        match_type: "directory",
      };
      this.directories.set(directory, { entry, files: new Map(), directories: new Set() });
      this.directories.get(parentDirectory(directory))!.directories.add(entry.file_name);
      added.splice(1, 0, entry);
    }
    this.directories.get(parentPath)!.files.set(name, file);
    for (const entry of added) this.retain(entry);
    return "added";
  }

  remove(path: string): boolean {
    const parentPath = parentDirectory(path);
    if (!this.directories.get(parentPath)?.files.delete(baseName(path))) return false;
    this.release(path);
    this.prune(parentPath);
    return true;
  }

  /** Removes a directory and everything below it; the empty path clears the index. */
  removeTree(directory: string): boolean {
    if (!directory) {
      const changed = this.entryCount > 0;
      this.directories.clear();
      this.directories.set("", emptyRoot());
      this.entryCount = 0;
      this.units = 0;
      if (changed) this.changed();
      return changed;
    }
    if (!this.directories.has(directory)) return false;
    const pending = [directory];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const record = this.directories.get(current)!;
      for (const name of record.files.keys()) this.release(childPath(current, name));
      for (const name of record.directories) pending.push(childPath(current, name));
      this.directories.delete(current);
      this.release(current);
    }
    const parentPath = parentDirectory(directory);
    this.directories.get(parentPath)?.directories.delete(baseName(directory));
    this.prune(parentPath);
    return true;
  }

  /**
   * Makes the files directly in `directory` (or, for `tree`, everywhere below it) exactly the
   * listed ones. Listed paths elsewhere below the directory are added when missing.
   */
  reconcile(
    directory: string,
    depth: "direct" | "tree",
    listed: readonly string[],
    capacity: FileIndexCapacity,
  ): { readonly changed: boolean; readonly full: boolean } {
    const keep = new Set(listed);
    let changed = false;
    let full = false;
    for (const path of depth === "direct" ? this.directFiles(directory) : this.files(directory))
      if (!keep.has(path)) changed = this.remove(path) || changed;
    for (const path of listed) {
      const result = this.add(path, capacity);
      changed ||= result === "added";
      full ||= result === "full";
    }
    return { changed, full };
  }

  private directFiles(directory: string): string[] {
    const record = this.directories.get(directory);
    return record ? [...record.files.keys()].map((name) => childPath(directory, name)) : [];
  }

  private files(directory: string): string[] {
    const files: string[] = [];
    const pending = this.directories.has(directory) ? [directory] : [];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const record = this.directories.get(current)!;
      for (const name of record.files.keys()) files.push(childPath(current, name));
      for (const name of record.directories) pending.push(childPath(current, name));
    }
    return files;
  }

  private prune(directory: string): void {
    for (let current = directory; current; current = parentDirectory(current)) {
      const record = this.directories.get(current);
      if (!record || record.files.size > 0 || record.directories.size > 0) return;
      this.directories.delete(current);
      this.release(current);
      this.directories.get(parentDirectory(current))?.directories.delete(baseName(current));
    }
  }

  private retain(entry: IndexedPath): void {
    this.entryCount++;
    this.units += entry.path.length;
    if (this.building) this.building.push(entry);
    else this.changed();
  }

  private release(path: string): void {
    this.entryCount--;
    this.units -= path.length;
    this.changed();
  }

  private changed(): void {
    if (this.building) return;
    this.snapshot = null;
    this.version++;
  }
}
