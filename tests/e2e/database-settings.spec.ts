import { expect, test, type Locator, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { withElectronScenario } from "../../scripts/scenarios/harness/electron-e2e-harness";
import {
  DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID,
  DATABASE_SETTINGS_CONFIGURATION_SCENARIO_REVISION,
  requireDatabaseSettingsConfigurationFacts,
} from "../../scripts/scenarios/scenarios/database-settings-configuration";
const focusSettingsDatabase = async (page: Page): Promise<void> => {
  await page.evaluate(() => localStorage.setItem("nodex-theme", "dark"));
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains("dark")))
    .toBe(true);
  const surface = page.locator("[data-database-view-id]:visible");
  if (await surface.isVisible().catch(() => false)) return;
  const restored = await surface
    .waitFor({ state: "visible", timeout: 1_500 })
    .then(() => true)
    .catch(() => false);
  if (restored) return;
  await page
    .getByRole("button", { name: "Open Database settings", exact: true })
    .evaluate((element) => (element as HTMLElement).click());
  await page.getByRole("tab", { name: "Project Home" }).waitFor();
  await surface.waitFor();
};

const openSettings = async (page: Page) => {
  await page.getByRole("button", { name: "Database settings", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Database settings" });
  await expect(rail).toBeVisible();
  return rail;
};

const openSettingsWithEnterMotion = async (page: Page) => {
  await page.getByRole("button", { name: "Database settings", exact: true }).click();
  const rail = page.getByRole("complementary", { name: "Database settings" });
  await rail.waitFor({ state: "attached" });
  const animations = await rail.evaluate(async (element) => {
    const deadline = performance.now() + 250;
    while (performance.now() < deadline) {
      const active = element.getAnimations().flatMap((animation) => {
        const effect = animation.effect;
        if (!(effect instanceof KeyframeEffect)) return [];
        const propertyName = (animation as CSSTransition).transitionProperty;
        if (propertyName !== "opacity" && propertyName !== "transform") return [];
        return [
          {
            propertyName,
            duration: effect.getTiming().duration,
            easing: effect.getTiming().easing,
            keyframes: effect.getKeyframes(),
          },
        ];
      });
      if (active.length === 2) return active;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return [];
  });
  return { rail, animations, devicePixelRatio: await page.evaluate(() => window.devicePixelRatio) };
};

const DATABASE_SETTINGS_ARTIFACT_DIR = resolve(
  "notes.local/artifacts/database-settings-ui-alignment",
);
const INLINE_RULE_ARTIFACT_TIMESTAMP = new Date().toISOString().replaceAll(":", "-");
const INLINE_RULE_ARTIFACT_DIR = resolve(
  "notes.local/artifacts/database-inline-filter-sort",
  INLINE_RULE_ARTIFACT_TIMESTAMP,
);

const captureDatabaseSettingsArtifact = async (page: Page, label: string): Promise<string> => {
  mkdirSync(DATABASE_SETTINGS_ARTIFACT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const path = resolve(DATABASE_SETTINGS_ARTIFACT_DIR, `${timestamp}-${label}.png`);
  await page.screenshot({ path });
  return path;
};

const captureInlineRuleArtifact = async (page: Page, label: string): Promise<string> => {
  mkdirSync(INLINE_RULE_ARTIFACT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const path = resolve(INLINE_RULE_ARTIFACT_DIR, `${timestamp}-${label}.png`);
  await page.screenshot({ path });
  return path;
};

const readCompactFramedInputStyle = async (input: Locator) =>
  await input.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      borderRadius: style.borderRadius,
      borderTopWidth: style.borderTopWidth,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
    };
  });

const readBackgroundColor = async (element: Locator): Promise<string> =>
  await element.evaluate((node) => getComputedStyle(node).backgroundColor);

const readSelectorChrome = async (element: Locator) =>
  await element.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      backgroundColor: style.backgroundColor,
      borderTopColor: style.borderTopColor,
      borderTopWidth: style.borderTopWidth,
    };
  });

test("Filter and Sort authoring stays inline, typed, draggable, and personally scoped", async () => {
  test.setTimeout(90_000);
  await withElectronScenario(
    {
      label: "database-inline-filter-sort",
      scenarioId: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID,
    },
    async ({ page, facts }) => {
      if (!facts) throw new Error("Database settings scenario did not materialize");
      const configured = requireDatabaseSettingsConfigurationFacts(facts);
      const screenshots: string[] = [];
      await focusSettingsDatabase(page);

      await page.getByRole("button", { name: "New view", exact: true }).click();
      const createRail = page.getByRole("complementary", { name: "Database settings" });
      await createRail.getByLabel("Name", { exact: true }).fill("Empty rules");
      await createRail.getByRole("button", { name: "Create view", exact: true }).click();
      await expect(page.getByRole("tab", { name: "Empty rules", exact: true })).toBeVisible();
      const closeSettings = createRail.getByRole("button", { name: "Close settings", exact: true });
      if (await closeSettings.isVisible()) await closeSettings.click();

      const ruleBar = page.getByTestId("database-view-rules-bar");
      await expect(ruleBar).toHaveCount(0);
      const filterToolbarButton = page.getByRole("button", { name: "Filter View", exact: true });
      await filterToolbarButton.click();
      await expect(ruleBar).toHaveCount(0);
      await expect(page.getByText("Add filter", { exact: true })).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "empty-filter-toolbar-popover-dark"));
      await filterToolbarButton.click();
      await expect(page.getByText("Add filter", { exact: true })).toBeHidden();

      await page.getByRole("button", { name: "Sort View", exact: true }).click();
      await expect(ruleBar).toHaveCount(0);
      await expect(page.getByText("New sort", { exact: true })).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "empty-sort-toolbar-popover-dark"));
      await page.getByRole("button", { name: "Name", exact: true }).click();
      await expect(ruleBar).toBeVisible();
      await expect(page.getByRole("button", { name: "Sort property" })).toContainText("Name");
      screenshots.push(await captureInlineRuleArtifact(page, "created-sort-owned-by-bar-dark"));
      await page.keyboard.press("Escape");
      await ruleBar.getByRole("button", { name: "Close filter and sort bar" }).click();

      await page.getByRole("tab", { name: "List", exact: true }).click();
      await expect(
        page.locator(`[data-database-view-id="${configured.listViewId}"]:visible`),
      ).toBeVisible();

      await expect(ruleBar).toHaveCount(0);
      const activeFilterToolbarButton = page.getByRole("button", {
        name: "Filter View",
        exact: true,
      });
      const activeSortToolbarButton = page.getByRole("button", {
        name: "Sort View",
        exact: true,
      });
      await expect(activeFilterToolbarButton).toHaveAttribute("data-active", "true");
      await expect(activeSortToolbarButton).toHaveAttribute("data-active", "true");

      await activeSortToolbarButton.click();
      await expect(ruleBar).toBeVisible();
      await expect(page.getByLabel("Personal sort change")).toHaveCount(0);
      const sortToken = ruleBar.getByRole("button", { name: "Edit sorts" });
      await expect(sortToken).not.toHaveAttribute("data-personal-action-preview");
      const sortFields = page.getByRole("button", { name: "Sort property" });
      const sortDirections = page.getByRole("button", { name: "Sort direction" });
      const addSort = page.getByRole("button", { name: "Add sort", exact: true });
      const deleteSort = page.getByRole("button", { name: "Delete sort", exact: true });
      await expect(sortFields).toHaveText(["Created time", "Scenario number 2"]);
      const selectorChrome = {
        property: await readSelectorChrome(sortFields.first()),
        direction: await readSelectorChrome(sortDirections.first()),
        transparentAction: await readSelectorChrome(addSort),
      };
      const [addSortColor, deleteSortColor] = await Promise.all([
        addSort.evaluate((element) => getComputedStyle(element).color),
        deleteSort.evaluate((element) => getComputedStyle(element).color),
      ]);
      const sortFooterMetrics = await page
        .locator('[data-slot="sort-footer"]')
        .evaluate((footer) => {
          const add = footer.querySelector('[aria-label="Add sort"]');
          const remove = Array.from(footer.querySelectorAll("button")).find(
            (button) => button.textContent?.trim() === "Delete sort",
          );
          if (!(add instanceof HTMLElement) || !(remove instanceof HTMLElement)) return null;
          return {
            addHeight: add.getBoundingClientRect().height,
            deleteHeight: remove.getBoundingClientRect().height,
            borderTopWidth: Number.parseFloat(getComputedStyle(footer).borderTopWidth),
          };
        });
      const sortFooterActionMetrics = await Promise.all(
        [addSort, deleteSort].map((action) =>
          action.locator('[data-slot="sort-footer-action-label"]').evaluate((label) => {
            const icon = label.querySelector("svg");
            const text = label.querySelector(":scope > span");
            if (!(icon instanceof SVGElement) || !(text instanceof HTMLElement)) return null;
            const labelRect = label.getBoundingClientRect();
            const iconRect = icon.getBoundingClientRect();
            const textRect = text.getBoundingClientRect();
            return {
              labelLeft: labelRect.left,
              iconLeft: iconRect.left,
              textLeft: textRect.left,
              iconTextGap: textRect.left - iconRect.right,
            };
          }),
        ),
      );
      const sortRowMetrics = await sortFields.evaluateAll((elements) =>
        elements.map((field) => {
          const row = field.parentElement;
          const direction = field.nextElementSibling;
          const remove = row?.lastElementChild;
          if (
            !(row instanceof HTMLElement) ||
            !(direction instanceof HTMLElement) ||
            !(remove instanceof HTMLElement)
          ) {
            return null;
          }
          const fieldRect = field.getBoundingClientRect();
          const directionRect = direction.getBoundingClientRect();
          const removeRect = remove.getBoundingClientRect();
          const rowRect = row.getBoundingClientRect();
          return {
            fieldWidth: fieldRect.width,
            directionWidth: directionRect.width,
            trailingSpace: removeRect.left - directionRect.right,
            rowTop: rowRect.top,
            rowBottom: rowRect.bottom,
          };
        }),
      );
      screenshots.push(await captureInlineRuleArtifact(page, "sort-popup-personal-dark"));

      const saveForEveryone = ruleBar.getByRole("button", {
        name: "Save for everyone",
        exact: true,
      });
      const resetChanges = ruleBar.getByRole("button", {
        name: "Reset my changes",
        exact: true,
      });
      await expect(saveForEveryone).toBeVisible();
      await expect(saveForEveryone).toHaveAttribute("data-active", "true");
      const saveRestingBackground = await readBackgroundColor(saveForEveryone);
      await saveForEveryone.hover();
      await expect(sortToken).toHaveAttribute("data-personal-action-preview", "publish");
      const saveHoverBackground = await readBackgroundColor(saveForEveryone);
      await expect(
        page.getByRole("tooltip").filter({
          hasText: "Save these sort changes",
        }),
      ).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "personal-save-tooltip-dark"));
      await resetChanges.hover();
      await expect(sortToken).toHaveAttribute("data-personal-action-preview", "reset");
      await expect(
        page.getByRole("tooltip").filter({
          hasText: "Discard these sort changes",
        }),
      ).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "personal-reset-tooltip-dark"));

      await sortDirections.first().click();
      await expect(page.getByRole("menuitem", { name: "Earliest first" })).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "sort-direction-menu-dark"));
      await page.keyboard.press("Escape");

      const firstHandle = page.getByLabel("Reorder sort Created time");
      const secondHandle = page.getByLabel("Reorder sort Scenario number 2");
      const [firstBox, secondBox] = await Promise.all([
        firstHandle.boundingBox(),
        secondHandle.boundingBox(),
      ]);
      if (!firstBox || !secondBox) throw new Error("Sort drag handles are unavailable");
      await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(firstBox.x + firstBox.width / 2, firstBox.y + firstBox.height / 2 + 8, {
        steps: 2,
      });
      await page.mouse.move(
        secondBox.x + secondBox.width / 2,
        secondBox.y + secondBox.height / 2 + 8,
        { steps: 6 },
      );
      await page.mouse.up();
      await expect(sortFields).toHaveText(["Scenario number 2", "Created time"]);
      const reorderedSortFieldLabels = (await sortFields.allTextContents()).map((label) =>
        label.trim(),
      );
      await page.keyboard.press("Escape");
      await expect(sortFields).toHaveCount(0);

      await ruleBar.getByRole("button", { name: "Filter", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Search filter properties" })).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "filter-property-picker-dark"));

      await page.getByRole("button", { name: "Scenario multi select 5", exact: true }).click();
      await expect(
        page.getByRole("combobox", { name: "Search Scenario multi select 5 options" }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Filter value for Scenario multi select 5" }),
      ).toHaveCount(0);
      await expect(page.getByRole("option", { name: "Alpha" }).first()).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "multi-select-quick-filter-dark"));
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      await ruleBar.getByRole("button", { name: "Edit filter Scenario text 1" }).click();
      await expect(
        page.getByRole("textbox", { name: "Filter value for Scenario text 1" }),
      ).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "text-quick-filter-dark"));
      await page.keyboard.press("Escape");

      await ruleBar.getByRole("button", { name: "Edit advanced filter" }).click();
      const whereLabel = page.getByText("Where").first();
      const booleanOperator = page.getByRole("button", { name: "Filter group operator root" });
      const advancedOperators = page.getByRole("button", { name: /^Filter operator for / });
      const advancedProperties = page.getByRole("button", { name: /^Filter property / });
      const advancedPopover = whereLabel.locator('xpath=ancestor::*[@role="dialog"]');
      const addFilterRule = advancedPopover
        .locator('[data-slot="advanced-filter-add-row"][data-depth="0"]')
        .getByRole("button", { name: "Add filter rule", exact: true });
      const deleteFilter = advancedPopover.getByRole("button", {
        name: "Delete filter",
        exact: true,
      });
      await expect(whereLabel).toBeVisible();
      await expect(booleanOperator).toBeVisible();
      await expect(advancedOperators).toHaveCount(2);
      const operatorMetrics = await advancedOperators.evaluateAll((elements) =>
        elements
          .map((element) => {
            const rect = element.getBoundingClientRect();
            return {
              label: element.textContent?.trim() ?? "",
              width: rect.width,
              height: rect.height,
            };
          })
          .sort((left, right) => left.width - right.width),
      );
      const operatorValueGaps = await advancedOperators.evaluateAll((elements) =>
        elements.map((element) => {
          const propertyName = element
            .getAttribute("aria-label")
            ?.replace("Filter operator for ", "");
          if (!propertyName) return Number.NaN;
          const dialog = element.closest('[role="dialog"]');
          const value = Array.from(
            dialog?.querySelectorAll(
              `[aria-label="${CSS.escape(`Filter value for ${propertyName}`)}"]`,
            ) ?? [],
          ).find((candidate) => {
            const rect = candidate.getBoundingClientRect();
            const style = getComputedStyle(candidate);
            return rect.width > 0 && rect.height > 0 && style.display !== "none";
          });
          if (!(value instanceof HTMLElement)) return Number.NaN;
          const operatorRect = element.getBoundingClientRect();
          const valueRect = value.getBoundingClientRect();
          return valueRect.left - operatorRect.right;
        }),
      );
      const [booleanOperatorBox, advancedPopoverBox] = await Promise.all([
        booleanOperator.boundingBox(),
        advancedPopover.boundingBox(),
      ]);
      const advancedFilterActionMetrics = await Promise.all(
        [addFilterRule, deleteFilter].map((action) =>
          action.evaluate((button) => {
            const icon = button.querySelector(":scope > svg");
            const label = button.querySelector(":scope > span");
            if (!(icon instanceof SVGElement) || !(label instanceof HTMLElement)) return null;
            const buttonRect = button.getBoundingClientRect();
            const iconRect = icon.getBoundingClientRect();
            const labelRect = label.getBoundingClientRect();
            return {
              buttonLeft: buttonRect.left,
              buttonRight: buttonRect.right,
              iconLeft: iconRect.left,
              labelLeft: labelRect.left,
              iconLabelGap: labelRect.left - iconRect.right,
            };
          }),
        ),
      );
      const addFilterRuleLayout = await addFilterRule.evaluate((button) => {
        const wrapper = button.closest('[data-slot="advanced-filter-add-row"]');
        const chevron = button.querySelector(":scope > svg:last-child");
        if (!(wrapper instanceof HTMLElement) || !(chevron instanceof SVGElement)) return null;
        const wrapperStyle = getComputedStyle(wrapper);
        const wrapperRect = wrapper.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const chevronRect = chevron.getBoundingClientRect();
        return {
          buttonWidth: buttonRect.width,
          availableWidth:
            wrapperRect.width -
            Number.parseFloat(wrapperStyle.paddingLeft) -
            Number.parseFloat(wrapperStyle.paddingRight),
          trailingSpace: buttonRect.right - chevronRect.right,
        };
      });
      const [whereColor, propertyColor, booleanLabelClipped] = await Promise.all([
        whereLabel.evaluate((element) => getComputedStyle(element).color),
        advancedProperties.first().evaluate((element) => getComputedStyle(element).color),
        booleanOperator.evaluate((element) =>
          Array.from(element.querySelectorAll("span")).some(
            (span) => span.scrollWidth > span.clientWidth + 1,
          ),
        ),
      ]);
      if (!booleanOperatorBox || !advancedPopoverBox) {
        throw new Error("Advanced filter geometry is unavailable");
      }
      const advancedFilterControlMetrics = {
        operators: operatorMetrics,
        operatorValueGaps,
        popoverWidth: advancedPopoverBox.width,
        booleanOperator: {
          width: booleanOperatorBox.width,
          height: booleanOperatorBox.height,
          inset: booleanOperatorBox.x - advancedPopoverBox.x,
        },
        booleanLabelClipped,
        whereColor,
        propertyColor,
      };

      const nestedAddFilterRule = advancedPopover
        .locator('[data-slot="advanced-filter-add-row"][data-depth="1"]')
        .getByRole("button", { name: "Add filter rule", exact: true });
      await nestedAddFilterRule.click();
      await page.getByRole("button", { name: "Add filter rule", exact: true }).last().click();
      const nestedBooleanOperator = advancedPopover.getByRole("button", {
        name: "Filter group operator 1",
        exact: true,
      });
      await expect(nestedBooleanOperator).toBeVisible();
      const nestedBooleanInset = await nestedBooleanOperator.evaluate((operator) => {
        const group = operator.closest('[data-slot="advanced-filter-group"][data-depth="1"]');
        const surface = group?.parentElement;
        if (!(surface instanceof HTMLElement)) return Number.NaN;
        return operator.getBoundingClientRect().left - surface.getBoundingClientRect().left;
      });
      const nestedControlBackgrounds = await advancedPopover
        .locator('[data-slot="advanced-filter-group"][data-depth="1"]')
        .evaluate((group) => {
          const surface = group.parentElement;
          const controls = [
            group.querySelector('[aria-label="Filter group operator 1"]'),
            group.querySelector('[aria-label^="Filter property "]'),
            group.querySelector('[aria-label^="Filter operator for "]'),
          ];
          if (!(surface instanceof HTMLElement) || controls.some((control) => !control)) {
            return null;
          }
          const controlBackgrounds = controls.map(
            (control) => getComputedStyle(control as Element).backgroundColor,
          );
          const colorAlpha = (color: string): number => {
            const rgba = color.match(/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/);
            return rgba ? Number.parseFloat(rgba[1] ?? "0") : 1;
          };
          return {
            surface: getComputedStyle(surface).backgroundColor,
            controls: controlBackgrounds,
            controlAlphas: controlBackgrounds.map(colorAlpha),
          };
        });
      screenshots.push(await captureInlineRuleArtifact(page, "advanced-filter-boolean-inset-dark"));
      await advancedPopover
        .getByRole("button", { name: "Filter actions 1.1", exact: true })
        .click();
      await page.getByRole("button", { name: "Remove", exact: true }).click();
      await expect(nestedBooleanOperator).toHaveCount(0);
      screenshots.push(await captureInlineRuleArtifact(page, "advanced-filter-grid-dark"));

      await page.getByRole("button", { name: "Filter group actions 1", exact: true }).click();
      await page.getByRole("button", { name: "Turn into filter", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Filter group actions 1", exact: true }),
      ).toHaveCount(0);
      const wideOperatorPopoverBox = await advancedPopover.boundingBox();
      if (!wideOperatorPopoverBox) {
        throw new Error("Expanded advanced filter geometry is unavailable");
      }
      const rootTextOperator = page.getByRole("button", {
        name: "Filter operator for Scenario text 1",
        exact: true,
      });
      await rootTextOperator.click();
      await page.getByRole("menuitem", { name: "is", exact: true }).click();
      await expect(rootTextOperator).toHaveText("is");
      const shortOperatorPopoverBox = await advancedPopover.boundingBox();
      if (!shortOperatorPopoverBox) {
        throw new Error("Content-sized advanced filter geometry is unavailable");
      }
      const advancedPopoverWidthDelta =
        wideOperatorPopoverBox.width - shortOperatorPopoverBox.width;
      screenshots.push(
        await captureInlineRuleArtifact(page, "advanced-filter-intrinsic-width-dark"),
      );

      await page.getByRole("button", { name: "Add filter rule", exact: true }).first().click();
      await expect(page.getByText("A group to nest more filters")).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "advanced-filter-add-menu-dark"));
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      const filterRestingBackground = await readBackgroundColor(activeFilterToolbarButton);
      await activeFilterToolbarButton.hover();
      const filterHoverBackground = await readBackgroundColor(activeFilterToolbarButton);
      screenshots.push(await captureInlineRuleArtifact(page, "active-filter-hover-dark"));
      const sortRestingBackground = await readBackgroundColor(activeSortToolbarButton);
      await activeSortToolbarButton.hover();
      const sortHoverBackground = await readBackgroundColor(activeSortToolbarButton);
      screenshots.push(await captureInlineRuleArtifact(page, "active-sort-hover-dark"));
      await page.mouse.move(1, 1);
      await expect(page.getByRole("tooltip")).toHaveCount(0);

      screenshots.push(await captureInlineRuleArtifact(page, "baseline-rule-bar-dark"));
      await page.setViewportSize({ width: 920, height: 720 });
      await expect(ruleBar).toBeVisible();
      screenshots.push(await captureInlineRuleArtifact(page, "narrow-rule-bar-dark"));

      const toolbar = page.getByTestId("db-view-toolbar");
      const [toolbarBox, barBox, sortTokenBox, resetChangesBox, saveForEveryoneBox] =
        await Promise.all([
          toolbar.boundingBox(),
          ruleBar.boundingBox(),
          sortToken.boundingBox(),
          resetChanges.boundingBox(),
          saveForEveryone.boundingBox(),
        ]);
      if (!toolbarBox || !barBox || !sortTokenBox || !resetChangesBox || !saveForEveryoneBox) {
        throw new Error("Inline rule bar geometry is unavailable");
      }
      const assertions = {
        scenario: `${DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID}@${DATABASE_SETTINGS_CONFIGURATION_SCENARIO_REVISION}`,
        darkMode: await page.evaluate(() => document.documentElement.classList.contains("dark")),
        toolbarBottom: toolbarBox.y + toolbarBox.height,
        ruleBarTop: barBox.y,
        ruleBarHeight: barBox.height,
        sortTokenHeight: sortTokenBox.height,
        resetActionSize: { width: resetChangesBox.width, height: resetChangesBox.height },
        saveActionSize: { width: saveForEveryoneBox.width, height: saveForEveryoneBox.height },
        actionAlignmentDelta:
          saveForEveryoneBox.y +
          saveForEveryoneBox.height / 2 -
          (sortTokenBox.y + sortTokenBox.height / 2),
        hoverBackgrounds: {
          filter: { resting: filterRestingBackground, hover: filterHoverBackground },
          sort: { resting: sortRestingBackground, hover: sortHoverBackground },
          save: { resting: saveRestingBackground, hover: saveHoverBackground },
        },
        selectorChrome,
        sortFooterActionColors: { add: addSortColor, delete: deleteSortColor },
        sortFooterMetrics,
        sortFooterActionMetrics,
        sortRowMetrics,
        advancedFilterControlMetrics,
        advancedFilterActionMetrics,
        addFilterRuleLayout,
        nestedBooleanInset,
        nestedControlBackgrounds,
        advancedPopoverWidthDelta,
        reorderedSortFields: reorderedSortFieldLabels,
        screenshotCount: screenshots.length,
      };
      expect(assertions.darkMode).toBe(true);
      expect(assertions.ruleBarTop).toBeGreaterThanOrEqual(assertions.toolbarBottom - 1);
      expect(assertions.ruleBarHeight).toBeLessThan(44);
      expect(assertions.sortTokenHeight).toBeCloseTo(24, 0);
      expect(assertions.resetActionSize).toEqual({ width: 24, height: 24 });
      expect(assertions.saveActionSize).toEqual({ width: 24, height: 24 });
      expect(Math.abs(assertions.actionAlignmentDelta)).toBeLessThanOrEqual(1);
      expect(assertions.hoverBackgrounds.filter.hover).not.toBe(
        assertions.hoverBackgrounds.filter.resting,
      );
      expect(assertions.hoverBackgrounds.sort.hover).not.toBe(
        assertions.hoverBackgrounds.sort.resting,
      );
      expect(assertions.hoverBackgrounds.save.hover).not.toBe(
        assertions.hoverBackgrounds.save.resting,
      );
      expect(assertions.selectorChrome.property).toEqual(assertions.selectorChrome.direction);
      expect(Number.parseFloat(assertions.selectorChrome.property.borderTopWidth)).toBeGreaterThan(
        0,
      );
      expect(assertions.selectorChrome.property.borderTopColor).not.toBe(
        assertions.selectorChrome.transparentAction.borderTopColor,
      );
      expect(assertions.sortFooterActionColors.add).toBe(assertions.sortFooterActionColors.delete);
      expect(assertions.sortFooterMetrics).toEqual({
        addHeight: 28,
        deleteHeight: 28,
        borderTopWidth: 0,
      });
      expect(assertions.sortFooterActionMetrics.every((metric) => metric !== null)).toBe(true);
      const [addSortMetrics, deleteSortMetrics] = assertions.sortFooterActionMetrics;
      expect(addSortMetrics?.labelLeft).toBeCloseTo(deleteSortMetrics?.labelLeft ?? 0, 0);
      expect(addSortMetrics?.iconLeft).toBeCloseTo(deleteSortMetrics?.iconLeft ?? 0, 0);
      expect(addSortMetrics?.textLeft).toBeCloseTo(deleteSortMetrics?.textLeft ?? 0, 0);
      expect(addSortMetrics?.iconTextGap).toBeCloseTo(deleteSortMetrics?.iconTextGap ?? 0, 0);
      expect(assertions.sortRowMetrics.every((metric) => metric !== null)).toBe(true);
      const completeSortRowMetrics = assertions.sortRowMetrics.filter(
        (metric): metric is NonNullable<typeof metric> => metric !== null,
      );
      expect(
        Math.min(...completeSortRowMetrics.map(({ trailingSpace }) => trailingSpace)),
      ).toBeGreaterThanOrEqual(32);
      expect(
        (completeSortRowMetrics[1]?.rowTop ?? 0) - (completeSortRowMetrics[0]?.rowBottom ?? 0),
      ).toBeGreaterThanOrEqual(4);
      expect(assertions.advancedFilterControlMetrics.operators[0]?.width).toBeLessThan(70);
      expect(assertions.advancedFilterControlMetrics.operators[1]?.width).toBeGreaterThan(
        (assertions.advancedFilterControlMetrics.operators[0]?.width ?? 0) + 20,
      );
      expect(assertions.advancedFilterControlMetrics.operatorValueGaps.every(Number.isFinite)).toBe(
        true,
      );
      expect(
        Math.max(...assertions.advancedFilterControlMetrics.operatorValueGaps),
      ).toBeLessThanOrEqual(12);
      expect(assertions.advancedPopoverWidthDelta).toBeGreaterThan(20);
      expect(assertions.advancedFilterControlMetrics.booleanOperator.height).toBeCloseTo(
        assertions.advancedFilterControlMetrics.operators[0]?.height ?? 0,
        0,
      );
      expect(assertions.advancedFilterControlMetrics.booleanOperator.inset).toBeGreaterThanOrEqual(
        12,
      );
      expect(assertions.advancedFilterControlMetrics.booleanLabelClipped).toBe(false);
      expect(assertions.advancedFilterControlMetrics.whereColor).toBe(
        assertions.advancedFilterControlMetrics.propertyColor,
      );
      expect(assertions.advancedFilterActionMetrics.every((metric) => metric !== null)).toBe(true);
      const [addFilterMetrics, deleteFilterMetrics] = assertions.advancedFilterActionMetrics;
      expect(addFilterMetrics?.buttonLeft).toBeCloseTo(deleteFilterMetrics?.buttonLeft ?? 0, 0);
      expect(addFilterMetrics?.iconLeft).toBeCloseTo(deleteFilterMetrics?.iconLeft ?? 0, 0);
      expect(addFilterMetrics?.labelLeft).toBeCloseTo(deleteFilterMetrics?.labelLeft ?? 0, 0);
      expect(addFilterMetrics?.iconLabelGap).toBeCloseTo(deleteFilterMetrics?.iconLabelGap ?? 0, 0);
      expect(assertions.addFilterRuleLayout?.buttonWidth).toBeCloseTo(
        assertions.addFilterRuleLayout?.availableWidth ?? 0,
        0,
      );
      expect(assertions.addFilterRuleLayout?.trailingSpace).toBeGreaterThan(24);
      expect(assertions.nestedBooleanInset).toBeGreaterThanOrEqual(12);
      expect(assertions.nestedControlBackgrounds).not.toBeNull();
      expect(new Set(assertions.nestedControlBackgrounds?.controls).size).toBe(1);
      expect(assertions.nestedControlBackgrounds?.controlAlphas).toEqual([1, 1, 1]);
      expect(assertions.nestedControlBackgrounds?.controls[0]).not.toBe(
        assertions.nestedControlBackgrounds?.surface,
      );
      expect(assertions.reorderedSortFields).toEqual(["Scenario number 2", "Created time"]);
      expect(assertions.screenshotCount).toBe(18);

      mkdirSync(INLINE_RULE_ARTIFACT_DIR, { recursive: true });
      writeFileSync(
        resolve(INLINE_RULE_ARTIFACT_DIR, "assertions.json"),
        `${JSON.stringify(assertions, null, 2)}\n`,
      );
      writeFileSync(
        resolve(INLINE_RULE_ARTIFACT_DIR, "dom.html"),
        await page
          .locator(`[data-database-view-id="${configured.listViewId}"]:visible`)
          .evaluate((element) => element.outerHTML),
      );
      writeFileSync(
        resolve(INLINE_RULE_ARTIFACT_DIR, "README.md"),
        [
          "# Database inline Filter / Sort visual evidence",
          "",
          `- Scenario: \`${DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID}@${DATABASE_SETTINGS_CONFIGURATION_SCENARIO_REVISION}\``,
          "- Theme: dark",
          "- Data: disposable public-operation scenario only",
          '- Command: `vp run test:e2e tests/e2e/database-settings.spec.ts -g "Filter and Sort authoring"`',
          "- Commit: working tree under test (replace with final commit after handoff)",
          "",
          "## Screenshots",
          "",
          ...screenshots.map((path) => `- \`${path.split("/").at(-1)}\``),
          "",
          "Machine measurements are in `assertions.json`; the final visible View DOM is in `dom.html`.",
          "",
        ].join("\n"),
      );

      const expectedPublishedRuleFrame = await ruleBar.evaluate((element) => {
        const frames: string[] = [];
        const read = () => {
          const buttons = Array.from(
            element.querySelectorAll<HTMLButtonElement>("button[aria-label]"),
          );
          frames.push(
            JSON.stringify(
              buttons.flatMap((button) => {
                const label = button.getAttribute("aria-label") ?? "";
                if (
                  label !== "Edit sorts" &&
                  label !== "Edit advanced filter" &&
                  !label.startsWith("Edit filter ")
                ) {
                  return [];
                }
                const style = getComputedStyle(button);
                return [
                  {
                    label,
                    text: button.textContent?.replaceAll(/\s+/g, " ").trim() ?? "",
                    color: style.color,
                    backgroundColor: style.backgroundColor,
                    opacity: style.opacity,
                  },
                ];
              }),
            ),
          );
        };
        let animationFrame = 0;
        const sample = () => {
          read();
          animationFrame = requestAnimationFrame(sample);
        };
        sample();
        (
          window as unknown as {
            __databaseRulePublicationProbe?: { stop: () => readonly string[] };
          }
        ).__databaseRulePublicationProbe = {
          stop: () => {
            cancelAnimationFrame(animationFrame);
            read();
            return frames;
          },
        };
        return frames[0] ?? "[]";
      });
      await saveForEveryone.click();
      await expect(saveForEveryone).toHaveCount(0);
      await page.evaluate(
        async () =>
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const publishedRuleFrames = await page.evaluate(() => {
        const host = window as unknown as {
          __databaseRulePublicationProbe?: { stop: () => readonly string[] };
        };
        const frames = host.__databaseRulePublicationProbe?.stop() ?? [];
        delete host.__databaseRulePublicationProbe;
        return frames;
      });
      expect(publishedRuleFrames.length).toBeGreaterThan(1);
      expect(new Set(publishedRuleFrames)).toEqual(new Set([expectedPublishedRuleFrame]));
    },
  );
});

test("View tabs own their action menu and persist direct drag reorder", async () => {
  await withElectronScenario(
    {
      label: "database-view-tab-actions-and-reorder",
      scenarioId: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID,
    },
    async ({ page, facts, harness }) => {
      if (!facts) throw new Error("Database settings scenario did not materialize");
      const configured = requireDatabaseSettingsConfigurationFacts(facts);
      await focusSettingsDatabase(page);

      const toolbar = page.getByTestId("db-view-toolbar");
      const boardTab = toolbar.getByRole("tab", { name: "Board", exact: true });
      const listTab = toolbar.getByRole("tab", { name: "List", exact: true });
      await expect(boardTab).toHaveAttribute("aria-haspopup", "dialog");
      const [boardBox, boardWrapperBox, boardIconBox, boardLabelBox, tabListBox] =
        await Promise.all([
          boardTab.boundingBox(),
          boardTab.locator("..").boundingBox(),
          boardTab.locator("svg").boundingBox(),
          boardTab.locator('[data-tab-label-visible="true"]').boundingBox(),
          toolbar.getByRole("tablist", { name: "Database views" }).boundingBox(),
        ]);
      await boardTab.click();
      const menu = page.getByRole("menu", { name: "Actions for Board" });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("menuitem")).toHaveText([
        "Rename",
        "Display as",
        "Edit view",
        /Source/,
        "Copy link to view",
        "Duplicate view",
        "Delete view",
      ]);

      const menuBox = await menu.boundingBox();
      if (
        !boardBox ||
        !boardWrapperBox ||
        !boardIconBox ||
        !boardLabelBox ||
        !tabListBox ||
        !menuBox
      ) {
        throw new Error("View tab geometry is unavailable");
      }
      expect(boardBox.height).toBeCloseTo(32, 0);
      expect(boardWrapperBox.height).toBeCloseTo(40, 0);
      expect(boardIconBox.width).toBeCloseTo(16, 0);
      expect(boardLabelBox.x - (boardIconBox.x + boardIconBox.width)).toBeCloseTo(6, 0);
      expect(menuBox.width).toBeCloseTo(220, 0);
      expect(menuBox.x).toBeCloseTo(boardBox.x, 0);
      await captureDatabaseSettingsArtifact(page, "view-tab-action-menu-dark");

      await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
      const rail = page.getByRole("complementary", { name: "Database settings" });
      const viewName = rail.getByRole("textbox", { name: "View name", exact: true });
      await expect(viewName).toBeFocused();
      expect(
        await viewName.evaluate((input) => ({
          start: (input as HTMLInputElement).selectionStart,
          end: (input as HTMLInputElement).selectionEnd,
          length: (input as HTMLInputElement).value.length,
        })),
      ).toEqual({ start: 0, end: 5, length: 5 });
      await rail.getByRole("button", { name: "Close settings", exact: true }).click();

      const listBox = await listTab.boundingBox();
      const currentBoardBox = await boardTab.boundingBox();
      if (!listBox || !currentBoardBox) throw new Error("View tab drag geometry is unavailable");
      const dragOverlay = page.locator(
        `[data-database-view-tab-drag-overlay="${configured.listViewId}"]`,
      );
      const dragY = listBox.y + listBox.height / 2;
      await page.mouse.move(listBox.x + listBox.width / 2, dragY);
      await page.mouse.down();
      await page.mouse.move(listBox.x + listBox.width / 2 - 8, dragY, { steps: 2 });
      await expect(toolbar.locator('[data-database-view-tab-dragging="true"]')).toHaveAttribute(
        "data-database-view-tab-sortable",
        configured.listViewId,
      );
      const firstOverlayBox = await dragOverlay.boundingBox();
      await page.mouse.move(listBox.x + listBox.width / 2 - 21, dragY);
      const secondOverlayBox = await dragOverlay.boundingBox();
      if (!firstOverlayBox || !secondOverlayBox) {
        throw new Error("View tab drag overlay geometry is unavailable");
      }
      expect(firstOverlayBox.x - listBox.x).toBeCloseTo(-8, 0);
      expect(firstOverlayBox.y - listBox.y).toBeCloseTo(0, 0);
      expect(secondOverlayBox.x - firstOverlayBox.x).toBeCloseTo(-13, 0);
      expect(secondOverlayBox.y - firstOverlayBox.y).toBeCloseTo(0, 0);
      await captureDatabaseSettingsArtifact(page, "view-tabs-continuous-drag-dark");

      await page.mouse.move(tabListBox.x - 200, dragY);
      const leftBoundedOverlayBox = await dragOverlay.boundingBox();
      if (!leftBoundedOverlayBox) throw new Error("Left-bounded drag geometry is unavailable");
      expect(leftBoundedOverlayBox.x).toBeCloseTo(tabListBox.x, 0);
      await page.mouse.move(tabListBox.x + tabListBox.width + 200, dragY);
      const rightBoundedOverlayBox = await dragOverlay.boundingBox();
      if (!rightBoundedOverlayBox) throw new Error("Right-bounded drag geometry is unavailable");
      expect(rightBoundedOverlayBox.x + rightBoundedOverlayBox.width).toBeCloseTo(
        tabListBox.x + tabListBox.width,
        0,
      );
      await captureDatabaseSettingsArtifact(page, "view-tabs-bounded-drag-dark");

      await page.mouse.move(
        currentBoardBox.x + currentBoardBox.width / 2,
        currentBoardBox.y + currentBoardBox.height / 2,
        { steps: 12 },
      );
      await expect(toolbar).toHaveAttribute(
        "data-database-view-tab-drag-over",
        configured.boardViewId,
      );
      await page.mouse.up();

      await expect
        .poll(() =>
          toolbar
            .locator("[data-database-view-tab-sortable]")
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-database-view-tab-sortable")),
            ),
        )
        .toEqual([configured.listViewId, configured.boardViewId]);
      await captureDatabaseSettingsArtifact(page, "view-tabs-reordered-dark");

      const restarted = await harness.restart();
      await focusSettingsDatabase(restarted);
      await expect
        .poll(() =>
          restarted
            .getByTestId("db-view-toolbar")
            .locator("[data-database-view-tab-sortable]")
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("data-database-view-tab-sortable")),
            ),
        )
        .toEqual([configured.listViewId, configured.boardViewId]);
    },
  );
});

test("View identity stays exact through tab selection, layout conversion, and restart", async () => {
  await withElectronScenario(
    {
      label: "database-settings-view-identity",
      scenarioId: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID,
    },
    async ({ page, manifest, facts, harness }) => {
      if (!manifest || !facts) throw new Error("Database settings scenario did not materialize");
      const configured = requireDatabaseSettingsConfigurationFacts(facts);
      await focusSettingsDatabase(page);
      await expect(
        page.locator(`[data-database-view-id="${configured.boardViewId}"]:visible`),
      ).toBeVisible();

      await page.getByRole("tab", { name: "List", exact: true }).click();
      const activeViewSurface = page.locator(
        `[data-database-view-id="${configured.listViewId}"]:visible`,
      );
      await expect(activeViewSurface).toBeVisible();
      const viewSurfaceBoxBeforeSettings = await activeViewSurface.boundingBox();
      const {
        rail,
        animations: railEnterAnimations,
        devicePixelRatio,
      } = await openSettingsWithEnterMotion(page);
      const opacityEnterAnimation = railEnterAnimations.find(
        (animation) => animation.propertyName === "opacity",
      );
      const transformEnterAnimation = railEnterAnimations.find(
        (animation) => animation.propertyName === "transform",
      );
      expect(opacityEnterAnimation).toMatchObject({ duration: 200, easing: "ease" });
      expect(transformEnterAnimation).toMatchObject({ duration: 200, easing: "ease" });
      expect(opacityEnterAnimation?.keyframes.at(0)?.opacity).toBe("0");
      const initialTranslate = Number.parseFloat(
        String(transformEnterAnimation?.keyframes.at(0)?.transform).match(
          /translateX\(([\d.]+)px\)/,
        )?.[1] ?? "NaN",
      );
      expect(initialTranslate / devicePixelRatio).toBeCloseTo(12, 0);
      expect(transformEnterAnimation?.keyframes.at(-1)?.transform).toContain("0px");
      await page.waitForTimeout(60);
      await captureDatabaseSettingsArtifact(page, "database-settings-rail-enter-motion-dark");
      await expect.poll(() => rail.evaluate((element) => element.getAnimations().length)).toBe(0);
      await expect(rail).toHaveAttribute("data-database-settings-entered", "true");
      await expect(rail).toHaveCSS("opacity", "1");
      await expect(rail).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
      const toolbar = page.getByTestId("db-view-toolbar");
      const toolbarBox = await toolbar.boundingBox();
      const railBox = await rail.boundingBox();
      const railHostBox = await rail.locator("..").boundingBox();
      const railColumnBox = await rail.locator(":scope > div").boundingBox();
      const viewSurfaceBoxWithSettings = await activeViewSurface.boundingBox();
      if (
        !toolbarBox ||
        !railBox ||
        !railHostBox ||
        !railColumnBox ||
        !viewSurfaceBoxBeforeSettings ||
        !viewSurfaceBoxWithSettings
      ) {
        throw new Error("Database settings geometry is unavailable");
      }
      const railPrimaryColor = await rail.evaluate((element) => getComputedStyle(element).color);
      expect(toolbarBox.height).toBeCloseTo(40, 0);
      expect(railBox.y).toBeCloseTo(toolbarBox.y + toolbarBox.height, 0);
      expect(railBox.width).toBeCloseTo(290, 0);
      expect(railBox.x + railBox.width).toBeCloseTo(railHostBox.x + railHostBox.width, 0);
      expect(viewSurfaceBoxWithSettings.width).toBeCloseTo(viewSurfaceBoxBeforeSettings.width, 0);
      const railBorderLeftWidth = await rail.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).borderLeftWidth),
      );
      expect(railColumnBox.width).toBeCloseTo(railBox.width - railBorderLeftWidth, 0);
      expect(railColumnBox.x + railColumnBox.width).toBeCloseTo(railBox.x + railBox.width, 0);
      const viewNameInput = rail.getByRole("textbox", { name: "View name", exact: true });
      const viewNameInputStyle = await readCompactFramedInputStyle(viewNameInput);
      const viewNameInputBox = await viewNameInput.boundingBox();
      const viewIdentityFrameBox = await rail
        .getByTestId("database-settings-view-identity-icon")
        .boundingBox();
      if (!viewNameInputBox || !viewIdentityFrameBox) {
        throw new Error("View rename geometry is unavailable");
      }
      expect(viewNameInputBox.height).toBeCloseTo(28, 0);
      expect(
        viewNameInputBox.x - (viewIdentityFrameBox.x + viewIdentityFrameBox.width),
      ).toBeCloseTo(8, 0);
      expect(viewNameInputStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(viewNameInputStyle.borderRadius).toBe("6px");
      expect(viewNameInputStyle.borderTopWidth).toBe("1px");
      expect(await viewNameInput.evaluate((element) => getComputedStyle(element).color)).toBe(
        railPrimaryColor,
      );
      expect(viewNameInputStyle.fontSize).toBe("14px");
      expect(viewNameInputStyle.lineHeight).toBe("20px");
      const rootTitle = rail.getByRole("heading", { name: "View settings", exact: true });
      await expect(rootTitle).toHaveCSS("font-size", "12px");
      await expect(rootTitle).toHaveCSS("font-weight", "500");
      const layoutRow = rail.getByRole("button", { name: /^Layout/ }).first();
      expect((await layoutRow.boundingBox())?.height).toBeCloseTo(28, 0);
      await expect(layoutRow).toHaveCSS("font-size", "14px");
      await expect(layoutRow).toHaveCSS("font-weight", "400");
      await expect(layoutRow).toHaveCSS("line-height", "16.8px");
      await expect(layoutRow).toHaveCSS("color", railPrimaryColor);
      await expect(layoutRow.locator("svg").first()).toHaveCSS("color", railPrimaryColor);
      const identityIconBox = await rail
        .getByTestId("database-settings-view-identity-icon")
        .locator("svg")
        .first()
        .boundingBox();
      const layoutIconBox = await layoutRow.locator("svg").first().boundingBox();
      if (!identityIconBox || !layoutIconBox) {
        throw new Error("Database settings icon geometry is unavailable");
      }
      expect(viewIdentityFrameBox.width).toBeCloseTo(24, 0);
      expect(identityIconBox.width).toBeCloseTo(16, 0);
      expect(layoutIconBox.width).toBeCloseTo(16, 0);
      expect(identityIconBox.x).toBeCloseTo(layoutIconBox.x, 0);
      await captureDatabaseSettingsArtifact(page, "database-settings-root-nodex-chrome-dark");
      await rail.getByRole("button", { name: /Property visibility/ }).click();
      const hideAllButton = rail.getByRole("button", { name: "Hide all", exact: true });
      await expect(hideAllButton).toHaveCSS("color", "rgb(131, 195, 255)");
      const namePropertyRow = rail.locator('[data-property-id="name"]');
      const shownPropertyRow = rail
        .locator("[data-property-id]")
        .filter({ hasText: "Scenario select 4" });
      const hiddenPropertyRow = rail
        .locator("[data-property-id]")
        .filter({ hasText: "Scenario text 1" });
      await expect(namePropertyRow).toBeVisible();
      await expect(namePropertyRow.locator("[data-property-drag-handle]")).toHaveCount(0);
      await expect(namePropertyRow).not.toHaveAttribute("draggable", "true");
      await expect(
        namePropertyRow.getByRole("button", { name: "Name is always visible" }),
      ).toBeDisabled();
      await expect(shownPropertyRow).toHaveAttribute("data-property-sortable");
      await expect(shownPropertyRow.locator("[data-property-drag-handle]")).toHaveCount(1);
      await expect(hiddenPropertyRow).toHaveAttribute("data-property-sortable");
      await expect(hiddenPropertyRow.locator("[data-property-drag-handle]")).toHaveCount(1);
      const nameIconBox = await namePropertyRow.getByText("Aa", { exact: true }).boundingBox();
      const shownPropertyIconBox = await shownPropertyRow.locator("svg").nth(1).boundingBox();
      if (!nameIconBox || !shownPropertyIconBox) {
        throw new Error("Property visibility icon geometry is unavailable");
      }
      expect(nameIconBox.width).toBeCloseTo(16, 0);
      expect(shownPropertyIconBox.width).toBeCloseTo(16, 0);
      expect(nameIconBox.x).toBeCloseTo(shownPropertyIconBox.x, 0);
      await captureDatabaseSettingsArtifact(page, "database-settings-properties-nodex-chrome-dark");

      const [hiddenPropertyBox, hiddenHandleBox, shownPropertyBox] = await Promise.all([
        hiddenPropertyRow.boundingBox(),
        hiddenPropertyRow.locator("[data-property-drag-handle]").boundingBox(),
        shownPropertyRow.boundingBox(),
      ]);
      const hiddenPropertyId = await hiddenPropertyRow.getAttribute("data-property-id");
      const shownPropertyId = await shownPropertyRow.getAttribute("data-property-id");
      if (
        !hiddenPropertyBox ||
        !hiddenHandleBox ||
        !shownPropertyBox ||
        !hiddenPropertyId ||
        !shownPropertyId
      ) {
        throw new Error("Property visibility drag geometry is unavailable");
      }
      const hiddenHandleCenter = {
        x: hiddenHandleBox.x + hiddenHandleBox.width / 2,
        y: hiddenHandleBox.y + hiddenHandleBox.height / 2,
      };
      const propertyDragOverlay = page.locator(
        `[data-property-visibility-drag-overlay="${hiddenPropertyId}"]`,
      );
      const restingDropChrome = {
        hideAllColor: await hideAllButton.evaluate((element) => getComputedStyle(element).color),
        hideAllOpacity: await hideAllButton.evaluate(
          (element) => getComputedStyle(element).opacity,
        ),
        handleColor: await hiddenPropertyRow
          .locator("[data-property-drag-handle]")
          .evaluate((element) => getComputedStyle(element).color),
      };
      await rail.evaluate((element, propertyId) => {
        const observer = new MutationObserver(() => {
          if (element.getAttribute("data-database-presentation-activity") !== "saving") return;
          const hideAll = [...element.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Hide all",
          );
          const handle = [...element.querySelectorAll("[data-property-drag-handle]")].find(
            (candidate) => candidate.getAttribute("data-property-drag-handle") === propertyId,
          );
          const save = [...element.querySelectorAll("button")].find(
            (button) => button.textContent?.trim() === "Save for everyone",
          );
          if (!hideAll || !handle || !save) return;
          element.setAttribute(
            "data-e2e-saving-style",
            JSON.stringify({
              hideAllColor: getComputedStyle(hideAll).color,
              hideAllOpacity: getComputedStyle(hideAll).opacity,
              hideAllDisabled: hideAll.disabled,
              handleColor: getComputedStyle(handle).color,
              saveDisabled: save.disabled,
            }),
          );
          observer.disconnect();
        });
        observer.observe(element, {
          attributes: true,
          attributeFilter: ["data-database-presentation-activity"],
        });
      }, hiddenPropertyId);
      await page.mouse.move(hiddenHandleCenter.x, hiddenHandleCenter.y);
      await page.mouse.down();
      await page.mouse.move(hiddenHandleCenter.x, hiddenHandleCenter.y - 5);
      await expect(propertyDragOverlay).toHaveCount(0);
      await page.mouse.move(hiddenHandleCenter.x, hiddenHandleCenter.y - 8, { steps: 2 });
      await expect(rail.locator('[data-property-dragging="true"]')).toHaveAttribute(
        "data-property-id",
        hiddenPropertyId,
      );
      const firstPropertyOverlayBox = await propertyDragOverlay.boundingBox();
      await page.mouse.move(hiddenHandleCenter.x + 20, hiddenHandleCenter.y - 21);
      const secondPropertyOverlayBox = await propertyDragOverlay.boundingBox();
      if (!firstPropertyOverlayBox || !secondPropertyOverlayBox) {
        throw new Error("Property visibility drag overlay geometry is unavailable");
      }
      expect(firstPropertyOverlayBox.y - hiddenPropertyBox.y).toBeCloseTo(-8, 0);
      expect(firstPropertyOverlayBox.x - hiddenPropertyBox.x).toBeCloseTo(0, 0);
      expect(secondPropertyOverlayBox.y - firstPropertyOverlayBox.y).toBeCloseTo(-13, 0);
      expect(secondPropertyOverlayBox.x - firstPropertyOverlayBox.x).toBeCloseTo(0, 0);

      await page.mouse.move(
        shownPropertyBox.x + shownPropertyBox.width / 2,
        shownPropertyBox.y + shownPropertyBox.height / 2,
        { steps: 12 },
      );
      await expect(rail.locator("[data-property-visibility-drag-over]")).toHaveAttribute(
        "data-property-visibility-drag-over",
        shownPropertyId,
      );
      await expect(shownPropertyRow).not.toHaveCSS("transform", "none");
      await captureDatabaseSettingsArtifact(page, "property-visibility-continuous-drag-dark");
      await page.mouse.up();
      await expect.poll(() => rail.getAttribute("data-e2e-saving-style")).not.toBeNull();
      const savingDropChrome = JSON.parse(
        (await rail.getAttribute("data-e2e-saving-style")) ?? "null",
      ) as typeof restingDropChrome & {
        readonly hideAllDisabled: boolean;
        readonly saveDisabled: boolean;
      };
      expect(savingDropChrome).toEqual({
        ...restingDropChrome,
        hideAllDisabled: false,
        saveDisabled: false,
      });
      await captureDatabaseSettingsArtifact(page, "property-visibility-drop-handoff-stable-dark");
      await expect(
        hiddenPropertyRow.getByRole("button", { name: "Hide Scenario text 1", exact: true }),
      ).toBeVisible();
      await captureDatabaseSettingsArtifact(page, "property-visibility-reordered-dark");

      await rail.getByRole("button", { name: "Back", exact: true }).click();
      await rail.getByRole("button", { name: /Layout/ }).click();
      await expect(rail.getByRole("heading", { name: "Layout" })).toBeVisible();
      await expect(rail.getByRole("button", { name: "List", exact: true })).toHaveCSS(
        "color",
        "rgb(131, 195, 255)",
      );
      await rail.getByRole("button", { name: "Board", exact: true }).click();
      await rail.getByRole("button", { name: "Convert", exact: true }).click();
      await expect(
        page.locator(`[data-database-view-id="${configured.listViewId}"]:visible`),
      ).toBeVisible();
      await expect(rail.getByRole("button", { name: "Board", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await rail.getByRole("button", { name: "Close settings", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Database settings", exact: true }),
      ).toBeFocused();
      await expect
        .poll(
          async () =>
            await page.evaluate(async (viewId) => {
              const api = (
                window as unknown as {
                  api: { invoke: (channel: string, ...args: unknown[]) => Promise<unknown> };
                }
              ).api;
              return JSON.stringify(await api.invoke("window-sessions:bootstrap")).includes(viewId);
            }, configured.listViewId),
        )
        .toBe(true);

      await page.emulateMedia({ reducedMotion: "reduce" });
      const reducedMotionRail = await openSettings(page);
      await expect(reducedMotionRail).toHaveCSS("transition-duration", "0.001s");
      await expect(reducedMotionRail).toHaveCSS("opacity", "1");
      await expect(reducedMotionRail).toHaveCSS("transform", "matrix(1, 0, 0, 1, 0, 0)");
      await reducedMotionRail.getByRole("button", { name: "Close settings", exact: true }).click();
      await page.emulateMedia({ reducedMotion: "no-preference" });

      const restarted = await harness.restart();
      await focusSettingsDatabase(restarted);
      await expect(
        restarted.locator(`[data-database-view-id="${configured.listViewId}"]:visible`),
      ).toBeVisible();
    },
  );
});

test("Property settings create, edit options, delete dependencies, and restore identity", async () => {
  await withElectronScenario(
    {
      label: "database-settings-property-lifecycle",
      scenarioId: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID,
    },
    async ({ page, manifest }) => {
      if (!manifest) throw new Error("Database settings scenario did not materialize");
      await focusSettingsDatabase(page);
      const rail = await openSettings(page);
      await rail.getByRole("button", { name: /Edit properties/ }).click();
      await rail.getByRole("button", { name: /New property/ }).click();
      const newPropertyNameInput = rail.getByRole("textbox", { name: "Name", exact: true });
      const newPropertyNameInputStyle = await readCompactFramedInputStyle(newPropertyNameInput);
      expect((await newPropertyNameInput.boundingBox())?.height).toBeCloseTo(28, 0);
      expect(newPropertyNameInputStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
      expect(newPropertyNameInputStyle.borderRadius).toBe("6px");
      expect(newPropertyNameInputStyle.borderTopWidth).toBe("1px");
      expect(newPropertyNameInputStyle.fontSize).toBe("14px");
      expect(newPropertyNameInputStyle.lineHeight).toBe("20px");
      await captureDatabaseSettingsArtifact(page, "database-settings-new-property-input-dark");
      await newPropertyNameInput.fill("E2E choice");
      await rail.getByRole("button", { name: "Select", exact: true }).click();
      await expect(rail.getByLabel("Property name")).toHaveValue("E2E choice");
      await rail.getByRole("button", { name: "Back", exact: true }).click();

      await rail.getByRole("button", { name: /Scenario select 4/ }).click();
      await rail.getByRole("button", { name: /Options/ }).click();
      await rail.getByLabel("New option name").fill("Gamma");
      await rail.getByRole("button", { name: "Add option", exact: true }).click();
      await expect(rail.getByRole("textbox", { name: "Option Gamma", exact: true })).toHaveValue(
        "Gamma",
      );
      await rail.getByRole("textbox", { name: "Option Alpha", exact: true }).fill("First");
      await rail.getByRole("textbox", { name: "Option Alpha", exact: true }).press("Enter");
      await expect(rail.getByRole("textbox", { name: "Option First", exact: true })).toHaveValue(
        "First",
      );
      await rail.getByRole("button", { name: "Color for First", exact: true }).click();
      await page.getByRole("menuitem", { name: "red", exact: true }).click();
      await expect(
        rail.getByRole("button", { name: "Color for First", exact: true }),
      ).toContainText("red");
      await rail.getByRole("button", { name: "Move option Gamma up", exact: true }).click();
      await expect
        .poll(
          async () =>
            await rail
              .locator('input[aria-label^="Option "]')
              .evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value)),
        )
        .toEqual(["First", "Gamma", "Beta"]);
      await rail.getByRole("button", { name: "Back", exact: true }).click();
      await expect(rail.getByLabel("Property name")).toHaveValue("Scenario select 4");
      await rail.getByRole("button", { name: /Delete property/ }).click();
      await expect(rail).toContainText("References in 2 Views");
      await rail.getByRole("button", { name: "Delete", exact: true }).click();
      await rail.getByRole("button", { name: /Deleted properties/ }).click();
      const deletedRow = rail.getByText("Scenario select 4", { exact: true }).locator("..");
      await expect(deletedRow).toContainText("Restore");
      await deletedRow.getByRole("button", { name: "Restore", exact: true }).click();
      await expect(rail.getByText("Scenario select 4", { exact: true })).toHaveCount(0);
      await expect(rail.getByText("Recoverable scenario Property", { exact: true })).toBeVisible();
      await rail.getByRole("button", { name: "Back", exact: true }).click();
      await expect(rail.getByRole("button", { name: /Scenario select 4/ })).toBeVisible();
      await expect(rail.getByRole("button", { name: /E2E choice/ })).toBeVisible();
    },
  );
});

test("Page layout visibility remains independent and durable across restart", async () => {
  await withElectronScenario(
    {
      label: "database-settings-page-layout",
      scenarioId: DATABASE_SETTINGS_CONFIGURATION_SCENARIO_ID,
    },
    async ({ page, manifest, harness }) => {
      if (!manifest) throw new Error("Database settings scenario did not materialize");
      let currentPage = page;
      await focusSettingsDatabase(currentPage);
      let rail = await openSettings(currentPage);
      await rail.getByRole("button", { name: /Customize page layout/ }).click();
      await expect(
        rail.getByRole("button", { name: "Page visibility for Scenario text 1" }),
      ).toContainText("Hide when empty");
      await expect(
        rail.getByRole("button", { name: "Page visibility for Scenario checkbox 3" }),
      ).toContainText("Always hide");
      await rail.getByRole("button", { name: "Page visibility for Scenario text 1" }).click();
      await currentPage.getByRole("menuitem", { name: "Always hide", exact: true }).click();
      await expect(
        rail.getByRole("button", { name: "Page visibility for Scenario text 1" }),
      ).toContainText("Always hide");
      await rail.getByRole("button", { name: "Close settings", exact: true }).click();

      currentPage = await harness.restart();
      await focusSettingsDatabase(currentPage);
      rail = await openSettings(currentPage);
      await rail.getByRole("button", { name: /Customize page layout/ }).click();
      await expect(
        rail.getByRole("button", { name: "Page visibility for Scenario text 1" }),
      ).toContainText("Always hide");
      await rail.getByRole("button", { name: "Close settings", exact: true }).click();

      const configuredPageId = manifest.pageIdsByKey.configured;
      if (!configuredPageId) throw new Error("Configured Page identity is missing");
      const card = currentPage.locator(`[data-board-uuid-v7="${configuredPageId}"]`);
      await card.locator('[data-card-context-menu-trigger="true"]').click();
      const properties = currentPage.getByRole("region", { name: "Properties" });
      await expect(properties.getByText("Scenario text 1", { exact: true })).toHaveCount(0);
      const disclosure = properties.getByRole("button", { name: /more properties/ });
      await disclosure.click();
      await expect(properties.getByText("Scenario text 1", { exact: true })).toBeVisible();
    },
  );
});
