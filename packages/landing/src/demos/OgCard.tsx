import { InboxCard } from "../replica/Inbox";
import { InboxComposer } from "../replica/Inbox";
import { ProviderMark } from "../replica/Window";
import { motionValue } from "motion/react";
import { INBOX_BURST } from "./lumen";

const PASSKEYS = INBOX_BURST.find((message) => message.id === "passkeys")!;
const CHANGELOG = INBOX_BURST.find((message) => message.id === "changelog")!;

/** The social preview: the promise on the left, the Inbox planning a fan-out on the right. */
export default function OgCard() {
  return (
    <div className="relative flex h-[630px] w-[1200px] overflow-hidden bg-page bg-[radial-gradient(80%_90%_at_85%_40%,var(--site-glow),transparent_70%)] font-sans text-ink">
      <div className="flex w-[520px] shrink-0 flex-col justify-between py-16 pl-16">
        <div className="flex items-center gap-3">
          <img src="/nodex-icon.png" alt="" width="40" height="40" className="size-10" />
          <span className="text-[26px] font-semibold tracking-[-0.02em]">Nodex</span>
        </div>
        <div className="flex flex-col gap-6">
          <h1 className="text-[60px] leading-[1.02] font-semibold tracking-[-0.045em]">
            One inbox.
            <br />
            Every agent.
            <br />
            All local.
          </h1>
          <p className="flex items-center gap-2.5 text-[21px] text-ink-2">
            <ProviderMark kind="claude" className="size-5" />
            <span className="text-ink">
              <ProviderMark kind="codex" className="size-5" />
            </span>
            <span className="text-ink">
              <ProviderMark kind="opencode" className="size-4" />
            </span>
            planned, delegated, kept in Pages
          </p>
        </div>
        <span className="font-mono text-[16px] text-ink-3">nodex.jyu.app</span>
      </div>
      <div className="relative flex-1">
        <div className="absolute top-[64px] right-12 bottom-[-28px] left-0 flex flex-col justify-end gap-4 rounded-[18px] bg-app px-7 pt-7 pb-6 font-app text-[13px] text-app-fg shadow-window">
          <div className="opacity-55">
            <InboxCard message={CHANGELOG} phase="suggested" />
          </div>
          <InboxCard message={PASSKEYS} phase="suggested" />
          <InboxComposer text={motionValue("")} placeholderOpacity={motionValue(1)} />
        </div>
      </div>
    </div>
  );
}
