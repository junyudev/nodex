import { useCallback, useEffect, useRef, useState, type RefCallback } from "react";
import { toast } from "@/components/ui/toast";
import { useCodexServiceTierSettings } from "@/lib/use-codex-service-tier-settings";
import type { ThreadFooterModel, ThreadStageActions } from "../../thread-stage-types";
import {
  areComposerIntelligenceSelectionsEqual,
  buildComposerIntelligenceTurnOverrides,
  deriveComposerIntelligenceSelection,
  type ComposerIntelligenceSelection,
} from "./composer-intelligence-selection";

export interface ComposerIntelligenceController {
  readonly selection: ComposerIntelligenceSelection;
  readonly isOpen: boolean;
  readonly isPending: boolean;
  readonly select: (selection: ComposerIntelligenceSelection) => void;
  readonly setOpen: (open: boolean) => void;
  readonly open: () => void;
  readonly flush: () => Promise<void>;
  readonly getSelection: () => ComposerIntelligenceSelection;
  readonly turnOverrides: ReturnType<typeof buildComposerIntelligenceTurnOverrides>;
  readonly triggerRef: RefCallback<HTMLButtonElement>;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Could not update model selection");
}

function focusModelPickerContent(trigger: HTMLButtonElement): void {
  const contentId = trigger.getAttribute("aria-controls");
  const content = contentId ? trigger.ownerDocument.getElementById(contentId) : null;
  if (!content) {
    trigger.focus();
    return;
  }

  const candidates = content.querySelectorAll<HTMLElement>('[role="menuitem"]');
  const target = [...candidates].find((candidate) => !candidate.closest("[inert]"));
  (target ?? trigger).focus();
}

export function useComposerIntelligenceController(
  model: ThreadFooterModel,
  actions: ThreadStageActions,
): ComposerIntelligenceController {
  const { serviceTierSettings, setServiceTier } = useCodexServiceTierSettings();
  const derivedAuthoritativeSelection = deriveComposerIntelligenceSelection(
    model,
    serviceTierSettings.serviceTier,
  );
  const authoritativeRef = useRef(derivedAuthoritativeSelection);
  // New-task defaults can clone an unchanged Agent profile; preserve its semantic identity for
  // layout and menu consumers that react to a genuinely changed selection.
  if (
    !areComposerIntelligenceSelectionsEqual(authoritativeRef.current, derivedAuthoritativeSelection)
  ) {
    authoritativeRef.current = derivedAuthoritativeSelection;
  }
  const authoritativeSelection = authoritativeRef.current;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const [optimisticSelection, setOptimisticSelection] =
    useState<ComposerIntelligenceSelection | null>(null);
  const [isOpen, setOpen] = useState(false);
  const [isPending, setPending] = useState(false);
  const desiredRef = useRef<ComposerIntelligenceSelection | null>(null);
  const displayedSelectionRef = useRef(authoritativeSelection);
  const triggerElementRef = useRef<HTMLButtonElement | null>(null);
  const drainRef = useRef<Promise<void> | null>(null);
  const lastFailureRef = useRef<Error | null>(null);

  const drain = useCallback((): Promise<void> => {
    if (drainRef.current) return drainRef.current;

    const operation = (async () => {
      setPending(true);
      try {
        while (desiredRef.current) {
          const candidate = desiredRef.current;
          desiredRef.current = null;
          const commit = actionsRef.current.onIntelligenceSelectionChange;

          try {
            if (commit) {
              await commit(candidate);
            } else {
              await Promise.all([
                actionsRef.current.onModelChange(candidate.model),
                actionsRef.current.onReasoningEffortChange(candidate.reasoningEffort),
              ]);
              setServiceTier(candidate.serviceTier, "composer_menu");
            }
            lastFailureRef.current = null;
          } catch (error) {
            if (desiredRef.current) continue;
            lastFailureRef.current = toError(error);
            displayedSelectionRef.current = authoritativeRef.current;
            setOptimisticSelection(null);
            toast.danger(lastFailureRef.current.message);
            return;
          }
        }
      } finally {
        setPending(false);
        drainRef.current = null;
        if (desiredRef.current) void drain();
      }
    })();
    drainRef.current = operation;
    return operation;
  }, [setServiceTier]);

  const select = useCallback(
    (selection: ComposerIntelligenceSelection) => {
      const current = desiredRef.current ?? optimisticSelection ?? authoritativeRef.current;
      if (areComposerIntelligenceSelectionsEqual(current, selection)) return;

      lastFailureRef.current = null;
      desiredRef.current = selection;
      displayedSelectionRef.current = selection;
      setOptimisticSelection(selection);
      void drain();
    },
    [drain, optimisticSelection],
  );

  const flush = useCallback(async (): Promise<void> => {
    if (desiredRef.current) await drain();
    if (drainRef.current) await drainRef.current;
    if (desiredRef.current) await drain();
    if (lastFailureRef.current) throw lastFailureRef.current;
  }, [drain]);

  // This ref is composed through Tooltip and Dropdown triggers. Keeping it stable
  // prevents React 19 from detaching the shared DOM node during unrelated composer renders.
  const triggerRef = useCallback((element: HTMLButtonElement | null) => {
    triggerElementRef.current = element;
  }, []);

  const selection = optimisticSelection ?? authoritativeSelection;
  displayedSelectionRef.current = selection;
  useEffect(() => {
    if (!optimisticSelection || isPending) return;
    if (!areComposerIntelligenceSelectionsEqual(optimisticSelection, authoritativeSelection))
      return;
    setOptimisticSelection(null);
  }, [authoritativeSelection, isPending, optimisticSelection]);
  const open = () => {
    const trigger = triggerElementRef.current;
    if (isOpen && trigger) {
      focusModelPickerContent(trigger);
      return;
    }

    setOpen(true);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const mountedTrigger = triggerElementRef.current;
        if (mountedTrigger) focusModelPickerContent(mountedTrigger);
      });
    });
  };
  return {
    selection,
    isOpen,
    isPending,
    select,
    setOpen,
    open,
    flush,
    getSelection: () => displayedSelectionRef.current,
    turnOverrides: buildComposerIntelligenceTurnOverrides(selection),
    triggerRef,
  };
}
