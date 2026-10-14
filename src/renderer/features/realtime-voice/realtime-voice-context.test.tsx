import { StrictMode, useLayoutEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import {
  createMaitaiStore,
  disposeMaitaiStore,
  MaitaiProvider,
  ScopeProvider,
} from "../../lib/maitai";
import { ThreadScope, RouteScope, ComposerScope } from "../../lib/workbench-ui-scopes";
import { TestQueryProvider, createTestQueryClient } from "../../test/query";
import {
  useComposerAppModelContext,
  type ComposerAppModelContextRecipient,
} from "../local-conversation/view/composer/composer-app-model-context";
import { RealtimeVoiceWindowProvider } from "./realtime-voice-window";
import { createRealtimeVoiceWindowOwner } from "./realtime-voice-window-owner";
import type { RealtimeVoiceClient } from "./realtime-voice-client";
import type {
  RealtimeVoiceMedia,
  RealtimeVoiceMediaInput,
} from "../../lib/realtime-voice/realtime-voice-media";
import type { CodexRealtimeVoiceEvent } from "../../../shared/codex-realtime-voice";

const target = { hostId: "local", threadId: "a" };
const grant = {
  ...target,
  claimId: "019a1240-1000-7000-8000-000000000001",
  realtimeSessionId: "019a1240-1000-7000-8000-000000000002",
  microphoneInputDeviceId: null,
  builtInMicrophoneLabelHint: null,
  bufferInputWhileConnecting: true,
};
const deferred = () => {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};

function fixture() {
  const store = createMaitaiStore();
  const queryClient = createTestQueryClient();
  const recipients = new Map<string, ComposerAppModelContextRecipient>();
  let listener: ((event: CodexRealtimeVoiceEvent) => void) | null = null;
  const client = {
    read: vi.fn(async () => ({ available: true, session: null })),
    prepare: vi.fn(async () => grant),
    start: vi.fn(async () => {}),
    reportMedia: vi.fn(async () => {}),
    setMuted: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    release: vi.fn(async () => true),
    appendText: vi.fn(async () => {}),
    appendSpeech: vi.fn(async () => {}),
    injectContext: vi.fn<RealtimeVoiceClient["injectContext"]>(async () => {}),
    subscribe: (next: (event: CodexRealtimeVoiceEvent) => void) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  } satisfies RealtimeVoiceClient;
  const inputs: RealtimeVoiceMediaInput[] = [];
  const media: RealtimeVoiceMedia = {
    acceptAnswer: async () => {},
    setMicrophoneMuted: () => {},
    setOutputMuted: () => {},
    releaseInput: () => {},
    refreshInput: async () => {},
    readInputStream: () => null,
    readOutputStream: () => null,
    stop: vi.fn(async () => {}),
  };
  const owner = createRealtimeVoiceWindowOwner({
    client,
    createMedia: async (input) => {
      inputs.push(input);
      return { offerSdp: "offer", media };
    },
  });
  function Composer({ id }: { readonly id: string }) {
    const context = useComposerAppModelContext({ hostId: "local", threadId: id, enabled: true });
    useLayoutEffect(() => {
      if (context.recipient) recipients.set(id, context.recipient);
    }, [context.recipient, id]);
    return <output aria-label={`Context ${id}`}>{context.attachments.length}</output>;
  }
  function Window({ id }: { readonly id: string }) {
    return (
      <MaitaiProvider store={store}>
        <TestQueryProvider client={queryClient}>
          <RealtimeVoiceWindowProvider owner={owner}>
            <ScopeProvider
              scope={ThreadScope}
              descriptor={{
                stableKey: `session:${id}`,
                phase: "attached",
                projectSessionId: id,
                clientThreadId: null,
                threadId: id,
              }}
            >
              <ScopeProvider scope={RouteScope} descriptor={{ kind: "thread", routeKey: id }}>
                <ScopeProvider
                  scope={ComposerScope}
                  descriptor={{ identity: "main", focusComposerNonce: null }}
                >
                  <Composer id={id} />
                </ScopeProvider>
              </ScopeProvider>
            </ScopeProvider>
          </RealtimeVoiceWindowProvider>
        </TestQueryProvider>
      </MaitaiProvider>
    );
  }
  const publish = (id: string, text: string, widget = "widget") => {
    const recipient = recipients.get(id);
    if (!recipient) throw new Error("Expected real committed Composer");
    recipient.publish(
      { id: widget, server: "charts", sourceName: "Chart" },
      { content: [{ type: "text", text, annotations: { audience: ["assistant"] } }] },
    );
  };
  const dispose = () => {
    queryClient.clear();
    disposeMaitaiStore(store);
  };
  return {
    owner,
    client,
    inputs,
    media,
    recipients,
    Window,
    publish,
    dispose,
    emit: (event: CodexRealtimeVoiceEvent) => listener?.(event),
  };
}

test("retains the committed origin past Thread and Composer cache budgets before confirming native voice", async () => {
  const f = fixture();
  const view = render(<f.Window id="a" />);
  const accepted = deferred();
  let started: Promise<void> | undefined;
  try {
    await act(async () => {
      f.publish("a", "origin selection");
    });
    f.client.injectContext.mockImplementationOnce(() => accepted.promise);
    await act(async () => {
      started = f.owner.start(target, f.recipients.get("a"));
      await Promise.resolve();
    });
    await waitFor(() => expect(f.client.injectContext).toHaveBeenCalledTimes(1));
    expect(f.client.start).not.toHaveBeenCalled();
    const origin = f.recipients.get("a")!;
    const pressure =
      Math.max(ThreadScope.retain!.max, RouteScope.retain!.max, ComposerScope.retain!.max) + 2;
    for (let index = 0; index < pressure; index++)
      view.rerender(<f.Window id={`other-${index}`} />);
    expect(f.owner.read().contextOrigin?.recipient).toBe(origin);
    expect(origin.isCurrent()).toBe(true);
    const currentId = `other-${pressure - 1}`;
    await act(async () => {
      f.publish(currentId, "other selection");
      accepted.resolve();
      await started;
    });
    expect(f.client.start).toHaveBeenCalledExactlyOnceWith(grant.claimId, "offer");
    const attachments = f.client.injectContext.mock.calls[0]![1];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      content: [
        { type: "text", text: "origin selection", annotations: { audience: ["assistant"] } },
      ],
    });
    expect(view.getByLabelText(`Context ${currentId}`).textContent).toBe("1");
    view.rerender(<f.Window id="a" />);
    expect(view.getByLabelText("Context a").textContent).toBe("0");
    await act(async () => {
      await f.owner.stop();
    });
    expect(f.owner.read().contextOrigin).toBeNull();
  } finally {
    await act(async () => {
      await f.owner.cancelStart();
      accepted.resolve();
      await started;
    });
    view.unmount();
    f.dispose();
  }
});

test("StrictMode cancellation releases the real origin bridge without consuming a held context ACK", async () => {
  const f = fixture();
  const tree = (id: string) => (
    <StrictMode>
      <f.Window id={id} />
    </StrictMode>
  );
  const view = render(tree("a"));
  const accepted = deferred();
  let started: Promise<void> | undefined;
  try {
    await act(async () => {
      f.publish("a", "keep origin selection");
    });
    f.client.injectContext.mockImplementationOnce(() => accepted.promise);
    await act(async () => {
      started = f.owner.start(target, f.recipients.get("a"));
      await Promise.resolve();
    });
    await waitFor(() => expect(f.client.injectContext).toHaveBeenCalledOnce());
    expect(f.owner.read().contextOrigin?.recipient).toBe(f.recipients.get("a"));
    view.rerender(tree("b"));
    await act(async () => {
      f.publish("b", "keep other selection");
      await f.owner.cancelStart();
    });
    expect(f.owner.read().phase).toBe("inactive");
    expect(f.owner.read().contextOrigin).toBeNull();
    expect(f.inputs[0]?.signal.aborted).toBe(true);
    expect(f.client.start).not.toHaveBeenCalled();
    expect(f.media.stop).toHaveBeenCalledOnce();
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(grant.claimId);
    await act(async () => {
      accepted.resolve();
      await started;
    });
    expect(f.client.start).not.toHaveBeenCalled();
    expect(view.getByLabelText("Context b").textContent).toBe("1");
    view.rerender(tree("a"));
    expect(view.getByLabelText("Context a").textContent).toBe("1");
    expect(f.client.prepare).toHaveBeenCalledOnce();
    expect(f.client.injectContext).toHaveBeenCalledOnce();
  } finally {
    await act(async () => {
      await f.owner.cancelStart();
      accepted.resolve();
      await started;
    });
    view.unmount();
    f.dispose();
  }
});

test("coalesces pending context triggers, retries only a repeated failure and rejects retired callbacks", async () => {
  const f = fixture();
  const view = render(<f.Window id="a" />);
  let started: Promise<void> | undefined;
  await act(async () => {
    started = f.owner.start(target, f.recipients.get("a"));
    await Promise.resolve();
  });
  await act(async () => {
    await started;
  });
  const input = f.inputs[0]!;
  const event = (value: unknown) => input.onEvent?.(JSON.stringify(value));
  const user = { type: "turn.created", turn: { id: "turn-a", role: "user", transcript: "hello" } };
  const accepted = deferred();
  f.client.injectContext.mockImplementationOnce(() => accepted.promise);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await act(async () => {
      f.publish("a", "one");
      event(user);
      event(user);
    });
    expect(f.client.injectContext).toHaveBeenCalledTimes(1);
    await act(async () => {
      accepted.reject(new Error("retryable"));
      await Promise.resolve();
    });
    await waitFor(() => expect(f.client.injectContext).toHaveBeenCalledTimes(2));
    await act(async () => {
      event(user);
    });
    expect(f.client.injectContext).toHaveBeenCalledTimes(2);
    await act(async () => {
      f.publish("a", "handoff context");
      event({
        type: "conversation.handoff.requested",
        handoff_id: "handoff",
        item_id: "item",
        user_bidi_turn_id: "bidi",
        input_transcript: "work",
      });
    });
    expect(f.client.injectContext).toHaveBeenCalledTimes(2);
    await act(async () => {
      input.onInitialized("");
      event({
        type: "conversation.handoff.requested",
        handoff_id: "handoff",
        item_id: "item",
        user_bidi_turn_id: "bidi",
        input_transcript: "work",
      });
    });
    await waitFor(() => expect(f.client.injectContext).toHaveBeenCalledTimes(3));
    await act(async () => {
      f.publish("a", "delegation context");
      event({
        type: "delegation.created",
        item: {
          id: "delegation",
          type: "delegation",
          target: "client",
          handoff_id: "handoff",
          user_bidi_turn_id: "bidi",
          content: [{ type: "input_text", text: "next" }],
        },
      });
    });
    await waitFor(() => expect(f.client.injectContext).toHaveBeenCalledTimes(4));
    await act(async () => {
      f.publish("a", "native context");
      f.emit({
        type: "native",
        claimId: grant.claimId,
        notification: {
          method: "thread/realtime/itemAdded",
          params: {
            threadId: "a",
            item: {
              type: "handoff_request",
              handoff_id: "native",
              input_transcript: "",
              active_transcript: [{ role: "user", text: "native work" }],
            },
          },
        },
      });
    });
    await waitFor(() => expect(f.client.injectContext).toHaveBeenCalledTimes(5));
    await act(async () => {
      await f.owner.stop();
      event({ ...user, turn: { ...user.turn, id: "late" } });
    });
    expect(f.client.injectContext).toHaveBeenCalledTimes(5);
  } finally {
    warning.mockRestore();
    await act(async () => {
      await f.owner.cancelStart();
    });
    view.unmount();
    f.dispose();
  }
});
