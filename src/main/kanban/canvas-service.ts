import type { CanvasData } from "../../shared/types";
import { getDb } from "./db-service";

interface DbCanvas {
  project_id: string;
  elements: string;
  app_state: string;
  files: string;
  updated: string;
}

export function getCanvas(projectId: string): CanvasData | null {
  const db = getDb();
  const row = db
    .prepare("SELECT elements, app_state, files, updated FROM canvas WHERE project_id = ?")
    .get(projectId) as DbCanvas | undefined;

  if (!row) return null;

  return {
    elements: row.elements,
    appState: row.app_state,
    files: row.files,
    updated: row.updated,
  };
}

export function saveCanvas(projectId: string, data: CanvasData): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO canvas (project_id, elements, app_state, files, updated)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       elements = excluded.elements,
       app_state = excluded.app_state,
       files = excluded.files,
       updated = excluded.updated`
  ).run(projectId, data.elements, data.appState, data.files, data.updated);
}
