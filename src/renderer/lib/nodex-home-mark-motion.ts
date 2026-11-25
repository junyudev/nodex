export type NodexMarkVec3 = readonly [number, number, number];
export type NodexMarkMat3 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];

export const NODEX_HOME_MARK_BASE_ROTATION: NodexMarkMat3 = [
  0.9591977392402923, 0, 0.282736090791947, -0.0590442569816084, 0.9779515955840853,
  0.2003108893995316, -0.2765022111191914, -0.208831694659938, 0.9380489595706912,
];

export const NODEX_HOME_MARK_FALLBACK_AXIS: NodexMarkVec3 = normalizeNodexMarkAxis([
  -0.9, -0.9, -0.59,
]);

export const NODEX_HOME_MARK_TAU = Math.PI * 2;

export function identityNodexMarkMatrix(): NodexMarkMat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

export function multiplyNodexMarkMatrices(
  left: NodexMarkMat3,
  right: NodexMarkMat3,
): NodexMarkMat3 {
  const output = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      for (let index = 0; index < 3; index += 1) {
        output[row * 3 + column] += left[row * 3 + index] * right[index * 3 + column];
      }
    }
  }
  return output as unknown as NodexMarkMat3;
}

export function nodexMarkAxisAngle(axis: NodexMarkVec3, angle: number): NodexMarkMat3 {
  const [x, y, z] = normalizeNodexMarkAxis(axis);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const inverse = 1 - cosine;
  return [
    inverse * x * x + cosine,
    inverse * x * y - sine * z,
    inverse * x * z + sine * y,
    inverse * x * y + sine * z,
    inverse * y * y + cosine,
    inverse * y * z - sine * x,
    inverse * x * z - sine * y,
    inverse * y * z + sine * x,
    inverse * z * z + cosine,
  ];
}

export function normalizeNodexMarkAxis(axis: NodexMarkVec3): NodexMarkVec3 {
  const length = Math.hypot(...axis);
  if (!Number.isFinite(length) || length < 1e-8) return [0, 1, 0];
  return [axis[0] / length, axis[1] / length, axis[2] / length];
}

function transposeMatrixVector(matrix: NodexMarkMat3, vector: NodexMarkVec3): NodexMarkVec3 {
  return [
    matrix[0] * vector[0] + matrix[3] * vector[1] + matrix[6] * vector[2],
    matrix[1] * vector[0] + matrix[4] * vector[1] + matrix[7] * vector[2],
    matrix[2] * vector[0] + matrix[5] * vector[1] + matrix[8] * vector[2],
  ];
}

export function resolveNodexHomeMarkClickAxis(input: {
  clientX: number;
  clientY: number;
  left: number;
  top: number;
  width: number;
  height: number;
  centerDeadZone?: number;
  fallbackAxis?: NodexMarkVec3;
}): NodexMarkVec3 {
  const {
    clientX,
    clientY,
    left,
    top,
    width,
    height,
    centerDeadZone = 0.12,
    fallbackAxis = NODEX_HOME_MARK_FALLBACK_AXIS,
  } = input;
  if (width <= 0 || height <= 0) return fallbackAxis;

  const x = (clientX - (left + width * 0.5)) / (width * 0.5);
  const y = (clientY - (top + height * 0.5)) / (height * 0.5);
  const distance = Math.hypot(x, y);
  if (!Number.isFinite(distance) || distance < centerDeadZone) return fallbackAxis;

  const cameraAxis = normalizeNodexMarkAxis([y / distance, -x / distance, 0]);
  return normalizeNodexMarkAxis(transposeMatrixVector(NODEX_HOME_MARK_BASE_ROTATION, cameraAxis));
}

export function nodexMarkAxisDot(left: NodexMarkVec3, right: NodexMarkVec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

export function canMergeNodexMarkAxes(
  left: NodexMarkVec3,
  right: NodexMarkVec3,
  minimumDot = 0.94,
): boolean {
  return nodexMarkAxisDot(left, right) >= minimumDot;
}

export function composeNodexMarkRotorPose(
  rotors: readonly {
    axis: NodexMarkVec3;
    turns: number;
  }[],
): NodexMarkMat3 {
  return rotors.reduce<NodexMarkMat3>(
    (pose, rotor) =>
      multiplyNodexMarkMatrices(
        nodexMarkAxisAngle(rotor.axis, -rotor.turns * NODEX_HOME_MARK_TAU),
        pose,
      ),
    identityNodexMarkMatrix(),
  );
}

export function nodexMarkPoseDistanceDegrees(matrix: NodexMarkMat3): number {
  const cosine = Math.max(-1, Math.min(1, (matrix[0] + matrix[4] + matrix[8] - 1) * 0.5));
  return (Math.acos(cosine) * 180) / Math.PI;
}

export function resolveNodexHomeMarkFieldMorph(
  poseDistanceDegrees: number,
  startDegrees = 0,
  endDegrees = 48,
): number {
  const safeEnd = Math.max(startDegrees + 0.1, endDegrees);
  const linear = Math.max(
    0,
    Math.min(1, (poseDistanceDegrees - startDegrees) / (safeEnd - startDegrees)),
  );
  return linear * linear * (3 - 2 * linear);
}

export interface NodexHomeMarkFramebufferMetrics {
  size: number;
  aaHalfWidth: number;
  pixelRatio: number;
}

export function resolveNodexHomeMarkFramebuffer(input: {
  devicePixelRatio: number;
  chargedScale: number;
  frameCssSize: number;
  maximumPixelRatio?: number;
  maximumChargedScale?: number;
  headroom?: number;
}): NodexHomeMarkFramebufferMetrics {
  const {
    devicePixelRatio,
    chargedScale,
    frameCssSize,
    maximumPixelRatio = 3,
    maximumChargedScale = 1.17,
    headroom = 1.08,
  } = input;
  const pixelRatio = Math.min(
    Math.max(Number.isFinite(devicePixelRatio) ? devicePixelRatio : 1, 1),
    maximumPixelRatio,
  );
  const allocatedScale = Math.max(1, maximumChargedScale * headroom, chargedScale);
  const size = Math.ceil((frameCssSize * pixelRatio * allocatedScale) / 2) * 2;
  const physicalOutputSize = frameCssSize * pixelRatio * Math.max(chargedScale, 0.01);
  return {
    size,
    aaHalfWidth: (0.5 * size) / physicalOutputSize,
    pixelRatio,
  };
}

export function isNodexMarkIdentity(matrix: NodexMarkMat3, tolerance = 1e-9): boolean {
  const identity = identityNodexMarkMatrix();
  return matrix.every((value, index) => Math.abs(value - identity[index]) <= tolerance);
}
