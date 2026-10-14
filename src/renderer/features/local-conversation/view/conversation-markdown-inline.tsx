import { useLayoutEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileReferenceButton } from "@/components/shared/file-link-anchor";
import { codexComposerSkillsListQueryOptions } from "@/lib/query-options";
import type { ConversationInlineRenderer } from "@/lib/markdown/conversation-token-renderer";
import {
  readConversationSkillMention,
  readConversationTextDecorations,
  readConversationNativeReference,
  resolveConversationInlineCode,
  resolveConversationMarkdownLink,
  resolveConversationSkill,
  presentConversationFileTarget,
  isConversationNativePath,
  type ConversationMarkdownTarget,
} from "@/lib/markdown/conversation-markdown-targets";
import { decodeConversationText, type ConversationToken } from "@/lib/markdown/conversation-tokens";
import {
  useConversationMarkdownSource,
  type ConversationMarkdownSource,
} from "./conversation-markdown-source";

const targetClass =
  "cursor-interaction inline appearance-none border-0 bg-transparent p-0 text-left align-baseline text-token-text-link-foreground hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-token-focus-border";
function createInlineLease() {
  let current: string | null = null;
  return {
    activate(identity: string) {
      current = identity;
      return () => {
        if (current === identity) current = null;
      };
    },
    matches: (identity: string) => current === identity,
  };
}
function ConversationTarget({
  target,
  href,
}: {
  readonly target: ConversationMarkdownTarget;
  readonly href?: string;
}) {
  const source = useConversationMarkdownSource();
  const [lease] = useState(createInlineLease);
  const identity = JSON.stringify([source?.sourceIdentity ?? null, target]);
  useLayoutEffect(() => lease.activate(identity), [lease, identity]);
  const isCurrent = () => lease.matches(identity) && source?.isCurrent() === true;
  if (!source) return target.label;
  if (
    target.kind === "file" &&
    !isConversationNativePath(target.reference.path) &&
    !source.cwd &&
    !source.workspaceRoot
  )
    return target.label;
  if (target.kind === "file")
    return (
      <FileReferenceButton
        target={target.reference}
        label={target.label}
        href={href}
        hostId={source.hostId}
        cwd={source.cwd}
        projectWorkspacePath={source.workspaceRoot}
        tooltipLabel={target.tooltip}
        isCurrent={isCurrent}
      >
        {target.label}
      </FileReferenceButton>
    );
  if (target.kind === "thread") {
    if (!source.onOpenThread) return target.label;
    return (
      <button
        type="button"
        className={targetClass}
        data-prompt-link-href={href}
        data-prompt-link-label={target.label}
        onClick={() => {
          if (!isCurrent()) return;
          void source.onOpenThread?.(target.threadId, {
            hostId: target.explicitHostId ?? source.hostId,
            sourceRoot: source.sourceRoot,
            isSourceCurrent: isCurrent,
          });
        }}
      >
        {target.label}
      </button>
    );
  }
  return source.skills ? (
    <ConversationSkill
      target={target}
      source={source}
      skills={source.skills}
      isCurrent={isCurrent}
    />
  ) : (
    <ConversationQueriedSkill target={target} source={source} isCurrent={isCurrent} />
  );
}
function ConversationQueriedSkill({
  target,
  source,
  isCurrent,
}: {
  readonly target: Extract<ConversationMarkdownTarget, { kind: "skill" }>;
  readonly source: ConversationMarkdownSource;
  readonly isCurrent: () => boolean;
}) {
  const catalog = useQuery(
    codexComposerSkillsListQueryOptions(source.cwd ? [source.cwd] : [], source.hostId),
  );
  return (
    <ConversationSkill
      target={target}
      source={source}
      skills={catalog.data ?? []}
      isCurrent={isCurrent}
    />
  );
}
function ConversationSkill({
  target,
  source,
  skills,
  isCurrent,
}: {
  readonly target: Extract<ConversationMarkdownTarget, { kind: "skill" }>;
  readonly source: ConversationMarkdownSource;
  readonly skills: NonNullable<ConversationMarkdownSource["skills"]>;
  readonly isCurrent: () => boolean;
}) {
  const presentation = resolveConversationSkill(target, skills, source.hostId);
  const [lease] = useState(createInlineLease);
  const identity = JSON.stringify([presentation.reference, presentation.skill]);
  useLayoutEffect(() => lease.activate(identity), [lease, identity]);
  const isCurrentSkill = () => isCurrent() && lease.matches(identity);
  if (!presentation.reference) return presentation.label;
  return (
    <FileReferenceButton
      target={presentation.reference}
      label={presentation.label}
      href={target.href}
      hostId={source.hostId}
      cwd={source.cwd}
      projectWorkspacePath={source.workspaceRoot}
      tooltipLabel={presentation.skill?.description}
      isCurrent={isCurrentSkill}
    >
      {presentation.label}
    </FileReferenceButton>
  );
}
function plainLabel(token: ConversationToken): string {
  if ("tokens" in token && Array.isArray(token.tokens))
    return token.tokens.map((child) => plainLabel(child as ConversationToken)).join("");
  return "text" in token && typeof token.text === "string"
    ? decodeConversationText(token.text)
    : "";
}
function Swatch({ color }: { readonly color: string }) {
  return (
    <span
      aria-hidden="true"
      data-hex-color-swatch={color}
      className="ms-1 inline-block size-3 rounded-[3px] border border-token-border align-[-0.08em]"
      style={{ backgroundColor: color }}
    />
  );
}
function mention(content: string): ConversationMarkdownTarget | null {
  const name = readConversationSkillMention(content);
  if (name) return { kind: "skill", name, label: content };
  if (!content.startsWith("@")) return null;
  return {
    kind: "file",
    reference: readConversationNativeReference(content.slice(1)),
    label: content.slice(1),
    tooltip: content.slice(1),
  };
}

/** Syntax data stays in the document cache; interactive authority is read by mounted leaves. */
export const renderConversationInline: ConversationInlineRenderer = (
  node,
  renderPlain,
  context,
) => {
  const token = node.token;
  if (token.type === "link") {
    const target = resolveConversationMarkdownLink(token.href, plainLabel(token));
    return target ? <ConversationTarget target={target} href={token.href} /> : undefined;
  }
  if (token.type === "codespan") {
    const target = resolveConversationInlineCode(token.text);
    if (target) return <ConversationTarget target={target} />;
    const color = readConversationTextDecorations(token.text).find(
      (value) =>
        value.type === "color" && value.index === 0 && value.content.length === token.text.length,
    );
    return color ? (
      <>
        {renderPlain()}
        <Swatch color={color.content} />
      </>
    ) : undefined;
  }
  if (token.type === "codexDirective" && token.name === "codex-file-citation") {
    const path = token.attributes.path;
    if (typeof path !== "string" || !path) return token.raw;
    const line = Number(token.attributes.line_range_start);
    const endLine = Number(token.attributes.line_range_end);
    const reference = {
      path,
      ...(Number.isSafeInteger(line) && line > 0 ? { line } : {}),
      ...(Number.isSafeInteger(endLine) && endLine > 0 ? { endLine } : {}),
    };
    return <ConversationTarget target={presentConversationFileTarget(reference, "")} />;
  }
  if (token.type !== "text" || node.children.length > 0) return undefined;
  const text = node.segments.map((segment) => segment.text).join("");
  const decorations = readConversationTextDecorations(text, context.precedingText);
  if (!decorations.length) return undefined;
  let cursor = 0;
  const content: ReactNode[] = [];
  const occurrences = new Map<string, number>();
  for (const decoration of decorations) {
    if (decoration.index < cursor) continue;
    const identity = `${decoration.type}:${decoration.content}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const key = `${node.key}:${identity}:${occurrence}`;
    content.push(<span key={`${key}:before`}>{renderPlain(cursor, decoration.index)}</span>);
    const end = decoration.index + decoration.content.length;
    const target = decoration.type === "mention" ? mention(decoration.content) : null;
    content.push(
      target ? (
        <ConversationTarget key={key} target={target} />
      ) : (
        <span key={key}>
          {renderPlain(decoration.index, end)}
          <Swatch color={decoration.content} />
        </span>
      ),
    );
    cursor = end;
  }
  content.push(<span key={`${node.key}:tail`}>{renderPlain(cursor)}</span>);
  return content;
};
