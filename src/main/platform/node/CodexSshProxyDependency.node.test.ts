import { expect, test } from "vitest";
import { codexSshProxyDependency } from "./CodexSshProxyDependency";
const inspect = (command: string) =>
  codexSshProxyDependency(
    `ProxyCommand ${command}`,
    "/bin:/usr/bin",
    (command) => command === "known",
  );

test("only unresolved bare executables wait for shell PATH", () => {
  expect(inspect("known %h").needsShellEnv).toBe(false);
  expect(inspect("missing %h").needsShellEnv).toBe(true);
  expect(inspect("/absolute/proxy %h").needsShellEnv).toBe(false);
  expect(inspect("NONE").needsShellEnv).toBe(false);
});

test("unwraps assignments and nested login shells with bounded recursion", () => {
  expect(inspect(`bash -lic 'env A=b exec known'`).commandName).toBe("known");
  expect(inspect(`sh -c 'sh -c "sh -c known"'`).commandName).toBe("sh");
});

test("rejects shell operators and incomplete quoting but keeps quoted literals", () => {
  expect(inspect("proxy | another").reason).toBe("proxy_command_unparsed");
  expect(inspect("'unterminated").reason).toBe("proxy_command_unparsed");
  expect(inspect("'proxy;literal'").commandName).toBe("proxy;literal");
  expect(inspect("$'kn\\157wn'").commandName).toBe("known");
});

test("uses the final proxy command in the resolved SSH configuration", () => {
  expect(
    codexSshProxyDependency("proxycommand missing\nProxyCommand none", null, () => false).reason,
  ).toBe("proxy_command_none");
});
