import { renameProject } from "@/features/projects/project-owner";

export const RenameProjectButton = () => (
  <button onClick={() => renameProject("project-1", "Renamed")}>Rename</button>
);
