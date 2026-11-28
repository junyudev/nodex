/** `claude-opus-5-5` reads as `Claude Opus 5.5`; `gpt-6.1-sol` as `GPT-6.1 Sol`. */
export function modelDisplayName(model: string): string {
  const base = model
    .replace(/^[a-z0-9-]+\//, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
  const words = base.split("-").map((word) => {
    if (word === "gpt") return "GPT";
    return /^[a-z]/.test(word) ? `${word[0]!.toUpperCase()}${word.slice(1)}` : word;
  });
  return words
    .join(" ")
    .replace(/^GPT /, "GPT-")
    .replace(/(\d) (\d)/g, "$1.$2");
}
