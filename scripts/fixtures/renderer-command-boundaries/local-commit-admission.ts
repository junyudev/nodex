import {
  admitLocalCommitApply as admitApply,
  rendererLocalCommitIngress as ingress,
} from "../../../src/renderer/lib/local-commit-ingress";

export const admitFixtureCommits = async (value: unknown): Promise<void> => {
  await admitApply(value);
  await ingress.admitPacket(value);
};
