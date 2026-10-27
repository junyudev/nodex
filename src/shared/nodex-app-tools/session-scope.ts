import { z } from "zod";

export const sessionScopeSchema = z.enum(["project", "profile"]).default("project");
export interface SessionScopeInput {
  readonly scope?: "project" | "profile";
  readonly projectId?: string;
}
/** A projectless caller's default is its own projectless lane, never every Project. */
export const resolveSessionScope = (input: SessionScopeInput, callerProjectId: string | null) => {
  if (input.scope === "profile" && input.projectId !== undefined)
    throw new TypeError("Choose a Project or Profile scope, not both");
  if (input.projectId !== undefined) return { projectId: input.projectId };
  if (input.scope === "profile") return {};
  return callerProjectId === null
    ? { projectlessOnly: true as const }
    : { projectId: callerProjectId };
};
