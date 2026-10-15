import { z } from "zod";
export type CodexSidebarProjectKind = "local" | "remote";

export type CodexSidebarThreadContainerId =
  | "pinned"
  | "chats"
  | "cloud"
  | `project-pinned:${string}`
  | `project:${string}`
  | `reorder-only:${string}`;

export interface CodexSidebarThreadContainerLocation {
  projectId: string | null;
  pinned: boolean;
}

interface CodexSidebarThreadMoveBase {
  hostId: "local";
  threadId: string;
  sourceContainerId: CodexSidebarThreadContainerId;
  targetContainerId: CodexSidebarThreadContainerId;
}

export type CodexSidebarThreadMovePlacement =
  | {
      beforeThreadId: string;
      afterThreadId?: never;
      insertAtEnd?: never;
      useDefaultOrder?: never;
    }
  | {
      beforeThreadId: null;
      afterThreadId: string;
      insertAtEnd?: never;
      useDefaultOrder?: never;
    }
  | {
      beforeThreadId: null;
      afterThreadId?: never;
      insertAtEnd: true;
      useDefaultOrder?: never;
    }
  | {
      beforeThreadId: null;
      afterThreadId?: never;
      insertAtEnd?: never;
      useDefaultOrder: true;
    }
  | {
      beforeThreadId: null;
      afterThreadId?: never;
      insertAtEnd?: never;
      useDefaultOrder?: never;
    };

export type CodexSidebarThreadMoveInput = CodexSidebarThreadMoveBase &
  CodexSidebarThreadMovePlacement;

export interface CodexSidebarThreadMoveScope {
  projectId: string | null;
}

export interface CodexSidebarThreadMoveSuccess {
  status: "moved";
  threadId: string;
  source: CodexSidebarThreadMoveScope;
  destination: CodexSidebarThreadMoveScope;
  operationId: string;
  projectionRevision: number;
}

export type CodexSidebarThreadMoveResult = CodexSidebarThreadMoveSuccess;

const ContainerIdSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      value === "pinned" ||
      value === "chats" ||
      value === "cloud" ||
      (value.startsWith("project-pinned:") && value.length > "project-pinned:".length) ||
      (value.startsWith("project:") && value.length > "project:".length) ||
      (value.startsWith("reorder-only:") && value.length > "reorder-only:".length),
    "Invalid sidebar thread container id",
  ) as z.ZodType<CodexSidebarThreadContainerId>;

const MoveBaseSchema = z.object({
  hostId: z.literal("local"),
  threadId: z.string().trim().min(1),
  sourceContainerId: ContainerIdSchema,
  targetContainerId: ContainerIdSchema,
});

const MovePlacementSchema = z.union([
  z.object({
    beforeThreadId: z.string().trim().min(1),
    afterThreadId: z.undefined().optional(),
    insertAtEnd: z.undefined().optional(),
    useDefaultOrder: z.undefined().optional(),
  }),
  z.object({
    beforeThreadId: z.null(),
    afterThreadId: z.string().trim().min(1),
    insertAtEnd: z.undefined().optional(),
    useDefaultOrder: z.undefined().optional(),
  }),
  z.object({
    beforeThreadId: z.null(),
    afterThreadId: z.undefined().optional(),
    insertAtEnd: z.literal(true),
    useDefaultOrder: z.undefined().optional(),
  }),
  z.object({
    beforeThreadId: z.null(),
    afterThreadId: z.undefined().optional(),
    insertAtEnd: z.undefined().optional(),
    useDefaultOrder: z.literal(true),
  }),
  z.object({
    beforeThreadId: z.null(),
    afterThreadId: z.undefined().optional(),
    insertAtEnd: z.undefined().optional(),
    useDefaultOrder: z.undefined().optional(),
  }),
]);

export const CodexSidebarThreadMoveInputSchema = MoveBaseSchema.and(
  MovePlacementSchema,
).superRefine((input, context) => {
  if (input.beforeThreadId !== input.threadId && input.afterThreadId !== input.threadId) {
    return;
  }
  context.addIssue({
    code: "custom",
    message: "Thread placement anchor must reference another Thread",
    path: [input.beforeThreadId === input.threadId ? "beforeThreadId" : "afterThreadId"],
  });
}) as z.ZodType<CodexSidebarThreadMoveInput>;

export function isCodexSidebarThreadContainerId(
  value: string,
): value is CodexSidebarThreadContainerId {
  return ContainerIdSchema.safeParse(value).success;
}

export function readCodexSidebarProjectContainerId(
  containerId: CodexSidebarThreadContainerId,
): string | null {
  const prefix = containerId.startsWith("project-pinned:")
    ? "project-pinned:"
    : containerId.startsWith("project:")
      ? "project:"
      : null;
  if (prefix === null) return null;
  const projectId = containerId.slice(prefix.length).trim();
  return projectId || null;
}

export function readCodexSidebarThreadContainerLocation(
  containerId: CodexSidebarThreadContainerId,
): CodexSidebarThreadContainerLocation | null {
  if (containerId === "pinned") return { projectId: null, pinned: true };
  if (containerId === "chats") return { projectId: null, pinned: false };

  const projectId = readCodexSidebarProjectContainerId(containerId);
  if (projectId === null) return null;
  return {
    projectId,
    pinned: containerId.startsWith("project-pinned:"),
  };
}

export function codexSidebarProjectThreadContainerId(
  projectId: string,
  pinned: boolean,
): CodexSidebarThreadContainerId {
  return pinned ? `project-pinned:${projectId}` : `project:${projectId}`;
}

export function isCodexSidebarPinnedThreadContainerId(containerId: string): boolean {
  return containerId === "pinned" || containerId.startsWith("project-pinned:");
}
