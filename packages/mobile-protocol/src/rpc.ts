import { z } from "zod";
import {
  AgentCatalogSchema,
  AgentChoiceSchema,
  ChatActivitySchema,
  ChatItemSchema,
  ChatListSchema,
  ChatPatchOpSchema,
  ChatResponseSchema,
  ChatSnapshotSchema,
  FileRefSchema,
  HelloSchema,
  InboxDecisionSchema,
  InboxMessageSchema,
  InboxScopeSchema,
  InboxWindowSchema,
  ProjectListSchema,
  RpcErrorSchema,
} from "./models";
import { PushRegistrationSchema } from "./push";

/** Increment on any change an older peer cannot ignore. A mismatch asks the person to update. */
export const MOBILE_PROTOCOL_REVISION = 1;

/** Most bytes one upload chunk or file read carries before base64. */
export const MOBILE_FILE_CHUNK_BYTES = 128 * 1024;
/** Largest file a phone may upload. */
export const MOBILE_UPLOAD_MAX_BYTES = 32 * 1024 * 1024;

const cursor = z.string().nullable().optional();
const empty = z.looseObject({});

const define = <Params extends z.ZodType, Result extends z.ZodType>(
  params: Params,
  result: Result,
) => ({ params, result });

/**
 * Every request a phone can make. Identities in mutation params are chosen by the phone before its
 * first attempt, and retried unchanged, so an uncertain delivery can be repeated safely.
 */
export const mobileMethods = {
  /**
   * Where this phone receives notifications from this desktop, replacing what it last said. Sent
   * again on each connection, since the system can change a phone's address at any time.
   */
  "push.register": define(PushRegistrationSchema, empty),
  /** This phone no longer wants notifications from this desktop. */
  "push.unregister": define(empty, empty),

  "projects.list": define(empty, ProjectListSchema),
  "agents.catalog": define(empty, AgentCatalogSchema),

  "inbox.window": define(
    z.looseObject({
      scope: InboxScopeSchema,
      filter: z.enum(["inbox", "processed"]),
      after: cursor,
      first: z.number().int().min(1).max(100).optional(),
    }),
    InboxWindowSchema,
  ),
  /** The whole message, for one the stream shows truncated. */
  "inbox.message": define(z.looseObject({ pageId: z.string() }), InboxMessageSchema),
  "inbox.capture": define(
    z.looseObject({
      operationId: z.string(),
      pageId: z.string(),
      documentId: z.string(),
      /** When the person sent it, which may be well before an offline capture reaches the Host. */
      issuedAt: z.number(),
      scope: InboxScopeSchema,
      text: z.string(),
      /** Refs returned by `files.upload.commit`. */
      fileRefs: z.array(z.string()),
    }),
    z.looseObject({ pageId: z.string() }),
  ),
  "inbox.decide": define(
    z.looseObject({
      operationId: z.string(),
      pageId: z.string(),
      decision: InboxDecisionSchema,
    }),
    z.looseObject({
      /** Pass to `inbox.undo` while the phone still offers it. */
      undoToken: z.string().nullable(),
      /** The chat a decision started or sent to. */
      sessionId: z.string().nullable(),
    }),
  ),
  "inbox.undo": define(
    z.looseObject({ operationId: z.string(), undoToken: z.string() }),
    z.looseObject({}),
  ),

  "chats.list": define(
    z.looseObject({
      query: z.string().optional(),
      projectId: z.string().nullable().optional(),
      archived: z.boolean().optional(),
      after: cursor,
      first: z.number().int().min(1).max(100).optional(),
    }),
    ChatListSchema,
  ),
  /** Of these chats, the ones the chat list still shows as unread. */
  "chats.unread": define(
    z.looseObject({ sessionIds: z.array(z.string()).max(100) }),
    z.looseObject({ sessionIds: z.array(z.string()) }),
  ),
  "chats.start": define(
    z.looseObject({
      /** Chosen once; the same identities replay the same chat. */
      sessionId: z.string(),
      launchId: z.string(),
      messageId: z.string(),
      projectId: z.string().nullable(),
      text: z.string(),
      fileRefs: z.array(z.string()),
      /** Null runs on the catalog's default. */
      agent: AgentChoiceSchema.nullable(),
      location: z.enum(["local", "worktree"]),
    }),
    z.looseObject({ sessionId: z.string() }),
  ),
  /** Reads the chat and begins `chat.patch` events for it, until `chat.close` or disconnect. */
  "chat.open": define(z.looseObject({ sessionId: z.string() }), ChatSnapshotSchema),
  "chat.close": define(z.looseObject({ sessionId: z.string() }), z.looseObject({})),
  "chat.history": define(
    z.looseObject({ sessionId: z.string(), cursor: z.string() }),
    z.looseObject({ items: z.array(ChatItemSchema), historyCursor: z.string().nullable() }),
  ),
  /** One item whole, for one a window or patch shows truncated. */
  "chat.item": define(z.looseObject({ sessionId: z.string(), itemId: z.string() }), ChatItemSchema),
  "chat.send": define(
    z.looseObject({
      sessionId: z.string(),
      messageId: z.string(),
      text: z.string(),
      fileRefs: z.array(z.string()),
      /** While a Run is active: wait behind it, or redirect it now. */
      delivery: z.enum(["queue", "steer"]),
    }),
    z.looseObject({}),
  ),
  "chat.stop": define(
    z.looseObject({ sessionId: z.string(), runId: z.string() }),
    z.looseObject({}),
  ),
  "chat.respond": define(
    z.looseObject({
      sessionId: z.string(),
      requestId: z.string(),
      runId: z.string().nullable(),
      /** One accepted answer; retries reuse it. */
      submissionId: z.string(),
      response: ChatResponseSchema,
    }),
    z.looseObject({}),
  ),
  "chat.markRead": define(z.looseObject({ sessionId: z.string() }), z.looseObject({})),
  "chat.setArchived": define(
    z.looseObject({ sessionId: z.string(), archived: z.boolean() }),
    z.looseObject({}),
  ),

  "files.read": define(
    z.looseObject({
      ref: z.string(),
      offset: z.number().int().min(0),
      length: z.number().int().min(1).max(MOBILE_FILE_CHUNK_BYTES),
      /**
       * The `version` of the chunk before this one, so one download never splices two versions. A
       * file that has changed since fails with `conflict`, and the phone starts over from zero.
       */
      version: z.string().nullable().optional(),
    }),
    z.looseObject({
      base64: z.string(),
      totalBytes: z.number().int(),
      mimeType: z.string().nullable(),
      name: z.string().nullable(),
      version: z.string().nullable(),
    }),
  ),
  "files.upload.begin": define(
    z.looseObject({
      name: z.string(),
      mimeType: z.string(),
      size: z.number().int().min(1).max(MOBILE_UPLOAD_MAX_BYTES),
    }),
    z.looseObject({ uploadId: z.string() }),
  ),
  "files.upload.chunk": define(
    z.looseObject({ uploadId: z.string(), offset: z.number().int().min(0), base64: z.string() }),
    z.looseObject({}),
  ),
  "files.upload.commit": define(z.looseObject({ uploadId: z.string() }), FileRefSchema),
} as const;

export type MobileMethod = keyof typeof mobileMethods;
export type MobileParams<Method extends MobileMethod> = z.input<
  (typeof mobileMethods)[Method]["params"]
>;
export type MobileResult<Method extends MobileMethod> = z.output<
  (typeof mobileMethods)[Method]["result"]
>;

/** Everything a Host pushes without being asked. */
export const mobileEvents = {
  /**
   * What a phone's lists show may have changed; re-read them. Coalesced, carries no data, and sent
   * only while a channel is open, so a phone also re-reads when it reconnects.
   */
  changed: z.looseObject({
    topics: z.array(z.enum(["inbox", "chats", "projects", "agents"])),
  }),
  /** A chat's live status, for list rows. A chat that went idle is sent once with status `idle`. */
  "chat.activity": ChatActivitySchema,
  /** Changes to a chat this phone has open. */
  "chat.patch": z.looseObject({
    sessionId: z.string(),
    /** See `ChatSnapshot.revision`. */
    revision: z.number().int(),
    ops: z.array(ChatPatchOpSchema),
  }),
  /** The Host lost track of what the phone holds; replace everything for this chat. */
  "chat.snapshot": ChatSnapshotSchema,
} as const;

export type MobileEvent = keyof typeof mobileEvents;
export type MobileEventData<Event extends MobileEvent> = z.output<(typeof mobileEvents)[Event]>;

/** The plaintext inside the encrypted channel. */
export const MobileEnvelopeSchema = z.discriminatedUnion("t", [
  z.looseObject({ t: z.literal("hello"), d: HelloSchema }),
  z.looseObject({
    t: z.literal("req"),
    id: z.number().int(),
    m: z.string(),
    p: z.unknown(),
  }),
  z.discriminatedUnion("ok", [
    z.looseObject({
      t: z.literal("res"),
      id: z.number().int(),
      ok: z.literal(true),
      r: z.unknown(),
    }),
    z.looseObject({
      t: z.literal("res"),
      id: z.number().int(),
      ok: z.literal(false),
      e: RpcErrorSchema,
    }),
  ]),
  z.looseObject({ t: z.literal("evt"), k: z.string(), d: z.unknown() }),
  z.looseObject({ t: z.literal("ping") }),
  z.looseObject({ t: z.literal("pong") }),
]);
export type MobileEnvelope = z.infer<typeof MobileEnvelopeSchema>;
