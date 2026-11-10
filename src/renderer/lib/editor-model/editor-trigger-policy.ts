import { matchInlineSkills } from "../../../../packages/agent-runtime/vendor/shared/src/inlineSkills";

export type NfmTypedSuggestionKind = "slash" | "page-mention" | "emoji" | "skill-mention";

export type NfmPageMentionTrigger = "@" | "+" | "[[";

export type NfmTriggerRejectionReason =
  | "unsupported-trigger"
  | "protected-literal"
  | "invalid-left-boundary";

export type NfmTriggerDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: NfmTriggerRejectionReason;
    };

export interface NfmTriggerPolicyInput {
  readonly kind: NfmTypedSuggestionKind;
  readonly trigger: string;
  readonly textBeforeTrigger: string;
  readonly locale: string;
}

const DEFAULT_SLASH_TRIGGERS = ["/", "／"] as const;
const JAPANESE_SLASH_TRIGGER = "；";
const URL_LIKE_SLASH_PREFIXES = ["http:", "http:/", "https:", "https:/"] as const;

function isJapaneseLocale(locale: string): boolean {
  return /^ja(?:-|$)/i.test(locale.trim());
}

function normalizedLastCharacter(value: string): string {
  return Array.from(value.normalize("NFKC")).at(-1) ?? "";
}

function reject(reason: NfmTriggerRejectionReason): NfmTriggerDecision {
  return { allowed: false, reason };
}

function isSupportedTrigger(input: NfmTriggerPolicyInput): boolean {
  if (input.kind === "slash") {
    return getNfmSlashTriggerCharacters(input.locale).includes(input.trigger);
  }
  if (input.kind === "page-mention") {
    return input.trigger === "@" || input.trigger === "+" || input.trigger === "[[";
  }
  if (input.kind === "skill-mention") return input.trigger === "$";
  return input.trigger === ":";
}

function hasSlashBoundary(textBeforeTrigger: string): boolean {
  if (!textBeforeTrigger) return true;
  return /\p{Z}/u.test(Array.from(textBeforeTrigger).at(-1) ?? "");
}

function hasMentionBoundary(textBeforeTrigger: string): boolean {
  if (!textBeforeTrigger) return true;
  return /[\s()\[\]]/u.test(normalizedLastCharacter(textBeforeTrigger));
}

function hasPageMentionBoundary(trigger: string, textBeforeTrigger: string): boolean {
  if (trigger === "[[") return true;
  return hasMentionBoundary(textBeforeTrigger);
}

function hasEmojiBoundary(textBeforeTrigger: string): boolean {
  if (!textBeforeTrigger) return true;
  return /[\s{\[(]/u.test(normalizedLastCharacter(textBeforeTrigger));
}

export function getNfmSlashTriggerCharacters(locale: string): string[] {
  return isJapaneseLocale(locale)
    ? [...DEFAULT_SLASH_TRIGGERS, JAPANESE_SLASH_TRIGGER]
    : [...DEFAULT_SLASH_TRIGGERS];
}

/** Decides whether literal typed input may start a new suggestion session. */
export function evaluateNfmTypedSuggestionTrigger(
  input: NfmTriggerPolicyInput,
): NfmTriggerDecision {
  if (!isSupportedTrigger(input)) return reject("unsupported-trigger");

  if (
    input.kind === "slash" &&
    URL_LIKE_SLASH_PREFIXES.some((prefix) => input.textBeforeTrigger.endsWith(prefix))
  ) {
    return reject("protected-literal");
  }

  if (input.kind === "skill-mention") {
    return /(?:^|\s)$/u.test(input.textBeforeTrigger)
      ? { allowed: true }
      : reject("invalid-left-boundary");
  }

  const hasBoundary =
    input.kind === "slash"
      ? hasSlashBoundary(input.textBeforeTrigger)
      : input.kind === "page-mention"
        ? hasPageMentionBoundary(input.trigger, input.textBeforeTrigger)
        : hasEmojiBoundary(input.textBeforeTrigger);

  return hasBoundary ? { allowed: true } : reject("invalid-left-boundary");
}

/** Use the provider token rule for both candidate eligibility and currency-shaped queries. */
export function isNfmInlineSkillToken(name: string): boolean {
  return !matchInlineSkills(`$${name}`, [{ name }]).next().done;
}

export function shouldCloseNfmSkillQuery(query: string, names: readonly string[]): boolean {
  if (!query) return names.length === 0;
  const prefix = query.toLowerCase();
  return !names.some((name) => name.toLowerCase().startsWith(prefix));
}
