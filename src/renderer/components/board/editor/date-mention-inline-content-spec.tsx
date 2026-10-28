import { lazy, Suspense } from "react";
import { createReactInlineContentSpec } from "@blocknote/react";
import { formatDateMentionPlainText } from "../../../../shared/rich-text/date-mention";
import { dateMentionInlineContentConfig } from "../../../../shared/block-documents/blocknote-schema-config";
import { DateMentionInlineVisual } from "../date-mention-inline-visual";
import {
  dateMentionPropsToPayload,
  type DateMentionInlineContentUpdate,
  type DateMentionProps,
} from "./date-mention-inline-content";

const LazyDateMentionInlineContentView = lazy(async () => ({
  default: (await import("./date-mention-chip")).DateMentionInlineContentView,
}));

const readDateMentionPayload = (inlineContent: unknown) =>
  dateMentionPropsToPayload((inlineContent as { props: Partial<DateMentionProps> }).props);

function DateMentionFallback({ inlineContent }: { readonly inlineContent: unknown }) {
  const payload = readDateMentionPayload(inlineContent);
  const title = formatDateMentionPlainText(payload);
  return (
    <DateMentionInlineVisual
      as="button"
      payload={payload}
      withGuards
      contentEditable={false}
      title={title}
      aria-label={title}
    />
  );
}

export function createReadonlyDateMentionInlineContentSpec() {
  return createReactInlineContentSpec(dateMentionInlineContentConfig, {
    render: ({ inlineContent }) => {
      const payload = readDateMentionPayload(inlineContent);
      return (
        <DateMentionInlineVisual
          as="button"
          payload={payload}
          withGuards
          contentEditable={false}
          title={formatDateMentionPlainText(payload)}
          tabIndex={-1}
        />
      );
    },
  });
}

export function createDateMentionInlineContentSpec() {
  return createReactInlineContentSpec(dateMentionInlineContentConfig, {
    render: ({ inlineContent, updateInlineContent }) => (
      <Suspense fallback={<DateMentionFallback inlineContent={inlineContent} />}>
        <LazyDateMentionInlineContentView
          inlineContent={inlineContent as { props: Partial<DateMentionProps> }}
          updateInlineContent={
            updateInlineContent as (update: DateMentionInlineContentUpdate) => void
          }
        />
      </Suspense>
    ),
    toExternalHTML: ({ inlineContent }) => {
      const payload = readDateMentionPayload(inlineContent);
      return (
        <DateMentionInlineVisual
          as="button"
          payload={payload}
          withGuards
          contentEditable={false}
          title={formatDateMentionPlainText(payload)}
        />
      );
    },
  });
}
