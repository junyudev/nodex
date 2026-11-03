import { describe, expect, test } from "vite-plus/test";
import { act, fireEvent } from "@testing-library/react";
import type { CodexMcpServerElicitationRequest } from "@/lib/types";
import { render, settleAsyncRender, textContent } from "@/test/dom";
import { CodexMcpElicitationRequestCard } from "./codex-mcp-elicitation-request-card";

const mcpRequest: CodexMcpServerElicitationRequest = {
  type: "mcpServerElicitation",
  requestId: "mcp_1",
  projectId: "project_1",
  threadId: "thread_1",
  turnId: "turn_1",
  itemId: "item_1",
  kind: "generic",
  serverName: "Context7",
  mode: "openai/form",
  message: "Context7 wants to collect extra arguments.",
  requestedSchema: {
    type: "object",
    required: ["library"],
    properties: {
      library: {
        type: "string",
        title: "Library",
      },
    },
  },
  createdAt: 1,
};

describe("CodexMcpElicitationRequestCard", () => {
  test("renders MCP form requests and submits accepted content", async () => {
    const responses: string[] = [];
    const { container, getByLabelText } = render(
      <CodexMcpElicitationRequestCard
        request={mcpRequest}
        onRespond={async (_requestId, response) => {
          responses.push(JSON.stringify(response));
        }}
      />,
    );
    await settleAsyncRender();

    expect(Boolean(textContent(container).includes("Context7"))).toBe(true);
    expect(Boolean(textContent(container).includes("Context7 requests information"))).toBe(true);

    const form = container.querySelector("form");
    if (!form) throw new Error("expected MCP form");

    await act(async () => {
      fireEvent.submit(form);
      await settleAsyncRender();
    });
    expect(Boolean(textContent(container).includes("Complete this field to continue"))).toBe(true);

    const libraryInput = getByLabelText("Library") as HTMLInputElement;
    await act(async () => {
      fireEvent.input(libraryInput, { target: { value: "react" } });
      await settleAsyncRender();
    });
    expect(libraryInput.value).toBe("react");
    await act(async () => {
      fireEvent.submit(form);
      await settleAsyncRender();
    });

    expect(responses[0]).toBe(
      JSON.stringify({
        action: "accept",
        content: {
          library: "react",
        },
        _meta: null,
      }),
    );
  });

  test("discards a previous request's draft and validation when the request changes", async () => {
    const onRespond = async () => {};
    const view = render(
      <CodexMcpElicitationRequestCard request={mcpRequest} onRespond={onRespond} />,
    );
    const input = view.getByLabelText("Library") as HTMLInputElement;
    await act(async () => {
      fireEvent.input(input, { target: { value: "react" } });
    });
    expect(input.value).toBe("react");
    await act(async () => {
      view.rerender(
        <CodexMcpElicitationRequestCard
          request={{ ...mcpRequest, requestId: "mcp_2" }}
          onRespond={onRespond}
        />,
      );
    });
    expect((view.getByLabelText("Library") as HTMLInputElement).value).toBe("");
    expect(view.queryByText("Complete this field to continue")).toBeNull();
  });

  test("keeps compact URL requests on open/cancel actions", async () => {
    const responses: string[] = [];
    const originalOpen = window.open;
    window.open = (() => null) as typeof window.open;
    try {
      const { getByText } = render(
        <CodexMcpElicitationRequestCard
          request={{
            ...mcpRequest,
            mode: "url",
            kind: "toolSuggestion",
            url: "https://example.test/connect",
            elicitationId: "elicitation-1",
            requestedSchema: undefined,
          }}
          onRespond={async (_requestId, response) => {
            responses.push(response.action);
          }}
        />,
      );
      await settleAsyncRender();

      await act(async () => {
        fireEvent.click(getByText("Cancel"));
        await settleAsyncRender();
      });
      await act(async () => {
        fireEvent.click(getByText("Open"));
        await settleAsyncRender();
      });

      expect(responses[0]).toBe("decline");
      expect(responses[1]).toBe("accept");
    } finally {
      window.open = originalOpen;
    }
  });
});
