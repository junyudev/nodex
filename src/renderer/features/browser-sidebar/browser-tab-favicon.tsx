import { useState, type ReactElement, type SVGProps, type TransitionEvent } from "react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { cn } from "@/lib/utils";
import { GLOBE_PATH } from "../../../shared/icon-geometry";
import "./browser-tab-favicon.css";

export type BrowserTabFaviconPhase =
  | "spinner-only"
  | "loading-favicon"
  | "settled"
  | "completion-start-frame"
  | "completion-midpoint-frame";

export interface BrowserTabFaviconProps {
  faviconUrl?: string;
  isLoading: boolean;
  isWaitingForResponse: boolean;
  className?: string;
}

export interface BrowserTabFaviconState {
  failedFaviconUrl: string | null;
  faviconUrl?: string;
  isLoading: boolean;
  isWaitingForResponse: boolean;
  pinnedCompletionFaviconUrl: string | null;
  reduceMotion: boolean;
  skipCompletionTransition: boolean;
}

export interface BrowserTabFaviconStateInput extends Omit<BrowserTabFaviconProps, "className"> {
  reduceMotion: boolean;
}

export function createBrowserTabFaviconState(
  input: BrowserTabFaviconStateInput,
): BrowserTabFaviconState {
  return {
    failedFaviconUrl: null,
    faviconUrl: input.faviconUrl,
    isLoading: input.isLoading,
    isWaitingForResponse: input.isWaitingForResponse,
    pinnedCompletionFaviconUrl: null,
    reduceMotion: input.reduceMotion,
    skipCompletionTransition: false,
  };
}

/** Reconciles live Browser state while retaining the favicon needed for the settle transition. */
export function reconcileBrowserTabFaviconState(
  previous: BrowserTabFaviconState,
  input: BrowserTabFaviconStateInput,
): BrowserTabFaviconState {
  if (
    previous.faviconUrl === input.faviconUrl &&
    previous.isLoading === input.isLoading &&
    previous.isWaitingForResponse === input.isWaitingForResponse &&
    previous.reduceMotion === input.reduceMotion
  ) {
    return previous;
  }

  const didFinishLoading = previous.isLoading && !input.isLoading;
  const failedFaviconUrl =
    previous.faviconUrl === input.faviconUrl ? previous.failedFaviconUrl : null;
  const completionFaviconUrl =
    !previous.isWaitingForResponse &&
    previous.faviconUrl != null &&
    previous.failedFaviconUrl !== previous.faviconUrl
      ? previous.faviconUrl
      : input.faviconUrl;
  const hasViableCompletionFavicon =
    completionFaviconUrl != null && failedFaviconUrl !== completionFaviconUrl;

  return {
    failedFaviconUrl,
    faviconUrl: input.faviconUrl,
    isLoading: input.isLoading,
    isWaitingForResponse: input.isWaitingForResponse,
    pinnedCompletionFaviconUrl:
      didFinishLoading && hasViableCompletionFavicon && !input.reduceMotion
        ? completionFaviconUrl
        : input.isLoading || input.reduceMotion
          ? null
          : previous.pinnedCompletionFaviconUrl,
    reduceMotion: input.reduceMotion,
    skipCompletionTransition: didFinishLoading
      ? !hasViableCompletionFavicon || input.reduceMotion
      : input.isLoading
        ? false
        : input.reduceMotion
          ? true
          : previous.skipCompletionTransition,
  };
}

export function resolveBrowserTabFaviconPhase(
  isLoading: boolean,
  isWaitingForResponse: boolean,
): BrowserTabFaviconPhase {
  if (!isLoading) return "settled";
  return isWaitingForResponse ? "spinner-only" : "loading-favicon";
}

export function BrowserTabFavicon({
  className,
  faviconUrl,
  isLoading,
  isWaitingForResponse,
}: BrowserTabFaviconProps): ReactElement {
  const reduceMotion = useResolvedReducedMotion();
  const input = {
    faviconUrl,
    isLoading,
    isWaitingForResponse,
    reduceMotion,
  };
  const [state, setState] = useState(() => createBrowserTabFaviconState(input));
  const reconciledState = reconcileBrowserTabFaviconState(state, input);
  if (reconciledState !== state) setState(reconciledState);

  const phase = resolveBrowserTabFaviconPhase(isLoading, isWaitingForResponse);
  const displayedFaviconUrl =
    reconciledState.pinnedCompletionFaviconUrl ?? reconciledState.faviconUrl;
  const handleCompletionTransitionFinish =
    reconciledState.pinnedCompletionFaviconUrl == null
      ? undefined
      : () =>
          setState((current) => ({
            ...current,
            pinnedCompletionFaviconUrl: null,
          }));
  const handleFaviconLoadError = (failedUrl: string) => {
    setState((current) => {
      if (current.faviconUrl !== failedUrl && current.pinnedCompletionFaviconUrl !== failedUrl) {
        return current;
      }
      const failedPinnedFavicon = current.pinnedCompletionFaviconUrl === failedUrl;
      return {
        ...current,
        failedFaviconUrl: failedUrl,
        pinnedCompletionFaviconUrl: failedPinnedFavicon ? null : current.pinnedCompletionFaviconUrl,
        skipCompletionTransition:
          failedPinnedFavicon || (!current.isLoading && current.faviconUrl === failedUrl)
            ? true
            : current.skipCompletionTransition,
      };
    });
  };

  return (
    <BrowserTabFaviconFrame
      className={className}
      faviconUrl={displayedFaviconUrl}
      phase={phase}
      reduceMotion={reduceMotion}
      skipCompletionTransition={reconciledState.skipCompletionTransition}
      onCompletionTransitionFinish={handleCompletionTransitionFinish}
      onFaviconLoadError={handleFaviconLoadError}
    />
  );
}

interface BrowserTabFaviconFrameProps {
  className?: string;
  faviconUrl?: string;
  phase: BrowserTabFaviconPhase;
  reduceMotion?: boolean;
  skipCompletionTransition?: boolean;
  onCompletionTransitionFinish?: () => void;
  onFaviconLoadError?: (faviconUrl: string) => void;
}

export function BrowserTabFaviconFrame({
  className,
  faviconUrl,
  phase,
  reduceMotion = false,
  skipCompletionTransition = false,
  onCompletionTransitionFinish,
  onFaviconLoadError,
}: BrowserTabFaviconFrameProps): ReactElement {
  const [failedFaviconUrl, setFailedFaviconUrl] = useState<string | null>(null);
  const currentFailedFaviconUrl = failedFaviconUrl === faviconUrl ? failedFaviconUrl : null;

  const isLoadingPhase = phase === "spinner-only" || phase === "loading-favicon";
  const faviconCanLoad = faviconUrl != null && currentFailedFaviconUrl !== faviconUrl;
  const showFavicon = phase !== "spinner-only" && (phase !== "loading-favicon" || faviconCanLoad);
  const disableTransition =
    skipCompletionTransition || reduceMotion || (phase === "settled" && !faviconCanLoad);
  const handleCompletionTransition = (event: TransitionEvent<HTMLSpanElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.propertyName !== "clip-path") return;
    onCompletionTransitionFinish?.();
  };
  const handleImageError = () => {
    if (faviconUrl == null) return;
    setFailedFaviconUrl(faviconUrl);
    onFaviconLoadError?.(faviconUrl);
  };

  return (
    <span
      className={cn(
        "relative flex size-full items-center justify-center",
        reduceMotion && "nodex-browser-tab-favicon-reduce-motion",
        className,
      )}
      data-browser-tab-icon-phase={phase}
    >
      <span
        className={cn(
          "nodex-browser-tab-favicon-clip absolute inset-0",
          showFavicon ? "visible" : "invisible",
          isLoadingPhase && "nodex-browser-tab-favicon-clip-loading",
          phase === "settled" && "nodex-browser-tab-favicon-clip-settled",
          disableTransition && "nodex-browser-tab-favicon-disable-transition",
          phase === "completion-start-frame" && "nodex-browser-tab-favicon-clip-completion-start",
          phase === "completion-midpoint-frame" &&
            "nodex-browser-tab-favicon-clip-completion-midpoint",
        )}
        data-browser-tab-favicon-clip="true"
        onTransitionCancel={
          onCompletionTransitionFinish == null ? undefined : handleCompletionTransition
        }
        onTransitionEnd={
          onCompletionTransitionFinish == null ? undefined : handleCompletionTransition
        }
      >
        <span
          className={cn(
            "nodex-browser-tab-favicon-image absolute inset-0 flex items-center justify-center",
            isLoadingPhase && "nodex-browser-tab-favicon-image-loading",
            phase === "settled" && "nodex-browser-tab-favicon-image-settled",
            disableTransition && "nodex-browser-tab-favicon-disable-transition",
            phase === "completion-start-frame" &&
              "nodex-browser-tab-favicon-image-completion-start",
            phase === "completion-midpoint-frame" &&
              "nodex-browser-tab-favicon-image-completion-midpoint",
          )}
        >
          <BrowserTabFaviconImage
            didFailToLoad={!faviconCanLoad && faviconUrl != null}
            faviconUrl={faviconUrl}
            onLoadError={handleImageError}
          />
        </span>
      </span>
      {isLoadingPhase ? (
        <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-token-text-link-foreground">
          <BrowserTabThrobber />
        </span>
      ) : null}
    </span>
  );
}

function BrowserTabFaviconImage({
  didFailToLoad,
  faviconUrl,
  onLoadError,
}: {
  didFailToLoad: boolean;
  faviconUrl?: string;
  onLoadError: () => void;
}) {
  if (faviconUrl == null || didFailToLoad) {
    return <BrowserFallbackIcon aria-hidden="true" className="size-full" />;
  }

  return (
    <img
      alt=""
      className="size-full object-contain"
      data-browser-tab-favicon-url={faviconUrl}
      key={faviconUrl}
      src={faviconUrl}
      onError={onLoadError}
    />
  );
}

function BrowserFallbackIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg fill="currentColor" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg" {...props}>
      <path d={GLOBE_PATH} />
    </svg>
  );
}

function BrowserTabThrobber() {
  return (
    <svg
      aria-hidden="true"
      className="nodex-browser-tab-throbber"
      data-browser-tab-throbber="true"
      height="16"
      viewBox="0 0 16 16"
      width="16"
    >
      <circle
        className="nodex-browser-tab-throbber-arc nodex-browser-tab-throbber-arc-growing"
        cx="8"
        cy="8"
        pathLength="360"
        r="7"
      />
      <circle
        className="nodex-browser-tab-throbber-arc nodex-browser-tab-throbber-arc-shrinking"
        cx="8"
        cy="8"
        pathLength="360"
        r="7"
      />
    </svg>
  );
}
