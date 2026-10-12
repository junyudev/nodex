import { latexToHTMLString } from "@blocknote/math-block";
import { describe, expect, test } from "vite-plus/test";

describe("Equation rendering security", () => {
  test.each([false, true])(
    "rejects trusted TeX commands when settings metadata is polluted (external: %s)",
    (external) => {
      const original = Object.getOwnPropertyDescriptor(Object.prototype, "processor");
      let htmlString: string;
      try {
        Object.defineProperty(Object.prototype, "processor", {
          configurable: true,
          value: () => true,
        });
        ({ htmlString } = latexToHTMLString(
          String.raw`\href{javascript:alert(1)}{x} + \includegraphics{https://example.com/image.png}`,
          false,
          external,
        ));
      } finally {
        if (original) Object.defineProperty(Object.prototype, "processor", original);
        else Reflect.deleteProperty(Object.prototype, "processor");
      }

      const rendered = new DOMParser().parseFromString(htmlString, "text/html");
      expect(rendered.querySelector("math")).not.toBeNull();
      expect(rendered.querySelector("a, img, [href], [src]")).toBeNull();
    },
  );
});
