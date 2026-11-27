import { useIntl } from "@/lib/i18n";
import { useEffect, useRef, useState } from "react";
import { CheckmarkIcon } from "@/components/shared/icons";
import { cn } from "@/lib/utils";
import {
  DEFAULT_MINI_ANCHOR,
  type MiniAnchor,
  type MiniOpenTarget,
  type MiniPresentationEvent,
} from "../../../shared/mini";
import type { InboxScope } from "../../../shared/inbox";
import { useComposerDictationCapabilityState } from "../dictation/use-composer-dictation-capability-state";
import { supportsComposerDictation } from "../local-conversation/view/composer/use-composer-dictation";
import { MiniCard, MINI_SURFACE_CLASS } from "./mini-card";
import { MiniComposer, useRestoreMiniDraft } from "./mini-composer";
import { MiniDock } from "./mini-dock";
import { useChooseMiniLocation } from "./mini-location-menu";
import { miniHost } from "./mini-host";
import { miniAttentionCount, miniCoverage, type MiniCard as MiniCardModel } from "./mini-model";
import { useMiniActivity } from "./use-mini-activity";
import { startMiniDrag } from "./mini-drag";

/** Pointer targets Mini draws; everywhere else the pointer reaches the app beneath. */
const DRAWN_SELECTOR = [
  "[data-mini-drawn]",
  "button",
  "form",
  "[role='menu']",
  "[role='listbox']",
  "[role='tooltip']",
].join(", ");

/** Cards that follow their chat live; the rest show how they stand. */
const FOLLOWED_CARDS = 3;
/** Backing plates drawn behind the front card while the stack is collapsed. */
const STACK_DEPTH = 2;
const NOTICE_MS = 2_600;

type Presentation =
  | { readonly kind: "hidden" }
  | { readonly kind: "resting" | "focused"; readonly generation: number };

/** What took the keyboard: the composer, or one card's reply. */
type FocusTarget = { readonly kind: "composer" } | { readonly kind: "reply"; readonly key: string };

/**
 * Mini: Nodex's presence over other apps. A dock to start a chat or dictate one, the cards of the
 * chats that are the person's concern, and the composer that grows from the dock. Main decides
 * when Mini is on screen and when it holds the keyboard; this renderer draws it at the edge Mini
 * sits on, growing away from that edge.
 */
export function MiniPanel() {
  const intl = useIntl();
  const activity = useMiniActivity();
  const { cards } = activity;
  const [presentation, setPresentation] = useState<Presentation>({ kind: "hidden" });
  const [anchor, setAnchor] = useState<MiniAnchor>(DEFAULT_MINI_ANCHOR);
  const [focusTarget, setFocusTarget] = useState<FocusTarget>({ kind: "composer" });
  const intended = useRef<FocusTarget | null>(null);
  const [cardsShown, setCardsShown] = useState(true);
  const [expanded, setExpanded] = useState(false);
  const [dictateToken, setDictateToken] = useState(0);
  const [notice, setNotice] = useState<{ readonly scope: InboxScope; readonly at: number } | null>(
    null,
  );
  const dictation = useComposerDictationCapabilityState(supportsComposerDictation());
  const canDictate = dictation?.isEnabled === true && dictation.capabilities.composer;

  const reported = useRef<boolean | null>(null);
  const holdsKeyboard = useRef(false);
  useEffect(
    () =>
      miniHost.onPresentation((event: MiniPresentationEvent) => {
        // Main starts every presentation letting the pointer through.
        reported.current = null;
        holdsKeyboard.current = event.kind === "focused";
        if (!holdsKeyboard.current) blurActiveElement();
        if (event.kind === "hidden") {
          setPresentation({ kind: "hidden" });
          setExpanded(false);
          return;
        }
        setAnchor(event.anchor);
        setPresentation({ kind: event.kind, generation: event.generation });
        if (event.kind === "focused") {
          // The shortcut asks for the composer; a card's reply asks for itself.
          setFocusTarget(intended.current ?? { kind: "composer" });
          intended.current = null;
        }
      }),
    [],
  );
  useEffect(() => {
    // Without the keyboard Mini holds no focus, so no focus ring or tooltip lingers over the app
    // beneath; its controls still work by pointer.
    const onFocusIn = () => {
      if (!holdsKeyboard.current) blurActiveElement();
    };
    document.addEventListener("focusin", onFocusIn);
    return () => document.removeEventListener("focusin", onFocusIn);
  }, []);
  useEffect(() => miniHost.ready(), []);
  const showingNotice = notice !== null;
  useEffect(() => miniHost.activity(miniCoverage(cards, showingNotice)), [cards, showingNotice]);

  useEffect(() => {
    const report = (over: boolean) => {
      if (reported.current === over) return;
      reported.current = over;
      miniHost.pointer(over);
    };
    const onMove = (event: PointerEvent) =>
      report(event.target instanceof Element && event.target.closest(DRAWN_SELECTOR) !== null);
    const onLeave = () => report(false);
    window.addEventListener("pointermove", onMove);
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
    };
  }, []);

  const focusedGeneration = presentation.kind === "focused" ? presentation.generation : null;
  useEffect(() => {
    if (focusedGeneration === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target;
      if (target instanceof Element && target.closest("[role='menu'], [role='listbox']")) return;
      event.preventDefault();
      miniHost.release(focusedGeneration);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [focusedGeneration]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const requestFocus = (target: FocusTarget) => {
    intended.current = target;
    setFocusTarget(target);
    miniHost.focus();
  };
  const release = () => {
    if (focusedGeneration !== null) miniHost.release(focusedGeneration);
  };
  const open = (target: MiniOpenTarget) => miniHost.open(target);
  const restoreDraft = useRestoreMiniDraft();
  const chooseLocation = useChooseMiniLocation();
  const openCard = (card: MiniCardModel) => {
    // A chat still starting has nothing to open yet; a failed one offers its own actions.
    if (card.kind === "starting") return;
    if (card.kind === "turn")
      open(
        card.sessionId
          ? { kind: "session", sessionId: card.sessionId }
          : { kind: "page", pageId: card.pageId },
      );
    else open({ kind: "session", sessionId: card.sessionId });
  };

  const composing = presentation.kind === "focused" && focusTarget.kind === "composer";
  const replyKey =
    presentation.kind === "focused" && focusTarget.kind === "reply" ? focusTarget.key : null;
  const showCards = cardsShown && cards.length > 0 && presentation.kind !== "hidden";
  const visibleCards = expanded ? cards : cards.slice(0, 1);
  const stacked = !expanded && cards.length > 1;
  const bottom = anchor.vertical === "bottom";

  return (
    <div
      data-mini-frame
      onPointerDown={(event) => startMiniDrag(event, DRAWN_SELECTOR)}
      className={cn(
        "fixed inset-0 flex gap-2 overflow-hidden p-4 select-none",
        bottom ? "flex-col-reverse" : "flex-col",
        anchor.horizontal === "left"
          ? "items-start"
          : anchor.horizontal === "right"
            ? "items-end"
            : "items-center",
        presentation.kind === "hidden" && "invisible",
      )}
    >
      {/* Nearest the edge: the composer while it is open, otherwise the dock. */}
      <div className={cn("w-[520px] select-text", composing ? "block" : "hidden")}>
        <MiniComposer
          projects={activity.projects}
          focusToken={
            composing && presentation.kind === "focused" ? presentation.generation + 1 : 0
          }
          dictateToken={dictateToken}
          visible={composing}
          onStart={activity.start}
          onStarted={() => {
            setCardsShown(true);
            release();
          }}
          onSaved={(scope) => {
            setNotice({ scope, at: Date.now() });
            release();
          }}
        />
      </div>
      {composing ? null : (
        <MiniDock
          canDictate={canDictate}
          cardCount={cards.length}
          attentionCount={miniAttentionCount(cards)}
          cardsShown={cardsShown}
          onNewChat={() => requestFocus({ kind: "composer" })}
          onDictate={() => {
            setDictateToken((token) => token + 1);
            requestFocus({ kind: "composer" });
          }}
          onToggleCards={() => {
            setCardsShown((shown) => !shown);
            setExpanded(false);
          }}
        />
      )}
      {notice ? (
        <button
          type="button"
          data-mini-drawn
          className={cn(
            "cursor-interaction inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs",
            MINI_SURFACE_CLASS,
          )}
          onClick={() => open({ kind: "inbox", scope: notice.scope })}
        >
          <CheckmarkIcon className="icon-2xs text-token-charts-green" />
          {intl.formatMessage({ id: "mini.notice.saved", defaultMessage: "Saved to Inbox" })}
          <span className="text-token-text-secondary">
            {intl.formatMessage({ id: "mini.notice.open", defaultMessage: "Open" })}
          </span>
        </button>
      ) : null}
      {showCards ? (
        <div
          className={cn(
            "flex gap-1.5",
            bottom ? "flex-col-reverse" : "flex-col",
            // The scroller's padding keeps the cards' shadows from being clipped at its edges; it
            // lets the pointer through to the dock and the app beneath, its cards do not.
            expanded
              ? "vertical-scroll-fade-mask hide-scrollbar pointer-events-none -m-8 max-h-[504px] w-[464px] overflow-y-auto overscroll-contain p-8 [--edge-fade-distance:2rem] *:pointer-events-auto"
              : "w-[400px]",
          )}
        >
          {visibleCards.map((card, index) => (
            <div
              key={card.key}
              className={cn(
                "relative",
                // Room for the plates, which peek out on the side away from the dock.
                stacked && (bottom ? "mt-2.5" : "mb-2.5"),
              )}
            >
              {stacked ? (
                <StackPlates depth={Math.min(cards.length - 1, STACK_DEPTH)} bottom={bottom} />
              ) : null}
              <MiniCard
                card={card}
                front={index < FOLLOWED_CARDS}
                replying={replyKey === card.key}
                onReply={(openReply) =>
                  openReply ? requestFocus({ kind: "reply", key: card.key }) : release()
                }
                onOpen={() => openCard(card)}
                onDismiss={() => activity.dismiss(card)}
                onRetryStart={() => activity.retryStart(card.sessionId ?? "")}
                onTakeBackStart={() =>
                  void activity.takeBackStart(card.sessionId ?? "").then(async (start) => {
                    if (!start) return;
                    // The message returns with the place it was meant for.
                    await Promise.all([restoreDraft(start.draft), chooseLocation(start.projectId)]);
                    requestFocus({ kind: "composer" });
                  })
                }
              />
            </div>
          ))}
        </div>
      ) : null}
      {/* Outside the list, so it stays in reach however far the list is scrolled. */}
      {showCards && cards.length > 1 ? (
        <button
          type="button"
          data-mini-drawn
          className={cn(
            "cursor-interaction rounded-full px-2.5 py-1 text-[11px] text-token-text-secondary hover:text-token-foreground",
            MINI_SURFACE_CLASS,
          )}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded
            ? intl.formatMessage({ id: "mini.stack.showLess", defaultMessage: "Show less" })
            : intl.formatMessage(
                { id: "mini.stack.showAll", defaultMessage: "{count} more" },
                { count: cards.length - 1 },
              )}
        </button>
      ) : null}
    </div>
  );
}

function blurActiveElement(): void {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
}

/** Solid, so the stack reads the same over any app; each plate a step further back. */
const PLATE_SHADE = [
  "brightness-[0.94] dark:brightness-[0.86]",
  "brightness-[0.88] dark:brightness-[0.72]",
];

/** The cards behind the front one, drawn as plates peeking out on the side away from the dock. */
function StackPlates({ depth, bottom }: { readonly depth: number; readonly bottom: boolean }) {
  return (
    <>
      {Array.from({ length: depth }, (_, index) => (
        <span
          key={index}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-x-0 h-full rounded-[18px]",
            MINI_SURFACE_CLASS,
            PLATE_SHADE[index],
          )}
          style={{
            transform: `translateY(${(bottom ? -1 : 1) * (index + 1) * 6}px) scale(${1 - (index + 1) * 0.04})`,
            zIndex: -1 - index,
          }}
        />
      ))}
    </>
  );
}
