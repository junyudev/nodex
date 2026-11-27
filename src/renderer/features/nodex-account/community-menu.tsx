import { defineMessage, defineMessages, getIntl, useIntl } from "@/lib/i18n";
import { OpenExternalIcon, SlashFeedbackIcon } from "@/components/shared/icons";
import { DiscordMarkIcon, QqMarkIcon } from "@/components/shared/icons/community-icons";
import {
  NodexDropdownFlyoutSubmenuItem,
  NodexDropdownItem,
  NodexDropdownSeparator,
} from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { WhatsNewMenuSection } from "@/features/whats-new/whats-new-menu-section";
import { useChangelogFeed } from "@/lib/changelog-feed";
import { writeTextToClipboard } from "@/lib/clipboard";
import { toastFailure } from "@/lib/failure-toast";
import { openInBrowser } from "@/lib/open-in-browser";
import { AccountMenuLeading } from "./account-menu-item";

/** The Nodex server on Discord. */
export const NODEX_DISCORD_INVITE_URL = "https://discord.com/invite/9yRa5SUeDz";
/** The Nodex QQ group. QQ finds a group by its number, so Nodex copies it rather than linking. */
export const NODEX_QQ_GROUP_NUMBER = "1126214921";

const MESSAGES = defineMessages({
  title: { id: "account.communityMenu.title", defaultMessage: "Feedback & community" },
  copyQqGroup: {
    id: "account.communityMenu.copyQqGroupLabel",
    defaultMessage: "Copy QQ group number",
  },
  qqGroupCopied: {
    id: "account.communityMenu.qqGroupCopied",
    defaultMessage: "Copied QQ group number",
  },
  qqGroupCopiedDetail: {
    id: "account.communityMenu.qqGroupCopiedDetail",
    defaultMessage: "Search for it in QQ to join.",
  },
  qqGroupCopyFailed: {
    id: "account.communityMenu.qqGroupCopyFailed",
    defaultMessage: "Couldn't copy the QQ group number",
  },
  discordOpenFailed: {
    id: "account.communityMenu.discordOpenFailed",
    defaultMessage: "Couldn't open Discord",
  },
});

const COPY_QQ_GROUP = defineMessage<{ number: string }>({
  id: "account.communityMenu.copyQqGroup",
  defaultMessage: "Copy QQ group number {number}",
});

/** Discord invites open in the system browser, which hands them to the Discord app when present. */
function joinDiscord(): Promise<void> {
  return openInBrowser(
    NODEX_DISCORD_INVITE_URL,
    getIntl().formatMessage(MESSAGES.discordOpenFailed),
  );
}

async function copyQqGroupNumber(): Promise<void> {
  const intl = getIntl();
  if (!(await writeTextToClipboard(NODEX_QQ_GROUP_NUMBER))) {
    toastFailure(intl.formatMessage(MESSAGES.qqGroupCopyFailed));
    return;
  }
  toast.success(intl.formatMessage(MESSAGES.qqGroupCopied), {
    description: intl.formatMessage(MESSAGES.qqGroupCopiedDetail),
    id: "community-qq-group-copied",
  });
}

/**
 * The account menu's way to keep up with and reach the people who make Nodex: what is new in
 * recent releases, then its QQ group, whose number stays readable in the row and is copied when
 * chosen, and its Discord server.
 */
export function CommunityMenu({
  openAfterClose,
}: {
  /** Opens a dialog once the menu has closed, so the dialog keeps focus. */
  readonly openAfterClose: (open: () => void) => void;
}) {
  const intl = useIntl();
  // Read with the account menu, so recent releases are there by the time this menu opens.
  useChangelogFeed();
  return (
    <NodexDropdownFlyoutSubmenuItem
      leftSlot={<AccountMenuLeading icon={<SlashFeedbackIcon />} />}
      label={intl.formatMessage(MESSAGES.title)}
      // Wide enough for a release's headline beside its date.
      contentClassName="w-[340px] max-w-none"
    >
      <WhatsNewMenuSection openAfterClose={openAfterClose} />
      <NodexDropdownSeparator />
      <NodexDropdownItem
        aria-label={intl.formatMessage(COPY_QQ_GROUP, { number: NODEX_QQ_GROUP_NUMBER })}
        leftSlot={<QqMarkIcon />}
        rightSlot={
          <span className="ml-3 text-xs tabular-nums text-token-description-foreground">
            {NODEX_QQ_GROUP_NUMBER}
          </span>
        }
        onSelect={() => void copyQqGroupNumber()}
      >
        {intl.formatMessage(MESSAGES.copyQqGroup)}
      </NodexDropdownItem>
      <NodexDropdownItem
        leftSlot={<DiscordMarkIcon />}
        rightSlot={<OpenExternalIcon className="icon-2xs text-token-description-foreground" />}
        onSelect={() => void joinDiscord()}
      >
        Discord
      </NodexDropdownItem>
    </NodexDropdownFlyoutSubmenuItem>
  );
}
