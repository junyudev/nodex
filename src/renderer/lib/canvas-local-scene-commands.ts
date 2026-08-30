import { defineLocalCommitRendererCommand } from "./renderer-command";

export const canvasSceneMutationCommand = defineLocalCommitRendererCommand({
  key: "canvas.scene.apply-mutation",
  channel: "canvas-scene:apply",
  authority: "core",
  owner: "canvas-scene-provider",
  protocol: { kind: "local_scene_outbox" },
});

export const canvasSceneCompactionCommand = defineLocalCommitRendererCommand({
  key: "canvas.scene.compact-tombstones",
  channel: "canvas-scene:compaction:apply",
  authority: "core",
  owner: "canvas-scene-provider",
  protocol: { kind: "local_scene_outbox" },
});
