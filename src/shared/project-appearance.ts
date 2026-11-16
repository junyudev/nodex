import type { components } from "@nodex/core-protocol";
import { defineMessages, type MessageDescriptor } from "./i18n/messages";

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

export const PROJECT_MARKER_COLOR_LABEL_MESSAGES = defineMessages({
  black: {
    id: "shared.projectAppearance.colorDefault",
    defaultMessage: "Default",
    description: "Default color for a Project marker",
  },
  red: { id: "shared.projectAppearance.colorRed", defaultMessage: "Red" },
  orange: { id: "shared.projectAppearance.colorOrange", defaultMessage: "Orange" },
  yellow: { id: "shared.projectAppearance.colorYellow", defaultMessage: "Yellow" },
  green: { id: "shared.projectAppearance.colorGreen", defaultMessage: "Green" },
  blue: { id: "shared.projectAppearance.colorBlue", defaultMessage: "Blue" },
  purple: { id: "shared.projectAppearance.colorPurple", defaultMessage: "Purple" },
  pink: { id: "shared.projectAppearance.colorPink", defaultMessage: "Pink" },
} satisfies Record<ProjectMarkerColor, MessageDescriptor>);

export const PROJECT_MARKER_ICON_LABEL_MESSAGES = defineMessages({
  folder: { id: "shared.projectAppearance.iconFolder", defaultMessage: "Folder" },
  "currency-dollar": {
    id: "shared.projectAppearance.iconCurrencyDollar",
    defaultMessage: "Currency dollar",
  },
  book: { id: "shared.projectAppearance.iconBook", defaultMessage: "Book" },
  "graduation-cap": {
    id: "shared.projectAppearance.iconGraduationCap",
    defaultMessage: "Graduation cap",
  },
  edit: { id: "shared.projectAppearance.iconPencil", defaultMessage: "Pencil" },
  writing: { id: "shared.projectAppearance.iconWriting", defaultMessage: "Writing" },
  function: { id: "shared.projectAppearance.iconCodeBrackets", defaultMessage: "Code brackets" },
  terminal: { id: "shared.projectAppearance.iconTerminal", defaultMessage: "Terminal" },
  music: { id: "shared.projectAppearance.iconMusic", defaultMessage: "Music" },
  popcorn: { id: "shared.projectAppearance.iconPopcorn", defaultMessage: "Popcorn" },
  customize: { id: "shared.projectAppearance.iconCustomize", defaultMessage: "Customize" },
  palette: { id: "shared.projectAppearance.iconPalette", defaultMessage: "Palette" },
  stethoscope: { id: "shared.projectAppearance.iconStethoscope", defaultMessage: "Stethoscope" },
  health: { id: "shared.projectAppearance.iconHealth", defaultMessage: "Health" },
  lotus: { id: "shared.projectAppearance.iconLotus", defaultMessage: "Lotus" },
  suitcase: { id: "shared.projectAppearance.iconSuitcase", defaultMessage: "Suitcase" },
  "bar-chart": { id: "shared.projectAppearance.iconBarChart", defaultMessage: "Bar chart" },
  kettlebell: { id: "shared.projectAppearance.iconKettlebell", defaultMessage: "Kettlebell" },
  dumbbell: { id: "shared.projectAppearance.iconDumbbell", defaultMessage: "Dumbbell" },
  logs: { id: "shared.projectAppearance.iconNotebook", defaultMessage: "Notebook" },
  scale: {
    id: "shared.projectAppearance.iconBalancingScale",
    defaultMessage: "Balancing scale",
    description: "Icon of a balance with two pans",
  },
  "desk-globe": { id: "shared.projectAppearance.iconGlobeSpin", defaultMessage: "Globe spin" },
  plane: { id: "shared.projectAppearance.iconPlane", defaultMessage: "Plane" },
  globe: { id: "shared.projectAppearance.iconGlobe", defaultMessage: "Globe" },
  wrench: { id: "shared.projectAppearance.iconWrench", defaultMessage: "Wrench" },
  paw: { id: "shared.projectAppearance.iconPaw", defaultMessage: "Paw" },
  flask: { id: "shared.projectAppearance.iconFlask", defaultMessage: "Flask" },
  brain: { id: "shared.projectAppearance.iconBrain", defaultMessage: "Brain" },
  heart: { id: "shared.projectAppearance.iconHeart", defaultMessage: "Heart" },
  plant: { id: "shared.projectAppearance.iconPlant", defaultMessage: "Plant" },
} satisfies Record<ProjectMarkerIcon, MessageDescriptor>);

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
