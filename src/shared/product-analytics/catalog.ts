import { z } from "zod";

/**
 * The complete vocabulary Nodex can send as anonymous product analytics. A value that does not
 * decode against this closed catalog is discarded before it reaches the outbox, so prompts, paths,
 * titles and other content have no field to travel in. See
 * docs/product-specs/product-analytics-behavior.md.
 */

/** Short machine vocabulary: no spaces or path separators, so free text cannot fit. */
const Code = z.string().regex(/^[a-zA-Z0-9_.:-]{1,64}$/);
const Count = z.number().int().nonnegative();
const Outcome = z.enum(["success", "failure", "aborted"]);
const Provider = z.enum(["codex", "claude", "opencode", "acp", "other"]);
const ImageSource = Code;

const event = <const Name extends string, Fields extends z.ZodRawShape>(
  name: Name,
  properties: Fields,
) =>
  z.strictObject({
    name: z.literal(name),
    value: z.number().optional(),
    properties: z.strictObject(properties),
  });

const lifecycleEvents = [
  /** Once per installation. `existing` marks a Profile that predates analytics. */
  event("installation_created", { profile: z.enum(["new", "existing"]) }),
  event("app_launched", { launch: z.enum(["first", "updated", "returning"]) }),
  /** The first window focus of each UTC day: a person used Nodex, not just a background process. */
  event("app_active", {}),
] as const;

const threadFields = {
  provider: Provider,
  model: Code,
  source: z.enum(["web", "mobile", "mcp", "provider", "server"]),
  actor: z.enum(["user", "agent", "system"]),
  host: z.enum(["local", "remote"]),
};

const executionEvents = [
  /** A new conversation. Subagents, forks and side chats are `thread_branched`. */
  event("thread_started", threadFields),
  event("thread_branched", {
    ...threadFields,
    kind: z.enum(["fork", "subagent", "side_chat"]),
  }),
  event("turn_completed", {
    provider: Provider,
    model: Code,
    status: z.enum(["completed", "failed", "interrupted", "cancelled"]),
    effort: Code.optional(),
    runtime_mode: Code.optional(),
    interaction_mode: Code.optional(),
    has_subagents: z.boolean().optional(),
    input_tokens: Count.optional(),
    cached_input_tokens: Count.optional(),
    output_tokens: Count.optional(),
    reasoning_tokens: Count.optional(),
  }),
] as const;

const rendererEvents = [
  /** Conversations on a remote host; local execution reports `turn_completed` from the Runtime. */
  event("turn_first_response", {
    outcome: Outcome,
    reason: Code.optional(),
    submission_kind: Code.optional(),
    response_runtime: Code.optional(),
    thread_kind: Code.optional(),
  }),
  event("thread_opened", {
    outcome: Outcome,
    reason: Code.optional(),
    thread_kind: Code.optional(),
    thread_state: Code.optional(),
  }),
  event("composer_prediction_interaction", {
    action: Code,
    edited: z.boolean().optional(),
    trigger: Code.optional(),
    model: Code,
  }),
  event("composer_prediction_submitted", {
    accepted: z.boolean(),
    edited: z.boolean().optional(),
    trigger: Code.optional(),
  }),
  event("thread_message_navigation", { ordinal: Count, item_count: Count }),
  event("image_view", {
    available_image_count: Count,
    entrypoint: Code,
    image_source: ImageSource,
    view: Code,
  }),
  event("image_edit_entered", { image_source: ImageSource, mode: Code, view: Code }),
  event("image_edit_submitted", {
    comment_count: Count.optional(),
    has_general_instruction: z.boolean(),
    image_source: ImageSource,
    mode: Code,
    selected_image_count: Count,
  }),
  event("image_edit_submit_outcome", {
    failure_reason: Code.optional(),
    image_source: ImageSource,
    mode: Code,
    outcome: Code,
    route: Code,
  }),
  event("image_editor_pin_outcome", {
    entrypoint: Code,
    image_source: ImageSource,
    outcome: Code,
    reason: Code.optional(),
  }),
  /** A Readback appeared, was acted on from its card, or left the window, and how. */
  event("readback", {
    action: z.enum([
      "shown",
      "stopped",
      "opened",
      "replied",
      "dismissed",
      "expired",
      "withdrawn",
      "replaced",
      "overflow",
    ]),
  }),
  /** A surface a person looked at or used in a window session: adoption, not volume. */
  event("feature_used", {
    feature: z.enum([
      "browser",
      "canvas",
      "command_palette",
      "database",
      "dictation",
      "inbox",
      "page",
      "review",
      "terminal",
    ]),
  }),
] as const;

export const RendererProductEvent = z.discriminatedUnion("name", rendererEvents);
export type RendererProductEvent = z.infer<typeof RendererProductEvent>;

export const ProductEvent = z.discriminatedUnion("name", [
  ...lifecycleEvents,
  ...executionEvents,
  ...rendererEvents,
]);
export type ProductEvent = z.infer<typeof ProductEvent>;
export type ProductEventName = ProductEvent["name"];

/** Strict at every level: an unknown event or field means the whole value is discarded. */
export const decodeProductEvent = (value: unknown): ProductEvent | null => {
  const result = ProductEvent.safeParse(value);
  return result.success ? result.data : null;
};

/** A renderer can report only what happens in a window, never installation or execution facts. */
export const decodeRendererProductEvent = (value: unknown): RendererProductEvent | null => {
  const result = RendererProductEvent.safeParse(value);
  return result.success ? result.data : null;
};
