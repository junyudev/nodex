/**
 * jsdom runs animation frames on one Node interval that it starts with the first queued callback
 * and stops when none remain. Under the forks pool that interval comes from the global timers, so a
 * frame requested while a test fakes them lands on a clock that disappears with the fake timers,
 * and jsdom never starts another: every later frame in the file waits forever. Motion captures the
 * frame function when it loads, so any animation under fake timers can strand it.
 *
 * Frames here run on the real timers captured before any test runs, as jsdom's already do in the VM
 * pool. This file runs before anything that loads Motion; a test that fakes timers still fakes
 * frames while they are fake.
 */
const setRealTimeout = globalThis.setTimeout.bind(globalThis);
const clearRealTimeout = globalThis.clearTimeout.bind(globalThis);
const now = performance.now.bind(performance);
const callbacks = new Map<number, FrameRequestCallback>();
let frame: ReturnType<typeof setTimeout> | null = null;
let lastHandle = 0;

function runFrame() {
  frame = null;
  const timestamp = now();
  // Callbacks requested while this frame runs belong to the next one, as in a browser.
  for (const [handle, callback] of [...callbacks]) {
    if (!callbacks.delete(handle)) continue;
    try {
      callback(timestamp);
    } catch (error) {
      queueMicrotask(() => {
        throw error;
      });
    }
  }
}

function requestAnimationFrame(callback: FrameRequestCallback): number {
  lastHandle += 1;
  callbacks.set(lastHandle, callback);
  frame ??= setRealTimeout(runFrame, 1000 / 60);
  return lastHandle;
}

function cancelAnimationFrame(handle: number): void {
  callbacks.delete(handle);
  if (callbacks.size > 0 || frame === null) return;
  clearRealTimeout(frame);
  frame = null;
}

for (const target of new Set<object>([globalThis, window])) {
  Object.assign(target, { requestAnimationFrame, cancelAnimationFrame });
}
