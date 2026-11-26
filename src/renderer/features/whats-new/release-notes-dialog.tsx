import { useRef, useState } from "react";
import type { ChangelogSectionKind } from "../../../shared/changelog";
import type { ChangelogEntryMedia, ChangelogRelease } from "../../../shared/changelog-feed";
import { changelogInlineTokens } from "../../../shared/changelog-inline";
import { OpenExternalIcon } from "@/components/shared/icons";
import {
  NodexDialog,
  NodexDialogContent,
  NodexDialogDescription,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import { NodexTooltip } from "@/components/ui/tooltip";
import { ImagePreviewDialog } from "@/features/user-attachment-image-editor";
import { defineMessage, defineMessages, useIntl } from "@/lib/i18n";
import { useTheme } from "@/lib/use-theme";
import { cn } from "@/lib/utils";
import type { ModalCloseProps } from "@/lib/modal-registry";
import { openChangelogPage, releaseDay } from "./whats-new-actions";

const SECTION_TITLES = defineMessages({
  added: { id: "whatsNew.section.added", defaultMessage: "Added" },
  changed: { id: "whatsNew.section.changed", defaultMessage: "Changed" },
  deprecated: { id: "whatsNew.section.deprecated", defaultMessage: "Deprecated" },
  removed: { id: "whatsNew.section.removed", defaultMessage: "Removed" },
  fixed: { id: "whatsNew.section.fixed", defaultMessage: "Fixed" },
  security: { id: "whatsNew.section.security", defaultMessage: "Security" },
} satisfies Record<ChangelogSectionKind, unknown>);

const RELEASE_VERSION_LABEL = defineMessage<{ version: string }>({
  id: "whatsNew.releaseVersion",
  defaultMessage: "v{version}",
});
const RELEASE_DESCRIPTION = defineMessage<{ version: string }>({
  id: "whatsNew.releaseDescription",
  defaultMessage: "What changed in Nodex {version}",
});
const OPEN_CHANGE_PAGE = defineMessage({
  id: "whatsNew.openChangePage",
  defaultMessage: "View on the changelog",
});
const OPEN_ON_WEBSITE = defineMessage({
  id: "whatsNew.openOnWebsite",
  defaultMessage: "View in full changelog",
});

/**
 * One release's notes, read in place: its day and version, its headline, then each kind of change
 * with every entry's first sentence set apart from the detail after it, as the changelog page
 * reads them.
 */
export function ReleaseNotesDialog({
  release,
  onClose,
}: ModalCloseProps & { readonly release: ChangelogRelease }) {
  const intl = useIntl();
  const notes = useRef<HTMLElement>(null);
  const version = { version: release.version };

  return (
    <NodexDialog open onOpenChange={(open) => !open && onClose()}>
      <NodexDialogContent
        size="wide"
        // The notes take focus, so they open at the top and scroll from the keyboard.
        initialFocus={notes}
        className="flex max-h-[min(720px,calc(100dvh-4rem))] flex-col"
      >
        <article
          ref={notes}
          tabIndex={-1}
          className="min-h-0 overflow-y-auto px-7 pt-6 pb-7 outline-none select-text"
        >
          <header className="pe-8">
            <p className="flex items-center gap-2 text-sm text-token-description-foreground tabular-nums">
              <time dateTime={release.date}>
                {intl.formatDate(releaseDay(release), {
                  day: "numeric",
                  month: "long",
                  year: "numeric",
                  timeZone: "UTC",
                })}
              </time>
              <span className="font-mono text-[0.92em]">
                {intl.formatMessage(RELEASE_VERSION_LABEL, version)}
              </span>
            </p>
            <NodexDialogTitle className="mt-1 text-pretty">{release.headline}</NodexDialogTitle>
            <NodexDialogDescription className="sr-only">
              {intl.formatMessage(RELEASE_DESCRIPTION, version)}
            </NodexDialogDescription>
          </header>
          {release.sections.map((section) => (
            <section key={section.kind} className="mt-6">
              <h3 className="text-sm font-medium text-token-description-foreground">
                {intl.formatMessage(SECTION_TITLES[section.kind])}
              </h3>
              <ul className="mt-2.5 flex flex-col gap-3">
                {section.entries.map((entry, index) => (
                  <li
                    // Entries are published text without identities; their place is stable.
                    key={index}
                    className="text-sm leading-[1.6] text-pretty text-token-description-foreground"
                  >
                    <span className="font-medium text-token-foreground">
                      <ChangelogInlineText markdown={entry.lead} />
                    </span>
                    {entry.detail ? (
                      <>
                        {" "}
                        <ChangelogInlineText markdown={entry.detail} />
                      </>
                    ) : null}
                    {entry.media?.[0] ? (
                      <ChangelogPicture media={entry.media[0]} url={entry.url ?? release.url} />
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <button
            type="button"
            className="mt-7 inline-flex cursor-interaction items-center gap-1 text-sm text-token-description-foreground hover:text-token-foreground focus-visible:text-token-foreground focus-visible:outline-none"
            onClick={() => void openChangelogPage(release.url)}
          >
            {intl.formatMessage(OPEN_ON_WEBSITE)}
            <OpenExternalIcon className="icon-2xs" />
          </button>
        </article>
      </NodexDialogContent>
    </NodexDialog>
  );
}

/**
 * An entry's first picture in the app's appearance, framed and capped in height so it illustrates
 * the entry without taking over the notes. It opens full size in the image viewer, like every image
 * in Nodex, which also leads to the change's page on the changelog.
 */
function ChangelogPicture({
  media,
  url,
}: {
  readonly media: ChangelogEntryMedia;
  readonly url: string;
}) {
  const images = (
    [
      ["light", media.light],
      ["dark", media.dark],
    ] as const
  ).flatMap(([theme, image]) => (image ? [{ theme, image }] : []));
  const intl = useIntl();
  const { resolved } = useTheme();
  const [viewing, setViewing] = useState(false);
  const shown = images.find(({ theme }) => theme === resolved) ?? images[0];
  return (
    <>
      <NodexTooltip tooltipContent={media.caption}>
        <button
          type="button"
          className="mt-2.5 flex w-full cursor-interaction items-center justify-center overflow-hidden rounded-lg bg-token-foreground/[0.035] p-3 ring-1 ring-token-border/60 transition-opacity hover:opacity-90 focus-visible:ring-2 focus-visible:ring-token-focus-border focus-visible:outline-none"
          onClick={() => setViewing(true)}
        >
          {images.map(({ theme, image }) => (
            <img
              key={theme}
              src={image.src}
              // Pictures are captured at twice their on-screen size.
              width={Math.round(image.width / 2)}
              height={Math.round(image.height / 2)}
              alt={media.caption}
              loading="lazy"
              decoding="async"
              draggable={false}
              className={cn(
                "h-auto max-h-80 w-auto max-w-full rounded-md object-contain",
                images.length > 1 && (theme === "light" ? "dark:hidden" : "hidden dark:block"),
              )}
            />
          ))}
        </button>
      </NodexTooltip>
      {viewing && shown ? (
        <ImagePreviewDialog
          open
          onOpenChange={setViewing}
          src={shown.image.src}
          alt={media.caption}
          title={media.caption}
          openIn={{
            label: intl.formatMessage(OPEN_CHANGE_PAGE),
            open: () => void openChangelogPage(url),
          }}
        />
      ) : null}
    </>
  );
}

/** An entry's inline Markdown: code spans and strong runs styled, everything else as text. */
function ChangelogInlineText({ markdown }: { readonly markdown: string }) {
  return changelogInlineTokens(markdown).map((token, index) =>
    token.kind === "code" ? (
      <code
        key={index}
        className="rounded-[5px] bg-token-foreground/[0.07] px-[0.32em] py-[0.06em] font-mono text-[0.88em] text-token-foreground"
      >
        {token.text}
      </code>
    ) : token.kind === "strong" ? (
      // Color tells a lead from its detail and weight marks emphasis, so a strong run opening a
      // detail doesn't read as part of the lead.
      <strong key={index} className="font-semibold">
        {token.text}
      </strong>
    ) : (
      token.text
    ),
  );
}
