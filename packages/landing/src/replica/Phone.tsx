import type { ReactNode } from "react";
import { PhoneGlyph, PhoneMark, SpinnerIcon, type PhoneGlyphName } from "./icons";
import { cx } from "./Window";

/**
 * Presentational copies of Nodex Mobile, drawn at the app's real point sizes and scaled as one
 * device by `PhoneFrame`. Text sizes follow packages/mobile/src/ui/theme.css.
 */
const TEXT_XS = "text-[13px] leading-[17px]";
const TEXT_SM = "text-[15px] leading-5";
const TEXT_BASE = "text-[17px] leading-[25px]";

const BEZEL = 9;
export const PHONE_WIDTH = 390;
export const PHONE_OUTER_WIDTH = PHONE_WIDTH + BEZEL * 2;
export const phoneOuterHeight = (height: number) => height + BEZEL * 2;

export type PhoneNetwork = "wifi" | "cellular";

/** A generic phone at one scale: its body, status bar and a screen for the demo to fill. */
export function PhoneFrame({
  height,
  scale,
  network,
  overlay,
  children,
}: {
  /** Screen height in points. */
  readonly height: number;
  readonly scale: number;
  readonly network: PhoneNetwork;
  /** Drawn above the screen in its coordinates, such as a fingertip. */
  readonly overlay?: ReactNode;
  readonly children: ReactNode;
}) {
  const outerHeight = phoneOuterHeight(height);
  return (
    <div style={{ width: PHONE_OUTER_WIDTH * scale, height: outerHeight * scale }}>
      <div
        className="origin-top-left rounded-[60px] bg-[#0a0a0c] shadow-[0_0_0_1px_rgb(255_255_255/0.14),0_44px_90px_-30px_rgb(0_0_0/0.75),0_16px_36px_-18px_rgb(0_0_0/0.5)]"
        style={{
          width: PHONE_OUTER_WIDTH,
          height: outerHeight,
          padding: BEZEL,
          transform: `scale(${scale})`,
        }}
      >
        {/* A clip path, because a rounded overflow doesn't clip glass that has moved under it. */}
        <div
          data-app-window
          className="relative h-full w-full overflow-hidden bg-phone-surface font-app text-phone-ink antialiased [clip-path:inset(0_round_51px)] select-none"
        >
          {children}
          <StatusBar network={network} />
          {overlay}
        </div>
      </div>
    </div>
  );
}

function StatusBar({ network }: { readonly network: PhoneNetwork }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 flex h-[54px] items-center justify-between px-[34px] pt-[6px] text-[16px] font-semibold">
      <span className="tabular-nums">9:41</span>
      <span
        aria-hidden="true"
        className="absolute top-[11px] left-1/2 h-[33px] w-[112px] -translate-x-1/2 rounded-full bg-[#0a0a0c]"
      />
      <span className="flex items-center gap-[6px]">
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor" aria-hidden="true">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="5.5" width="3" height="6.5" rx="1" />
          <rect x="10" y="3" width="3" height="9" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        {network === "wifi" ? (
          <svg width="17" height="12" viewBox="0 0 17 12" fill="currentColor" aria-label="Wi-Fi">
            <path d="M8.5 2.4c2.3 0 4.5.9 6.1 2.5.1.1.3.1.4 0l1.2-1.2c.1-.1.1-.3 0-.4A11 11 0 0 0 8.5 0 11 11 0 0 0 .8 3.3c-.1.1-.1.3 0 .4L2 4.9c.1.1.3.1.4 0a8.7 8.7 0 0 1 6.1-2.5Zm0 3.9c1.3 0 2.5.5 3.4 1.3.1.1.3.1.4 0l1.2-1.2c.1-.1.1-.3 0-.4a7.1 7.1 0 0 0-10 0c-.1.1-.1.3 0 .4l1.2 1.2c.1.1.3.1.4 0 .9-.8 2.1-1.3 3.4-1.3Zm2.4 2.9c.1-.1.1-.3 0-.4a3.4 3.4 0 0 0-4.8 0c-.1.1-.1.3 0 .4l2.2 2.2c.1.1.3.1.4 0l2.2-2.2Z" />
          </svg>
        ) : (
          <span className="text-[14px] leading-none font-semibold">5G</span>
        )}
        <svg width="26" height="12" viewBox="0 0 26 12" fill="none" aria-hidden="true">
          <rect
            x="0.5"
            y="0.5"
            width="22"
            height="11"
            rx="3.2"
            stroke="currentColor"
            opacity="0.4"
          />
          <rect x="2" y="2" width="19" height="8" rx="2" fill="currentColor" />
          <path d="M24 4v4c.8-.3 1.4-1.1 1.4-2S24.8 4.3 24 4Z" fill="currentColor" opacity="0.5" />
        </svg>
      </span>
    </div>
  );
}

/** The app's floating material: content passes beneath it and blurs away. */
export function PhoneGlass({
  radius,
  className,
  children,
}: {
  readonly radius: number;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "bg-phone-glass shadow-[0_0_0_0.5px_var(--phone-line)] backdrop-blur-xl",
        className,
      )}
      style={{ borderRadius: radius }}
    >
      {children}
    </div>
  );
}

/** A round control of its own glass, as the system draws a bar's buttons. */
function GlassButton({
  label,
  cursorTarget,
  children,
}: {
  readonly label?: string;
  readonly cursorTarget?: string;
  readonly children: ReactNode;
}) {
  return (
    <PhoneGlass radius={23} className="flex size-[46px] shrink-0 items-center justify-center">
      <span
        aria-label={label}
        data-cursor-target={cursorTarget}
        className="flex size-full items-center justify-center"
      >
        {children}
      </span>
    </PhoneGlass>
  );
}

export type PhoneHomeMode = "inbox" | "chats";

/** Home's floating bar: settings under the mark, the two panes, and what the pane adds. */
export function PhoneHomeBar({
  mode,
  inboxCount,
  attentionCount,
}: {
  readonly mode: PhoneHomeMode;
  readonly inboxCount: number;
  readonly attentionCount: number;
}) {
  return (
    <div className="absolute inset-x-0 top-[60px] z-10 flex items-center justify-between px-4">
      <GlassButton label="Settings">
        <PhoneMark />
      </GlassButton>
      <PhoneGlass radius={22} className="flex p-1">
        <Segment
          active={mode === "inbox"}
          label="Inbox"
          count={inboxCount}
          countClassName="text-phone-ink-3"
          cursorTarget="segment:inbox"
        />
        <Segment
          active={mode === "chats"}
          label="Chats"
          count={attentionCount}
          countClassName="text-phone-warning"
        />
      </PhoneGlass>
      <GlassButton label={mode === "inbox" ? "Show handled messages" : "Search chats"}>
        <PhoneGlyph name={mode === "inbox" ? "history" : "search"} className="text-phone-ink" />
      </GlassButton>
    </div>
  );
}

function Segment({
  active,
  label,
  count,
  countClassName,
  cursorTarget,
}: {
  readonly active: boolean;
  readonly label: string;
  readonly count: number;
  readonly countClassName: string;
  readonly cursorTarget?: string;
}) {
  return (
    <span
      data-cursor-target={cursorTarget}
      className={cx(
        "flex h-9 items-center gap-1 rounded-full px-3.5 transition-colors duration-200",
        active && "bg-phone-fill",
      )}
    >
      <span className={cx(TEXT_SM, "font-medium", active ? "text-phone-ink" : "text-phone-ink-2")}>
        {label}
      </span>
      {count > 0 ? (
        <span className={cx(TEXT_XS, "font-medium tabular-nums", countClassName)}>{count}</span>
      ) : null}
    </span>
  );
}

/** A chat's floating bar: back, and its title in glass of its own. */
export function PhoneChatBar({
  title,
  subtitle,
}: {
  readonly title: string;
  readonly subtitle: string;
}) {
  return (
    <div className="absolute inset-x-0 top-[60px] z-10 flex items-center gap-3 px-4">
      <GlassButton label="Back" cursorTarget="back">
        <PhoneGlyph name="chevronLeft" size={24} className="text-phone-ink" />
      </GlassButton>
      <PhoneGlass
        radius={22}
        className="mr-[58px] flex h-11 min-w-0 flex-1 flex-col items-center justify-center px-4"
      >
        <span className="max-w-full truncate text-[15px] leading-[19px] font-semibold">
          {title}
        </span>
        <span className="max-w-full truncate text-[13px] leading-[15px] text-phone-ink-2">
          {subtitle}
        </span>
      </PhoneGlass>
    </div>
  );
}

export interface PhoneChat {
  readonly title: string;
  readonly project: string;
  readonly status: "waiting" | "running" | "idle";
  /** What it is asking, while it waits. */
  readonly attention?: string;
  /** Its last words, once it has stopped. */
  readonly preview?: string;
  readonly unread?: boolean;
  readonly age: string;
}

const CHAT_SECTIONS = [
  { label: "Needs you", status: "waiting" },
  { label: "Working", status: "running" },
  { label: "Recent", status: "idle" },
] as const;

/** Every chat on the desktop, with what needs the person first. */
export function PhoneChatList({ chats }: { readonly chats: readonly PhoneChat[] }) {
  return (
    <div className="flex h-full flex-col pt-[110px]">
      {CHAT_SECTIONS.map(({ label, status }) => {
        const section = chats.filter((chat) => chat.status === status);
        if (section.length === 0) return null;
        return (
          <div key={label} className="flex flex-col">
            <span className={cx(TEXT_XS, "px-4 pt-3 pb-0.5 font-medium text-phone-ink-3")}>
              {label}
            </span>
            {section.map((chat) => (
              <PhoneChatRow key={chat.title} chat={chat} />
            ))}
          </div>
        );
      })}
    </div>
  );
}

function PhoneChatRow({ chat }: { readonly chat: PhoneChat }) {
  const asking = chat.status === "waiting";
  const line = asking
    ? (chat.attention ?? "Waiting for you")
    : chat.status === "running"
      ? `${chat.project} · Working`
      : `${chat.project} · ${chat.preview ?? ""}`;
  const dot = asking
    ? "bg-phone-warning"
    : chat.status === "running" || chat.unread
      ? "bg-phone-accent"
      : null;
  return (
    <div data-cursor-target={`chat:${chat.title}`} className="flex gap-2.5 px-4 py-3">
      <span className="flex h-[23px] w-2 shrink-0 items-center justify-center">
        {dot ? <span className={cx("size-2 rounded-full", dot)} /> : null}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span
            className={cx(TEXT_BASE, "min-w-0 flex-1 truncate", chat.unread && "font-semibold")}
          >
            {chat.title}
          </span>
          <span className={cx(TEXT_XS, "text-phone-ink-3")}>{chat.age}</span>
        </span>
        <span
          className={cx(TEXT_SM, "truncate", asking ? "text-phone-warning" : "text-phone-ink-3")}
        >
          {line}
        </span>
      </span>
    </div>
  );
}

export function PhoneUserRow({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex justify-end pt-4 pr-4 pl-14">
      <div className={cx(TEXT_BASE, "rounded-[22px] bg-phone-surface-3 px-4 py-2.5")}>
        {children}
      </div>
    </div>
  );
}

export function PhoneAssistantRow({ children }: { readonly children: ReactNode }) {
  return <div className={cx(TEXT_BASE, "px-4 pt-4")}>{children}</div>;
}

/** A stretch of work on one line: the step in progress, or how many were done. */
export function PhoneWorkRow({
  title,
  running,
}: {
  readonly title: string;
  readonly running: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 px-4 pt-4 text-phone-ink-3">
      {running ? <SpinnerIcon className="size-[17px]" /> : <PhoneGlyph name="check" size={15} />}
      <span className={cx(TEXT_SM, "shrink truncate")}>{title}</span>
      <PhoneGlyph name="chevronRight" size={13} />
    </div>
  );
}

export interface PhoneOption {
  readonly label: string;
  readonly tone: "primary" | "default" | "danger";
  readonly cursorTarget?: string;
}

const BUTTON_TONES: Readonly<Record<PhoneOption["tone"], string>> = {
  primary: "bg-phone-ink text-phone-surface",
  default: "bg-phone-fill text-phone-ink",
  danger: "bg-phone-danger-soft text-phone-danger",
};

function PhoneButton({
  label,
  tone,
  icon,
  cursorTarget,
}: PhoneOption & { readonly icon?: PhoneGlyphName }) {
  return (
    <span
      data-cursor-target={cursorTarget}
      className={cx(
        TEXT_SM,
        "flex h-9 shrink-0 items-center gap-1.5 rounded-full px-3.5 font-medium",
        BUTTON_TONES[tone],
      )}
    >
      {icon ? <PhoneGlyph name={icon} size={15} /> : null}
      {label}
    </span>
  );
}

/** An approval, pinned above the Composer with exactly what is being approved. */
export function PhoneApprovalCard({
  title,
  detail,
  options,
}: {
  readonly title: string;
  readonly detail: string;
  readonly options: readonly PhoneOption[];
}) {
  return (
    <PhoneGlass radius={25} className="mx-4 flex flex-col gap-2 p-3.5">
      <span className="flex items-start gap-2">
        <PhoneGlyph name="warning" size={17} className="mt-1 text-phone-warning" />
        <span className={cx(TEXT_BASE, "font-medium")}>{title}</span>
      </span>
      <code className={cx(TEXT_XS, "block rounded-2xl bg-phone-fill p-3 font-mono")}>{detail}</code>
      <span className="flex flex-wrap gap-1.5">
        {options.map((option) => (
          <PhoneButton key={option.label} {...option} />
        ))}
      </span>
    </PhoneGlass>
  );
}

export type PhoneSendState = "empty" | "ready" | "stop";

/** The floating Composer: one line at rest, and open to its pickers while in use. */
export function PhoneComposer({
  placeholder,
  text,
  chip,
  send,
}: {
  readonly placeholder: string;
  /** What has been typed so far; null shows the placeholder. */
  readonly text?: ReactNode;
  /** While present, the Composer is open and this says where the message goes. */
  readonly chip?: { readonly icon: PhoneGlyphName; readonly label: string } | null;
  readonly send: PhoneSendState;
}) {
  const field = (
    <span className={cx(TEXT_BASE, "min-h-10 min-w-0 flex-1 py-[7.5px]", chip ? "px-2.5" : "px-1")}>
      {text ?? <span className="text-phone-ink-3">{placeholder}</span>}
    </span>
  );
  const attach = (
    <span className="flex size-10 shrink-0 items-center justify-center">
      <PhoneGlyph name="plus" size={22} className="text-phone-ink" />
    </span>
  );
  const sendControl = (
    <span
      data-cursor-target="send"
      className={cx(
        "flex size-10 shrink-0 items-center justify-center rounded-full transition-colors duration-150",
        send === "empty" && "bg-phone-fill text-phone-ink-3",
        send === "ready" && "bg-phone-accent text-white",
        send === "stop" && "bg-phone-ink text-phone-surface",
      )}
    >
      <PhoneGlyph name={send === "stop" ? "stop" : "arrowUp"} size={send === "stop" ? 18 : 20} />
    </span>
  );
  return (
    <div className="px-4 pb-[26px]">
      <PhoneGlass radius={25}>
        <div data-cursor-target="composer" className="flex items-end p-[5px]">
          {chip ? null : attach}
          {field}
          {chip ? null : sendControl}
        </div>
        {chip ? (
          <div className="flex items-center gap-1 px-[5px] pb-[5px]">
            {attach}
            <span className="flex h-8 min-w-0 flex-1 items-center">
              <span className="flex h-8 items-center gap-1 rounded-full bg-phone-fill px-2.5 text-phone-ink-2">
                <PhoneGlyph name={chip.icon} size={14} />
                <span className="text-[14px] leading-[18px]">{chip.label}</span>
                <PhoneGlyph name="chevronDown" size={10} className="text-phone-ink-3" />
              </span>
            </span>
            {sendControl}
          </div>
        ) : null}
      </PhoneGlass>
    </div>
  );
}

/** One message in the Inbox stream, with whatever the Inbox has to say about it below. */
export function PhoneInboxRow({
  text,
  meta,
  faded = false,
  children,
}: {
  readonly text: string;
  readonly meta?: ReactNode;
  /** Not yet on the desktop. */
  readonly faded?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-4 py-3">
      <span className={cx(TEXT_BASE, faded && "text-phone-ink-2")}>{text}</span>
      {children}
      {meta ? <span className={cx(TEXT_XS, "text-phone-ink-3")}>{meta}</span> : null}
    </div>
  );
}

/** A message's advice in the stream: enough to decide at a glance, and one decision. */
export function PhoneSuggestion({
  summary,
  destination,
  action,
}: {
  readonly summary: string;
  readonly destination: string;
  readonly action: PhoneOption & { readonly icon: PhoneGlyphName };
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[20px] bg-phone-fill p-3">
      <span className={TEXT_SM}>{summary}</span>
      <span className="flex items-center gap-2">
        <span className="flex min-w-0 flex-1 items-center gap-1 text-phone-ink-3">
          <PhoneGlyph name="agent" size={14} />
          <span className={cx(TEXT_XS, "truncate")}>{destination}</span>
          <PhoneGlyph name="chevronRight" size={12} />
        </span>
        <PhoneButton {...action} />
      </span>
    </div>
  );
}

/** A suggestion that isn't an offer yet, or no longer is. */
export function PhoneQuietLine({ text }: { readonly text: string }) {
  return (
    <span className="flex items-center gap-1.5 text-phone-ink-3">
      <PhoneGlyph name="agent" size={14} />
      <span className={TEXT_SM}>{text}</span>
    </span>
  );
}

/** A capture on its way to the desktop. */
export function PhonePendingLine({ text }: { readonly text: string }) {
  return (
    <span className="flex items-center gap-1.5 text-phone-ink-3">
      <PhoneGlyph name="clock" size={12} />
      <span className={TEXT_XS}>{text}</span>
    </span>
  );
}
