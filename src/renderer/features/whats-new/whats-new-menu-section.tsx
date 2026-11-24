import type { ReactNode } from "react";
import { CHANGELOG_PAGE_URL } from "../../../shared/changelog-feed";
import { OpenExternalIcon } from "@/components/shared/icons";
import { NodexDropdownItem, NodexDropdownSectionLabel } from "@/components/ui/dropdown";
import { LoadingPlaceholder } from "@/components/ui/loading-placeholder";
import { NodexOverflowTooltip } from "@/components/ui/tooltip";
import { useChangelogFeed } from "@/lib/changelog-feed";
import { defineMessages, useIntl } from "@/lib/i18n";
import { appScope, useScopeHandle } from "@/lib/maitai";
import { openModal } from "@/lib/modal-registry";
import { cn } from "@/lib/utils";
import { ReleaseNotesDialog } from "./release-notes-dialog";
import { openChangelogPage, releaseDay } from "./whats-new-actions";
import { WHATS_NEW_RELEASE_COUNT } from "./whats-new-model";
import { useNewReleases } from "./whats-new-seen";

const MESSAGES = defineMessages({
  title: { id: "whatsNew.title", defaultMessage: "What's new" },
  fullChangelog: { id: "whatsNew.fullChangelog", defaultMessage: "Full changelog" },
  loading: { id: "whatsNew.loading", defaultMessage: "Loading recent releases" },
});

/** Placeholder headline widths while the releases load, so the rows don't read as one block. */
const LOADING_WIDTHS = [104, 72, 88] as const;

/**
 * A menu's account of recent releases: the newest few on a timeline, each opening its release
 * notes, then the full changelog on the website. Releases published since the person last looked
 * carry a filled dot. Without the feed, only the way to the full changelog remains.
 */
export function WhatsNewMenuSection({
  openAfterClose,
}: {
  /** Opens a release's notes once the menu has closed, so the dialog keeps focus. */
  readonly openAfterClose: (open: () => void) => void;
}) {
  const intl = useIntl();
  const appHandle = useScopeHandle(appScope);
  const feed = useChangelogFeed();
  const releases = feed.data?.releases.slice(0, WHATS_NEW_RELEASE_COUNT);
  const newReleases = useNewReleases(releases);
  const dateFormat = { day: "numeric", month: "short", timeZone: "UTC" } as const;

  return (
    <>
      <NodexDropdownSectionLabel>{intl.formatMessage(MESSAGES.title)}</NodexDropdownSectionLabel>
      {feed.isPending ? (
        <div role="group" aria-busy="true" aria-label={intl.formatMessage(MESSAGES.loading)}>
          {LOADING_WIDTHS.map((width) => (
            <TimelineStop key={width} connected>
              <NodexDropdownItem
                disabled
                className="opacity-100"
                leftSlot={<TimelineDot />}
                rightSlot={<LoadingPlaceholder className="h-3 w-9 rounded" />}
              >
                <LoadingPlaceholder className="h-3 rounded" style={{ width }} />
              </NodexDropdownItem>
            </TimelineStop>
          ))}
        </div>
      ) : (
        releases?.map((release) => (
          <TimelineStop key={release.version} connected>
            <NodexOverflowTooltip content={release.headline} side="right">
              <NodexDropdownItem
                leftSlot={<TimelineDot fresh={newReleases.has(release.version)} />}
                rightSlot={
                  <time
                    dateTime={release.date}
                    className="text-xs text-token-description-foreground tabular-nums"
                  >
                    {intl.formatDate(releaseDay(release), dateFormat)}
                  </time>
                }
                onSelect={() =>
                  openAfterClose(() => openModal(appHandle, ReleaseNotesDialog, { release }))
                }
              >
                <span data-tooltip-overflow-target className="block truncate">
                  {release.headline}
                </span>
              </NodexDropdownItem>
            </NodexOverflowTooltip>
          </TimelineStop>
        ))
      )}
      <TimelineStop>
        <NodexDropdownItem
          leftSlot={<TimelineDot />}
          rightSlot={<OpenExternalIcon className="icon-2xs text-token-description-foreground" />}
          onSelect={() => void openChangelogPage(feed.data?.url ?? CHANGELOG_PAGE_URL)}
        >
          {intl.formatMessage(MESSAGES.fullChangelog)}
        </NodexDropdownItem>
      </TimelineStop>
    </>
  );
}

/**
 * One row on the timeline. A connected row draws the line from its dot down to the next row's,
 * stopping short of both dots.
 */
function TimelineStop({
  connected = false,
  children,
}: {
  readonly connected?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="relative">
      {connected ? (
        <span
          aria-hidden="true"
          // The row's inline padding plus half the 16px leading column puts the line through
          // each dot's center.
          className="pointer-events-none absolute top-1/2 -bottom-1/2 left-[calc(var(--padding-row-x)+8px)] my-2 w-px -translate-x-1/2 bg-token-border"
        />
      ) : null}
      {children}
    </div>
  );
}

/**
 * A filled dot, in the color that marks unread chats, for a release that is new to the person,
 * and a ring for everything else. It takes the 16px column the menu's icons use, so every label
 * lines up.
 */
function TimelineDot({ fresh = false }: { readonly fresh?: boolean }) {
  return (
    <span aria-hidden="true" className="inline-flex size-4 items-center justify-center">
      <span
        data-fresh={fresh || undefined}
        className={cn(
          "size-[7px] rounded-full",
          fresh ? "bg-info-solid" : "border-[1.33px] border-current text-tertiary",
        )}
      />
    </span>
  );
}
