export function shouldOpenProjectManagerForRequest(
  projectPickerOpenTick: number,
  lastHandledProjectPickerOpenTick: number,
): boolean {
  return projectPickerOpenTick > 0 && projectPickerOpenTick !== lastHandledProjectPickerOpenTick;
}
