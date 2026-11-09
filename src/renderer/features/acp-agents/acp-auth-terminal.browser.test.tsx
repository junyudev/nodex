import { render } from "@testing-library/react";
import { expect, test, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import AcpAuthTerminal from "./acp-auth-terminal";

import "@/globals.css";
import "@xterm/xterm/css/xterm.css";

test("shows the sign-in command's output as it grows and sends what is typed to it", async () => {
  const onInput = vi.fn<(data: string) => void>();
  const onResize = vi.fn<(size: { cols: number; rows: number }) => void>();
  const ports = { onInput, onResize };
  const view = render(<AcpAuthTerminal output="Code: " outputOffset={6} {...ports} />);
  const shown = () =>
    view.getByRole("group", { name: "Sign-in terminal" }).querySelector(".xterm-rows")
      ?.textContent ?? "";
  try {
    await expect.poll(shown).toContain("Code:");
    // The command's PTY takes the size the terminal fits to.
    const [size] = onResize.mock.calls.at(-1)!;
    expect(size.cols).toBeGreaterThan(0);
    expect(size.rows).toBeGreaterThan(0);

    // Output after what the terminal already shows is appended.
    view.rerender(
      <AcpAuthTerminal output={"Code: ABCD\r\nWaiting"} outputOffset={19} {...ports} />,
    );
    await expect.poll(shown).toContain("Waiting");
    expect(shown()).toContain("Code: ABCD");

    // A gap the Runtime no longer holds redraws the terminal from the output it kept.
    view.rerender(<AcpAuthTerminal output="Signed in" outputOffset={120} {...ports} />);
    await expect.poll(shown).toContain("Signed in");
    expect(shown()).not.toContain("Waiting");

    await userEvent.keyboard("y");
    await expect.poll(() => onInput.mock.calls).toEqual([["y"]]);
  } finally {
    view.unmount();
  }
});
