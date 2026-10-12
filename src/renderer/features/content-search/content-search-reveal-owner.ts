const revealOwners = new WeakMap<HTMLElement, () => void>();

/** A mounted disclosure owns its reveal action; Find never simulates its controls. */
export function registerContentSearchRevealOwner(
  element: HTMLElement,
  reveal: () => void,
): () => void {
  revealOwners.set(element, reveal);
  return () => {
    if (revealOwners.get(element) === reveal) revealOwners.delete(element);
  };
}

/** Reveal only owners inside the addressed content unit before marking its rendered text. */
export function revealContentSearchUnit(unit: HTMLElement): boolean {
  const owners = [unit, ...unit.querySelectorAll<HTMLElement>("*")].flatMap((element) => {
    const reveal = revealOwners.get(element);
    return reveal ? [reveal] : [];
  });
  owners.forEach((reveal) => reveal());
  return owners.length > 0;
}
