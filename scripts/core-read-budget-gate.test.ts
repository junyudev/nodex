import { expect, test } from "vite-plus/test";
import { verifyReadBudgetTestResult } from "./core-read-budget-gate";

test("accepts exactly one executed read-budget test after fixture diagnostics", () => {
  expect(() =>
    verifyReadBudgetTestResult(
      "integrity_check: ok\ntest result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 839 filtered out; finished in 1.00s\n",
    ),
  ).not.toThrow();
});

test.each([
  "test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 840 filtered out;",
  "test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 839 filtered out;",
  "test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 838 filtered out;",
  "test result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 839 filtered out;",
  "running 1 test\n",
])("rejects missing, ignored, broad, or failed execution: %s", (output) => {
  expect(() => verifyReadBudgetTestResult(output)).toThrow("exactly one passing");
});
