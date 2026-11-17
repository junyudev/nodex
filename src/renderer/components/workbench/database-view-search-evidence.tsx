import { FormattedMessage } from "@/lib/i18n";
import type { components } from "@nodex/core-protocol";
import type { DatabaseViewSearchStatus } from "../../../shared/database-views";

type DatabasePageSearchEvidence = components["schemas"]["DatabasePageSearchEvidence"];

type TextPart = components["schemas"]["LibraryPageSearchTextPart"];

export function DatabaseSearchHighlight({ parts }: { readonly parts: readonly TextPart[] }) {
  let offset = 0;
  return parts.map(({ text, highlighted }) => {
    const start = offset;
    offset += text.length;
    return highlighted ? (
      <mark key={start} className="bg-token-editor-find-match-background text-inherit">
        {text}
      </mark>
    ) : (
      text
    );
  });
}

export function DatabaseSearchTitle({
  title,
  parts,
}: {
  readonly title: string;
  readonly parts?: readonly TextPart[];
}) {
  if (!parts?.some((part) => part.highlighted) || parts.map((part) => part.text).join("") !== title)
    return title;
  return <DatabaseSearchHighlight parts={parts} />;
}

export function DatabaseViewSearchNotice({
  status,
}: {
  readonly status?: DatabaseViewSearchStatus;
}) {
  if (!status || (status.coverage === "complete" && !status.truncated)) return null;
  return (
    <div role="status" className="shrink-0 px-4 py-1 text-xs text-token-description-foreground">
      {status.coverage === "indexing" ? (
        <div>
          <FormattedMessage
            id="database.viewSearch.indexing"
            defaultMessage="Still indexing Pages. Some matches may not appear yet."
          />
        </div>
      ) : null}
      {status.truncated ? (
        <div>
          <FormattedMessage
            id="database.viewSearch.truncated"
            defaultMessage="Some matches were omitted. Try a more specific search."
          />
        </div>
      ) : null}
    </div>
  );
}

export function DatabaseSearchExcerpt({
  evidence,
}: {
  readonly evidence: DatabasePageSearchEvidence;
}) {
  const historicalKey = evidence.matches.find(
    (match) => match.source === "page_key" && !match.is_current,
  );
  return (
    <>
      {historicalKey ? (
        <FormattedMessage
          id="database.viewSearch.matchedKey"
          defaultMessage="Matched {key}"
          values={{ key: <DatabaseSearchHighlight parts={historicalKey.parts} /> }}
        />
      ) : null}
      {historicalKey && evidence.excerpt_parts ? " · " : null}
      {evidence.excerpt_parts ? <DatabaseSearchHighlight parts={evidence.excerpt_parts} /> : null}
    </>
  );
}

export const hasDatabaseSearchExcerpt = (
  evidence: DatabasePageSearchEvidence | undefined,
): evidence is DatabasePageSearchEvidence =>
  Boolean(
    evidence?.excerpt_parts ||
    evidence?.matches.some((match) => match.source === "page_key" && !match.is_current),
  );
