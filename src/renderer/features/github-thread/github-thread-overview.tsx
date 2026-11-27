import { FormattedMessage } from "@/lib/i18n";
import { PAGE_TITLE_TEXT_CLASS_NAME } from "@/components/block-documents/page-title-typography";
import { PageStageContentLayout } from "@/components/board/page-stage/frame";
import type { GitHubThreadDetail, GitHubThreadLinks } from "../../../shared/github-thread";
import { GitHubThreadActivity } from "./github-thread-activity";
import { GitHubThreadComposer } from "./github-thread-composer";
import type { GitHubChatContextSubject } from "./github-thread-model";
import { GitHubMarkdown } from "./github-thread-parts";
import { GitHubThreadProperties } from "./github-thread-properties";
import type { GitHubThreadCommandRunner } from "./github-thread-surface-types";

/** Title, where it stands, what it says, and what happened since: the thread in reading order. */
export function GitHubThreadOverview({
  detail,
  links,
  run,
  onShowFiles,
  onAddToChat,
  revealChecks,
}: {
  readonly detail: GitHubThreadDetail;
  readonly links: GitHubThreadLinks | null;
  readonly run: GitHubThreadCommandRunner & { readonly post: (body: string) => Promise<boolean> };
  readonly onShowFiles: () => void;
  readonly onAddToChat: ((subject: GitHubChatContextSubject) => void) | null;
  readonly revealChecks: boolean;
}) {
  return (
    <PageStageContentLayout
      title={
        <h1 className={PAGE_TITLE_TEXT_CLASS_NAME} data-github-thread-title="">
          {detail.title}
        </h1>
      }
      properties={
        <GitHubThreadProperties
          detail={detail}
          links={links}
          run={run}
          onShowFiles={onShowFiles}
          onAddToChat={onAddToChat}
          revealChecks={revealChecks}
        />
      }
      body={
        <div className="flex flex-col gap-6">
          <div
            className="border-t-[0.5px] border-token-border pt-5"
            data-github-thread-description=""
          >
            {detail.body.trim() ? (
              <GitHubMarkdown markdown={detail.body} thread={detail.ref} />
            ) : (
              <p className="text-sm text-token-description-foreground">
                <FormattedMessage
                  id="githubThread.description.empty"
                  defaultMessage="No description."
                />
              </p>
            )}
          </div>
          <GitHubThreadActivity detail={detail} onAddToChat={onAddToChat} />
          <GitHubThreadComposer detail={detail} run={run} />
        </div>
      }
    />
  );
}
