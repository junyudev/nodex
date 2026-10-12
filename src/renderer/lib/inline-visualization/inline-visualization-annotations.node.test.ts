import { expect, test, vi } from "vite-plus/test";
import { createInlineVisualizationAnnotations } from "./inline-visualization-annotations";
import { canExpandInlineVisualization } from "./inline-visualization-presentation";

const registration = (id = "first", targetId = "target") => ({
  type: "register",
  registrationId: id,
  targets: [
    {
      id: targetId,
      label: "Chart",
      selector: "#chart",
      tagName: "section",
      rect: { x: 0, y: 0, width: 200, height: 100 },
    },
  ],
  annotationControls: {
    controls: [
      {
        type: "range",
        callback: "Radius",
        label: "Radius",
        reference: "chart.radius",
        min: 0,
        max: 100,
        step: 1,
        currentValue: 10,
      },
      {
        type: "select",
        callback: "Density",
        label: "Density",
        currentValue: "compact",
        options: [
          { label: "Compact", value: "compact" },
          { label: "Relaxed", value: "relaxed" },
        ],
      },
    ],
  },
});

test("accepted controls preview, reset and submit only labelled untrusted context while body writes stay transient", async () => {
  const globals = vi.fn(),
    persist = vi.fn(async (_context: unknown) => {}),
    submit = vi.fn(async (_message: unknown) => {});
  const owner = createInlineVisualizationAnnotations({ allowed: true, globals, persist, submit });
  owner.handleMessage(registration());
  owner.setPresentation({ active: true, preview: false, ready: true });
  owner.open();
  owner.change("Radius", 40);
  owner.change("Density", "relaxed");
  expect(globals.mock.lastCall?.[0]).toMatchObject({
    active: true,
    changes: [
      {
        annotationControlChanges: expect.arrayContaining([
          { callback: "Radius", previousValue: 10, value: 40 },
        ]),
      },
    ],
  });
  const writes = persist.mock.calls.length;
  const globalUpdates = globals.mock.calls.length;
  owner.setBody("Please keep the colors");
  expect(persist.mock.calls).toHaveLength(writes);
  expect(globals.mock.calls).toHaveLength(globalUpdates);
  owner.handleMessage({ type: "dispose", registrationId: "unknown" });
  expect(persist.mock.calls).toHaveLength(writes);
  await owner.submit();
  expect(submit.mock.lastCall?.[0]).toEqual({
    prompt: "Please keep the colors",
    title: "Visualization changes",
    context: {
      edits: [
        {
          target: "Chart",
          changes: [
            { label: "Radius", reference: "chart.radius", value: 40 },
            { label: "Density", reference: null, value: "Relaxed" },
          ],
        },
      ],
    },
  });
  expect(owner.getSnapshot().open).toBe(false);
  owner.open();
  owner.handleMessage({ type: "variants", selectedVariants: [{ carousel: 0, variant: "Dots" }] });
  owner.reset();
  expect(owner.getSnapshot().hasEdits).toBe(false);
  expect(persist.mock.lastCall?.[0]).toEqual({
    edits: [],
    selectedVariants: [{ carousel: 0, variant: "Dots" }],
  });
});

test("a registration update invalidates stale drafts; last target ownership and disposal fence detached edits", () => {
  const owner = createInlineVisualizationAnnotations({ allowed: true, globals: () => {} });
  owner.handleMessage(registration());
  owner.setPresentation({ active: true, preview: false, ready: true });
  owner.open();
  owner.change("Radius", 40);
  const next = registration();
  next.annotationControls.controls[0]!.currentValue = 20;
  owner.handleMessage({ ...next, type: "update" });
  expect(owner.getSnapshot().hasEdits).toBe(false);
  owner.handleMessage(registration("second"));
  expect(owner.getSnapshot().rows.map((row) => row.registrationId)).toEqual(["second"]);
  expect(() => owner.handleMessage(registration("second"))).toThrow("cannot call tools");
  owner.handleMessage({ type: "dispose", registrationId: "second" });
  expect(owner.getSnapshot().rows.map((row) => row.registrationId)).toEqual(["first"]);
  owner.dispose();
  expect(() => owner.handleMessage(registration("late"))).toThrow("cannot call tools");
});

test("bounds are admitted synchronously and denied calls do not consume capacity", () => {
  const owner = createInlineVisualizationAnnotations({ allowed: true, globals: () => {} });
  for (let index = 0; index < 64; index++)
    owner.handleMessage(registration(`r${index}`, `t${index}`));
  expect(() => owner.handleMessage(registration("overflow"))).toThrow();
  owner.handleMessage({ type: "dispose", registrationId: "r0" });
  expect(() => owner.handleMessage(registration("overflow"))).not.toThrow();
  const invalid = registration("invalid");
  invalid.annotationControls.controls[0]!.step = 0;
  expect(() => owner.handleMessage({ ...invalid, type: "update", registrationId: "r1" })).toThrow();
  owner.setPresentation({ active: true, preview: false, ready: true });
  owner.open();
  owner.change("Radius", 1000);
  expect(owner.getSnapshot().hasEdits).toBe(false);
});

test("total targets and serialized controls are bounded before acknowledgement", () => {
  const owner = createInlineVisualizationAnnotations({ allowed: true, globals: () => {} });
  const create = (index: number, count: number) => ({
    ...registration(`r${index}`, `t${index}`),
    targets: Array.from({ length: count }, (_, target) => ({
      ...registration().targets[0]!,
      id: `r${index}t${target}`,
    })),
  });
  for (let index = 0; index < 8; index++) owner.handleMessage(create(index, 128));
  expect(() => owner.handleMessage(create(8, 1))).toThrow();
  owner.handleMessage({ ...create(0, 1), type: "update" });
  expect(() => owner.handleMessage(create(8, 127))).not.toThrow();
  const options = Array.from({ length: 12 }, (_, index) => ({
    label: `Option ${index}`,
    value: `${index}` + "x".repeat(500),
  }));
  expect(() =>
    owner.handleMessage({
      ...create(9, 1),
      annotationControls: {
        controls: Array.from({ length: 3 }, (_, index) => ({
          type: "select",
          label: "Selection",
          callback: `Select${index}`,
          currentValue: options[0]!.value,
          options,
        })),
      },
    }),
  ).toThrow();
});

test("variants persist independently of annotations and preview/inactive gates do not clear context", async () => {
  const persist = vi.fn(async (_context: unknown) => {}),
    submit = vi.fn(async () => {
      throw new Error("offline");
    });
  const disabled = createInlineVisualizationAnnotations({
    allowed: false,
    globals: () => {},
    persist,
  });
  expect(() => disabled.handleMessage(registration())).toThrow();
  disabled.handleMessage({
    type: "variants",
    selectedVariants: [{ carousel: 0, variant: "Bars" }],
  });
  expect(persist.mock.lastCall?.[0]).toEqual({
    edits: [],
    selectedVariants: [{ carousel: 0, variant: "Bars" }],
  });
  const owner = createInlineVisualizationAnnotations({
    allowed: true,
    globals: () => {},
    persist,
    submit,
  });
  owner.handleMessage(registration());
  owner.setPresentation({ active: true, preview: false, ready: true });
  owner.open();
  owner.change("Radius", 40);
  await expect(owner.submit()).rejects.toThrow("offline");
  expect(owner.getSnapshot().open).toBe(true);
  const writes = persist.mock.calls.length;
  owner.setPresentation({ active: false, preview: false, ready: true });
  expect(owner.getSnapshot()).toMatchObject({ visible: false, open: false, hasEdits: true });
  expect(persist.mock.calls).toHaveLength(writes);
  expect(() =>
    owner.handleMessage({ type: "select", registrationId: "first", targetId: "target" }),
  ).toThrow();
  owner.setPresentation({ active: true, preview: true, ready: true });
  expect(owner.getSnapshot().visible).toBe(false);
  expect(canExpandInlineVisualization({ mode: "wide", variant: "inline" })).toBe(true);
  expect(canExpandInlineVisualization({ mode: "wide", variant: "live" })).toBe(false);
  expect(canExpandInlineVisualization({ mode: "wide", htmlStreaming: true })).toBe(false);
});
