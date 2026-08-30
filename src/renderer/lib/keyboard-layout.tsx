import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import {
  createKeyboardLayoutSnapshot,
  DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT,
  SUPPORTED_KEYBOARD_CODES,
  type KeyboardLayoutSnapshot,
} from "../../shared/command-keybindings";
import { publishKeyboardLayout } from "./keyboard-layout-runtime";

interface BrowserKeyboardLayoutMap {
  get(code: string): string | undefined;
}

interface BrowserKeyboardApi {
  getLayoutMap(): Promise<BrowserKeyboardLayoutMap>;
  addEventListener?(type: "layoutchange", listener: () => void): void;
  removeEventListener?(type: "layoutchange", listener: () => void): void;
}

const KeyboardLayoutContext = createContext<KeyboardLayoutSnapshot>(
  DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT,
);

function browserKeyboardApi(): BrowserKeyboardApi | null {
  const value = (navigator as Navigator & { keyboard?: BrowserKeyboardApi }).keyboard;
  return typeof value?.getLayoutMap === "function" ? value : null;
}

export async function readKeyboardLayoutSnapshot(
  keyboard: Pick<BrowserKeyboardApi, "getLayoutMap">,
  generation: number,
): Promise<KeyboardLayoutSnapshot> {
  const layout = await keyboard.getLayoutMap();
  const entries: Record<string, string> = {};
  for (const code of SUPPORTED_KEYBOARD_CODES) {
    const value = layout.get(code);
    if (value) entries[code] = value;
  }
  return createKeyboardLayoutSnapshot(generation, entries);
}

/** One renderer owner keeps shortcut capture and Main's native projection on the same layout. */
export function KeyboardLayoutProvider({ children }: { readonly children: ReactNode }) {
  const [snapshot, setSnapshot] = useState(DEFAULT_KEYBOARD_LAYOUT_SNAPSHOT);
  const generationRef = useRef(0);

  useEffect(() => {
    if (window.__NODEX_STORYBOOK__ === true) return;
    const keyboard = browserKeyboardApi();
    if (!keyboard) return;
    let cancelled = false;

    const refresh = async (): Promise<void> => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      try {
        const next = await readKeyboardLayoutSnapshot(keyboard, generation);
        if (cancelled || generation !== generationRef.current) return;
        setSnapshot(next);
        if (window.api) {
          await publishKeyboardLayout(next).catch(() => undefined);
        }
      } catch {
        // The static physical-code projection remains a complete deterministic fallback.
      }
    };

    const handleLayoutChange = (): void => {
      void refresh();
    };
    // Some Electron/Chromium builds expose getLayoutMap without the EventTarget surface.
    const canObserveLayoutChanges =
      typeof keyboard.addEventListener === "function" &&
      typeof keyboard.removeEventListener === "function";
    if (canObserveLayoutChanges) {
      keyboard.addEventListener?.("layoutchange", handleLayoutChange);
    }
    void refresh();
    return () => {
      cancelled = true;
      generationRef.current += 1;
      if (canObserveLayoutChanges) {
        keyboard.removeEventListener?.("layoutchange", handleLayoutChange);
      }
    };
  }, []);

  return (
    <KeyboardLayoutContext.Provider value={snapshot}>{children}</KeyboardLayoutContext.Provider>
  );
}

export function useKeyboardLayoutSnapshot(): KeyboardLayoutSnapshot {
  return useContext(KeyboardLayoutContext);
}
