import type { ElectronApplication } from "@playwright/test";

/** Public fixture DOM identifies the owned document; inspection never invokes its application callbacks. */
export async function readOwnedWidget<T>(
  application: ElectronApplication,
  guestId: number,
  marker: string,
  expression: string,
): Promise<T> {
  return (await application.evaluate(
    async ({ webContents }, input) => {
      const guest = webContents.fromId(input.guestId);
      if (!guest || guest.isDestroyed()) throw new Error("Owned widget was released");
      for (const frame of guest.mainFrame.framesInSubtree) {
        if (
          !(await frame
            .executeJavaScript(`Boolean(document.getElementById(${JSON.stringify(input.marker)}))`)
            .catch(() => false))
        )
          continue;
        return await frame.executeJavaScript(input.expression);
      }
      throw new Error("Owned fixture document is unavailable");
    },
    { guestId, marker, expression },
  )) as T;
}

/** Native guest input uses its DIP coordinates, including each public embedding iframe's content origin. */
export async function clickOwnedWidget(
  application: ElectronApplication,
  guestId: number,
  marker: string,
  selector: string,
) {
  await application.evaluate(
    async ({ webContents }, input) => {
      const guest = webContents.fromId(input.guestId);
      if (!guest || guest.isDestroyed()) throw new Error("Owned widget was released");
      for (const frame of guest.mainFrame.framesInSubtree) {
        const belongs = await frame
          .executeJavaScript(`Boolean(document.getElementById(${JSON.stringify(input.marker)}))`)
          .catch(() => false);
        if (!belongs) continue;
        const point = (await frame.executeJavaScript(
          `(async()=>{await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const button=document.querySelector(${JSON.stringify(input.selector)});if(!button)throw new Error('Fixture control missing');const box=button.getBoundingClientRect(),x=box.left+box.width/2,y=box.top+box.height/2;if(!box.width||!box.height||x<0||y<0||x>=innerWidth||y>=innerHeight||!button.contains(document.elementFromPoint(x,y)))throw new Error('Fixture control is not the visible hit target');return{x,y};})()`,
        )) as { x: number; y: number };
        let current = frame;
        while (current.parent) {
          const parent = current.parent;
          const owners = (await parent.executeJavaScript(
            `Array.from(document.querySelectorAll('iframe,frame')).map(element=>{const box=element.getBoundingClientRect();return{src:element.src,name:element.name,x:box.left+element.clientLeft,y:box.top+element.clientTop}})`,
          )) as { src: string; name: string; x: number; y: number }[];
          const owner =
            owners.find((candidate) => current.name && candidate.name === current.name) ??
            owners.find((candidate) => candidate.src === current.url) ??
            (owners.length === 1 && parent.frames.length === 1 ? owners[0] : undefined);
          if (!owner) throw new Error("Owned frame has no unique public iframe rectangle");
          point.x += owner.x;
          point.y += owner.y;
          current = parent;
        }
        const x = Math.round(point.x),
          y = Math.round(point.y);
        guest.sendInputEvent({ type: "mouseMove", x, y });
        guest.sendInputEvent({ type: "mouseDown", x, y, button: "left", clickCount: 1 });
        guest.sendInputEvent({ type: "mouseUp", x, y, button: "left", clickCount: 1 });
        return;
      }
      throw new Error("Owned fixture control was not available for native input");
    },
    { guestId, marker, selector },
  );
}
