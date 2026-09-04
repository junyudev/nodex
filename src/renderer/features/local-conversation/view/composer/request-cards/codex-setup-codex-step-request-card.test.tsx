import { act, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vite-plus/test";
import { NodexTooltipProvider as TooltipProvider } from "@/components/ui/tooltip";
import { clearPersistedAtomStoreForTests } from "@/lib/persisted-atom-store";
import type { CodexCanonicalSetupCodexStepResponse, CodexSetupCodexStepRequest } from "@/lib/types";
import { renderWithMaitai } from "@/test/thread-maitai";
import { render, settleAsyncRender } from "@/test/dom";
import type { CodexSetupContextSource } from "../../../setup-codex-context-sources";
import {
  CodexSetupCodexStepRequestCard,
  CodexSetupContextRequestCardView,
} from "./codex-setup-codex-step-request-card";

function request(step: CodexSetupCodexStepRequest["step"]): CodexSetupCodexStepRequest {
  return {
    type: "setupCodexStep",
    requestId: `setup-${step}`,
    projectId: "project-1",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: `setup-${step}-item`,
    step,
    createdAt: 1,
  };
}

describe("CodexSetupCodexStepRequestCard", () => {
  beforeEach(() => {
    clearPersistedAtomStoreForTests();
  });

  test("maps shuffled role labels back to canonical ids before replying", async () => {
    const responses: CodexCanonicalSetupCodexStepResponse[] = [];
    const view = renderWithMaitai(
      <CodexSetupCodexStepRequestCard
        request={request("role")}
        onRespond={async (_requestId, response) => {
          responses.push(response);
        }}
      />,
    );
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(view.getByRole("checkbox", { name: "Engineering" }));
      await settleAsyncRender();
    });
    await act(async () => {
      fireEvent.click(view.getByText("Continue"));
      await settleAsyncRender();
    });

    expect(JSON.stringify(responses)).toBe(
      JSON.stringify([
        {
          step: "role",
          action: "submit",
          selectedRoles: ["engineering"],
        },
      ]),
    );
  });

  test("builds the exact first_task wrapper from persisted role suggestions", async () => {
    const roleView = renderWithMaitai(
      <CodexSetupCodexStepRequestCard
        request={request("role")}
        onRespond={async () => undefined}
      />,
    );
    await settleAsyncRender();
    await act(async () => {
      fireEvent.click(roleView.getByRole("checkbox", { name: "Engineering" }));
      await settleAsyncRender();
    });
    await act(async () => {
      fireEvent.click(roleView.getByText("Continue"));
      await settleAsyncRender();
    });
    roleView.unmount();

    const responses: CodexCanonicalSetupCodexStepResponse[] = [];
    const view = renderWithMaitai(
      <TooltipProvider>
        <CodexSetupCodexStepRequestCard
          request={request("task")}
          onRespond={async (_requestId, response) => {
            responses.push(response);
          }}
        />
      </TooltipProvider>,
    );
    await settleAsyncRender();

    expect(view.getByText("First task").textContent).toBe("First task");
    expect(view.getByText("Debug an issue").textContent).toBe("Debug an issue");
    await act(async () => {
      fireEvent.click(view.getByText("Debug an issue"));
      await settleAsyncRender();
    });

    expect(JSON.stringify(responses)).toBe(
      JSON.stringify([
        {
          step: "task",
          action: "submit",
          answers: { first_task: { answers: ["Debug an issue"] } },
        },
      ]),
    );
  });

  test("dedupes selected and connected context sources while clearing skip", async () => {
    const responses: CodexCanonicalSetupCodexStepResponse[] = [];
    const recommendedSources: CodexSetupContextSource[] = [
      {
        id: "slack",
        name: "Slack",
        description: "Read decisions and team context",
        logoUrl: null,
        logoUrlDark: null,
        connected: true,
      },
      {
        id: "notion",
        name: "Notion",
        description: "Read project docs",
        logoUrl: null,
        logoUrlDark: null,
        connected: false,
      },
    ];
    const view = render(
      <CodexSetupContextRequestCardView
        request={request("context")}
        recommendedSources={recommendedSources}
        browseSources={recommendedSources}
        onConnectSource={() => {}}
        onRespond={async (_requestId, response) => {
          responses.push(response);
        }}
      />,
    );
    await settleAsyncRender();

    await act(async () => {
      fireEvent.click(view.getByText("Connect"));
      await settleAsyncRender();
    });
    await act(async () => {
      fireEvent.click(view.getByText("Continue"));
      await settleAsyncRender();
    });
    await act(async () => {
      fireEvent.click(view.getByText("Skip"));
      await settleAsyncRender();
    });

    expect(JSON.stringify(responses)).toBe(
      JSON.stringify([
        { step: "context", action: "continue", selectedSources: ["notion", "slack"] },
        { step: "context", action: "skip", selectedSources: [] },
      ]),
    );
  });
});
