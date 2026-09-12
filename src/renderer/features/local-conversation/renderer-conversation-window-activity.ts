import type { ConversationWindowActivity } from "../../../shared/codex-conversation-stream";
import { subscribeWindowFocusChanges } from "./local-conversation-deps";

const isHotkeyRoute = (route: string | null): boolean =>
  route === "/hotkey-window" || route?.startsWith("/hotkey-window/") === true;

/** Ordinary windows may acquire streams while hidden; a hotkey window must be active. */
export function readRendererConversationWindowActivity(): ConversationWindowActivity {
  const url = new URL(window.location.href);
  const visibilityState = document.visibilityState;
  const hotkey = isHotkeyRoute(url.pathname) || isHotkeyRoute(url.searchParams.get("initialRoute"));
  return {
    canAcquireThreadStream: !hotkey || (visibilityState === "visible" && document.hasFocus()),
    routePath: url.pathname,
    visibilityState,
  };
}

/** The registry owns one activity registration for each live window manager. */
export function bindRendererConversationWindowActivity(manager: {
  registerWindowActivity(activity: ConversationWindowActivity): Disposable & {
    update(activity: ConversationWindowActivity): void;
  };
  onDispose(callback: () => void): Disposable;
}): void {
  const registration = manager.registerWindowActivity(readRendererConversationWindowActivity());
  const update = () => registration.update(readRendererConversationWindowActivity());
  document.addEventListener("visibilitychange", update);
  const stopFocus = subscribeWindowFocusChanges(update);
  manager.onDispose(() => {
    document.removeEventListener("visibilitychange", update);
    stopFocus();
    registration[Symbol.dispose]();
  });
}
