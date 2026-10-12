import {
  VisualizationAnnotationMessageSchema,
  annotationDefaultValue,
  annotationValueIsValid,
  type VisualizationAnnotationRegistration,
  type VisualizationAnnotationControls,
  type VisualizationAnnotationDraft,
  type VisualizationAnnotationCommand,
  type VisualizationAnnotationValue,
} from "../../../shared/codex-visualization-annotations";
import { areStructurallyEqual } from "../../../shared/structural-equality";

export interface VisualizationAnnotationRow {
  readonly registrationId: string;
  readonly targetId: string;
  readonly label: string;
  readonly visible: boolean;
  readonly controls: VisualizationAnnotationControls;
  readonly changes: VisualizationAnnotationDraft["annotationControlChanges"];
}
export interface VisualizationAnnotationSubmission {
  readonly prompt: string;
  readonly title: string;
  readonly context?: {
    readonly edits: readonly {
      readonly target: string;
      readonly changes: readonly {
        readonly label: string;
        readonly reference: string | null;
        readonly value: VisualizationAnnotationValue;
      }[];
    }[];
    readonly selectedVariants?: readonly {
      readonly carousel: number;
      readonly label?: string;
      readonly variant: string;
    }[];
  };
}
export interface VisualizationAnnotationsSnapshot {
  readonly rows: readonly VisualizationAnnotationRow[];
  readonly selected: VisualizationAnnotationRow | null;
  readonly open: boolean;
  readonly visible: boolean;
  readonly body: string;
  readonly submitting: boolean;
  readonly hasEdits: boolean;
  readonly canSubmit: boolean;
}
export interface InlineVisualizationAnnotations {
  readonly getSnapshot: () => VisualizationAnnotationsSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  readonly handleMessage: (value: unknown) => {
    annotationControls?: VisualizationAnnotationControls;
  };
  readonly setPresentation: (value: { active: boolean; preview: boolean; ready: boolean }) => void;
  readonly open: () => void;
  readonly close: () => void;
  readonly select: (registrationId: string, targetId: string) => void;
  readonly change: (callback: string, value: unknown) => void;
  readonly reset: () => void;
  readonly setBody: (value: string) => void;
  readonly submit: () => Promise<void>;
  readonly dispose: () => void;
  readonly resetDocument: () => void;
}

/** One document owns accepted registrations, previews and model context. Guest metadata never selects persistence scope. */
export function createInlineVisualizationAnnotations(input: {
  readonly allowed: boolean;
  readonly globals: (command: VisualizationAnnotationCommand | null) => void;
  readonly persist?: (
    context: VisualizationAnnotationSubmission["context"] | null,
  ) => Promise<unknown>;
  readonly submit?: (message: VisualizationAnnotationSubmission) => Promise<void>;
}): InlineVisualizationAnnotations {
  let registrations: VisualizationAnnotationRegistration[] = [];
  let drafts: VisualizationAnnotationDraft[] = [];
  let variants: NonNullable<VisualizationAnnotationSubmission["context"]>["selectedVariants"] = [];
  let selection: VisualizationAnnotationCommand["selection"] = null;
  let open = false;
  let active = true;
  let preview = false;
  let ready = false;
  let body = "";
  let submitting = false;
  let disposed = false;
  const listeners = new Set<() => void>();
  const owners = () =>
    new Map(
      registrations.flatMap((registration) =>
        registration.targets.map((target) => [target.id, registration] as const),
      ),
    );
  const validDrafts = () => {
    const map = owners();
    return drafts.flatMap((draft) => {
      const owner = map.get(draft.targetId);
      if (owner?.registrationId !== draft.registrationId) return [];
      const changes = draft.annotationControlChanges.filter((change) =>
        owner.annotationControls.controls.some(
          (control) =>
            control.callback === change.callback &&
            control.currentValue === change.previousValue &&
            annotationValueIsValid(control, change.value),
        ),
      );
      return changes.length ? [{ ...draft, annotationControlChanges: changes }] : [];
    });
  };
  const rows = (): VisualizationAnnotationRow[] => {
    const map = owners();
    return registrations.flatMap((registration) =>
      registration.targets
        .filter((target) => map.get(target.id) === registration)
        .map((target) => ({
          registrationId: registration.registrationId,
          targetId: target.id,
          label: target.label,
          visible: target.visible !== false,
          controls: registration.annotationControls,
          changes: registration.annotationControls.controls.map(
            (control) =>
              drafts
                .find(
                  (draft) =>
                    draft.registrationId === registration.registrationId &&
                    draft.targetId === target.id,
                )
                ?.annotationControlChanges.find(
                  (change) => change.callback === control.callback,
                ) ?? {
                callback: control.callback,
                previousValue: control.currentValue,
                value: annotationDefaultValue(control),
              },
          ),
        })),
    );
  };
  const submission = (): VisualizationAnnotationSubmission => {
    const edits = rows().flatMap((row) => {
      const changes = row.changes.flatMap((change) => {
        const control = row.controls.controls.find(
          (control) => control.callback === change.callback,
        );
        if (
          !control ||
          control.currentValue !== change.previousValue ||
          change.value === change.previousValue ||
          !annotationValueIsValid(control, change.value)
        )
          return [];
        const value =
          control.type === "select"
            ? control.options.find((option) => option.value === change.value)!.label
            : change.value;
        return [{ label: control.label, reference: control.reference ?? null, value }];
      });
      return changes.length ? [{ target: row.label, changes }] : [];
    });
    return {
      prompt: body.trim() || "Apply the changes",
      title: "Visualization changes",
      ...(edits.length || variants?.length
        ? { context: { edits, ...(variants?.length ? { selectedVariants: variants } : {}) } }
        : {}),
    };
  };
  const derive = (): VisualizationAnnotationsSnapshot => {
    const entries = rows();
    return {
      rows: entries,
      selected:
        entries.find(
          (row) =>
            row.visible &&
            row.registrationId === selection?.registrationId &&
            row.targetId === selection.targetId,
        ) ??
        entries.find((row) => row.visible) ??
        null,
      open,
      visible: active && !preview && ready && entries.length > 0,
      body,
      submitting,
      hasEdits: Boolean(submission().context?.edits.length),
      canSubmit: input.submit !== undefined,
    };
  };
  let snapshot = derive();
  const publish = (persist = false, syncGlobals = true) => {
    if (disposed) return;
    snapshot = derive();
    if (syncGlobals)
      input.globals(
        registrations.length
          ? { active: open && active && !preview, selection, changes: validDrafts() }
          : null,
      );
    listeners.forEach((listener) => listener());
    if (persist && active)
      void input.persist?.(submission().context ?? null).catch(() => undefined);
  };
  const deny = () => {
    throw new Error("Inline visualizations cannot call tools");
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    handleMessage: (raw) => {
      if (disposed) return deny();
      const parsed = VisualizationAnnotationMessageSchema.safeParse(raw);
      if (!parsed.success || (!input.allowed && parsed.data.type !== "variants")) return deny();
      const message = parsed.data;
      if (message.type === "variants") {
        if (areStructurallyEqual(variants, message.selectedVariants)) return {};
        variants = message.selectedVariants;
        publish(true);
        return {};
      }
      if (message.type === "escape") {
        if (!open) return {};
        open = false;
        publish();
        return {};
      }
      if (message.type === "select") {
        if (!active || preview || !open) return deny();
        if (owners().get(message.targetId)?.registrationId !== message.registrationId) return {};
        if (
          selection?.registrationId === message.registrationId &&
          selection.targetId === message.targetId
        )
          return {};
        selection = { registrationId: message.registrationId, targetId: message.targetId };
        publish();
        return {};
      }
      if (message.type === "dispose") {
        if (
          !registrations.some(
            (registration) => registration.registrationId === message.registrationId,
          )
        )
          return {};
        registrations = registrations.filter(
          (registration) => registration.registrationId !== message.registrationId,
        );
        drafts = drafts.filter((draft) => draft.registrationId !== message.registrationId);
        if (selection?.registrationId === message.registrationId) {
          const first = owners().entries().next().value;
          selection = first
            ? { registrationId: first[1].registrationId, targetId: first[0] }
            : null;
          open = open && selection !== null;
        }
        publish(true);
        return {};
      }
      const index = registrations.findIndex(
        (entry) => entry.registrationId === message.registrationId,
      );
      if (
        (message.type === "register" && index !== -1) ||
        (message.type === "update" && index === -1) ||
        (index === -1 && registrations.length >= 64)
      )
        return deny();
      const previous = registrations[index];
      const next = [...registrations];
      if (index === -1) next.push(message);
      else next[index] = message;
      if (next.reduce((sum, entry) => sum + entry.targets.length, 0) > 1024) return deny();
      drafts = drafts.flatMap((draft) => {
        if (draft.registrationId !== message.registrationId) return [draft];
        if (
          !previous?.targets.some((target) => target.id === draft.targetId) ||
          !message.targets.some((target) => target.id === draft.targetId)
        )
          return [];
        const changes = draft.annotationControlChanges.filter((change) =>
          areStructurallyEqual(
            previous.annotationControls.controls.find(
              (control) => control.callback === change.callback,
            ),
            message.annotationControls.controls.find(
              (control) => control.callback === change.callback,
            ),
          ),
        );
        return changes.length ? [{ ...draft, annotationControlChanges: changes }] : [];
      });
      registrations = next;
      drafts = validDrafts();
      const selectedOwner = selection && owners().get(selection.targetId);
      selection =
        selection && selectedOwner
          ? { ...selection, registrationId: selectedOwner.registrationId }
          : {
              registrationId: owners().get(message.targets[0]!.id)!.registrationId,
              targetId: message.targets[0]!.id,
            };
      publish(true);
      return { annotationControls: message.annotationControls };
    },
    setPresentation: (value) => {
      if (
        disposed ||
        (active === value.active && preview === value.preview && ready === value.ready)
      )
        return;
      const becameActive = !active && value.active;
      active = value.active;
      preview = value.preview;
      ready = value.ready;
      if (!active || preview) open = false;
      publish(becameActive);
    },
    open: () => {
      if (open || !snapshot.visible || !snapshot.selected) return;
      selection = {
        registrationId: snapshot.selected.registrationId,
        targetId: snapshot.selected.targetId,
      };
      open = true;
      publish();
    },
    close: () => {
      if (!open) return;
      open = false;
      publish();
    },
    select: (registrationId, targetId) => {
      if (!snapshot.visible || owners().get(targetId)?.registrationId !== registrationId) return;
      selection = { registrationId, targetId };
      publish();
    },
    change: (callback, value) => {
      const row = snapshot.selected;
      const control = row?.controls.controls.find((control) => control.callback === callback);
      if (
        !snapshot.visible ||
        !open ||
        submitting ||
        !row ||
        !control ||
        !annotationValueIsValid(control, value)
      )
        return;
      const changes = row.changes.filter((change) => change.callback !== callback);
      changes.push({ callback, previousValue: control.currentValue, value });
      drafts = drafts.filter(
        (draft) => draft.registrationId !== row.registrationId || draft.targetId !== row.targetId,
      );
      drafts.push({
        registrationId: row.registrationId,
        targetId: row.targetId,
        annotationControlChanges: changes,
      });
      publish(true);
    },
    reset: () => {
      if (submitting) return;
      drafts = rows().flatMap((row) => {
        const changes = row.controls.controls.flatMap((control) =>
          control.currentValue !== undefined &&
          control.currentValue !== annotationDefaultValue(control)
            ? [
                {
                  callback: control.callback,
                  previousValue: control.currentValue,
                  value: control.currentValue,
                },
              ]
            : [],
        );
        return changes.length
          ? [
              {
                registrationId: row.registrationId,
                targetId: row.targetId,
                annotationControlChanges: changes,
              },
            ]
          : [];
      });
      publish(true);
    },
    setBody: (value) => {
      if (body === value) return;
      body = value;
      publish(false, false);
    },
    submit: async () => {
      if (
        disposed ||
        !snapshot.visible ||
        !open ||
        submitting ||
        !input.submit ||
        (!snapshot.hasEdits && !body.trim())
      )
        return;
      submitting = true;
      publish(false, false);
      let closed = false;
      try {
        await input.submit(submission());
        if (!disposed) {
          open = false;
          closed = true;
        }
      } finally {
        submitting = false;
        publish(false, closed);
      }
    },
    dispose: () => {
      disposed = true;
      registrations = [];
      drafts = [];
      variants = [];
      input.globals(null);
      listeners.clear();
    },
    resetDocument: () => {
      registrations = [];
      drafts = [];
      variants = [];
      selection = null;
      open = false;
      body = "";
      publish();
    },
  };
}
