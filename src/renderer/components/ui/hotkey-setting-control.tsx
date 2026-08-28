import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { DeleteIcon, EditIcon, ResetIcon } from "../shared/icons";
import {
  formatAcceleratorLabel,
  keyboardEventToAccelerator,
  type RuntimePlatform,
} from "../../../shared/command-keybindings";
import { cn } from "@/lib/utils";
import { ShortcutKeycaps } from "./shortcut-keycaps";
import { useKeyboardLayoutSnapshot } from "@/lib/keyboard-layout";

export type HotkeyCaptureMode = "set" | "replace" | "append";

type BareModifierPhase = "pressed" | "released";

type BareModifierKeyboardEvent = Pick<
  KeyboardEvent,
  "altKey" | "ctrlKey" | "key" | "location" | "metaKey" | "shiftKey"
>;

const LEFT_KEY_LOCATION = 1;
const RIGHT_KEY_LOCATION = 2;
const SEQUENCE_CAPTURE_TIMEOUT_MS = 1_000;
const MODIFIER_KEYS = new Set(["Alt", "Control", "Fn", "Meta", "Shift"]);

export const HOTKEY_ACTION_BUTTON_CLASSNAME =
  "no-drag cursor-interaction flex h-token-button-composer aspect-square shrink-0 items-center justify-center rounded-lg border border-transparent px-0 py-0 text-base leading-[18px] whitespace-nowrap text-token-text-tertiary select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-token-focus-border disabled:cursor-default disabled:opacity-40 enabled:hover:bg-token-list-hover-background data-[state=open]:bg-token-list-hover-background";

/**
 * Returns the location-preserving identity used for modifier-only global hotkeys.
 * A modifier is only committed after the matching keyup; keydown merely records a candidate.
 */
export function bareModifierIdentity(
  event: BareModifierKeyboardEvent,
  phase: BareModifierPhase,
): string | null {
  if (event.key.toLowerCase() === "fn") return "Fn";

  const side =
    event.location === LEFT_KEY_LOCATION
      ? "Left"
      : event.location === RIGHT_KEY_LOCATION
        ? "Right"
        : null;
  if (!side) return null;

  const isReleased = phase === "released";
  if (
    event.key === "Alt" &&
    (isReleased || (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey))
  ) {
    return `${side}Option`;
  }
  if (
    event.key === "Meta" &&
    (isReleased || (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey))
  ) {
    return `${side}Command`;
  }
  if (
    event.key === "Control" &&
    side === "Left" &&
    (isReleased || (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey))
  ) {
    return "LeftControl";
  }
  return null;
}

function physicalBareModifierIdentity(event: BareModifierKeyboardEvent): string | null {
  if (event.key.toLowerCase() === "fn") return "Fn";

  const side =
    event.location === LEFT_KEY_LOCATION
      ? "Left"
      : event.location === RIGHT_KEY_LOCATION
        ? "Right"
        : null;
  if (!side) return null;
  if (event.key === "Alt") return `${side}Option`;
  if (event.key === "Meta") return `${side}Command`;
  if (event.key === "Shift") return `${side}Shift`;
  if (event.key === "Control") return `${side}Control`;
  return null;
}

function doubleModifierIdentity(pressedModifiers: ReadonlySet<string>): string | null {
  if (pressedModifiers.has("LeftOption") && pressedModifiers.has("RightOption")) {
    return "DoubleOption";
  }
  if (pressedModifiers.has("LeftCommand") && pressedModifiers.has("RightCommand")) {
    return "DoubleCommand";
  }
  if (pressedModifiers.has("LeftShift") && pressedModifiers.has("RightShift")) {
    return "DoubleShift";
  }
  return null;
}

function preventCaptureButtonBlur(event: ReactMouseEvent<HTMLButtonElement>): void {
  event.preventDefault();
}

export interface HotkeySettingControlProps {
  readonly accelerator: string | null;
  readonly acceleratorLabel: string | null;
  readonly allowsBareModifiers?: boolean;
  readonly allowsSequences?: boolean;
  readonly ariaLabelledBy?: string;
  readonly canAppend?: boolean;
  readonly captureAriaLabel: string;
  readonly captureFnHotkey?: () => Promise<string | null>;
  readonly className?: string;
  readonly conflict?: string | null;
  readonly disabled?: boolean;
  readonly emptyLabel?: string;
  readonly hotkeyName: string;
  readonly isCapturing: boolean;
  readonly onCancelCapture: () => void;
  readonly onCapture: (accelerator: string) => void;
  readonly onClear: () => void;
  readonly onReset?: () => void;
  readonly onStartCapture: (mode: HotkeyCaptureMode) => void;
  readonly platform: RuntimePlatform;
  readonly valueLabelId?: string;
}

/** Shared inline shortcut recorder used by Voice settings and the full shortcut editor. */
export function HotkeySettingControl({
  accelerator,
  acceleratorLabel,
  allowsBareModifiers = false,
  allowsSequences = false,
  ariaLabelledBy,
  canAppend = false,
  captureAriaLabel,
  captureFnHotkey,
  className,
  conflict = null,
  disabled = false,
  emptyLabel = "Unassigned",
  hotkeyName,
  isCapturing,
  onCancelCapture,
  onCapture,
  onClear,
  onReset,
  onStartCapture,
  platform,
  valueLabelId,
}: HotkeySettingControlProps) {
  const keyboardLayout = useKeyboardLayoutSnapshot();
  const nativeCaptureGenerationRef = useRef(0);
  const pressedBareModifiersRef = useRef(new Set<string>());
  const pendingSequenceRef = useRef<string | null>(null);
  const sequenceTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const [captureValue, setCaptureValue] = useState<string | null>(null);
  const [appendHintVisible, setAppendHintVisible] = useState(false);

  const resetCaptureState = (): void => {
    if (sequenceTimerRef.current !== null) {
      globalThis.clearTimeout(sequenceTimerRef.current);
      sequenceTimerRef.current = null;
    }
    pendingSequenceRef.current = null;
    pressedBareModifiersRef.current.clear();
    setCaptureValue(null);
  };

  const commitCapture = (nextAccelerator: string): void => {
    nativeCaptureGenerationRef.current += 1;
    resetCaptureState();
    onCapture(nextAccelerator);
  };

  const cancelCapture = (): void => {
    nativeCaptureGenerationRef.current += 1;
    resetCaptureState();
    onCancelCapture();
  };

  const captureChord = (chord: string): void => {
    const pendingSequence = pendingSequenceRef.current;
    if (pendingSequence) {
      commitCapture(`${pendingSequence} ${chord}`);
      return;
    }
    if (!allowsSequences || chord.includes("+")) {
      commitCapture(chord);
      return;
    }

    pendingSequenceRef.current = chord;
    setCaptureValue(`${formatAcceleratorLabel(chord, platform)} …`);
    sequenceTimerRef.current = globalThis.setTimeout(() => {
      if (pendingSequenceRef.current === chord) commitCapture(chord);
    }, SEQUENCE_CAPTURE_TIMEOUT_MS);
  };

  useEffect(() => {
    nativeCaptureGenerationRef.current += 1;
    const generation = nativeCaptureGenerationRef.current;
    const pressedBareModifiers = pressedBareModifiersRef.current;
    if (isCapturing && allowsBareModifiers && platform === "macOS" && captureFnHotkey) {
      void captureFnHotkey()
        .then((hotkey) => {
          if (hotkey === "Fn" && nativeCaptureGenerationRef.current === generation) {
            commitCapture(hotkey);
          }
        })
        .catch(() => undefined);
    }
    return () => {
      nativeCaptureGenerationRef.current += 1;
      pressedBareModifiers.clear();
      pendingSequenceRef.current = null;
      if (sequenceTimerRef.current !== null) globalThis.clearTimeout(sequenceTimerRef.current);
    };
    // commitCapture intentionally follows the active capture generation rather than its render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allowsBareModifiers, captureFnHotkey, isCapturing, platform]);

  const handleCaptureKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.repeat) return;
    event.preventDefault();
    event.stopPropagation();

    if (
      event.key === "Escape" &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey
    ) {
      cancelCapture();
      return;
    }

    if (MODIFIER_KEYS.has(event.key)) {
      if (!allowsBareModifiers) return;
      const physicalModifier = physicalBareModifierIdentity(event.nativeEvent);
      if (physicalModifier) pressedBareModifiersRef.current.add(physicalModifier);
      return;
    }

    pressedBareModifiersRef.current.clear();
    const acceleratorFromEvent = keyboardEventToAccelerator(event.nativeEvent, platform, {
      keyboardLayout,
    });
    if (acceleratorFromEvent) captureChord(acceleratorFromEvent);
  };

  const handleCaptureKeyUp = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (!allowsBareModifiers) return;

    const physicalModifier = physicalBareModifierIdentity(event.nativeEvent);
    if (!physicalModifier || !pressedBareModifiersRef.current.has(physicalModifier)) return;

    const doubleModifier = doubleModifierIdentity(pressedBareModifiersRef.current);
    if (doubleModifier) {
      commitCapture(doubleModifier);
      return;
    }

    const bareModifier = bareModifierIdentity(event.nativeEvent, "released");
    if (bareModifier && pressedBareModifiersRef.current.size === 1) {
      commitCapture(bareModifier);
      return;
    }
    pressedBareModifiersRef.current.delete(physicalModifier);
  };

  if (isCapturing) {
    const conflictId = conflict ? `${captureAriaLabel.replaceAll(" ", "-")}-conflict` : undefined;
    return (
      <div className={cn("flex w-full flex-col items-start gap-1", className)}>
        <div className="flex items-center gap-2">
          <div className="w-36 max-w-full">
            <input
              autoFocus
              data-codex-shortcut-capture
              readOnly
              aria-describedby={conflictId}
              aria-invalid={conflict ? true : undefined}
              aria-label={captureAriaLabel}
              value={captureValue ?? "Press shortcut"}
              onBlur={cancelCapture}
              onKeyDown={handleCaptureKeyDown}
              onKeyUp={handleCaptureKeyUp}
              className="h-7 w-full min-w-0 rounded-md border border-token-border bg-token-input-background px-2 text-sm text-token-text-primary outline-none placeholder:text-token-text-tertiary focus:border-token-focus-border aria-invalid:border-token-error-foreground aria-invalid:ring-2 aria-invalid:ring-token-error-foreground/20"
            />
          </div>
          <button
            type="button"
            className={cn(HOTKEY_ACTION_BUTTON_CLASSNAME, "aspect-auto px-2")}
            onMouseDown={preventCaptureButtonBlur}
            onClick={cancelCapture}
          >
            Cancel
          </button>
        </div>
        {conflict ? (
          <span id={conflictId} className="text-xs text-token-editor-warning-foreground">
            Used by {conflict}
          </span>
        ) : null}
      </div>
    );
  }

  const hasAccelerator = accelerator !== null;
  const setAriaLabel = hasAccelerator
    ? appendHintVisible
      ? `Create new shortcut for ${hotkeyName}`
      : `Change shortcut for ${hotkeyName}`
    : `Set shortcut for ${hotkeyName}`;
  const clearAriaLabel = `Clear shortcut for ${hotkeyName}`;
  const resetAriaLabel = `Reset shortcut for ${hotkeyName}`;

  return (
    <div
      aria-labelledby={ariaLabelledBy}
      className={cn("group flex min-h-8 items-center", className)}
      role={ariaLabelledBy ? "group" : undefined}
    >
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <span
          id={valueLabelId}
          className="flex min-h-8 items-center gap-1 text-sm text-token-text-secondary"
        >
          {acceleratorLabel ? (
            <ShortcutKeycaps
              className="px-2 py-1 text-sm"
              keys={[acceleratorLabel]}
              density="settings"
              tone="current"
            />
          ) : (
            emptyLabel
          )}
        </span>
        <button
          type="button"
          className={HOTKEY_ACTION_BUTTON_CLASSNAME}
          aria-label={setAriaLabel}
          disabled={disabled}
          onMouseEnter={(event) =>
            setAppendHintVisible(canAppend && hasAccelerator && event.shiftKey)
          }
          onMouseMove={(event) =>
            setAppendHintVisible(canAppend && hasAccelerator && event.shiftKey)
          }
          onMouseLeave={() => setAppendHintVisible(false)}
          onClick={(event) =>
            onStartCapture(
              hasAccelerator ? (canAppend && event.shiftKey ? "append" : "replace") : "set",
            )
          }
        >
          <EditIcon />
        </button>
      </div>
      <div className="ms-2 flex shrink-0 items-center justify-end gap-1">
        {hasAccelerator ? (
          <button
            type="button"
            className={HOTKEY_ACTION_BUTTON_CLASSNAME}
            aria-label={clearAriaLabel}
            disabled={disabled}
            onClick={onClear}
          >
            <DeleteIcon />
          </button>
        ) : null}
        {onReset ? (
          <button
            type="button"
            className={HOTKEY_ACTION_BUTTON_CLASSNAME}
            aria-label={resetAriaLabel}
            disabled={disabled}
            onClick={onReset}
          >
            <ResetIcon />
          </button>
        ) : null}
      </div>
    </div>
  );
}
