import { useLayoutEffect } from "react";
import { act, render, waitFor } from "@testing-library/react";
import { expect, test } from "vite-plus/test";
import {
  MaitaiProvider,
  ScopeProvider,
  createMaitaiStore,
  disposeMaitaiStore,
  useScopeHandle,
  type ScopeHandle,
} from "../../../../lib/maitai";
import { ThreadScope, RouteScope, ComposerScope } from "../../../../lib/workbench-ui-scopes";
import { McpAppHostDispatcher } from "../../../../lib/mcp-app/mcp-app-host-dispatcher";
import { prepareUntrustedAppInput } from "../../../../../shared/codex-untrusted-app-input";
import {
  readComposerAppModelContext,
  restoreComposerAppModelContextSnapshot,
  useComposerAppModelContext,
  type ComposerAppModelContextRecipient,
} from "./composer-app-model-context";

test("an actual MCP update reaches its Composer and an acknowledged old snapshot cannot consume a new update", async () => {
  let recipient: ComposerAppModelContextRecipient | null = null;
  function Composer() {
    const context = useComposerAppModelContext({
      hostId: "local",
      threadId: "thread-a",
      enabled: true,
    });
    useLayoutEffect(() => {
      recipient = context.recipient;
    }, [context.recipient]);
    return <output aria-label="App context count">{context.attachments.length}</output>;
  }
  const view = render(
    <MaitaiProvider store={createMaitaiStore()}>
      <ScopeProvider
        scope={ThreadScope}
        descriptor={{
          stableKey: "session:a",
          phase: "attached",
          projectSessionId: "a",
          clientThreadId: null,
          threadId: "thread-a",
        }}
      >
        <ScopeProvider scope={RouteScope} descriptor={{ kind: "thread", routeKey: "a" }}>
          <ScopeProvider
            scope={ComposerScope}
            descriptor={{ identity: "main", focusComposerNonce: null }}
          >
            <Composer />
          </ScopeProvider>
        </ScopeProvider>
      </ScopeProvider>
    </MaitaiProvider>,
  );
  const current = (): ComposerAppModelContextRecipient => {
    if (!recipient) throw new Error("Expected the committed Composer recipient");
    return recipient;
  };
  const dispatcher = new McpAppHostDispatcher({
    scope: {
      allowedTools: new Map(),
      codexAppsToolScope: null,
      originResourceUri: "ui://chart",
      resourceTemplates: [],
      resources: [],
      server: "charts",
      threadId: "thread-a",
    },
    updateModelContext: (update) =>
      current().publish({ id: "widget-a", server: "charts", sourceName: "Chart" }, update),
  });
  const update = (text: string) =>
    dispatcher.handlers().callMcp({
      method: "ui/update-model-context",
      params: { content: [{ type: "text", text, annotations: { audience: ["assistant"] } }] },
    });
  await act(async () => {
    await expect(
      dispatcher
        .handlers()
        .callMcp({ method: "ui/update-model-context", params: { content: null } }),
    ).rejects.toMatchObject({ code: -32_602 });
  });
  expect(view.getByLabelText("App context count").textContent).toBe("0");
  await act(async () => {
    await expect(update("old")).resolves.toMatchObject({
      _meta: { "openai/modelContext": { updateId: expect.any(String) } },
    });
  });
  expect(view.getByLabelText("App context count").textContent).toBe("1");
  let acknowledge: (() => void) | undefined;
  const ack = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const sent: unknown[] = [];
  const pending = current().injectHidden(async (attachments) => {
    sent.push(
      prepareUntrustedAppInput("", { mcpAppModelContextAttachments: attachments }, "call")
        .responseItems,
    );
    await ack;
  });
  await act(async () => {
    await update("new");
  });
  await act(async () => {
    acknowledge?.();
    await pending;
  });
  expect(view.getByLabelText("App context count").textContent).toBe("1");
  await act(async () => {
    await current().submit(async (attachments) => {
      expect(attachments).toMatchObject([{ id: "widget-a", content: [{ text: "new" }] }]);
    });
  });
  await waitFor(() => expect(view.getByLabelText("App context count").textContent).toBe("0"));
  expect(sent).toMatchObject([
    [{}, { output: [{ text: expect.stringContaining('"text":"old"') }] }],
  ]);
});

test("ordinary draft delivery survives native attachment and consumes only its acknowledged snapshot", async () => {
  const store = createMaitaiStore();
  let scope: ScopeHandle | undefined;
  let committed: ReturnType<typeof useComposerAppModelContext> | undefined;
  function Composer({ threadId }: { readonly threadId: string | null }) {
    const handle = useScopeHandle(ComposerScope);
    const context = useComposerAppModelContext({
      hostId: "local",
      threadId,
      enabled: threadId !== null,
    });
    useLayoutEffect(() => {
      scope = handle;
      committed = context;
    });
    return (
      <output aria-label="Context target">{context.recipient?.target.threadId ?? "draft"}</output>
    );
  }
  const tree = (threadId: string | null) => (
    <MaitaiProvider store={store}>
      <ScopeProvider
        scope={ThreadScope}
        descriptor={{
          stableKey: "session:a",
          phase: "attached",
          projectSessionId: "a",
          clientThreadId: null,
          threadId: "thread-a",
        }}
      >
        <ScopeProvider scope={RouteScope} descriptor={{ kind: "thread", routeKey: "a" }}>
          <ScopeProvider
            scope={ComposerScope}
            descriptor={{ identity: "main", focusComposerNonce: null }}
          >
            <Composer threadId={threadId} />
          </ScopeProvider>
        </ScopeProvider>
      </ScopeProvider>
    </MaitaiProvider>
  );
  const view = render(tree(null));
  const actualScope = () => {
    if (!scope) throw new Error("Expected the committed Composer");
    return scope;
  };
  const actualContext = () => {
    if (!committed) throw new Error("Expected the committed context");
    return committed;
  };
  const original = {
    kind: "message" as const,
    id: "restored",
    title: "Chart",
    untrusted: true as const,
    text: "old",
    imageAttachments: [],
  };
  await act(async () => {
    restoreComposerAppModelContextSnapshot(actualScope(), [original]);
  });
  expect(actualContext().recipient).toBeNull();
  let acknowledge: (() => void) | undefined;
  const ack = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  let captured: unknown;
  const pending = actualContext().submit(async (attachments) => {
    captured = attachments;
    await ack;
  });
  expect(captured).toEqual([original]);
  view.rerender(tree("thread-a"));
  expect(view.getByLabelText("Context target").textContent).toBe("thread-a");
  const newer = { ...original, text: "new" };
  await act(async () => {
    restoreComposerAppModelContextSnapshot(actualScope(), [newer]);
  });
  await act(async () => {
    acknowledge?.();
    await pending;
  });
  expect(readComposerAppModelContext(actualScope())).toEqual([newer]);
  await act(async () => {
    await actualContext().submit(async (attachments) => {
      expect(attachments).toEqual([newer]);
    });
  });
  expect(readComposerAppModelContext(actualScope())).toEqual([]);
  const retiredSubmit = actualContext().submit;
  view.unmount();
  disposeMaitaiStore(store);
  let deliveries = 0;
  await expect(
    retiredSubmit(async () => {
      deliveries += 1;
    }),
  ).rejects.toThrow();
  expect(deliveries).toBe(0);
});
