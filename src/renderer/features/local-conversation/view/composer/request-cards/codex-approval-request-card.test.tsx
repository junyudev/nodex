import { describe, expect, test } from "vite-plus/test";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import { act, fireEvent } from "@testing-library/react";
import { render, settleAsyncRender, textContent } from "@/test/dom";
import type { CodexApprovalRequest, CodexConversationItem } from "@/lib/types";
import { buildCodexFileChangeMap } from "../../../../../../shared/codex-file-change";
import { CodexApprovalRequestCard } from "./codex-approval-request-card";

const approvalRequest: CodexApprovalRequest = {
  type: "approval",
  requestId: "approval_1",
  kind: "command",
  projectId: "project_1",
  threadId: "thread_1",
  turnId: "turn_1",
  itemId: "item_1",
  approvalReason:
    "Do you want to let me restage the thread Storybook files and verify the index state before committing?",
  reason:
    "Do you want to let me restage the thread Storybook files and verify the index state before committing?",
  command: "git add docs/FRONTEND.md && git status --short",
  cwd: "/workspace/nodex",
  cmd: ["git", "add"],
  proposedExecpolicyAmendment: ["git", "add"],
  createdAt: 1,
};

describe("CodexApprovalRequestCard", () => {
  test("honors a native deny default when submitted without changing the selection", async () => {
    const responses: unknown[] = [];
    const view = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={{
            ...approvalRequest,
            defaultToNo: true,
            availableDecisions: ["accept", "decline"],
          }}
          onRespond={async (_id, response) => {
            responses.push(response);
          }}
        />
      </TooltipProvider>,
    );
    expect(view.getByRole("radio", { name: "No" }).getAttribute("aria-checked")).toBe("true");
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Submit/ }));
      await Promise.resolve();
    });
    expect(responses).toEqual([{ kind: "command", decision: "decline" }]);
  });

  test("suppresses session and permanent permission rules when the native request forbids them", async () => {
    const responses: unknown[] = [];
    const view = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={{ ...approvalRequest, suppressAlwaysAllowRule: true }}
          onRespond={async (_id, response) => {
            responses.push(response);
          }}
        />
      </TooltipProvider>,
    );
    expect(view.getAllByRole("radio")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: /Submit/ }));
      await Promise.resolve();
    });
    expect(responses).toEqual([{ kind: "command", decision: "accept" }]);
  });

  test("offers only decisions supported by the request's runtime", async () => {
    const responses: unknown[] = [];
    const view = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={{ ...approvalRequest, availableDecisions: ["accept", "decline"] }}
          onRespond={async (_id, response) => {
            responses.push(response);
          }}
          onSubmitLocalFollowup={async () => {}}
        />
      </TooltipProvider>,
    );
    expect(view.getAllByRole("radio")).toHaveLength(1);
    await act(async () => {
      fireEvent.click(view.getByRole("radio", { name: "Yes" }));
      fireEvent.click(view.getByRole("button", { name: /Submit/ }));
      await Promise.resolve();
    });
    expect(responses).toEqual([{ kind: "command", decision: "accept" }]);
  });

  test("renders the codex approval shell with command preview and skip action", async () => {
    const { container } = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={approvalRequest}
          onRespond={async () => {}}
          onSubmitLocalFollowup={async () => {}}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    const rendered = textContent(container);
    expect(
      Boolean(
        rendered.includes(
          "Do you want to let me restage the thread Storybook files and verify the index state before committing?",
        ),
      ),
    ).toBe(true);
    expect(Boolean(rendered.includes("git add docs/FRONTEND.md && git status --short"))).toBe(true);
    expect(Boolean(rendered.includes("in /workspace/nodex"))).toBe(false);
    expect(Boolean(rendered.includes("Yes"))).toBe(true);
    expect(
      Boolean(rendered.includes("Yes, and don't ask again for commands that start with")),
    ).toBe(true);
    expect(Boolean(rendered.includes("No, and tell Nodex what to do differently"))).toBe(true);
    expect(Boolean(rendered.includes("Skip"))).toBe(true);
    expect(Boolean(rendered.includes("Submit"))).toBe(true);
    expect(container.querySelector(".request-input-panel__inline-freeform")).not.toBeNull();
    expect(container.querySelector(".rounded-2xl.border.backdrop-blur-sm")).not.toBeNull();
  });

  test("renders command approval previews from command action commands before raw command text", async () => {
    const actionRequest: CodexApprovalRequest = {
      ...approvalRequest,
      approvalReason: undefined,
      reason: undefined,
      command: "bash -lc 'cat package.json'",
      cmd: ["legacy", "fallback"],
      commandActions: [
        { type: "read", command: "cat package.json", name: "package.json", path: "package.json" },
        { type: "search", command: "rg TODO src", query: "TODO", path: "src" },
      ],
    };

    const { container } = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={actionRequest}
          onRespond={async () => {}}
          onSubmitLocalFollowup={async () => {}}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    const rendered = textContent(container);
    expect(Boolean(rendered.includes("Do you want to run this command?"))).toBe(true);
    expect(Boolean(rendered.includes("cat package.json && rg TODO src"))).toBe(true);
    expect(Boolean(rendered.includes("bash -lc"))).toBe(false);
    expect(Boolean(rendered.includes("legacy fallback"))).toBe(false);
  });

  test("renders command approval previews from execpolicy amendment fallback", async () => {
    const amendmentRequest: CodexApprovalRequest = {
      ...approvalRequest,
      approvalReason: undefined,
      reason: undefined,
      command: undefined,
      cmd: undefined,
      proposedExecpolicyAmendment: ["git", "commit", "-m", "hello world"],
    };

    const { container } = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={amendmentRequest}
          onRespond={async () => {}}
          onSubmitLocalFollowup={async () => {}}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    const rendered = textContent(container);
    expect(Boolean(rendered.includes('git commit -m "hello world"'))).toBe(true);
  });

  test("renders network approval reason without a command preview", async () => {
    const networkRequest: CodexApprovalRequest = {
      ...approvalRequest,
      approvalReason: undefined,
      reason: undefined,
      command: undefined,
      cmd: undefined,
      proposedExecpolicyAmendment: undefined,
      networkApprovalContext: {
        host: "api.example.com",
        protocol: "https",
      },
      proposedNetworkPolicyAmendments: [{ host: "api.example.com", action: "allow" }],
    };

    const { container } = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={networkRequest}
          onRespond={async () => {}}
          onSubmitLocalFollowup={async () => {}}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    const rendered = textContent(container);
    expect(
      Boolean(rendered.includes('Do you want to approve network access to "api.example.com"?')),
    ).toBe(true);
    expect(
      Boolean(rendered.includes("Reason: api.example.com isn't on the current network allowlist")),
    ).toBe(true);
    expect(Boolean(rendered.includes("Yes, and allow this host in the future"))).toBe(true);
    expect(Boolean(rendered.includes("git add docs/FRONTEND.md"))).toBe(false);
  });

  test("renders a background actor inline in the prompt instead of as a separate header", async () => {
    const backgroundApprovalRequest: CodexApprovalRequest = {
      ...approvalRequest,
      approvalReason: undefined,
      reason: undefined,
    };

    const { container } = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={backgroundApprovalRequest}
          actorName="Worker 1"
          approvalQuestionActor={<span className="font-medium">Worker 1</span>}
          onRespond={async () => {}}
          onSubmitLocalFollowup={async () => {}}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    const rendered = textContent(container);
    expect(Boolean(rendered.includes("Do you want Worker 1 to run this command?"))).toBe(true);
    expect(Boolean(rendered.includes("Worker 1Worker 1"))).toBe(false);
  });

  test("maps approval submit and skip actions to distinct response paths", async () => {
    const numericRequest: CodexApprovalRequest = {
      ...approvalRequest,
      requestId: 73,
    };
    const decisions: string[] = [];
    const requestIds: CodexApprovalRequest["requestId"][] = [];
    const { container, getByText } = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={numericRequest}
          onRespond={async (requestId, response) => {
            requestIds.push(requestId);
            decisions.push(
              typeof response.decision === "string"
                ? response.decision
                : JSON.stringify(response.decision),
            );
          }}
          onSubmitLocalFollowup={async () => {}}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();
    const form = container.querySelector("form");
    if (!(form instanceof HTMLFormElement)) {
      throw new Error("Expected approval form.");
    }

    await act(async () => {
      fireEvent.click(getByText("Yes"));
      fireEvent.submit(form);
      await settleAsyncRender();
    });

    expect(decisions[0]).toBe("accept");
    expect(requestIds[0]).toBe(73);

    await act(async () => {
      fireEvent.click(getByText("Skip"));
      await settleAsyncRender();
    });

    expect(decisions[1]).toBe("decline");
    expect(requestIds[1]).toBe(73);
  });

  test("renders file approval previews from the shared path-keyed patch model", async () => {
    const fileRequest: CodexApprovalRequest = {
      ...approvalRequest,
      kind: "file",
      itemId: "patch-1",
      approvalReason: undefined,
      reason: undefined,
      command: undefined,
      cmd: undefined,
      proposedExecpolicyAmendment: undefined,
      grantRoot: "/workspace/nodex",
    };
    const requestItem: CodexConversationItem = {
      threadId: "thread_1",
      turnId: "turn_1",
      itemId: "patch-1",
      entryId: "patch-1",
      type: "file_change",
      kind: "fileChange",
      semanticKind: "patch",
      status: "inProgress",
      approvalRequestId: "approval_1",
      fileChange: {
        changes: buildCodexFileChangeMap([
          { type: "add", path: "src/app.ts", content: "export const app = true;\n" },
          {
            type: "update",
            path: "src/app.ts",
            movePath: null,
            unifiedDiff: [
              "@@ -1,1 +1,2 @@",
              "-export const app = false;",
              "+export const app = true;",
              "+export const ready = true;",
            ].join("\n"),
          },
        ]),
      },
      createdAt: 1,
      updatedAt: 1,
    };

    const { container } = render(
      <TooltipProvider>
        <CodexApprovalRequestCard
          request={fileRequest}
          requestItem={requestItem}
          onRespond={async () => {}}
          onSubmitLocalFollowup={async () => {}}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    const rendered = textContent(container);
    expect(Boolean(rendered.includes("Do you want to make these changes?"))).toBe(true);
    expect(Boolean(rendered.includes("src/app.ts"))).toBe(true);
    expect(rendered.split("src/app.ts").length - 1).toBe(1);
    expect(Boolean(rendered.includes("+2 -1"))).toBe(true);
    expect(Boolean(rendered.includes("+1 -0"))).toBe(false);
  });
});
