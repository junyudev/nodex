import { type ReactNode, useEffect } from "react";
import { toast as toastEngine, Toaster } from "sonner";
import {
  AlertCircle16Icon,
  Close16Icon,
  InfoCircle16Icon,
  SuccessCircle16Icon,
} from "@/components/shared/icons";
import { ToolbarButton } from "@/components/ui/toolbar-button";
import { APP_SHELL_TOAST_LAYER_CLASS } from "@/lib/app-shell-layers";
import { cn } from "@/lib/utils";
import styles from "./toast.module.css";

const DEFAULT_TOAST_DURATION_MS = 5000;

export type ToastLevel = "info" | "success" | "warning" | "danger";

export interface ToastHandle {
  close: () => void;
}

export interface ToastAction {
  label: ReactNode;
  /** Runs the action; returning `false` keeps the toast open. */
  onClick: () => boolean | void;
}

export interface ToastOptions {
  description?: ReactNode;
  /** Replaces the level's icon. */
  leading?: ReactNode;
  /** The emphasized action. */
  action?: ToastAction;
  /** A quieter action placed before `action`. */
  secondaryAction?: ToastAction;
  /** Milliseconds before the toast closes itself; `0` keeps it until it is dismissed. */
  duration?: number;
  /** Logical identity: showing a toast replaces the visible one with the same id. */
  id?: string;
}

export interface ToastRecord extends Omit<ToastOptions, "duration" | "id"> {
  id: string;
  logicalId: string | null;
  level: ToastLevel;
  title: ReactNode;
  duration: number;
}

function resolveToastDuration(duration?: number): number {
  if (typeof duration !== "number" || Number.isNaN(duration) || duration < 0) {
    return DEFAULT_TOAST_DURATION_MS;
  }
  return duration;
}

/** A confirmation with nothing to act on leaves on time, even while the toast stack is hovered. */
function closesOnFixedTimer(record: ToastRecord): boolean {
  return (
    record.level === "success" &&
    record.duration !== 0 &&
    record.action === undefined &&
    record.secondaryAction === undefined
  );
}

/**
 * Owns which toasts are open, newest first, and asks the notification engine to present them. The
 * engine owns everything after that: stacking, hover expansion, swipe, and the exit animation.
 */
class NodexToastStore {
  private records: readonly ToastRecord[] = [];

  private viewportMounted = false;

  private nextId = 1;

  private readonly fixedTimers = new Map<string, ReturnType<typeof setTimeout>>();

  getSnapshot = (): readonly ToastRecord[] => this.records;

  show(level: ToastLevel, title: ReactNode, options: ToastOptions = {}): ToastHandle {
    const logicalId = options.id?.trim() || null;
    const id = `${logicalId ?? "toast"}-${this.nextId}`;
    this.nextId += 1;

    if (logicalId) {
      for (const existing of this.records) {
        if (existing.logicalId === logicalId) this.close(existing.id);
      }
    }

    const record: ToastRecord = {
      id,
      logicalId,
      level,
      title,
      description: options.description,
      leading: options.leading,
      action: options.action,
      secondaryAction: options.secondaryAction,
      duration: resolveToastDuration(options.duration),
    };
    this.records = [record, ...this.records];
    this.present(record);

    return { close: () => this.close(id) };
  }

  runAction(record: ToastRecord, action: ToastAction): void {
    if (action.onClick() !== false) this.close(record.id);
  }

  runLatestAction(): boolean {
    const record = this.records.find((candidate) => candidate.action !== undefined);
    if (!record?.action) return false;
    this.runAction(record, record.action);
    return true;
  }

  close(id: string): void {
    if (!this.records.some((record) => record.id === id)) return;
    this.forget(id);
    if (this.viewportMounted) toastEngine.dismiss(id);
  }

  closeAll(): void {
    for (const record of this.records) this.close(record.id);
  }

  /**
   * The engine replays its open toasts to every new viewport, so it only holds toasts while a
   * viewport is mounted; the records here carry them across a remount.
   */
  registerViewport(): () => void {
    this.viewportMounted = true;
    for (const record of [...this.records].reverse()) this.present(record);
    return () => {
      this.viewportMounted = false;
      for (const record of this.records) toastEngine.dismiss(record.id);
    };
  }

  resetForTest(): void {
    this.closeAll();
  }

  private present(record: ToastRecord): void {
    if (!this.viewportMounted) return;
    toastEngine.custom(() => <ToastSurface record={record} />, {
      id: record.id,
      duration: record.duration === 0 ? Number.POSITIVE_INFINITY : record.duration,
      onAutoClose: () => this.forget(record.id),
      onDismiss: () => this.forget(record.id),
    });
    if (closesOnFixedTimer(record) && !this.fixedTimers.has(record.id)) {
      this.fixedTimers.set(
        record.id,
        setTimeout(() => this.close(record.id), record.duration),
      );
    }
  }

  private forget(id: string): void {
    const timer = this.fixedTimers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.fixedTimers.delete(id);

    this.records = this.records.filter((record) => record.id !== id);
    // Blurring before the last toast unmounts returns focus to where it was before the toast.
    if (this.viewportMounted && this.records.length === 0) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && active.closest("[data-sonner-toaster]")) active.blur();
    }
  }
}

const nodexToastStore = new NodexToastStore();

export const toast = {
  info: (title: ReactNode, options?: ToastOptions) => nodexToastStore.show("info", title, options),
  success: (title: ReactNode, options?: ToastOptions) =>
    nodexToastStore.show("success", title, options),
  warning: (title: ReactNode, options?: ToastOptions) =>
    nodexToastStore.show("warning", title, options),
  danger: (title: ReactNode, options?: ToastOptions) =>
    nodexToastStore.show("danger", title, options),
  runLatestAction: () => nodexToastStore.runLatestAction(),
  closeAll: () => nodexToastStore.closeAll(),
};

export function useToaster() {
  return toast;
}

const TOAST_TONE: Record<
  ToastLevel,
  { surface: string; description: string; icon: typeof InfoCircle16Icon }
> = {
  info: {
    surface: "border-default bg-surface-elevated-secondary text-default",
    description: "text-(--color-text-secondary)",
    icon: InfoCircle16Icon,
  },
  success: {
    surface:
      "border-(--color-text-success)/20 bg-(--color-background-success-surface) text-(--color-text-success)",
    description: "text-(--color-text-success)/80",
    icon: SuccessCircle16Icon,
  },
  warning: {
    surface:
      "border-(--color-border-warning-outline) bg-(--color-background-warning-surface) text-(--color-text-warning)",
    description: "text-(--color-text-warning)/80",
    icon: AlertCircle16Icon,
  },
  danger: {
    surface:
      "border-(--color-border-danger-outline) bg-(--color-background-danger-surface) text-(--color-text-danger)",
    description: "text-(--color-text-danger)/80",
    icon: AlertCircle16Icon,
  },
};

function ToastSurface({ record }: { record: ToastRecord }) {
  const { action, secondaryAction, description } = record;
  const tone = TOAST_TONE[record.level];
  const LevelIcon = tone.icon;
  const actions =
    action || secondaryAction ? (
      <>
        {secondaryAction ? (
          <ToolbarButton
            color="secondary"
            size="compact"
            onClick={() => nodexToastStore.runAction(record, secondaryAction)}
          >
            {secondaryAction.label}
          </ToolbarButton>
        ) : null}
        {action ? (
          <ToolbarButton
            color="primary"
            size="compact"
            onClick={() => nodexToastStore.runAction(record, action)}
          >
            {action.label}
          </ToolbarButton>
        ) : null}
      </>
    ) : null;

  return (
    <div data-slot="toast-item" className="max-w-full min-w-0">
      <div
        role="alert"
        className={cn(
          "no-drag pointer-events-auto flex max-w-full min-w-0 flex-col gap-2 rounded-xl border px-3 py-2 text-base leading-normal shadow-[0_4px_12px_rgb(0_0_0/0.1)]",
          tone.surface,
        )}
      >
        <div className="flex min-w-0 items-start gap-1">
          <div className="flex size-6 shrink-0 grow-0 items-center justify-center">
            {record.leading ?? <LevelIcon className="size-4 shrink-0" />}
          </div>
          <div className="flex min-w-0 flex-1 items-start gap-3">
            <div className="min-w-0 flex-1 break-words">
              <div className="flex min-h-6 items-center text-start font-medium whitespace-pre-wrap">
                {record.title}
              </div>
              {description ? (
                <div className={cn("text-start", tone.description)}>{description}</div>
              ) : null}
            </div>
            {actions && !description ? (
              <div className="flex shrink-0 items-center gap-2">{actions}</div>
            ) : null}
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            className="flex size-6 shrink-0 grow-0 cursor-interaction items-center justify-center rounded-full hover:bg-(--color-background-primary-ghost-hover)/5"
            onClick={() => nodexToastStore.close(record.id)}
          >
            <Close16Icon className="size-4 shrink-0" />
          </button>
        </div>
        {actions && description ? (
          <div className="flex items-center justify-end gap-2">{actions}</div>
        ) : null}
      </div>
    </div>
  );
}

const TOAST_SWIPE_DIRECTIONS = ["right"] as const;
const TOAST_ENGINE_OPTIONS = { className: styles.toast, unstyled: true };

export function NodexToastProvider({ children }: { children: ReactNode }) {
  useEffect(() => nodexToastStore.registerViewport(), []);

  return (
    <>
      {children}
      <div
        className={cn(
          "pointer-events-none fixed inset-0 px-2 pt-12",
          styles.layer,
          APP_SHELL_TOAST_LAYER_CLASS,
        )}
      >
        <div data-slot="toast-viewport" className="relative w-full">
          <Toaster
            className={cn(
              styles.toaster,
              "flex max-w-(--thread-composer-max-width) justify-center",
            )}
            customAriaLabel="Notifications"
            gap={8}
            hotkey={[]}
            mobileOffset={0}
            offset={0}
            position="top-center"
            swipeDirections={[...TOAST_SWIPE_DIRECTIONS]}
            toastOptions={TOAST_ENGINE_OPTIONS}
            visibleToasts={3}
          />
        </div>
      </div>
    </>
  );
}

export function __resetNodexToastStoreForTests() {
  nodexToastStore.resetForTest();
}

export function __getNodexToastSnapshotForTests(): readonly ToastRecord[] {
  return nodexToastStore.getSnapshot();
}
