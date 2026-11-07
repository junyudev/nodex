import type { components } from "@nodex/core-protocol";

export const PROJECT_MARKER_COLORS = [
  "black",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
] as const;

export type ProjectMarkerColor = components["schemas"]["ProjectMarkerColor"];

export const PROJECT_MARKER_ICONS = [
  "folder",
  "currency-dollar",
  "book",
  "graduation-cap",
  "edit",
  "writing",
  "function",
  "terminal",
  "music",
  "popcorn",
  "customize",
  "palette",
  "stethoscope",
  "health",
  "lotus",
  "suitcase",
  "bar-chart",
  "kettlebell",
  "dumbbell",
  "logs",
  "scale",
  "desk-globe",
  "plane",
  "globe",
  "wrench",
  "paw",
  "flask",
  "brain",
  "heart",
  "plant",
] as const;

export type ProjectMarkerIcon = components["schemas"]["ProjectMarkerIcon"];

export type ProjectMarker = components["schemas"]["ProjectMarker"];
export type ProjectAppearance = components["schemas"]["ProjectAppearance"];

export const DEFAULT_PROJECT_APPEARANCE = {
  color: "black",
  marker: {
    kind: "icon",
    icon: "folder",
  },
} as const satisfies ProjectAppearance;

export const PROJECT_MARKER_COLOR_LABELS: Record<ProjectMarkerColor, string> = {
  black: "Default",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
};

export const PROJECT_MARKER_ICON_LABELS: Record<ProjectMarkerIcon, string> = {
  folder: "Folder",
  "currency-dollar": "Currency dollar",
  book: "Book",
  "graduation-cap": "Graduation cap",
  edit: "Pencil",
  writing: "Writing",
  function: "Code brackets",
  terminal: "Terminal",
  music: "Music",
  popcorn: "Popcorn",
  customize: "Customize",
  palette: "Palette",
  stethoscope: "Stethoscope",
  health: "Health",
  lotus: "Lotus",
  suitcase: "Suitcase",
  "bar-chart": "Bar chart",
  kettlebell: "Kettlebell",
  dumbbell: "Dumbbell",
  logs: "Notebook",
  scale: "Balancing scale",
  "desk-globe": "Globe spin",
  plane: "Plane",
  globe: "Globe",
  wrench: "Wrench",
  paw: "Paw",
  flask: "Flask",
  brain: "Brain",
  heart: "Heart",
  plant: "Plant",
};

export function isProjectAppearanceEqual(
  left: ProjectAppearance,
  right: ProjectAppearance,
): boolean {
  if (left.color !== right.color) return false;
  if (left.marker.kind !== right.marker.kind) return false;

  if (left.marker.kind === "emoji" && right.marker.kind === "emoji") {
    return left.marker.emoji === right.marker.emoji;
  }

  if (left.marker.kind === "icon" && right.marker.kind === "icon") {
    return left.marker.icon === right.marker.icon;
  }

  return false;
}

export function selectProjectMarkerColor(
  appearance: ProjectAppearance,
  color: ProjectMarkerColor,
): ProjectAppearance {
  if (appearance.color === color) return appearance;

  return {
    ...appearance,
    color,
  };
}

export function selectProjectMarkerIcon(
  appearance: ProjectAppearance,
  icon: ProjectMarkerIcon,
): ProjectAppearance {
  if (appearance.marker.kind === "icon" && appearance.marker.icon === icon) {
    return appearance;
  }

  return {
    color: appearance.color,
    marker: {
      kind: "icon",
      icon,
    },
  };
}
