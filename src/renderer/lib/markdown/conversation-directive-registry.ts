import { CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES } from "../../../shared/conversation-markdown-display";
import type { ConversationDirectiveToken } from "./conversation-directives";

type NullDirective = Exclude<
  (typeof CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES)[number],
  "code-comment"
>;
type RegisteredDirective = NullDirective | "github-details" | "task-stub";
type DirectiveRenderer = "null" | "github-details" | "task-stub";

const nullDirectives = CONVERSATION_MARKDOWN_HIDDEN_DIRECTIVES.filter(
  (name): name is NullDirective => name !== "code-comment",
);
const registry: ReadonlyMap<RegisteredDirective, DirectiveRenderer> = new Map([
  ...nullDirectives.map((name) => [name, "null"] as const),
  ["github-details", "github-details"],
  ["task-stub", "task-stub"],
]);

export type ConversationDirectiveRegistration =
  | { readonly kind: "unregistered" }
  | { readonly kind: "null" }
  | { readonly kind: "task-stub"; readonly title: string; readonly prompt: string }
  | {
      readonly kind: "github-details";
      readonly summary: string | undefined;
      readonly initiallyOpen: boolean;
    };

function isRegistered(name: string): name is RegisteredDirective {
  return (
    name === "github-details" ||
    name === "task-stub" ||
    nullDirectives.some((registered) => registered === name)
  );
}

/** Registration is syntax data; mounted leaves retain all actions and DOM lifetimes. */
export function readConversationDirectiveRegistration(
  token: ConversationDirectiveToken,
): ConversationDirectiveRegistration {
  if (!isRegistered(token.name)) return { kind: "unregistered" };
  if (registry.get(token.name) === "null") return { kind: "null" };
  if (token.name === "task-stub")
    return {
      kind: "task-stub",
      title: typeof token.attributes.title === "string" ? token.attributes.title : "",
      prompt: token.text,
    };
  return {
    kind: "github-details",
    summary: typeof token.attributes.summary === "string" ? token.attributes.summary : undefined,
    initiallyOpen: token.attributes.open === "true",
  };
}
