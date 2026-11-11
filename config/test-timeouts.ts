// Timeouts detect hung work. Passing waits finish as soon as their condition is met.
export const ASYNC_WAIT_TIMEOUT_MS = 10_000;
export const STANDARD_TEST_TIMEOUT_MS = 60_000;
export const STRESS_TEST_TIMEOUT_MS = 120_000;
export const E2E_EXPECT_TIMEOUT_MS = 15_000;
export const E2E_TEST_TIMEOUT_MS = 120_000;

export function vitestTimeouts(isStress: boolean) {
  const timeout = isStress ? STRESS_TEST_TIMEOUT_MS : STANDARD_TEST_TIMEOUT_MS;
  return {
    expect: { poll: { timeout: ASYNC_WAIT_TIMEOUT_MS } },
    hookTimeout: timeout,
    testTimeout: timeout,
  };
}
