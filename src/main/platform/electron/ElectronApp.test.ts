import { expect, test, vi } from "vite-plus/test";
import type { WebContents } from "electron";
import { selectMainClientCertificate } from "./ElectronApp";

test("background net requests continue without disclosing a client certificate", () => {
  const preventDefault = vi.fn();
  const callback = vi.fn();
  selectMainClientCertificate({ preventDefault }, null, "https://example.test", [], callback);
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(callback.mock.calls).toEqual([[]]);
});

test("Browser requests retain their existing certificate behavior", () => {
  const preventDefault = vi.fn();
  const callback = vi.fn();
  selectMainClientCertificate(
    { preventDefault },
    {} as WebContents,
    "https://example.test",
    [],
    callback,
  );
  expect(preventDefault).not.toHaveBeenCalled();
  expect(callback).not.toHaveBeenCalled();
});
