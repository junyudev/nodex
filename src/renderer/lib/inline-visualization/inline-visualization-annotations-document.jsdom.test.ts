import { act, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vite-plus/test";
import { buildInlineVisualizationDocument } from "./inline-visualization-document";
import { createInlineVisualizationAnnotations } from "./inline-visualization-annotations";
import { VISUALIZATION_ANNOTATION_TOOL } from "../../../shared/codex-visualization-annotations";
import type { VisualizationAnnotationCommand } from "../../../shared/codex-visualization-annotations";

const frames: HTMLIFrameElement[] = [];
const guestErrors: string[] = [];
afterEach(async () => {
  await act(async () => {
    for (const frame of frames.splice(0)) {
      frame.contentWindow?.dispatchEvent(new Event("pagehide"));
      await Promise.resolve();
      frame.remove();
    }
    await Promise.resolve();
  });
  expect(guestErrors.splice(0)).toEqual([]);
});
const fragment = `<section id="chart" aria-label="Chart"><button id="counter">Count</button></section><button id="outside">Outside</button><div class="viz-carousel" id="variants"><section data-variant="Bars" id="bars"></section><section data-variant="Dots" id="dots" hidden></section></div><script>
window.settings={radius:10,color:'#112233',details:true,density:'compact'};window.count=0;
document.getElementById('counter').onclick=()=>window.count++;
new Tweak({container:document.getElementById('chart'),onChange:()=>document.getElementById('chart').dataset.preview=JSON.stringify(settings)}).addSlider(settings,'radius',{min:0,max:100}).addColorPicker(settings,'color').addToggle(settings,'details').addSelect(settings,'density',{options:['compact','relaxed']});
new Tweak({container:document.getElementById('bars')}).addSlider({size:3},'size',{min:0,max:10});
new Tweak({container:document.getElementById('dots')}).addSlider({size:5},'size',{min:0,max:10});
</script>`;

function mount(allowed = true, authored = fragment) {
  const frame = document.createElement("iframe");
  document.body.append(frame);
  frames.push(frame);
  const guest = frame.contentWindow! as Window &
    typeof globalThis & {
      openai: { callTool: (name: string, input: unknown) => Promise<unknown> };
      settings: Record<string, unknown>;
      count: number;
    };
  guest.Range.prototype.getBoundingClientRect = () => new guest.DOMRect();
  guest.addEventListener("error", (event) => {
    guestErrors.push(event.message);
    event.preventDefault();
  });
  const owner = createInlineVisualizationAnnotations({
    allowed,
    globals: (command: VisualizationAnnotationCommand | null) =>
      guest.dispatchEvent(
        new guest.CustomEvent("openai:set_globals", {
          detail: { globals: { visualizationAnnotation: command } },
        }),
      ),
  });
  Object.assign(guest, {
    openai: {
      callTool: async (name: string, value: unknown) =>
        name === VISUALIZATION_ANNOTATION_TOOL ? owner.handleMessage(value) : undefined,
    },
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
  });
  guest.document.open();
  guest.document.write(
    buildInlineVisualizationDocument(
      allowed ? authored : '<div class="viz-carousel" id="variants"></div>',
      { allowAnnotations: allowed },
    ),
  );
  guest.document.close();
  owner.setPresentation({ active: true, ready: true, preview: false });
  return { guest, owner };
}
test("Tweak accepts all four bindings before authored code, previews and restores real objects, and intercepts only editing target clicks", async () => {
  const { guest, owner } = mount();
  await waitFor(() => expect(owner.getSnapshot().rows[0]?.controls.controls).toHaveLength(4));
  await act(async () => {
    owner.open();
    owner.change("tweak-1-1", 40);
    owner.change("tweak-1-2", "#aabbcc");
    owner.change("tweak-1-3", false);
    owner.change("tweak-1-4", "relaxed");
    await Promise.resolve();
  });
  expect(guest.settings).toEqual({
    radius: 40,
    color: "#aabbcc",
    details: false,
    density: "relaxed",
  });
  const counter = guest.document.getElementById("counter")!;
  await act(async () => {
    counter.dispatchEvent(
      new guest.MouseEvent("click", { bubbles: true, composed: true, cancelable: true, button: 0 }),
    );
    await Promise.resolve();
  });
  expect(guest.count).toBe(0);
  await act(async () => {
    owner.reset();
    await Promise.resolve();
  });
  expect(guest.settings.radius).toBe(10);
  await act(async () => {
    guest.document
      .getElementById("outside")!
      .dispatchEvent(new guest.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    await Promise.resolve();
  });
  expect(owner.getSnapshot().open).toBe(false);
  await act(async () => {
    counter.dispatchEvent(
      new guest.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
    );
    await Promise.resolve();
  });
  expect(guest.count).toBe(1);
});
test("carousel variants work without Tweak and removal clears their model context", async () => {
  const { guest, owner } = mount(false);
  await act(async () => {
    guest.document.getElementById("variants")!.setAttribute("data-active-variant", "Dots");
    await Promise.resolve();
  });
  expect(owner.getSnapshot().rows).toHaveLength(0);
  expect(owner.getSnapshot().visible).toBe(false);
  await act(async () => {
    guest.document.getElementById("variants")!.remove();
    await Promise.resolve();
  });
  expect(owner.getSnapshot().hasEdits).toBe(false);
});
test("hidden carousel targets update eligibility without losing an accepted registration", async () => {
  const { guest, owner } = mount();
  await waitFor(() => expect(owner.getSnapshot().rows).toHaveLength(3));
  expect(owner.getSnapshot().rows.map((row) => row.visible)).toEqual([true, true, false]);
  await act(async () => {
    guest.document.getElementById("bars")!.hidden = true;
    guest.document.getElementById("dots")!.hidden = false;
    await Promise.resolve();
  });
  await waitFor(() =>
    expect(owner.getSnapshot().rows.map((row) => row.visible)).toEqual([true, false, true]),
  );
  await act(async () => {
    guest.document.getElementById("chart")!.remove();
    await Promise.resolve();
  });
  await waitFor(() => expect(owner.getSnapshot().rows).toHaveLength(2));
});
test("a rejected authored binding cannot change the first accepted control's callback identity", async () => {
  const { guest, owner } = mount(
    true,
    `<section id="chart"></section><script>
  window.settings={details:true};
  const panel=new Tweak({container:document.getElementById('chart')});
  try{panel.addSlider({radius:200},'radius',{min:0,max:100})}catch{}
  panel.addToggle(settings,'details');
  </script>`,
  );
  await waitFor(() => expect(owner.getSnapshot().rows[0]?.controls.controls).toHaveLength(1));
  await act(async () => {
    owner.open();
    owner.change("tweak-1-1", false);
    await Promise.resolve();
  });
  expect(guest.settings.details).toBe(false);
});
