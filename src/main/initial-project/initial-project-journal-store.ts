import { lstat, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { ProjectAppearanceSchema } from "../../shared/schemas/projects";
import { isMissingPathError, syncDirectory, writeDurableJson } from "../durable-json-file";

const JOURNAL_FILE_NAME = "initial-project-v2.json";
const JOURNAL_MAX_BYTES = 64 * 1024;

const InitialProjectStarterPageSchema = z
  .object({
    pageId: z.string().uuid(),
    documentId: z.string().uuid(),
    titleMarkdown: z.string().min(1).max(10_000),
    markdown: z.string().max(48 * 1024),
  })
  .strict();

const InitialProjectPayloadSchema = z
  .object({
    projectId: z.string().uuid(),
    name: z.string().min(1).max(256),
    description: z.string().max(100_000),
    appearance: ProjectAppearanceSchema,
    sources: z.array(z.string().min(1).max(4_096)).length(1),
    starterPage: InitialProjectStarterPageSchema,
  })
  .strict();

const InitialProjectJournalSchema = z
  .object({
    schemaVersion: z.literal(2),
    attemptId: z.string().uuid(),
    // v2 journals may contain an older UUID identity. Recovery reconciles Core
    // state before renewing an uncommitted attempt with the bounded form.
    operationId: z.string().min(1).max(1_024),
    payload: InitialProjectPayloadSchema,
  })
  .strict();

export type InitialProjectJournal = z.infer<typeof InitialProjectJournalSchema>;

interface InitialProjectRecoveryJournalOptions {
  readonly filePath: string;
}

export class InitialProjectRecoveryJournal {
  constructor(private readonly options: InitialProjectRecoveryJournalOptions) {}

  async load(quarantineTimestamp: number): Promise<InitialProjectJournal | null> {
    try {
      const metadata = await lstat(this.options.filePath);
      if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size > JOURNAL_MAX_BYTES) {
        await this.quarantine(quarantineTimestamp);
        return null;
      }
      const raw = await readFile(this.options.filePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > JOURNAL_MAX_BYTES) {
        await this.quarantine(quarantineTimestamp);
        return null;
      }
      const parsed = InitialProjectJournalSchema.safeParse(JSON.parse(raw) as unknown);
      if (!parsed.success || parsed.data.payload.sources.some((source) => !isAbsolute(source))) {
        await this.quarantine(quarantineTimestamp);
        return null;
      }
      return parsed.data;
    } catch (error) {
      if (isMissingPathError(error)) return null;
      if (error instanceof SyntaxError) {
        await this.quarantine(quarantineTimestamp);
        return null;
      }
      throw error;
    }
  }

  async save(journal: InitialProjectJournal): Promise<void> {
    const parsed = InitialProjectJournalSchema.parse(journal);
    if (parsed.payload.sources.some((source) => !isAbsolute(source))) {
      throw new Error("Initial Project journal sources must be absolute");
    }
    await writeDurableJson(this.options.filePath, parsed, JOURNAL_MAX_BYTES);
  }

  async clear(): Promise<void> {
    await rm(this.options.filePath, { force: true });
    await syncDirectory(dirname(this.options.filePath));
  }

  private async quarantine(timestamp: number): Promise<void> {
    const target = `${this.options.filePath}.corrupt-${timestamp}`;
    try {
      await rename(this.options.filePath, target);
      await syncDirectory(dirname(this.options.filePath));
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
}

export function resolveInitialProjectJournalPath(nodexHome: string): string {
  return join(nodexHome, "recovery", JOURNAL_FILE_NAME);
}
