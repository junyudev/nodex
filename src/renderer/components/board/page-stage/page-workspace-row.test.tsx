import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { act, fireEvent, screen } from "@testing-library/react";
import { render } from "@/test/dom";
import { PageWorkspaceRow } from "./page-workspace-row";
const boundary = vi.hoisted(() => ({ data: null as unknown, open: vi.fn(), copy: vi.fn() }));
vi.mock("@/lib/page-workspace-runtime", () => ({
  usePageWorkspace: () => ({ data: boundary.data }),
}));
vi.mock("@/lib/file-system-operations", () => ({ openExternalUrl: boundary.open }));
vi.mock("@/lib/clipboard", () => ({ writeTextToClipboard: boundary.copy }));
const thread = (kind: "pull_request" | "issue", number: number) => ({
  id: `github:${kind}:${number}`,
  host: "github.com",
  repository_id: "1",
  repository: "acme/repo",
  number,
  kind,
  url: `https://github.com/acme/repo/${kind === "issue" ? "issues" : "pull"}/${number}`,
  title: `Thread ${number}`,
  state: "open",
});
const click = async (element: HTMLElement) => {
  await act(async () => {
    fireEvent.click(element);
    await Promise.resolve();
  });
};
beforeEach(() => {
  boundary.open.mockReset().mockResolvedValue(true);
  boundary.copy.mockReset().mockResolvedValue(true);
});
describe("where a Page's code lives", () => {
  test("a pull request makes the row GitHub, with the branch kept out of the line", async () => {
    boundary.data = {
      workspace: { branch_name: "nodex-12-fix-login" },
      pull_request: { number: 42, url: "https://github.com/acme/repo/pull/42", state: "OPEN" },
      follows: [
        { role: "own_pr", thread: thread("pull_request", 42) },
        { role: "origin", thread: thread("issue", 14) },
      ],
    };
    render(<PageWorkspaceRow pageId="page" />);
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByText("Branch")).toBeNull();
    expect(screen.queryByText("nodex-12-fix-login")).toBeNull();
    expect(screen.queryByText(/Following/u)).toBeNull();
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual([
      "PR #42 · Open",
      "Issue #14",
    ]);
    await click(screen.getByRole("link", { name: "PR #42 · Open" }));
    expect(boundary.open).toHaveBeenCalledWith("https://github.com/acme/repo/pull/42");
    await click(screen.getByRole("button", { name: "Copy branch name" }));
    expect(boundary.copy).toHaveBeenCalledWith("nodex-12-fix-login");
  });

  test("followed threads alone need no checkout", () => {
    boundary.data = {
      workspace: null,
      pull_request: null,
      follows: [
        { role: "context", thread: thread("pull_request", 7) },
        { role: "origin", thread: thread("issue", 9) },
      ],
    };
    render(<PageWorkspaceRow pageId="page" />);
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByRole("link", { name: "PR #7" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Issue #9" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Copy branch name" })).toBeNull();
  });

  test("a checkout alone shows its branch", () => {
    boundary.data = { workspace: { branch_name: "nodex-12-fix-login" }, pull_request: null };
    render(<PageWorkspaceRow pageId="page" />);
    expect(screen.getByText("Branch")).toBeTruthy();
    expect(screen.getByText("nodex-12-fix-login")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy branch name" })).toBeTruthy();
  });

  test("omits the row before a Workspace is allocated", () => {
    boundary.data = { workspace: null, pull_request: null };
    const view = render(<PageWorkspaceRow pageId="page" />);
    expect(view.container.childElementCount).toBe(0);
  });
});
