import {
  CodeIcon,
  NfmCalloutBlockIcon,
  NfmSideMenuBulletedListBlockIcon,
  NfmSideMenuCheckListBlockIcon,
  NfmSideMenuHeadingBlockIcon,
  NfmSideMenuNumberedListBlockIcon,
  NfmSideMenuQuoteBlockIcon,
  NfmSideMenuTextBlockIcon,
  NfmSideMenuToggleListBlockIcon,
  TextActionEquationIcon,
} from "@/components/shared/icons";
import { CornerDownRight } from "@/components/shared/icons/generic-icons";
import type { NFM_TURN_INTO_DEFINITIONS } from "@/lib/nfm-turn-into-targets";

export type NfmTurnIntoBlockKey = (typeof NFM_TURN_INTO_DEFINITIONS)[number]["key"];

interface NfmTurnIntoBlockIconProps {
  readonly targetKey: NfmTurnIntoBlockKey;
  readonly className?: string;
}

/** Keeps block-type iconography identical across every Turn into and insertion surface. */
export function NfmTurnIntoBlockIcon({ targetKey, className }: NfmTurnIntoBlockIconProps) {
  if (targetKey === "heading-1" || targetKey === "toggle-heading-1") {
    return <NfmSideMenuHeadingBlockIcon level={1} className={className} />;
  }
  if (targetKey === "heading-2" || targetKey === "toggle-heading-2") {
    return <NfmSideMenuHeadingBlockIcon level={2} className={className} />;
  }
  if (targetKey === "heading-3" || targetKey === "toggle-heading-3") {
    return <NfmSideMenuHeadingBlockIcon level={3} className={className} />;
  }
  if (targetKey === "bullet-list") {
    return <NfmSideMenuBulletedListBlockIcon className={className} />;
  }
  if (targetKey === "numbered-list") {
    return <NfmSideMenuNumberedListBlockIcon className={className} />;
  }
  if (targetKey === "todo-list") {
    return <NfmSideMenuCheckListBlockIcon className={className} />;
  }
  if (targetKey === "toggle-list") {
    return <NfmSideMenuToggleListBlockIcon className={className} />;
  }
  if (targetKey === "quote") {
    return <NfmSideMenuQuoteBlockIcon className={className} />;
  }
  if (targetKey === "equation") {
    return <TextActionEquationIcon className={className} />;
  }
  if (targetKey === "code") {
    return <CodeIcon className={className} />;
  }
  if (targetKey === "callout") {
    return <NfmCalloutBlockIcon className={className} />;
  }
  if (targetKey === "prompt") {
    return <CornerDownRight className={className ?? "size-5"} />;
  }
  return <NfmSideMenuTextBlockIcon className={className} />;
}
