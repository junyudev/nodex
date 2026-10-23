import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CodexComposerPredictionResult } from "../../../../../shared/codex-composer-prediction";
import { logTelemetryEvent } from "../../../../lib/statsig-telemetry";
import { useConversationRuntimeOverride } from "../../conversation-runtime";
import { runConversationOperation } from "../../local-conversation-operations";
import { useComposerPredictionSettings } from "../../composer-prediction-settings";
import type { ComposerPredictionInteraction } from "./composer-prediction-plugin";

export interface ComposerPredictionSubmission {
  readonly prediction: CodexComposerPredictionResult;
  readonly accepted: boolean;
  readonly acceptedText?: string;
}

const reportInteraction = (
  prediction: CodexComposerPredictionResult,
  action: string,
  edited?: boolean,
) =>
  logTelemetryEvent("codex_composer_prediction_interaction", undefined, {
    action,
    edited,
    generationTrigger: prediction.generationTrigger,
    model: prediction.model,
  });

/** Catch-up shares the execution owner's cache with background completion. */
export function useComposerPrediction({
  hostId,
  threadId,
  latestTurnId,
  eligible,
  connected,
}: {
  readonly hostId: string;
  readonly threadId: string | null;
  readonly latestTurnId: string | null;
  readonly eligible: boolean;
  readonly connected: boolean;
}) {
  const override = useConversationRuntimeOverride();
  const queryClient = useQueryClient();
  const preference = useComposerPredictionSettings();
  const enabledPreference =
    !preference.isLoading && !preference.error && preference.settings.enabled;
  const allowed = eligible && (!override || override.kind === "codex") && threadId !== null;
  const availability = useQuery({
    queryKey: ["composer_prediction_availability", hostId],
    queryFn: () => runConversationOperation("codex:composer-prediction:availability", hostId),
    enabled: allowed && enabledPreference,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    networkMode: "always",
    refetchOnWindowFocus: true,
  });
  const target = JSON.stringify([hostId, threadId, latestTurnId]);
  const [suppressedTarget, setSuppressedTarget] = useState<string | null>(null);
  const interactionRef = useRef<{
    readonly target: string;
    readonly interaction: ComposerPredictionInteraction;
  } | null>(null);
  const shownId = useRef<string | null>(null);
  const acceptedId = useRef<string | null>(null);
  const activeTarget =
    allowed &&
    enabledPreference &&
    availability.data?.enabled === true &&
    connected &&
    latestTurnId !== null &&
    suppressedTarget !== target;
  const request = useQuery({
    queryKey: ["composer_prediction", hostId, activeTarget ? [threadId, latestTurnId] : null],
    enabled: activeTarget,
    queryFn: async ({ signal }) => {
      if (!threadId || !latestTurnId) return null;
      signal.throwIfAborted();
      const result = await runConversationOperation("codex:composer-prediction:request", {
        hostId,
        threadId,
        latestTurnId,
        generationTrigger: "catch-up",
      });
      signal.throwIfAborted();
      return result;
    },
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
    networkMode: "always",
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    if (enabledPreference) return;
    queryClient.removeQueries({ queryKey: ["composer_prediction_availability", hostId] });
    queryClient.removeQueries({ queryKey: ["composer_prediction", hostId] });
    interactionRef.current = null;
  }, [enabledPreference, hostId, queryClient]);

  const onInteraction = useCallback(
    (interaction: ComposerPredictionInteraction) => {
      if (interaction.prediction.sourceTurnId !== latestTurnId) return;
      const previous = interactionRef.current;
      if (
        previous?.target !== target ||
        previous.interaction.prediction.predictionThreadId !==
          interaction.prediction.predictionThreadId ||
        interaction.action === "accepted"
      )
        interactionRef.current = { target, interaction };
      if (interaction.action === "shown") {
        if (shownId.current === interaction.prediction.predictionThreadId) return;
        shownId.current = interaction.prediction.predictionThreadId;
      } else {
        if (acceptedId.current === interaction.prediction.predictionThreadId) return;
        acceptedId.current = interaction.prediction.predictionThreadId;
      }
      reportInteraction(interaction.prediction, interaction.action);
    },
    [latestTurnId, target],
  );

  const beforeSubmit = useCallback((): ComposerPredictionSubmission | null => {
    if (
      !allowed ||
      !enabledPreference ||
      availability.data?.enabled !== true ||
      latestTurnId === null
    )
      return null;
    setSuppressedTarget(target);
    const record = interactionRef.current;
    const interaction = record?.target === target ? record.interaction : null;
    if (!interaction || interaction.prediction.sourceTurnId !== latestTurnId) return null;
    interactionRef.current = null;
    if (interaction.action === "shown") reportInteraction(interaction.prediction, "ignored");
    return {
      prediction: interaction.prediction,
      accepted: interaction.action === "accepted",
      acceptedText: interaction.acceptedText,
    };
  }, [allowed, availability.data?.enabled, enabledPreference, latestTurnId, target]);

  const recordSubmitted = useCallback(
    (submission: ComposerPredictionSubmission | null, submittedText: string) => {
      if (!submission) return;
      const edited =
        submission.accepted && submission.acceptedText !== undefined
          ? submittedText !== submission.acceptedText
          : undefined;
      if (submission.accepted) reportInteraction(submission.prediction, "submitted", edited);
      logTelemetryEvent("codex_composer_prediction_submitted", undefined, {
        acceptedPrediction: submission.accepted,
        edited,
        generationTrigger: submission.prediction.generationTrigger,
      });
    },
    [],
  );

  const prediction =
    activeTarget && request.data?.sourceTurnId === latestTurnId ? request.data : null;
  return { prediction, onInteraction, beforeSubmit, recordSubmitted };
}
