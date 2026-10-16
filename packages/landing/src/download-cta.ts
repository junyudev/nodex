function initializeBrewCopyButton(): void {
  if (typeof document === "undefined") return;

  const button = document.querySelector<HTMLButtonElement>(".landing-brew-copy");
  if (!button) return;

  button.addEventListener("click", async () => {
    const command = button.dataset.command;
    if (!command) return;

    try {
      await navigator.clipboard.writeText(command);
      button.classList.add("copied");
      setTimeout(() => button.classList.remove("copied"), 1500);
    } catch {
      // Fallback: select the code text
      const code = button.parentElement?.querySelector("code");
      if (code) {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    }
  });
}

initializeBrewCopyButton();
