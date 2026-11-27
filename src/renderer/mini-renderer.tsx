import { initializeMiniRenderer } from "./bootstrap/mini-bootstrap";
import { initializeRendererMarkdown } from "./bootstrap/renderer-markdown";

/**
 * Mounts Mini once Main has said which Space it belongs to. Its modules load only after that,
 * because renderer state is keyed by the bound Space as it is built.
 */
export async function mountMiniRenderer(): Promise<void> {
  const [bootstrap] = await Promise.all([initializeMiniRenderer(), initializeRendererMarkdown()]);
  const { mountMiniApplication } = await import("./mini-application");
  mountMiniApplication(bootstrap);
}
