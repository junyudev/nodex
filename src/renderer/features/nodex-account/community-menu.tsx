import { defineMessage, defineMessages, getIntl, useIntl } from "@/lib/i18n";
import { CopyIcon, OpenExternalIcon, SlashFeedbackIcon } from "@/components/shared/icons";
import { DiscordMarkIcon, QqMarkIcon } from "@/components/shared/icons/community-icons";
import { NodexDropdownFlyoutSubmenuItem, NodexDropdownItem } from "@/components/ui/dropdown";
import { toast } from "@/components/ui/toast";
import { writeTextToClipboard } from "@/lib/clipboard";
import { toastFailure } from "@/lib/failure-toast";
import { openExternalUrl } from "@/lib/file-system-operations";
import { AccountMenuLeading } from "./account-menu-item";

/** The Nodex server on Discord. */
export const NODEX_DISCORD_INVITE_URL = "https://discord.com/invite/9yRa5SUeDz";
/** The Nodex QQ group. QQ finds a group by its number, so Nodex copies it rather than linking. */
export const NODEX_QQ_GROUP_NUMBER = "1126214921";

const MESSAGES = defineMessages({
  title: { id: "account.communityMenu.title", defaultMessage: "Feedback & community" },
  qqGroup: { id: "account.communityMenu.qqGroup", defaultMessage: "QQ group" },
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
async function joinDiscord(): Promise<void> {
  const failed = getIntl().formatMessage(MESSAGES.discordOpenFailed);
  try {
    if (!(await openExternalUrl(NODEX_DISCORD_INVITE_URL))) toastFailure(failed);
  } catch (error) {
    toastFailure(failed, error);
  }
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
 * The account menu's way to reach the people who make Nodex: its QQ group, whose number stays
 * readable in the row and is copied when chosen, and its Discord server.
 */
export function CommunityMenu() {
  const intl = useIntl();
  return (
    <NodexDropdownFlyoutSubmenuItem
      leftSlot={<AccountMenuLeading icon={<SlashFeedbackIcon />} />}
      label={intl.formatMessage(MESSAGES.title)}
    >
      <NodexDropdownItem
        aria-label={intl.formatMessage(COPY_QQ_GROUP, { number: NODEX_QQ_GROUP_NUMBER })}
        leftSlot={<QqMarkIcon />}
        rightSlot={
          <span className="ml-3 flex items-center gap-1.5 text-xs text-token-description-foreground">
            <span className="tabular-nums">{NODEX_QQ_GROUP_NUMBER}</span>
            <CopyIcon className="icon-2xs" />
          </span>
        }
        onSelect={() => void copyQqGroupNumber()}
      >
        {intl.formatMessage(MESSAGES.qqGroup)}
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
