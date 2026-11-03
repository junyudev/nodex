import { fireEvent } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_PROJECT_APPEARANCE } from "../../../shared/project-appearance";
import { NodexHoverCard, NodexHoverCardProvider } from "@/components/ui/hover-card";
import { render, settleAsyncRender } from "@/test/dom";
import type { Project } from "@/lib/types";
import { ProjectHoverCard } from "./project-hover-card";

const PROJECT: Project = {
  id: "project-1",
  libraryId: "library-1",
  databaseId: "database-1",
  defaultDatabaseViewId: "view-1",
  lifecycle: "active",
  bindingRevision: 1,
  name: "Nodex",
  description: "",
  appearance: DEFAULT_PROJECT_APPEARANCE,
  sources: [{ root: "/Users/asc/repo/nodex", order: 0 }],
  primaryWorkspaceRoot: "/Users/asc/repo/nodex",
  pinned: false,
  pinnedOrder: null,
  created: new Date(0),
  updated: new Date(0),
};

describe("ProjectHoverCard", () => {
  it("keeps every card action outside the owning Project row activation", async () => {
    const onParentClick = vi.fn();
    const onSetPinned = vi.fn(async () => undefined);
    const onOpenSource = vi.fn();
    const onEdit = vi.fn();
    const view = render(
      <div onClick={onParentClick}>
        <ProjectHoverCard
          project={PROJECT}
          activity={{
            projectId: PROJECT.id,
            taskCount: 66,
            waitingCount: 0,
            unreadCount: 0,
            activeCount: 1,
          }}
          repositoryIdentity={{
            repositoryRoot: PROJECT.primaryWorkspaceRoot!,
            ownerRepo: { owner: "acme", repo: "nodex" },
          }}
          pathContext={{ homeDirectory: "/Users/asc", separator: "/" }}
          onAppearanceChange={vi.fn()}
          onRename={vi.fn(async () => undefined)}
          onSetPinned={onSetPinned}
          onOpenSource={onOpenSource}
          onEdit={onEdit}
        />
      </div>,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Pin project" }));
      fireEvent.click(view.getByRole("button", { name: "~/repo/nodex" }));
      fireEvent.click(view.getByRole("button", { name: "Edit project" }));
      fireEvent.click(view.getByRole("button", { name: "Change marker for Nodex" }));
      await settleAsyncRender();
    });

    expect(onSetPinned).toHaveBeenCalledWith(true);
    expect(onOpenSource).toHaveBeenCalledWith("/Users/asc/repo/nodex");
    expect(onEdit).toHaveBeenCalledOnce();
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it("keeps an active rename draft and uses the current Project name after cancellation", async () => {
    const card = (name: string) => (
      <ProjectHoverCard
        project={{ ...PROJECT, name }}
        activity={null}
        repositoryIdentity={null}
        pathContext={null}
        onAppearanceChange={() => undefined}
        onRename={async () => undefined}
        onOpenSource={() => undefined}
        onEdit={() => undefined}
      />
    );
    const view = render(card("Nodex"));
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Nodex" }));
      await Promise.resolve();
    });
    const input = view.getByRole("textbox", { name: "Project name" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "Local draft" } });
      await Promise.resolve();
    });
    view.rerender(card("Remote rename"));
    expect(input).toHaveProperty("value", "Local draft");
    await act(async () => {
      fireEvent.keyDown(input, { key: "Escape" });
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Remote rename" }));
      await Promise.resolve();
    });
    expect(view.getByRole("textbox", { name: "Project name" })).toHaveProperty(
      "value",
      "Remote rename",
    );
  });

  it("commits a trimmed inline rename and cancels Escape", async () => {
    const onRename = vi.fn(async () => undefined);
    const view = render(
      <ProjectHoverCard
        project={PROJECT}
        activity={null}
        repositoryIdentity={null}
        pathContext={null}
        onAppearanceChange={vi.fn()}
        onRename={onRename}
        onOpenSource={vi.fn()}
        onEdit={vi.fn()}
      />,
    );

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Nodex" }));
      await settleAsyncRender();
    });
    const input = view.getByRole("textbox", { name: "Project name" });
    await act(async () => {
      fireEvent.change(input, { target: { value: "  Nodex Next  " } });
      fireEvent.blur(input);
      await settleAsyncRender();
    });
    expect(onRename).toHaveBeenCalledWith("Nodex Next");

    await act(async () => {
      fireEvent.click(view.getByRole("button", { name: "Nodex" }));
      await settleAsyncRender();
    });
    const cancelInput = view.getByRole("textbox", { name: "Project name" });
    await act(async () => {
      fireEvent.change(cancelInput, { target: { value: "Discard me" } });
      fireEvent.keyDown(cancelInput, { key: "Escape" });
      await settleAsyncRender();
    });
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it("closes the nested picker before the outer card on consecutive Escapes", async () => {
    const view = render(
      <NodexHoverCardProvider>
        <NodexHoverCard
          ariaLabel="Project details"
          defaultOpen
          hoverCardContent={
            <ProjectHoverCard
              project={PROJECT}
              activity={undefined}
              repositoryIdentity={null}
              pathContext={null}
              onAppearanceChange={vi.fn()}
              onRename={vi.fn(async () => undefined)}
              onOpenSource={vi.fn()}
              onEdit={vi.fn()}
            />
          }
        >
          <button type="button">Project row</button>
        </NodexHoverCard>
      </NodexHoverCardProvider>,
    );

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: "Change marker for Nodex",
        }),
      );
      await settleAsyncRender();
    });
    const picker = view.getByRole("dialog", {
      name: "Project marker for Nodex",
    });
    expect(view.getByRole("dialog", { name: "Project details" })).toBeTruthy();

    await act(async () => {
      fireEvent.keyDown(picker, { key: "Escape" });
      await settleAsyncRender();
    });
    expect(
      view.queryByRole("dialog", {
        name: "Project marker for Nodex",
      }),
    ).toBeNull();
    const outer = view.getByRole("dialog", { name: "Project details" });

    await act(async () => {
      fireEvent.keyDown(outer, { key: "Escape" });
      await settleAsyncRender();
    });
    expect(view.queryByRole("dialog", { name: "Project details" })).toBeNull();
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Project row" }));
  });

  it("keeps the outer card open when Done closes the nested picker", async () => {
    const view = render(
      <NodexHoverCardProvider>
        <NodexHoverCard
          ariaLabel="Project details"
          defaultOpen
          hoverCardContent={
            <ProjectHoverCard
              project={PROJECT}
              activity={null}
              repositoryIdentity={null}
              pathContext={null}
              onAppearanceChange={vi.fn()}
              onRename={vi.fn(async () => undefined)}
              onOpenSource={vi.fn()}
              onEdit={vi.fn()}
            />
          }
        >
          <button type="button">Project row</button>
        </NodexHoverCard>
      </NodexHoverCardProvider>,
    );

    await act(async () => {
      fireEvent.click(
        view.getByRole("button", {
          name: "Change marker for Nodex",
        }),
      );
      await settleAsyncRender();
      fireEvent.click(view.getByRole("button", { name: "Done" }));
      await settleAsyncRender();
    });

    expect(
      view.queryByRole("dialog", {
        name: "Project marker for Nodex",
      }),
    ).toBeNull();
    expect(view.getByRole("dialog", { name: "Project details" })).toBeTruthy();
  });
});
