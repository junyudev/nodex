import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vite-plus/test";
import { NodexTooltipProvider } from "@/components/ui/tooltip";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { renderWithAppMaitai } from "@/test/app-maitai";
import { TestQueryProvider } from "@/test/query";
import { buildAppGitHubMediaUrl } from "../../../shared/app-protocol";
import type { GitHubMediaResult } from "../../../shared/github-media";
import { GitHubMarkdown } from "./github-thread-parts";

const thread = { host: "github.com", owner: "acme", repo: "web", number: 1 };
const imageUrl = "https://github.com/user-attachments/assets/23c3c624-f538-4f67-a100-bed566043a1f";
const signedImageUrl =
  "https://private-user-images.githubusercontent.com/123/456-23c3c624-f538-4f67-a100-bed566043a1f.png?jwt=sample.signature";
const videoUrl = "https://github.com/user-attachments/assets/7c423fbb-8d2a-402d-aeb2-584d5bcbc23a";
const missingUrl =
  "https://github.com/user-attachments/assets/08334b27-223e-4870-8167-f87b473834bd";

afterEach(() => vi.unstubAllGlobals());

test("GitHub Markdown displays capabilities and falls back to GitHub for unavailable media", async () => {
  const read = vi.fn(
    async (channel: string, input: { url: string }): Promise<GitHubMediaResult> => {
      if (channel !== "github:thread-media") throw new Error(`Unexpected query ${channel}`);
      if (input.url === imageUrl)
        return { status: "ready", kind: "image", url: buildAppGitHubMediaUrl("image") };
      if (input.url === videoUrl)
        return { status: "ready", kind: "video", url: buildAppGitHubMediaUrl("video") };
      return { status: "unavailable", reason: "not_found", message: null, retryAt: null };
    },
  );
  vi.stubGlobal("api", { invoke: read });
  const { container } = renderWithAppMaitai(
    <NodexTooltipProvider>
      <TestQueryProvider>
        <GitHubMarkdown
          thread={thread}
          markdown={`<img alt="Screenshot" src="${signedImageUrl}">\n\n${videoUrl}\n\n![Unavailable screenshot](${missingUrl})`}
        />
        <MarkdownRenderer content={`![Ordinary Markdown](${imageUrl})`} />
      </TestQueryProvider>
    </NodexTooltipProvider>,
  );

  const screenshot = await screen.findByRole("img", { name: "Screenshot" });
  const fallback = await screen.findByRole("link", { name: "Unavailable screenshot" });
  const recording = await screen.findByLabelText("GitHub attachment video");
  expect(screenshot.getAttribute("src")).toBe(buildAppGitHubMediaUrl("image"));
  expect(fallback.getAttribute("href")).toBe(missingUrl);
  expect(recording).toBeInstanceOf(HTMLVideoElement);
  expect(recording.hasAttribute("controls")).toBe(true);
  expect(recording.getAttribute("src")).toBe(buildAppGitHubMediaUrl("video"));
  expect(screen.getByRole("img", { name: "Ordinary Markdown" }).getAttribute("src")).toBe(imageUrl);
  expect(read).toHaveBeenCalledTimes(3);

  await act(async () => {
    fireEvent.error(recording);
    await Promise.resolve();
  });
  await waitFor(() => expect(container.querySelector("video")).toBeNull());
  expect(screen.getByRole("link", { name: "Open attachment on GitHub" }).getAttribute("href")).toBe(
    videoUrl,
  );
});
