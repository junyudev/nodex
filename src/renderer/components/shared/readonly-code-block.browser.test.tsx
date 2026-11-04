import { act, waitFor } from "@testing-library/react";
import { describe, expect, test, vi } from "vite-plus/test";
import "@/globals.css";
import { ReadonlyCodeBlock } from "./readonly-code-block";
import { MAX_WORKER_CODE_UNITS } from "@/lib/markdown/markdown-code-highlight-queue";
import { NfmDocument } from "@/components/board/nfm-renderer";
import { MarkdownRenderer } from "@/features/local-conversation/view/shared/markdown/markdown-renderer";
import { readMarkdown } from "../../../shared/nodex-markdown";
import { renderWithAppMaitai as render } from "@/test/app-maitai";
import { contrastRatio, getPaintedBackground, parseComputedColor } from "@/test/color-contrast";
import {
  applyRendererThemeForTest,
  installRendererThemeFixture,
  readRendererThemeColor,
} from "@/test/renderer-theme";

installRendererThemeFixture();

// Whitespace and `&&` take the theme's ordinary foreground, which is the first token to vanish
// when a light color is painted on the dark surface.
const source = "```bash\nbrew install --cask qlvideo && qlmanage -r cache\n```";

const surfaces = {
  "assistant thread": () => <MarkdownRenderer content={source} dialect="conversation" />,
  "user message": () => <NfmDocument blocks={readMarkdown(source)} density="message" />,
};

describe.each(["light", "dark"] as const)("read-only code in the %s scheme", (theme) => {
  test.each(Object.keys(surfaces) as (keyof typeof surfaces)[])(
    "keeps every %s token legible against the composited surface",
    async (surface) => {
      applyRendererThemeForTest(theme);
      const Subject = surfaces[surface];
      const view = render(
        <div style={{ background: "var(--background)" }}>
          <Subject />
        </div>,
      );
      try {
        const block = view.container.querySelector<HTMLElement>("[data-readonly-code-block]")!;
        const tokens = await waitFor(() => {
          const rendered = [...block.querySelectorAll<HTMLElement>("code > span > span")];
          if (rendered.length < 2) throw new Error("Shiki tokens did not render");
          return rendered;
        });
        const background = getPaintedBackground(block);
        const ratios = tokens.map((token) => ({
          text: token.textContent,
          ratio: contrastRatio(parseComputedColor(getComputedStyle(token).color), background),
        }));

        expect(
          Math.min(...ratios.map(({ ratio }) => ratio)),
          `${theme} ${surface} contrast: ${JSON.stringify(ratios)}`,
        ).toBeGreaterThanOrEqual(4.5);
      } finally {
        view.unmount();
      }
    },
  );
});

test.each(["light", "dark"] as const)(
  "conversation code reads in the shared %s Code palette",
  async (theme) => {
    applyRendererThemeForTest(theme);
    const view = render(
      <MarkdownRenderer
        content={'```json\n{ "name": "nodex", "count": 2 }\n```'}
        dialect="conversation"
      />,
    );
    try {
      const color = (text: string) => {
        const token = [
          ...view.container.querySelectorAll<HTMLElement>(
            "[data-readonly-code-block] code span span",
          ),
        ].find((candidate) => candidate.textContent?.includes(text));
        if (!token) throw new Error(`No token for ${text}`);
        return getComputedStyle(token).color;
      };
      await waitFor(() => {
        expect(color("name")).toBe(readRendererThemeColor("--color-codex-syntax-attribute"));
        expect(color("nodex")).toBe(readRendererThemeColor("--color-codex-syntax-string"));
        expect(color("2")).toBe(readRendererThemeColor("--color-codex-syntax-literal"));
      });
    } finally {
      view.unmount();
    }
  },
);

test("one Wrap toggle rewraps every read-only code block without changing its source", async () => {
  const line = `const values = [${Array.from({ length: 40 }, (_, index) => index).join(", ")}];`;
  const fence = (value: string) => `\`\`\`ts\n${value}\n\`\`\``;
  const view = render(
    <div style={{ width: 360 }}>
      <MarkdownRenderer content={`${fence(line)}\n\n${fence(`${line} // second`)}`} />
    </div>,
  );
  const blocks = () => [
    ...view.container.querySelectorAll<HTMLElement>("[data-readonly-code-block]"),
  ];
  const overflows = (block: HTMLElement) => {
    const pre = block.querySelector("pre")!;
    return pre.scrollWidth > pre.clientWidth;
  };
  const toggle = async () => {
    const button = blocks()[0]!.querySelector<HTMLButtonElement>(
      '[data-code-block-action="wrap"]',
    )!;
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  };
  try {
    await waitFor(() => expect(blocks()).toHaveLength(2));
    expect(blocks().every(overflows)).toBe(true);
    const sources = blocks().map((block) => block.querySelector("code")!.textContent);

    await toggle();
    await waitFor(() => expect(blocks().some(overflows)).toBe(false));
    for (const block of blocks()) {
      const wrap = block.querySelector('[data-code-block-action="wrap"]')!;
      expect(wrap.getAttribute("aria-pressed")).toBe("true");
      expect(wrap.getAttribute("aria-label")).toBe("Disable word wrap");
    }
    expect(blocks().map((block) => block.querySelector("code")!.textContent)).toEqual(sources);

    await toggle();
    await waitFor(() => expect(blocks().every(overflows)).toBe(true));
  } finally {
    view.unmount();
  }
});

const blockCode = (container: ParentNode) => container.querySelector<HTMLElement>("figure code")!;
const tokenPaint = (code: HTMLElement) => code.querySelector<HTMLElement>("span > span");
const waitForTokens = (code: HTMLElement) => waitFor(() => expect(tokenPaint(code)).not.toBeNull());

test("conversation code first requests tokens near the viewport", async () => {
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const content = 'const nearViewport = "ready";';
  const view = render(
    <div style={{ paddingTop: window.innerHeight + 1_500 }}>
      <MarkdownRenderer content={"```ts\n" + content + "\n```"} dialect="conversation" />
    </div>,
  );
  try {
    const code = await waitFor(() => {
      const element = blockCode(view.container);
      expect(element?.textContent).toBe(content);
      return element;
    });
    await act(async () => {
      await new Promise<void>((resolve) => {
        const observer = new IntersectionObserver(
          () => {
            observer.disconnect();
            resolve();
          },
          { rootMargin: "600px 0px" },
        );
        observer.observe(code);
      });
    });
    expect(code.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight + 600);
    expect(post).not.toHaveBeenCalled();
    expect(tokenPaint(code)).toBeNull();

    await act(async () => {
      code.scrollIntoView();
    });
    await waitForTokens(code);
    expect(post).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: content }));
  } finally {
    view.unmount();
    post.mockRestore();
  }
});

test("streaming retains matching tokens, repaints for theme, and discards rewritten or retyped code", async () => {
  applyRendererThemeForTest("light");
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const code = 'const prefix = "value";';
  const suffix = "\n  console.log(prefix);";
  const view = render(<ReadonlyCodeBlock code={code} language="ts" incomplete />);
  const displayed = blockCode(view.container);
  try {
    await waitForTokens(displayed);
    const colored = tokenPaint(displayed)!;
    const light = getComputedStyle(colored).color;
    const requests = post.mock.calls.length;
    applyRendererThemeForTest("dark");
    expect(tokenPaint(displayed)).toBe(colored);
    expect(getComputedStyle(colored).color).not.toBe(light);
    expect(post).toHaveBeenCalledTimes(requests);

    view.rerender(<ReadonlyCodeBlock code={code + suffix} language="ts" incomplete />);
    expect(displayed.textContent).toBe(code + suffix);
    expect(tokenPaint(displayed)).toBe(colored);
    expect(colored.parentElement?.lastChild).toMatchObject({ nodeValue: suffix });

    const rewritten = "let rewritten = 7;";
    view.rerender(<ReadonlyCodeBlock code={rewritten} language="ts" />);
    expect(displayed.textContent).toBe(rewritten);
    expect(tokenPaint(displayed)).toBeNull();
    await waitForTokens(displayed);

    view.rerender(<ReadonlyCodeBlock code={rewritten} language="bash" />);
    expect(displayed.textContent).toBe(rewritten);
    expect(tokenPaint(displayed)).toBeNull();
    await waitForTokens(displayed);
    expect(post).toHaveBeenLastCalledWith(expect.objectContaining({ language: "bash" }));
  } finally {
    view.unmount();
    post.mockRestore();
  }
});

test("plain and oversized blocks skip the worker and Copy preserves the source", async () => {
  const post = vi.spyOn(Worker.prototype, "postMessage");
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  const writeText = vi.fn(async () => undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  const source = "  first\n\tsecond\n";
  const view = render(
    <>
      <ReadonlyCodeBlock code={source} language="made-up" />
      <ReadonlyCodeBlock code={"x".repeat(MAX_WORKER_CODE_UNITS + 1)} language="ts" />
      <ReadonlyCodeBlock code="plain" language="plaintext" incomplete />
    </>,
  );
  try {
    const [copy, , disabled] = view.getAllByRole("button", { name: "Copy code to clipboard" });
    expect(disabled).toBeDisabled();
    await act(async () => copy!.click());
    expect(writeText).toHaveBeenCalledExactlyOnceWith(source);
    expect(blockCode(view.container).textContent).toBe(source);
    expect(post).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    post.mockRestore();
    if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
    else Reflect.deleteProperty(navigator, "clipboard");
  }
});

test("worker failure leaves text readable and falls back for a small visible block", async () => {
  const post = vi.spyOn(Worker.prototype, "postMessage").mockImplementationOnce(() => {
    throw new DOMException("Worker unavailable", "InvalidStateError");
  });
  const source = 'const useFallback = "small snippet";';
  const view = render(<ReadonlyCodeBlock code={source} language="ts" />);
  try {
    const code = blockCode(view.container);
    expect(code.textContent).toBe(source);
    expect(tokenPaint(code)).toBeNull();
    await waitForTokens(code);
    expect(code.textContent).toBe(source);
    expect(post).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
    post.mockRestore();
  }
});
