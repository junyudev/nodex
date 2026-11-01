// Keep Pierre's entry at one canonical module URL. Its lazy highlighter chunks
// import that entry too; making it the Vite worker entry would load it again
// without Vite's worker query and register a second message handler in dev.
import "@pierre/diffs/worker/worker.js";
