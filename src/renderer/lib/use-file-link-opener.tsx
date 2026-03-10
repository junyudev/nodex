import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import {
  buildFileUrl,
  parseLocalFileLinkHref,
  type FileLinkTarget,
  type FileLinkOpenerId,
} from "../../shared/file-link-openers";
import { invoke } from "./api";
import {
  readFileLinkOpener,
  writeFileLinkOpener,
} from "./file-link-opener-settings";

interface FileLinkOpenerContextValue {
  opener: FileLinkOpenerId;
  setOpener: (value: FileLinkOpenerId) => void;
}

type HandledFileLinkEvent = Pick<
  MouseEvent,
  "preventDefault" | "stopPropagation" | "stopImmediatePropagation"
>;

type FileLinkPointerEvent = Pick<
  MouseEvent,
  | "altKey"
  | "button"
  | "ctrlKey"
  | "defaultPrevented"
  | "metaKey"
  | "shiftKey"
  | "target"
>;

interface ResolvedLocalFileLinkAction {
  rawHref: string;
  target: FileLinkTarget;
}

interface RecentHandledMouseUp {
  at: number;
  href: string;
}

const FileLinkOpenerContext = createContext<FileLinkOpenerContextValue>({
  opener: "vscode",
  setOpener: () => {},
});

function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && !!window.api;
}

function resolveElementFromEventTarget(target: EventTarget | null): Element | null {
  if (typeof Element !== "undefined" && target instanceof Element) {
    return target;
  }
  if (typeof Node !== "undefined" && target instanceof Node) {
    return target.parentElement;
  }

  return null;
}

function resolveAnchorFromEventTarget(target: EventTarget | null): HTMLAnchorElement | null {
  const element = resolveElementFromEventTarget(target);
  if (!element) return null;

  const anchor = element.closest("a[href]");
  if (!(anchor instanceof HTMLAnchorElement)) return null;

  return anchor;
}

function resolveLocalFileLinkAction(
  event: FileLinkPointerEvent,
): ResolvedLocalFileLinkAction | null {
  if (event.defaultPrevented) return null;
  if (event.button !== 0) return null;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return null;

  const anchor = resolveAnchorFromEventTarget(event.target);
  if (!anchor) return null;
  if (anchor.hasAttribute("download")) return null;

  const rawHref = anchor.getAttribute("href");
  if (!rawHref) return null;

  const target = parseLocalFileLinkHref(rawHref);
  if (!target) return null;

  return { rawHref, target };
}

function consumeHandledFileLinkEvent(event: HandledFileLinkEvent): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function shouldSkipDuplicateClickOpen(
  recentMouseUp: RecentHandledMouseUp | null,
  rawHref: string,
  now: number,
): boolean {
  if (!recentMouseUp) return false;
  if (recentMouseUp.href !== rawHref) return false;
  return now - recentMouseUp.at < 250;
}

function useFileLinkOpenerInternal(): FileLinkOpenerContextValue {
  const [opener, setOpenerState] = useState<FileLinkOpenerId>(() =>
    readFileLinkOpener(),
  );

  const setOpener = useCallback((value: FileLinkOpenerId) => {
    const next = writeFileLinkOpener(value);
    setOpenerState(next);
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime()) return;

    let recentMouseUp: RecentHandledMouseUp | null = null;

    const openTarget = (target: FileLinkTarget) => {
      void (async () => {
        try {
          const opened = await invoke("shell:open-file-link", target, opener) as boolean;
          if (opened) return;
        } catch {
          // Fall back to the default file URL handoff if the custom open path fails.
        }

        window.open(buildFileUrl(target), "_blank", "noopener,noreferrer");
      })();
    };

    const handleMouseUp = (event: MouseEvent) => {
      const action = resolveLocalFileLinkAction(event);
      if (!action) return;

      consumeHandledFileLinkEvent(event);
      recentMouseUp = {
        at: Date.now(),
        href: action.rawHref,
      };
      openTarget(action.target);
    };

    const handleClick = (event: MouseEvent) => {
      const action = resolveLocalFileLinkAction(event);
      if (!action) return;

      consumeHandledFileLinkEvent(event);
      if (shouldSkipDuplicateClickOpen(recentMouseUp, action.rawHref, Date.now())) {
        return;
      }

      openTarget(action.target);
    };

    document.addEventListener("mouseup", handleMouseUp, true);
    document.addEventListener("click", handleClick, true);
    return () => {
      document.removeEventListener("mouseup", handleMouseUp, true);
      document.removeEventListener("click", handleClick, true);
    };
  }, [opener]);

  return { opener, setOpener };
}

export function FileLinkOpenerProvider({ children }: { children: ReactNode }) {
  const value = useFileLinkOpenerInternal();
  return (
    <FileLinkOpenerContext.Provider value={value}>
      {children}
    </FileLinkOpenerContext.Provider>
  );
}

export function useFileLinkOpener(): FileLinkOpenerContextValue {
  return useContext(FileLinkOpenerContext);
}

export const fileLinkOpenerTestHelpers = {
  resolveLocalFileLinkAction,
  resolveElementFromEventTarget,
  consumeHandledFileLinkEvent,
  shouldSkipDuplicateClickOpen,
};
