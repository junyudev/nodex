import { z } from "zod";

export const DICTATION_DICTIONARY_MAX_WORDS = 200;
export const DICTATION_DICTIONARY_MAX_WORD_LENGTH = 100;

export const DictationDictionaryTargetSchema = z
  .object({
    accountId: z.string().min(1).max(256),
    userId: z.string().min(1).max(256),
  })
  .strict();
export const DictationDictionaryOperationIdSchema = z.string().uuid();
const operation = { operationId: DictationDictionaryOperationIdSchema };
const mutation = { ...operation, target: DictationDictionaryTargetSchema };
const word = z.string().trim().min(1).max(DICTATION_DICTIONARY_MAX_WORD_LENGTH);

export const DictationDictionaryReadSchema = z
  .object({
    ...operation,
    target: DictationDictionaryTargetSchema.optional(),
  })
  .strict();
export const DictationDictionaryAddSchema = z.object({ ...mutation, text: word }).strict();
export const DictationDictionaryRemoveSchema = z
  .object({
    ...mutation,
    wordId: z.string().min(1).max(256),
  })
  .strict();
export const DictationDictionaryImportSchema = z
  .object({
    ...mutation,
    // Device entries retain their original spelling until the server accepts them.
    words: z.array(z.string().max(512)).min(1).max(DICTATION_DICTIONARY_MAX_WORDS),
  })
  .strict();

export type DictationDictionaryTarget = z.infer<typeof DictationDictionaryTargetSchema>;
export type DictationDictionaryReadInput = z.infer<typeof DictationDictionaryReadSchema>;
export type DictationDictionaryAddInput = z.infer<typeof DictationDictionaryAddSchema>;
export type DictationDictionaryRemoveInput = z.infer<typeof DictationDictionaryRemoveSchema>;
export type DictationDictionaryImportInput = z.infer<typeof DictationDictionaryImportSchema>;

export interface DictationDictionaryWord {
  readonly id: string;
  readonly text: string;
}

export interface DictationDictionarySnapshot {
  readonly target: DictationDictionaryTarget;
  readonly words: readonly DictationDictionaryWord[];
  readonly maxWords: number;
  readonly localWords: readonly string[];
}
