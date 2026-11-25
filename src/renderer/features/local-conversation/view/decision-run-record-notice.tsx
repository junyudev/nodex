import { useIntl } from "@/lib/i18n";
import { NodexLogoMarkIcon } from "@/components/shared/icons";

/** Stands where a chat's composer would: a decision run is Nodex's record and takes no messages. */
export function DecisionRunRecordNotice() {
  const intl = useIntl();
  return (
    <p
      data-decision-run-record="true"
      className="mx-auto flex w-full max-w-(--thread-content-max-width) items-center justify-center gap-2 px-toolbar pt-3 text-sm text-token-description-foreground"
    >
      <NodexLogoMarkIcon monochrome className="icon-xs shrink-0" />
      {intl.formatMessage({
        id: "conversation.decisionRunRecord.notice",
        defaultMessage: "This is how Nodex decided. It’s kept as a record and takes no messages.",
      })}
    </p>
  );
}
