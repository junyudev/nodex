import type { components } from "@nodex/core-protocol";
import { z } from "zod";

import { isBoundedOperationId } from "./operation-identity";
import { isUuidV7 } from "./uuid-v7";

export type PageCreationTarget =
  | { readonly kind: "project"; readonly projectId: string }
  | { readonly kind: "session"; readonly sessionId: string };

export interface CreatePageForInput {
  readonly for: PageCreationTarget;
  readonly title?: string;
}

export interface CreatePageForCommand extends CreatePageForInput {
  readonly operationId: string;
  readonly pageId: string;
  readonly documentId: string;
}

type CorePlacement = components["schemas"]["ProjectWorkspaceCreatedPagePlacement"];
export type CreatedPagePlacement =
  | {
      readonly kind: "library";
      readonly libraryId: Extract<CorePlacement, { kind: "library" }>["library_id"];
    }
  | {
      readonly kind: "data_source";
      readonly databaseId: Extract<CorePlacement, { kind: "data_source" }>["database_id"];
      readonly dataSourceId: Extract<CorePlacement, { kind: "data_source" }>["data_source_id"];
      readonly viewId: Extract<CorePlacement, { kind: "data_source" }>["view_id"];
    };

export interface CreatePageForResult {
  readonly pageId: string;
  readonly projectId: string | null;
  readonly placement: CreatedPagePlacement;
  readonly pageKey: string | null;
}

const id = z.string().trim().min(1).max(512);
export const CreatePageForCommandSchema = z
  .object({
    for: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("project"), projectId: id }).strict(),
      z.object({ kind: z.literal("session"), sessionId: id }).strict(),
    ]),
    title: z.string().max(10_000).optional(),
    operationId: z.string().refine(isBoundedOperationId, "Invalid operation identity"),
    pageId: z.string().refine(isUuidV7, "Expected a UUID-v7 Page identity"),
    documentId: z.string().refine(isUuidV7, "Expected a UUID-v7 Document identity"),
  })
  .strict() satisfies z.ZodType<CreatePageForCommand>;
