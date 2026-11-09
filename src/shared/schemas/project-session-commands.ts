import { z } from "zod";
import { isBoundedOperationId } from "../operation-identity";
import type {
  ProjectSessionArchiveCommandInput,
  ProjectSessionRenameCommandInput,
} from "../workspace-catalog-commands";
import { ProjectSessionRenameInputSchema } from "./project-sessions";

const sessionId = z.string().trim().min(1).max(512);
const sessionCommand = <Payload extends z.ZodRawShape>(payload: Payload) =>
  z.strictObject({
    operationId: z.string().refine(isBoundedOperationId),
    payload: z.strictObject({ sessionId, ...payload }),
  });

/** Chat commands a Member's Device sends to the Space host, validated where they arrive. */
export const ProjectSessionRenameCommandSchema = sessionCommand({
  input: ProjectSessionRenameInputSchema.strict(),
}) satisfies z.ZodType<ProjectSessionRenameCommandInput>;

export const ProjectSessionArchiveCommandSchema = sessionCommand(
  {},
) satisfies z.ZodType<ProjectSessionArchiveCommandInput>;
