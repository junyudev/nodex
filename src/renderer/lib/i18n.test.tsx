import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { activateAppLocale, FormattedMessage, resetAppLocaleForTests, useIntl } from "./i18n";

afterEach(() => {
  act(resetAppLocaleForTests);
});

function LocaleProbe() {
  const intl = useIntl();
  return (
    <div>
      <output>{intl.locale}</output>
      <FormattedMessage id="settings.general.title" defaultMessage="General" />
    </div>
  );
}

test("switches useIntl subscribers, catalog messages and the document language together", async () => {
  render(<LocaleProbe />);
  expect(screen.getByRole("status").textContent).toBe("en-US");
  expect(screen.getByText("General")).toBeTruthy();

  await act(async () => activateAppLocale("zh-CN"));
  expect(screen.getByRole("status").textContent).toBe("zh-CN");
  expect(screen.getByText("常规")).toBeTruthy();
  expect(document.documentElement.lang).toBe("zh-CN");
});

test("supersedes a pending catalog load with the latest locale", async () => {
  render(<LocaleProbe />);
  await act(async () => {
    const earlier = activateAppLocale("zh-CN");
    await activateAppLocale("en-US");
    await earlier;
  });
  expect(screen.getByText("General")).toBeTruthy();
  expect(screen.getByRole("status").textContent).toBe("en-US");
  expect(document.documentElement.lang).toBe("en-US");
});
