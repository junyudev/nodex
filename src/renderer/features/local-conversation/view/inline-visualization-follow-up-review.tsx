import { useCallback, useEffect, useRef, useState } from "react";
import {
  NodexDialog,
  NodexDialogAction,
  NodexDialogBody,
  NodexDialogContent,
  NodexDialogFooter,
  NodexDialogForm,
  NodexDialogHeader,
  NodexDialogTitle,
} from "@/components/ui/dialog";
import type { McpAppFollowUpMessage } from "../../../lib/mcp-app/mcp-app-follow-up";

interface ReviewRequest {
  readonly message: McpAppFollowUpMessage;
  readonly settle: (prompt: string | null) => void;
}

/** Review is bounded to one pending document request and always settles when its consumer leaves. */
export function useInlineVisualizationFollowUpReview() {
  const [request, setRequest] = useState<ReviewRequest | null>(null);
  const pending = useRef<ReviewRequest | null>(null);
  const review = useCallback(
    (message: McpAppFollowUpMessage, signal?: AbortSignal): Promise<string | null> => {
      if (signal?.aborted) return Promise.resolve(null);
      if (pending.current) return Promise.reject(new Error("A message is already awaiting review"));
      return new Promise((resolve) => {
        const value: ReviewRequest = {
          message,
          settle: (prompt) => {
            signal?.removeEventListener("abort", abort);
            resolve(prompt);
          },
        };
        const abort = () => {
          if (pending.current !== value) return;
          pending.current = null;
          setRequest(null);
          value.settle(null);
        };
        pending.current = value;
        setRequest(value);
        signal?.addEventListener("abort", abort, { once: true });
      });
    },
    [],
  );
  const settle = useCallback((prompt: string | null) => {
    const value = pending.current;
    if (!value) return;
    pending.current = null;
    setRequest(null);
    value.settle(prompt);
  }, []);
  useEffect(
    () => () => {
      pending.current?.settle(null);
      pending.current = null;
    },
    [],
  );
  return { request, review, settle };
}

export function InlineVisualizationFollowUpReview({
  request,
  settle,
  portalContainer,
}: {
  readonly request: ReviewRequest | null;
  readonly settle: (prompt: string | null) => void;
  readonly portalContainer?: HTMLElement | null;
}) {
  if (!request) return null;
  return (
    <ReviewDialog
      key={request.message.prompt}
      message={request.message}
      settle={settle}
      portalContainer={portalContainer}
    />
  );
}

function ReviewDialog({
  message,
  settle,
  portalContainer,
}: {
  message: McpAppFollowUpMessage;
  settle: (prompt: string | null) => void;
  portalContainer?: HTMLElement | null;
}) {
  const [prompt, setPrompt] = useState(message.prompt);
  return (
    <NodexDialog
      open
      onOpenChange={(open) => {
        if (!open) settle(null);
      }}
    >
      <NodexDialogContent size="compact" portalContainer={portalContainer}>
        <NodexDialogForm
          onSubmit={(event) => {
            event.preventDefault();
            if (prompt.trim()) settle(prompt.trim());
          }}
        >
          <NodexDialogHeader>
            <NodexDialogTitle>{message.title ?? "Send message"}</NodexDialogTitle>
          </NodexDialogHeader>
          <NodexDialogBody>
            <textarea
              aria-label="Message"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              className="min-h-28 w-full resize-y rounded-lg border border-token-border bg-token-input-background px-3 py-2 text-sm outline-none focus:border-token-focus-border"
            />
          </NodexDialogBody>
          <NodexDialogFooter>
            <NodexDialogAction tone="ghost" onClick={() => settle(null)}>
              Cancel
            </NodexDialogAction>
            <NodexDialogAction tone="primary" type="submit" disabled={!prompt.trim()}>
              Send
            </NodexDialogAction>
          </NodexDialogFooter>
        </NodexDialogForm>
      </NodexDialogContent>
    </NodexDialog>
  );
}
