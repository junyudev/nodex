import type { GeneratedImageDescriptor } from "@/lib/content-image";

export type SingleImageTool = "navigate" | "comment" | "remove";
export type ImageAspectRatio = "1:1" | "3:4" | "9:16" | "4:3" | "16:9";

export interface ImagePoint {
  x: number;
  y: number;
}

export interface ImageSize {
  width: number;
  height: number;
}

export interface ImageComment extends ImagePoint {
  id: string;
  text: string;
}

export interface CommentEditorLayoutMetrics extends ImagePoint {
  editorMaxX: number;
  editorMaxY: number;
  editorMinX: number;
  editorMinY: number;
  surfaceHeight: number;
  surfaceWidth: number;
}

export interface CommentEditorPlacement {
  height: number;
  left: number;
  top: number;
  width: number;
}

export interface ImageCommentGroup {
  comments: readonly ImageComment[];
  imageNumber: number;
}

export interface RemoveStroke {
  brushSize: number;
  points: readonly ImagePoint[];
}

export interface RemoveHistory {
  committed: readonly RemoveStroke[];
  redo: readonly RemoveStroke[];
}

export type RemoveMaskDrawingCommand =
  | {
      kind: "circle";
      center: ImagePoint;
      diameter: number;
    }
  | {
      kind: "line";
      from: ImagePoint;
      lineCap: "round";
      lineJoin: "round";
      lineWidth: number;
      to: ImagePoint;
    };

export interface RemoveMaskDrawingPlan {
  background: "black";
  commands: readonly RemoveMaskDrawingCommand[];
  height: number;
  mimeType: "image/png";
  strokeColor: "white";
  suggestedFilename: "image-mask.png";
  width: number;
}

export interface GeneratedImageCollectionState {
  activeImageId: string | null;
  images: readonly GeneratedImageDescriptor[];
  selectedImageIds: readonly string[];
}
