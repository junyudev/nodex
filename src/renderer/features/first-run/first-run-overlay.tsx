import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { BackIcon } from "@/components/shared/icons";
import { NodexButton, NodexIconButton } from "@/components/ui/button";
import type { Project, ProjectCreateInput } from "@/lib/types";
import { cn } from "@/lib/utils";
import { FirstRunAgentsStep } from "./first-run-agents-step";
import {
  firstRunSteps,
  firstTaskPrompt,
  nextFirstRunStep,
  previousFirstRunStep,
  type FirstRunLanding,
  type FirstRunStep,
} from "./first-run-model";
import { useChatImportProgress } from "./first-run-projects";
import { FirstRunProjectsStep } from "./first-run-projects-step";
import { useFirstRunState, type useFirstRunPresentation } from "./first-run-state";

export interface FirstRunOverlayProps {
  readonly presentation: ReturnType<typeof useFirstRunPresentation>;
  readonly projects: readonly Project[];
  readonly insets: { readonly left: number; readonly right: number };
  readonly onCreateProject: (input: ProjectCreateInput) => Promise<Project | null>;
  readonly onStartNewChatWithPrompt: (input: {
    readonly projectId: string | null;
    readonly prompt: string;
  }) => Promise<void>;
  readonly onStartNewChat: (
    projectId: string | null,
    options: { readonly focusComposer: boolean },
  ) => Promise<void>;
}

function FirstRunFlow({
  presentation,
  projects,
  insets,
  onCreateProject,
  onStartNewChatWithPrompt,
  onStartNewChat,
}: FirstRunOverlayProps) {
  const { state, goTo, finish } = useFirstRunState();
  const reducedMotion = useReducedMotion();
  const progress = useChatImportProgress();
  const entry = state?.entry ?? "first-run";
  // Finishing clears the saved step, and this page stays on screen while it fades.
  const [step, setStep] = useState<FirstRunStep>(state?.step ?? "agents");
  if (state?.step && state.step !== step) setStep(state.step);
  const previous = previousFirstRunStep(entry, step);
  const steps = firstRunSteps(entry);
  const firstProjectId = projects[0]?.id ?? null;

  // Record the step as soon as it shows, so quitting here resumes here.
  const recordStep = state !== null && !state.done && state.step === null;
  useEffect(() => {
    if (recordStep) void goTo("agents");
  }, [goTo, recordStep]);

  /** The Workbench is ready behind the flow before it fades, so nothing flashes on the way out. */
  const close = (prepare: () => Promise<void>) => {
    presentation.beginClosing();
    return prepare().finally(finish);
  };
  const land = (landing: FirstRunLanding | null) =>
    close(async () => {
      if (landing) {
        await onStartNewChatWithPrompt({
          projectId: landing.projectId,
          prompt: firstTaskPrompt(landing.task),
        });
      } else if (entry === "first-run") {
        await onStartNewChat(firstProjectId, { focusComposer: true });
      }
    });
  const skip = () => land(null);
  const advance = () => {
    const next = nextFirstRunStep(entry, step);
    if (next) void goTo(next);
    else void land(null);
  };

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label="Set up Nodex"
      data-testid="first-run"
      className="fixed inset-0 flex flex-col bg-token-main-surface-primary text-token-text-primary"
      exit={reducedMotion ? { opacity: 1 } : { opacity: 0 }}
      transition={{ duration: reducedMotion ? 0 : 0.2, ease: "easeOut" }}
    >
      <div
        className="relative flex h-11 shrink-0 items-center justify-between"
        style={
          {
            WebkitAppRegion: "drag",
            paddingLeft: insets.left,
            paddingRight: Math.max(insets.right, 12),
          } as CSSProperties
        }
      >
        <div style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          {previous ? (
            <NodexIconButton
              icon={BackIcon}
              ariaLabel="Back"
              size="sm"
              onClick={() => void goTo(previous)}
            />
          ) : null}
        </div>
        <div className="pointer-events-none absolute inset-x-0 flex justify-center">
          {progress ? (
            <span role="status" className="text-xs text-token-description-foreground tabular-nums">
              Bringing in chats · {progress.settled} of {progress.total}
            </span>
          ) : steps.length > 1 ? (
            <div
              role="img"
              aria-label={`Step ${steps.indexOf(step) + 1} of ${steps.length}`}
              className="flex gap-1.5"
            >
              {steps.map((entryStep) => (
                <span
                  key={entryStep}
                  className={cn(
                    "size-1.5 rounded-full",
                    entryStep === step ? "bg-token-foreground/60" : "bg-token-foreground/15",
                  )}
                />
              ))}
            </div>
          ) : null}
        </div>
        <div style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <NodexButton size="sm" variant="ghostSecondary" onClick={() => void skip()}>
            {entry === "connect" ? "Close" : "Skip"}
          </NodexButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="flex min-h-full flex-col items-center justify-center px-6 pt-4 pb-14">
          <motion.div
            key={step}
            className="w-full max-w-[520px]"
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
          >
            {step === "agents" ? (
              <FirstRunAgentsStep entry={entry} onContinue={advance} />
            ) : (
              <FirstRunProjectsStep
                projects={projects}
                onCreateProject={onCreateProject}
                onContinue={(landing) => void land(landing)}
              />
            )}
          </motion.div>
        </div>
      </div>
    </motion.div>
  );
}

/** The whole-window setup flow, above a Workbench that stays mounted and out of reach. */
export function FirstRunOverlay(props: FirstRunOverlayProps) {
  return (
    <AnimatePresence>
      {props.presentation.showing ? <FirstRunFlow key="first-run" {...props} /> : null}
    </AnimatePresence>
  );
}
