export interface LocalConversationNativeFindScroll {
  readonly resume: () => void;
  readonly cancel: () => void;
}

function scrollPadding(value: string, height: number): number {
  const amount = Number.parseFloat(value);
  if (!Number.isFinite(amount)) return 0;
  return value.endsWith("%") ? (amount * height) / 100 : amount;
}

/** Native center may stop at either scroll boundary instead of reaching the padded center. */
function isPositioned(scrollElement: HTMLElement, target: HTMLElement): boolean {
  const viewport = scrollElement.getBoundingClientRect();
  const rect = target.getBoundingClientRect();
  if (viewport.height <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(scrollElement);
  const scale = scrollElement.offsetHeight > 0 ? viewport.height / scrollElement.offsetHeight : 1;
  const height = scrollElement.clientHeight * scale;
  const top = viewport.top + scrollElement.clientTop * scale;
  const paddedTop = top + scrollPadding(style.scrollPaddingTop, scrollElement.clientHeight) * scale;
  const paddedBottom =
    top + height - scrollPadding(style.scrollPaddingBottom, scrollElement.clientHeight) * scale;
  if (paddedBottom <= paddedTop) return false;
  const targetStyle = window.getComputedStyle(target);
  const targetCenter =
    (rect.top +
      rect.bottom -
      scrollPadding(targetStyle.scrollMarginTop, scrollElement.clientHeight) * scale +
      scrollPadding(targetStyle.scrollMarginBottom, scrollElement.clientHeight) * scale) /
    2;
  const viewportCenter = (paddedTop + paddedBottom) / 2;
  const tolerance = Math.max(1, scale);
  if (Math.abs(targetCenter - viewportCenter) <= tolerance) return true;
  if (rect.top < paddedTop - tolerance || rect.bottom > paddedBottom + tolerance) return false;
  const max = Math.max(0, scrollElement.scrollHeight - scrollElement.clientHeight);
  const reverse = style.flexDirection === "column-reverse" || scrollElement.scrollTop < 0;
  const distanceFromTop = reverse ? max + scrollElement.scrollTop : scrollElement.scrollTop;
  const distanceFromBottom = reverse ? -scrollElement.scrollTop : max - scrollElement.scrollTop;
  return (
    (targetCenter < viewportCenter && distanceFromTop <= 1) ||
    (targetCenter > viewportCenter && distanceFromBottom <= 1)
  );
}

/** Keeps one native Find navigation alive across layout compensation and same-query mark remounts. */
export function createLocalConversationNativeFindScroll(input: {
  readonly scrollElement: HTMLElement;
  readonly readTarget: () => HTMLElement | null;
  readonly signal?: AbortSignal;
  readonly onFinish: () => void;
}): LocalConversationNativeFindScroll {
  let active = true;
  let frame: number | null = null;
  let requestedTarget: HTMLElement | null = null;
  let requestedHeight = 0;
  let requestedViewportHeight = 0;
  let confirmNoMovement = false;
  const currentTarget = () => {
    const target = input.readTarget();
    return target?.isConnected && input.scrollElement.contains(target) ? target : null;
  };
  const finish = () => {
    if (!active) return;
    active = false;
    confirmNoMovement = false;
    if (frame !== null) window.cancelAnimationFrame(frame);
    window.clearTimeout(timer);
    input.signal?.removeEventListener("abort", finish);
    input.scrollElement.removeEventListener("scrollend", scrollEnd);
    queueMicrotask(input.onFinish);
  };
  const request = () => {
    frame = null;
    if (!active) return;
    if (input.signal?.aborted || !input.scrollElement.isConnected) {
      finish();
      return;
    }
    const target = currentTarget();
    if (target === null) {
      confirmNoMovement = false;
      frame = window.requestAnimationFrame(request);
      return;
    }
    if (confirmNoMovement) {
      confirmNoMovement = false;
      if (
        target === requestedTarget &&
        requestedHeight === input.scrollElement.scrollHeight &&
        requestedViewportHeight === input.scrollElement.clientHeight &&
        isPositioned(input.scrollElement, target)
      ) {
        finish();
        return;
      }
    }
    const alreadyPositioned = isPositioned(input.scrollElement, target);
    requestedTarget = target;
    requestedHeight = input.scrollElement.scrollHeight;
    requestedViewportHeight = input.scrollElement.clientHeight;
    target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    // A native request that does not move emits no scrollend; confirm it after layout instead.
    if (active && alreadyPositioned) {
      confirmNoMovement = true;
      frame = window.requestAnimationFrame(request);
    }
  };
  const resume = () => {
    if (!active) return;
    confirmNoMovement = false;
    if (frame !== null) return;
    frame = window.requestAnimationFrame(request);
  };
  const scrollEnd = () => {
    if (!active || frame !== null) return;
    const target = currentTarget();
    if (target === null || target !== requestedTarget) {
      resume();
      return;
    }
    if (
      requestedHeight !== input.scrollElement.scrollHeight ||
      requestedViewportHeight !== input.scrollElement.clientHeight
    ) {
      resume();
      return;
    }
    if (isPositioned(input.scrollElement, target)) finish();
  };
  const timer = window.setTimeout(finish, 1_500);
  input.signal?.addEventListener("abort", finish, { once: true });
  input.scrollElement.addEventListener("scrollend", scrollEnd);
  request();
  return { resume, cancel: finish };
}
