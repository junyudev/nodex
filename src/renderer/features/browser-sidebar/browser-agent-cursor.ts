import type { BrowserUseCursorState } from "../../../shared/browser-sidebar";

const CURSOR_LAYER_SIZE = 24;
const CURSOR_LAYER_CENTER = CURSOR_LAYER_SIZE / 2;
const CURSOR_ASSET_WIDTH = 23;
const CURSOR_ASSET_HEIGHT = 24;
const CURSOR_ASSET_OFFSET_X = 12;
const CURSOR_ASSET_OFFSET_Y = -2.5;
const CURSOR_ASSET_ROTATION = 44;
const CURSOR_GLOW_PROPERTY = "--browser-agent-cursor-glow-color";
const CURSOR_GLOW_FILTER =
  `drop-shadow(0 0 6px color-mix(in srgb, var(${CURSOR_GLOW_PROPERTY}) 90%, transparent)) ` +
  `drop-shadow(0 0 15px color-mix(in srgb, var(${CURSOR_GLOW_PROPERTY}) 48%, transparent))`;
const CURSOR_HIDDEN_BLUR = 5;
const CURSOR_HIDDEN_SCALE = 0.4;
const CURSOR_IDLE_DELAY_SECONDS = 0;
const CURSOR_IDLE_DURATION_SECONDS = 1.41;
const CURSOR_IDLE_CYCLE_SECONDS = 0.66;
const CURSOR_IDLE_ROTATION_DEGREES = 12.5;
const DEFAULT_CURSOR_X_RATIO = 0.58;
const DEFAULT_CURSOR_Y_RATIO = 0.55;
const FRAME_DURATION_SECONDS = 1 / 60;
const ARRIVAL_DISTANCE = 0.85;
const ARRIVAL_VELOCITY = 12;
const CURVED_PATH_DISTANCE = 196;
const MAX_SCOOT_ROTATION = 70;
const SCOOT_STRETCH = 0.15;
const MIN_STRETCH = 0;
const SPRING_STEP_SECONDS = 1 / 240;
const MAX_SPRING_CATCHUP_SECONDS = 1;
const SPRING_SETTLED_THRESHOLD = 0.001 * 60;
const CURSOR_ASSET_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC4AAAAwCAYAAABuZUjcAAAG+klEQVR4Ae1ZW2xUVRS982qnj+lzSh9UrLWosVFq+TAkRmpi0URJSBogqRggavyF1Cj6Q0P94A+iURJDQrH6Q2OxIF/EEE0a0hqBEBKRQihSIYHQxwzTTtuZua51e/Z4GeZxh85MP2AnJ/d1HuvsvfY++5yraU/kiTzeYtN1PVq6u7vtvPK9fNOWSZzxXhIQhFfjecuWLfa7d+/a+vr6GvB+bPPmzXpzc7O+WHWxLu+15RTRLG7tbW1tzps3b64OhUKDeD+pK8Hzb4FA4MNr166tZh2pLxaRCedaqD4Ccfl8vo/MgOOJTOLcuXNVaCOTiFIpJ3RSgxigL168+EIq0DEyOT8///29e/fa165d6wKdHCwm8FKyAtpG0zc0NLjn5uZ+EETXr1/X8d7gNL7pu3btMt4lkkgkMsZJTE1NvclJoJ2DljA5d2aBs2M4XZ7X6/Vg8CkBsmnTJgN0bGlpadF7e3tTTgJK6IE/PIc2hiW0RatmzAI21an75MmTa8yDxwMdW2gRTmJyMjG7Yp1aJhFDpfQmw8bsDLdFe/bsaTIPSHpYAS9lx44d+vHjx/VkIpMYGhpagTbGJOJQKfUkVANXdXV1Ea7V6PSsDIIO0wIuhRPmJM6cOZNsDpOgUp84tab8wWQFTU/mF6JxAi8uLl5x9erVfdIzB34U4LGTSNepJSppyTSvKjjq6+sLcPVu27btAZ5LVMlEserUpJKyQuJoxA+cYVNTUz4eywsKCp7CAjS8VLqkKqmcemZm5hNGOpP2HwIe5XlFRUVJYWFh3YULFz6LEhEdZwO4ZsGpYZlXCV5bDKPxtU6e19XVFYLnVZ2dnS3hcHg6G3TRUviDmUagzLeKwk7ReuwMCC4CbYedTucCZj8Bb/9VPmIh0nIhY2Nj2s6dO6PPbrf7nWAw6ATfJRONKzblEJ6ioqIaLEbvmelSVlaWM62LIOb/g3flTEVUEvcwZ8j1xsbGCG7DmF0YTnEWHu7jN4DWEBG0XAgsH70HXX0ej8cBSyQPixJdALSM0eXWrVu9MvtMxPRUhb5k5jjo2g/gXvoevjsSAtcWA76zqqqqGNfqU6dOdWaTLuyPYA8cOPBQbGdw2L9//2uoV4niVsATat7QOj25pKSkAs7xDJblcemMK+BSwcpKSgsmS8xGRkY+p9VpfXI8ocZFlBPkl5eXl6JhPfj11VLpkkir8QTL/h+HDh3qyM/Pf5ZWR/GooGFLCVxli8XMXXp6etrMHadLlyNHjiQFisjhu3Hjxi9QSveGDRteR5tmgobSVoq2VRqcHLiunJQNFF0apqenR2SgdFIAajqeTExM/Hnp0qXvjh49+rHL5WpF3ZdRXkRpwnhP41pD0HRKpcQoaHsi4Az0PIKorKwMOxwOhsYFRJfT8n39+vWaVdm+fXv03u/3j0Kr+9rb299AavFBa2vr1/j+u91u9wGsH1WmsX748/Ly/NiJBUCZYG1t7QIXRkuD6WqTK5sL0oUpgFljVlMAM6cHBwe7AOol0OB5xd9VzIvYP0JeJX2K0YyBQVJbLU52mEzjHJQLQQR0odYXBgYGJqGxEaljXiQSCdoaReTw4cND0G4A5T4ila+0tNQPTd+HlgOwbgARJghLB9etWze/cePG8LFjx6jpiOCxJPr/xxXGBhrXuvPnz38q2rOSMTLjE6GPKC3XULPctHCho2Zj96D6Uk8DVAekSyFXr46OjlfSyRjN27bLly9/iXcroWUj7xCw+oNnL5kR0ToH4oAIT6vu3LkzIGAOHjyYFLhZED3eZbqs9rVGTNazeVzHmE5zki5wpFqrGaM5DHLlZUgVbVuKyRmQ6AaDng8AjVboYl50YKWfuJjgfQmKsZtZCo/tFuvpCFE6NxiIKiEk9Qu3b9/+WT7u3bs3biNz1Lly5crp2dnZEG7DmqJQWpHiUUTx0NA6Yyw3GOaMkRJ7aMSdvFm2bt26Bu+9sgXTckATAW84qRqYdGnADvwvAcZFhmeMcghkXnR4WiAZnjpFsGrpjADnxa5228wYV544ceJ93YLAudtgpWpay1KGlwXw0RQApYpOOjo6+k0iwMz4hoeHv2DCxEQNbWitnESTWDFOu6h1mh33dVgJV+/evfttOOsgHPdvgoXz/guq/NjV1fUW6jSh1KB4SBPZ7GYCSNptoHUHokQessV8RJoChMZCKDgP535OpKc2FS1CeJ7DdRZznEEJgv8hrKThTEQTp5a+GGcv0O4CH+Cg3K2EwXkXKMH+qFEdWmfomwPgeayWc9hBhWCFcNZDYAqxmXZIbjodkybFYy+vkp5qixtcmVDGuP3IHcmqBw0avwrBXzv4bWMZHx+XJT/Mhau/v5/P1jYCuRLd9NcZjw7572n657lsf5/TlZyA/Q9N3TljZhaAsAAAAABJRU5ErkJggg==";

const POSITION_SPRING = {
  dampingFraction: 0.9,
  response: 0.19,
};
const VISIBILITY_SPRING = {
  dampingFraction: 0.86,
  response: 0.42,
};
const STRETCH_SPRING = {
  dampingFraction: 0.85,
  response: 0.2,
};
const SCOOT_PROGRESS_SPRING = {
  dampingFraction: 0.94,
  response: 0.19,
};
const ROTATION_SPRING = {
  dampingFraction: 0.9,
  response: 0.12,
};
const SCOOT_ROTATION_SPRING = {
  dampingFraction: 0.82,
  response: 0.055,
};
const SCOOT_STRETCH_SPRING = {
  dampingFraction: 0.86,
  response: 0.12,
};

interface Point {
  x: number;
  y: number;
}

interface Size {
  width: number;
  height: number;
}

interface SpringConfig {
  dampingFraction: number;
  response: number;
}

interface Spring extends SpringConfig {
  force: number;
  simulationTime: number;
  scriptTime: number;
  target: number;
  value: number;
  velocity: number;
}

interface MotionPathSegment {
  control1: Point;
  control2: Point;
  end: Point;
}

interface MotionPath {
  arc: Point | null;
  arcIn: Point | null;
  arcOut: Point | null;
  end: Point;
  endControl: Point;
  segments: MotionPathSegment[];
  start: Point;
  startControl: Point;
}

type CursorMotion =
  | {
      mode: "bezier";
      path: MotionPath;
      progressSpring: Spring;
    }
  | {
      axisRotation: number;
      end: Point;
      mode: "scoot";
      progressSpring: Spring;
      rotationTarget: number;
      start: Point;
    };

interface CursorMotionState {
  motion: CursorMotion | null;
  point: Point;
  positionXSpring: Spring;
  positionYSpring: Spring;
  rotation: number;
  rotationSpring: Spring;
  scootAxisRotation: number;
  scootAxisSpring: Spring;
  scootRotationSpring: Spring;
  scootStretchSpring: Spring;
  stretchSpring: Spring;
  thinkStartedAt: number | null;
  visibilitySpring: Spring;
}

interface CursorElements {
  cursor: HTMLDivElement;
  layer: HTMLDivElement;
}

export interface BrowserAgentCursorControllerState {
  cursor: BrowserUseCursorState | null;
  isVisible?: boolean;
  turnKey?: string;
  viewportSize: Size;
}

export interface BrowserAgentCursorController {
  destroy(): void;
  setState(state: BrowserAgentCursorControllerState): void;
}

interface CursorPathMetrics {
  angleChangeEnergy: number;
  length: number;
  maxAngleChange: number;
  staysInBounds: boolean;
  totalTurn: number;
}

const PATH_CONFIG = {
  arcFlow: 0.5783555327868779,
  arcSize: 0.2765523188064277,
  boundsMargin: 20,
  candidateCount: 20,
  clickAngleDegrees: -44,
  endpointHandle: 0.15,
  startHandle: 0.41960295031576633,
};

export function clampBrowserAgentCursorPoint({
  cursorX,
  cursorY,
  viewportHeight,
  viewportWidth,
}: {
  cursorX?: number;
  cursorY?: number;
  viewportHeight: number;
  viewportWidth: number;
}): Point {
  return {
    x: clamp(cursorX ?? Math.round(viewportWidth * DEFAULT_CURSOR_X_RATIO), 0, viewportWidth),
    y: clamp(cursorY ?? Math.round(viewportHeight * DEFAULT_CURSOR_Y_RATIO), 0, viewportHeight),
  };
}

export function createBrowserAgentCursorController(
  host: HTMLElement,
  {
    dataTestId = "browser-agent-cursor",
    glowColor = "var(--color-text-info)",
    onArrived,
  }: {
    dataTestId?: string;
    glowColor?: string;
    onArrived?: (moveSequence: number) => void;
  } = {},
): BrowserAgentCursorController {
  const elements = createCursorElements(host, CURSOR_ASSET_URL, dataTestId, glowColor);
  let animationFrame: number | null = null;
  let previousFrameTime = now();
  let motionState: CursorMotionState | null = null;
  let lastDefaultTurnKey: string | null = null;
  let lastFirstMoveTurnKey: string | null = null;
  let moveSequence: number | null = null;
  let arrivalKey: string | null = null;
  let notifiedArrivalKey: string | null = null;
  let preferMinimumFrameDuration = false;
  let destroyed = false;

  const notifyArrived = () => {
    if (moveSequence === null || arrivalKey === null || notifiedArrivalKey === arrivalKey) {
      return;
    }
    notifiedArrivalKey = arrivalKey;
    onArrived?.(moveSequence);
  };

  const scheduleFrame = () => {
    if (animationFrame !== null || motionState === null || destroyed) {
      return;
    }
    animationFrame = requestFrame((timestamp) => {
      animationFrame = null;
      const currentState = motionState;
      if (!currentState) return;
      const deltaSeconds = preferMinimumFrameDuration
        ? SPRING_STEP_SECONDS
        : Math.max(SPRING_STEP_SECONDS, (timestamp - previousFrameTime) / 1_000);
      preferMinimumFrameDuration = false;
      previousFrameTime = timestamp;
      const arrived = advanceCursorMotion(currentState, deltaSeconds, timestamp);
      renderCursor(elements, currentState);
      if (arrived) notifyArrived();
      if (isCursorAnimating(currentState)) scheduleFrame();
    });
  };

  return {
    destroy: () => {
      destroyed = true;
      if (animationFrame !== null) cancelFrame(animationFrame);
      animationFrame = null;
      elements.layer.remove();
    },
    setState: (state) => {
      const turnKey = state.turnKey ?? "";
      const hasCursor = state.cursor !== null;
      const point = clampBrowserAgentCursorPoint({
        cursorX: state.cursor?.x,
        cursorY: state.cursor?.y,
        viewportHeight: state.viewportSize.height,
        viewportWidth: state.viewportSize.width,
      });
      const visible = state.isVisible !== false && state.cursor?.visible !== false;
      const animateMovement = state.cursor?.animateMovement !== false;
      const showingDefaultCursor = visible && !hasCursor;
      moveSequence = state.cursor?.moveSequence ?? null;
      arrivalKey = moveSequence === null ? null : `${turnKey}:${moveSequence}`;
      motionState ??= createCursorMotionState(point, visible);
      motionState.visibilitySpring.target = Number(visible);

      if (showingDefaultCursor && lastDefaultTurnKey !== turnKey) {
        lastDefaultTurnKey = turnKey;
        setSpringImmediately(motionState.visibilitySpring, 1);
        motionState.thinkStartedAt = now();
      }

      if (!hasCursor) {
        moveCursorImmediately(motionState, point);
        renderCursor(elements, motionState);
        scheduleFrame();
        return;
      }

      const firstVisibleMove =
        state.cursor?.moveSequence !== undefined &&
        visible &&
        motionState.visibilitySpring.value <= 0.001 &&
        lastFirstMoveTurnKey !== turnKey;
      motionState.thinkStartedAt = null;
      const distance = distanceBetween(motionState.point, point);
      if (!animateMovement || firstVisibleMove || distance < 0.5) {
        if (firstVisibleMove) {
          lastFirstMoveTurnKey = turnKey;
          setSpringImmediately(motionState.visibilitySpring, 1);
        }
        moveCursorImmediately(motionState, point);
        if (!animateMovement) {
          motionState.stretchSpring.force = 0;
          motionState.stretchSpring.value = 1;
          motionState.stretchSpring.velocity = 0;
        }
        renderCursor(elements, motionState);
        notifyArrived();
        scheduleFrame();
        return;
      }

      startCursorMotion(motionState, point, state.viewportSize);
      preferMinimumFrameDuration = true;
      renderCursor(elements, motionState);
      scheduleFrame();
    },
  };
}

function createCursorElements(
  host: HTMLElement,
  assetUrl: string,
  dataTestId: string,
  glowColor: string,
): CursorElements {
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, {
    inset: "0",
    overflow: "hidden",
    pointerEvents: "none",
    position: "absolute",
    zIndex: "20",
  });

  const cursor = document.createElement("div");
  cursor.setAttribute("data-testid", dataTestId);
  Object.assign(cursor.style, {
    height: `${CURSOR_LAYER_SIZE}px`,
    left: "0",
    position: "absolute",
    top: "0",
    transformOrigin: `${CURSOR_LAYER_CENTER}px ${CURSOR_LAYER_CENTER}px`,
    willChange: "transform",
    width: `${CURSOR_LAYER_SIZE}px`,
  });

  const assetOffset = document.createElement("div");
  assetOffset.style.transform = `translate3d(${CURSOR_ASSET_OFFSET_X}px, ${CURSOR_ASSET_OFFSET_Y}px, 0)`;

  const image = document.createElement("img");
  image.alt = "";
  image.setAttribute("data-browser-agent-cursor-asset", "");
  image.setAttribute("data-testid", `${dataTestId}-asset`);
  image.draggable = false;
  image.height = CURSOR_ASSET_HEIGHT;
  image.src = assetUrl;
  image.style.display = "block";
  image.style.setProperty(CURSOR_GLOW_PROPERTY, glowColor);
  image.style.filter = CURSOR_GLOW_FILTER;
  image.style.transform = `rotate(${CURSOR_ASSET_ROTATION}deg) scale(1)`;
  image.style.transformOrigin = "0 0";
  image.width = CURSOR_ASSET_WIDTH;

  assetOffset.append(image);
  cursor.append(assetOffset);
  layer.append(cursor);
  host.append(layer);
  return { cursor, layer };
}

function createCursorMotionState(point: Point, visible: boolean): CursorMotionState {
  const visibility = Number(visible);
  const rotation = wrapDegrees(-44);
  return {
    motion: null,
    point,
    positionXSpring: createSpring(point.x, point.x, POSITION_SPRING),
    positionYSpring: createSpring(point.y, point.y, POSITION_SPRING),
    rotation,
    rotationSpring: createSpring(rotation, rotation, ROTATION_SPRING),
    scootAxisRotation: 0,
    scootAxisSpring: createSpring(0, 0, ROTATION_SPRING),
    scootRotationSpring: createSpring(0, 0, SCOOT_ROTATION_SPRING),
    scootStretchSpring: createSpring(1, 1, SCOOT_STRETCH_SPRING),
    stretchSpring: createSpring(1, 1, STRETCH_SPRING),
    thinkStartedAt: null,
    visibilitySpring: createSpring(visibility, visibility, VISIBILITY_SPRING),
  };
}

function startCursorMotion(state: CursorMotionState, target: Point, viewportSize: Size): void {
  state.thinkStartedAt = null;
  const start = { ...state.point };
  if (distanceBetween(start, target) <= CURVED_PATH_DISTANCE) {
    startScootMotion(state, start, target);
    return;
  }
  const path = chooseCursorMotionPath({
    bounds: viewportSize,
    end: target,
    start,
  });
  const springConfig = responseForPath(path);
  setPositionSpringConfig(state, springConfig.response, springConfig.dampingFraction);
  state.motion = {
    mode: "bezier",
    path,
    progressSpring: createSpring(0, 1, springConfig),
  };
}

function startScootMotion(state: CursorMotionState, start: Point, end: Point): void {
  const direction = normalizePoint({
    x: end.x - start.x,
    y: end.y - start.y,
  });
  const axisRotation = pointAngleDegrees(direction);
  const rotationTarget =
    clamp(direction.x * 0.75 + -direction.y * 0.62, -1, 1) * MAX_SCOOT_ROTATION;
  setPositionSpringConfig(state, POSITION_SPRING.response, POSITION_SPRING.dampingFraction);
  state.positionXSpring.target = end.x;
  state.positionYSpring.target = end.y;
  setAngularSpringTarget(state.rotationSpring, wrapDegrees(-44));
  setAngularSpringTarget(state.scootAxisSpring, axisRotation);
  state.motion = {
    axisRotation,
    end,
    mode: "scoot",
    progressSpring: createSpring(0, 1, SCOOT_PROGRESS_SPRING),
    rotationTarget,
    start,
  };
}

function advanceCursorMotion(
  state: CursorMotionState,
  deltaSeconds: number,
  timestamp: number,
): boolean {
  const arrived = advancePositionMotion(state, deltaSeconds, timestamp);
  advanceSpring(state.visibilitySpring, deltaSeconds);
  advanceSpring(state.stretchSpring, deltaSeconds);
  advanceSpring(state.scootStretchSpring, deltaSeconds);
  advanceSpring(state.scootRotationSpring, deltaSeconds);
  return arrived;
}

function advancePositionMotion(
  state: CursorMotionState,
  deltaSeconds: number,
  timestamp: number,
): boolean {
  if (!state.motion) {
    state.stretchSpring.target = 1;
    state.scootStretchSpring.target = 1;
    state.scootRotationSpring.target = 0;
    return false;
  }
  state.thinkStartedAt = null;
  return state.motion.mode === "scoot"
    ? advanceScootMotion(state, deltaSeconds, timestamp)
    : advanceBezierMotion(state, deltaSeconds, timestamp);
}

function advanceBezierMotion(
  state: CursorMotionState,
  deltaSeconds: number,
  timestamp: number,
): boolean {
  const motion = state.motion;
  if (motion?.mode !== "bezier") return false;
  state.scootStretchSpring.target = 1;
  state.scootRotationSpring.target = 0;
  advanceSpring(motion.progressSpring, deltaSeconds);
  const progress = clamp(motion.progressSpring.value, 0, 1);
  const sample = sampleCursorMotionPath(motion.path, progress);
  state.positionXSpring.target = sample.point.x;
  state.positionYSpring.target = sample.point.y;
  setAngularSpringTarget(state.rotationSpring, cursorRotationForTangent(sample.tangent));
  setAngularSpringTarget(state.scootAxisSpring, 0);
  const current = advanceCursorPositionSprings(state, deltaSeconds);
  state.stretchSpring.target = stretchForSpeed(current.speed);

  if (
    progress < 0.999 ||
    Math.abs(motion.progressSpring.velocity) >= 0.01 ||
    !hasCursorArrived(state, sample.point)
  ) {
    return false;
  }

  const finalSample = sampleCursorMotionPath(motion.path, 1);
  const rotation = cursorRotationForTangent(finalSample.tangent);
  setCursorPointImmediately(state, finalSample.point);
  setSpringImmediately(state.rotationSpring, rotation);
  state.rotation = rotation;
  setSpringImmediately(state.scootAxisSpring, 0);
  state.scootAxisRotation = 0;
  setSpringImmediately(state.stretchSpring, 1);
  state.motion = null;
  state.thinkStartedAt = timestamp;
  return true;
}

function advanceScootMotion(
  state: CursorMotionState,
  deltaSeconds: number,
  timestamp: number,
): boolean {
  const motion = state.motion;
  if (motion?.mode !== "scoot") return false;
  advanceSpring(motion.progressSpring, deltaSeconds);
  state.positionXSpring.target = motion.end.x;
  state.positionYSpring.target = motion.end.y;
  setAngularSpringTarget(state.scootAxisSpring, motion.axisRotation);
  setAngularSpringTarget(state.rotationSpring, wrapDegrees(-44));
  const current = advanceCursorPositionSprings(state, deltaSeconds);
  const progress = projectedProgress(current.point, motion.start, motion.end);
  const arc = Math.sin(Math.min(1, progress) * Math.PI);
  state.stretchSpring.target = 1;
  state.scootStretchSpring.target = scootStretchForProgress(progress);
  state.scootRotationSpring.target = motion.rotationTarget * arc;

  if (
    progress < 0.999 ||
    Math.abs(motion.progressSpring.velocity) >= 0.01 ||
    !hasCursorArrived(state, motion.end)
  ) {
    return false;
  }

  setCursorPointImmediately(state, motion.end);
  setSpringImmediately(state.rotationSpring, wrapDegrees(-44));
  state.rotation = state.rotationSpring.value;
  resetScootState(state);
  setSpringImmediately(state.stretchSpring, 1);
  state.motion = null;
  state.thinkStartedAt = timestamp;
  return true;
}

function isCursorAnimating(state: CursorMotionState): boolean {
  return (
    state.motion !== null ||
    state.thinkStartedAt !== null ||
    !isSpringSettled(state.positionXSpring) ||
    !isSpringSettled(state.positionYSpring) ||
    !isSpringSettled(state.rotationSpring) ||
    !isSpringSettled(state.scootAxisSpring) ||
    !isSpringSettled(state.scootRotationSpring) ||
    !isSpringSettled(state.scootStretchSpring) ||
    !isSpringSettled(state.stretchSpring) ||
    !isSpringSettled(state.visibilitySpring)
  );
}

function renderCursor(elements: CursorElements, state: CursorMotionState): void {
  const rotation = readIdleRotation(state, now());
  const presentation = makeCursorPresentation({
    point: state.point,
    rotation,
    scootAxisRotation: state.scootAxisRotation,
    scootRotation: state.scootRotationSpring.value,
    scootStretch: state.scootStretchSpring.value,
    stretch: state.stretchSpring.value,
    visibility: state.visibilitySpring.value,
  });
  elements.cursor.style.transform = presentation.transform;
  elements.cursor.style.opacity = `${presentation.opacity}`;
  elements.cursor.style.filter = presentation.filter;
}

function makeCursorPresentation({
  point,
  rotation,
  scootAxisRotation,
  scootRotation,
  scootStretch,
  stretch,
  visibility,
}: {
  point: Point;
  rotation: number;
  scootAxisRotation: number;
  scootRotation: number;
  scootStretch: number;
  stretch: number;
  visibility: number;
}): {
  filter: string;
  opacity: number;
  transform: string;
} {
  const visibleProgress = clamp(visibility, 0, 1);
  const scale = interpolate(CURSOR_HIDDEN_SCALE, 1, visibleProgress);
  const blur = interpolate(CURSOR_HIDDEN_BLUR, 0, visibleProgress);
  const scootScale = clamp(scootStretch, MIN_STRETCH, 1);
  const transforms = [
    `translate3d(${round(point.x - CURSOR_LAYER_CENTER)}px, ${round(point.y - CURSOR_LAYER_CENTER)}px, 0)`,
  ];
  if (
    Math.abs(shortestAngleDifference(0, scootAxisRotation)) > 0.001 ||
    Math.abs(scootScale - 1) > 0.001
  ) {
    transforms.push(
      `rotate(${round(scootAxisRotation)}deg)`,
      `scale(1, ${round(scootScale)})`,
      `rotate(${round(-scootAxisRotation)}deg)`,
    );
  }
  transforms.push(
    `rotate(${round(wrapDegrees(rotation + scootRotation))}deg)`,
    `scale(${round(stretch * scale)}, ${round(scale)})`,
  );
  return {
    filter: `blur(${round(blur)}px)`,
    opacity: round(visibleProgress),
    transform: transforms.join(" "),
  };
}

function readIdleRotation(state: CursorMotionState, timestamp: number): number {
  if (state.thinkStartedAt === null) return state.rotation;
  const elapsed = (timestamp - state.thinkStartedAt) / 1_000 - CURSOR_IDLE_DELAY_SECONDS;
  if (elapsed < 0) return state.rotation;
  const progress = Math.min(1, elapsed / CURSOR_IDLE_DURATION_SECONDS);
  const envelope = Math.sin(progress * Math.PI);
  const oscillation = Math.sin((elapsed / CURSOR_IDLE_CYCLE_SECONDS) * Math.PI * 2) * envelope;
  if (progress >= 1) {
    state.thinkStartedAt = null;
    return state.rotation;
  }
  return state.rotation + oscillation * CURSOR_IDLE_ROTATION_DEGREES;
}

function stretchForSpeed(speed: number): number {
  return clamp(1 - speed / 5_500, 0.65, 1);
}

function scootStretchForProgress(progress: number): number {
  const arc = Math.sin(clamp(progress, 0, 1) * Math.PI);
  return interpolate(1, interpolate(1, MIN_STRETCH, arc), SCOOT_STRETCH);
}

function setPositionSpringConfig(
  state: CursorMotionState,
  response: number,
  dampingFraction: number,
): void {
  state.positionXSpring.response = response;
  state.positionYSpring.response = response;
  state.positionXSpring.dampingFraction = dampingFraction;
  state.positionYSpring.dampingFraction = dampingFraction;
}

function advanceCursorPositionSprings(
  state: CursorMotionState,
  deltaSeconds: number,
): {
  point: Point;
  speed: number;
} {
  const previousPoint = state.point;
  advanceSpring(state.positionXSpring, deltaSeconds);
  advanceSpring(state.positionYSpring, deltaSeconds);
  advanceSpring(state.rotationSpring, deltaSeconds);
  advanceSpring(state.scootAxisSpring, deltaSeconds);
  const point = {
    x: state.positionXSpring.value,
    y: state.positionYSpring.value,
  };
  const speed = distanceBetween(previousPoint, point) / Math.max(deltaSeconds, SPRING_STEP_SECONDS);
  state.point = point;
  state.rotation = state.rotationSpring.value;
  state.scootAxisRotation = state.scootAxisSpring.value;
  return { point, speed };
}

function hasCursorArrived(state: CursorMotionState, target: Point): boolean {
  return (
    distanceBetween(state.point, target) <= ARRIVAL_DISTANCE &&
    Math.abs(state.positionXSpring.velocity) <= ARRIVAL_VELOCITY &&
    Math.abs(state.positionYSpring.velocity) <= ARRIVAL_VELOCITY
  );
}

function setCursorPointImmediately(state: CursorMotionState, point: Point): void {
  state.point = point;
  setSpringImmediately(state.positionXSpring, point.x);
  setSpringImmediately(state.positionYSpring, point.y);
}

function moveCursorImmediately(state: CursorMotionState, point: Point): void {
  state.motion = null;
  setCursorPointImmediately(state, point);
  setSpringImmediately(state.rotationSpring, wrapDegrees(-44));
  state.rotation = state.rotationSpring.value;
  resetScootState(state);
  setSpringImmediately(state.stretchSpring, 1);
}

function resetScootState(state: CursorMotionState): void {
  setSpringImmediately(state.scootAxisSpring, 0);
  setSpringImmediately(state.scootRotationSpring, 0);
  setSpringImmediately(state.scootStretchSpring, 1);
  state.scootAxisRotation = 0;
}

function projectedProgress(point: Point, start: Point, end: Point): number {
  const direction = {
    x: end.x - start.x,
    y: end.y - start.y,
  };
  const lengthSquared = direction.x * direction.x + direction.y * direction.y;
  if (lengthSquared < 0.001) return 1;
  return clamp(
    ((point.x - start.x) * direction.x + (point.y - start.y) * direction.y) / lengthSquared,
    0,
    1,
  );
}

function setAngularSpringTarget(spring: Spring, target: number): void {
  spring.target = spring.value + shortestAngleDifference(spring.value, target);
}

function shortestAngleDifference(start: number, end: number): number {
  let difference = end - start;
  while (difference > 180) difference -= 360;
  while (difference < -180) difference += 360;
  return difference;
}

function createSpring(value: number, target: number, config: SpringConfig): Spring {
  return {
    ...config,
    force: 0,
    simulationTime: 0,
    scriptTime: 0,
    target,
    value,
    velocity: 0,
  };
}

function setSpringImmediately(spring: Spring, target: number): void {
  spring.force = 0;
  spring.simulationTime = 0;
  spring.scriptTime = 0;
  spring.target = target;
  spring.value = target;
  spring.velocity = 0;
}

function advanceSpring(spring: Spring, deltaSeconds: number): void {
  const response = Math.max(0.001, spring.response);
  const maxStiffness = 1 / (2 * SPRING_STEP_SECONDS ** 2);
  const stiffness = Math.min((Math.PI * 2) ** 2 / response ** 2, maxStiffness);
  const damping = Math.sqrt(stiffness) * 2 * spring.dampingFraction;
  spring.scriptTime += Math.max(0, deltaSeconds);
  if (spring.scriptTime - spring.simulationTime > MAX_SPRING_CATCHUP_SECONDS) {
    spring.simulationTime = spring.scriptTime - FRAME_DURATION_SECONDS;
  }
  while (spring.simulationTime < spring.scriptTime) {
    integrateSpring(spring, stiffness, damping);
    spring.simulationTime += SPRING_STEP_SECONDS;
  }
  if (isSpringNearTarget(spring)) spring.value = spring.target;
}

function integrateSpring(spring: Spring, stiffness: number, damping: number): void {
  const halfStep = SPRING_STEP_SECONDS / 2;
  const midpointVelocity = spring.velocity + spring.force * halfStep;
  spring.value += midpointVelocity * SPRING_STEP_SECONDS;
  spring.force = midpointVelocity * -damping + (spring.target - spring.value) * stiffness;
  spring.velocity = midpointVelocity + spring.force * halfStep;
}

function isSpringSettled(spring: Spring): boolean {
  return spring.value === spring.target && isSpringNearTarget(spring);
}

function isSpringNearTarget(spring: Spring): boolean {
  if (
    Math.max(spring.velocity * spring.velocity, spring.force * spring.force) >
    SPRING_SETTLED_THRESHOLD * SPRING_SETTLED_THRESHOLD
  ) {
    return false;
  }
  const relativeThreshold = spring.target * 0.01;
  const delta = spring.target - spring.value;
  return relativeThreshold === 0 || delta * delta <= relativeThreshold * relativeThreshold;
}

function chooseCursorMotionPath({
  bounds,
  end,
  start,
}: {
  bounds: Size;
  end: Point;
  start: Point;
}): MotionPath {
  const candidates = generateCursorPathCandidates({ bounds, end, start });
  const fallback = candidates[0];
  if (!fallback) throw new Error("Cursor motion requires at least one path");
  let bestInBounds = fallback;
  let bestInBoundsScore = Number.POSITIVE_INFINITY;
  let bestOverall = fallback;
  let bestOverallScore = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const metrics = measureCursorPath(candidate, bounds, PATH_CONFIG.boundsMargin);
    const score = scoreCursorPath(candidate, metrics);
    if (score < bestOverallScore) {
      bestOverall = candidate;
      bestOverallScore = score;
    }
    if (metrics.staysInBounds && score < bestInBoundsScore) {
      bestInBounds = candidate;
      bestInBoundsScore = score;
    }
  }
  return bestInBoundsScore === Number.POSITIVE_INFINITY ? bestOverall : bestInBounds;
}

function generateCursorPathCandidates({
  bounds,
  end,
  start,
}: {
  bounds: Size;
  end: Point;
  start: Point;
}): MotionPath[] {
  const clickTangent = vectorForDegrees(PATH_CONFIG.clickAngleDegrees);
  const distance = distanceBetween(start, end);
  const direction = {
    x: end.x - start.x,
    y: end.y - start.y,
  };
  const normalizedDirection = normalizePoint(direction);
  const startHandleDistance = Math.max(
    48,
    Math.min(640, distance * PATH_CONFIG.startHandle, distance * 0.9),
  );
  const endHandleDistance = Math.max(
    48,
    Math.min(640, distance * PATH_CONFIG.endpointHandle, distance * 0.9),
  );
  const reverseClickTangent = {
    x: -clickTangent.x,
    y: -clickTangent.y,
  };
  const startControl = boundRay(bounds, start, clickTangent, startHandleDistance);
  const endControl = boundRay(bounds, end, reverseClickTangent, endHandleDistance);
  const perpendicular = {
    x: -normalizedDirection.y,
    y: normalizedDirection.x,
  };
  const naturalSide =
    perpendicular.x * clickTangent.x + perpendicular.y * clickTangent.y >= 0 ? 1 : -1;
  const naturalArcNormal = {
    x: perpendicular.x * naturalSide,
    y: perpendicular.y * naturalSide,
  };
  const midpoint = midpointBetween(start, end);
  const shorterStartControl = boundRay(bounds, start, clickTangent, startHandleDistance * 0.65);
  const shorterEndControl = boundRay(bounds, end, reverseClickTangent, endHandleDistance * 0.65);
  const arcDistance = Math.max(50, Math.min(520, distance * PATH_CONFIG.arcSize));
  const arcHandleDistance = Math.max(38, Math.min(440, distance * PATH_CONFIG.arcFlow));
  const candidates = [
    makeDirectPath(start, end, startControl, endControl),
    makeDirectPath(start, end, shorterStartControl, shorterEndControl),
  ];
  for (const arcScale of [0.55, 0.8, 1.05]) {
    for (const handleScale of [0.65, 1, 1.35]) {
      addArcPathPair({
        arcDistance: arcDistance * arcScale,
        arcHandleDistance: arcHandleDistance * handleScale,
        arcTangent: normalizedDirection,
        candidates,
        clickTangent,
        end,
        endControl,
        midpoint,
        naturalArcNormal,
        start,
        startControl,
        startHandleDistance,
      });
    }
  }
  return candidates.slice(0, PATH_CONFIG.candidateCount);
}

function addArcPathPair(input: {
  arcDistance: number;
  arcHandleDistance: number;
  arcTangent: Point;
  candidates: MotionPath[];
  clickTangent: Point;
  end: Point;
  endControl: Point;
  midpoint: Point;
  naturalArcNormal: Point;
  start: Point;
  startControl: Point;
  startHandleDistance: number;
}): void {
  addArcPath(input);
  addArcPath({
    ...input,
    naturalArcNormal: {
      x: -input.naturalArcNormal.x,
      y: -input.naturalArcNormal.y,
    },
  });
}

function addArcPath({
  arcDistance,
  arcHandleDistance,
  arcTangent,
  candidates,
  clickTangent,
  end,
  endControl,
  midpoint,
  naturalArcNormal,
  start,
  startControl,
  startHandleDistance,
}: {
  arcDistance: number;
  arcHandleDistance: number;
  arcTangent: Point;
  candidates: MotionPath[];
  clickTangent: Point;
  end: Point;
  endControl: Point;
  midpoint: Point;
  naturalArcNormal: Point;
  start: Point;
  startControl: Point;
  startHandleDistance: number;
}): void {
  const arc = {
    x: midpoint.x + naturalArcNormal.x * arcDistance + clickTangent.x * startHandleDistance * 0.16,
    y: midpoint.y + naturalArcNormal.y * arcDistance + clickTangent.y * startHandleDistance * 0.16,
  };
  const arcIn = {
    x: arc.x - arcTangent.x * arcHandleDistance,
    y: arc.y - arcTangent.y * arcHandleDistance,
  };
  const arcOut = {
    x: arc.x + arcTangent.x * arcHandleDistance,
    y: arc.y + arcTangent.y * arcHandleDistance,
  };
  candidates.push(
    makeArcPath({
      arc,
      arcIn,
      arcOut,
      end,
      endControl,
      start,
      startControl,
    }),
  );
}

function makeDirectPath(
  start: Point,
  end: Point,
  startControl: Point,
  endControl: Point,
): MotionPath {
  return {
    arc: null,
    arcIn: null,
    arcOut: null,
    end,
    endControl,
    segments: [{ control1: startControl, control2: endControl, end }],
    start,
    startControl,
  };
}

function makeArcPath({
  arc,
  arcIn,
  arcOut,
  end,
  endControl,
  start,
  startControl,
}: {
  arc: Point;
  arcIn: Point;
  arcOut: Point;
  end: Point;
  endControl: Point;
  start: Point;
  startControl: Point;
}): MotionPath {
  return {
    arc,
    arcIn,
    arcOut,
    end,
    endControl,
    segments: [
      { control1: startControl, control2: arcIn, end: arc },
      { control1: arcOut, control2: endControl, end },
    ],
    start,
    startControl,
  };
}

function measureCursorPath(
  path: MotionPath,
  bounds?: Size,
  boundsMargin?: number,
): CursorPathMetrics {
  let length = 0;
  let angleChangeEnergy = 0;
  let maxAngleChange = 0;
  let totalTurn = 0;
  let previousAngle: number | null = null;
  let staysInBounds =
    !bounds || boundsMargin === undefined || pointWithinBounds(path.start, bounds, boundsMargin);
  let segmentStart = path.start;
  let previousPoint = path.start;

  for (const segment of path.segments) {
    for (let sampleIndex = 1; sampleIndex <= 24; sampleIndex += 1) {
      const progress = sampleIndex / 24;
      const point = cubicBezierPoint(
        segmentStart,
        segment.control1,
        segment.control2,
        segment.end,
        progress,
      );
      length += distanceBetween(previousPoint, point);
      if (bounds && boundsMargin !== undefined) {
        staysInBounds &&= pointWithinBounds(point, bounds, boundsMargin);
      }
      const delta = {
        x: point.x - previousPoint.x,
        y: point.y - previousPoint.y,
      };
      if (distanceBetween({ x: 0, y: 0 }, delta) > 0.01) {
        const angle = Math.atan2(delta.y, delta.x);
        if (previousAngle !== null) {
          const change = shortestRadiansDifference(previousAngle, angle);
          angleChangeEnergy += change * change;
          maxAngleChange = Math.max(maxAngleChange, Math.abs(change));
          totalTurn += Math.abs(change);
        }
        previousAngle = angle;
      }
      previousPoint = point;
    }
    segmentStart = segment.end;
  }

  return {
    angleChangeEnergy,
    length,
    maxAngleChange,
    staysInBounds,
    totalTurn,
  };
}

function scoreCursorPath(path: MotionPath, metrics: CursorPathMetrics): number {
  const directDistance = Math.max(1, distanceBetween(path.start, path.end));
  const excessLength = Math.max(0, metrics.length / directDistance - 1);
  const arcPenalty = path.arc === null ? 0 : 45;
  const reversePenalty = cursorPathReversePenalty(path);
  return (
    metrics.length +
    excessLength * 320 +
    metrics.angleChangeEnergy * 140 +
    metrics.maxAngleChange * 180 +
    metrics.totalTurn * 18 +
    reversePenalty * 90 +
    arcPenalty
  );
}

function cursorPathReversePenalty(path: MotionPath): number {
  const clickDirection = vectorForDegrees(-44);
  const direction = normalizePoint({
    x: path.end.x - path.start.x,
    y: path.end.y - path.start.y,
  });
  return clamp(
    (-(direction.x * clickDirection.x + direction.y * clickDirection.y) - 0.08) / 0.92,
    0,
    1,
  );
}

function responseForPath(path: MotionPath): SpringConfig {
  const metrics = measureCursorPath(path);
  const directDistance = Math.max(1, distanceBetween(path.start, path.end));
  const excessLength = Math.max(0, metrics.length / directDistance - 1);
  const lengthProgress = clamp((metrics.length - 180) / 760, 0, 1);
  const excessProgress = clamp(excessLength / 0.55, 0, 1);
  const turnProgress = clamp(metrics.totalTurn / (Math.PI * 1.4), 0, 1);
  const energyProgress = clamp(metrics.angleChangeEnergy / 1.25, 0, 1);
  const curvature = clamp(excessProgress * 0.42 + turnProgress * 0.38 + energyProgress * 0.2, 0, 1);
  const reversePenalty = cursorPathReversePenalty(path);
  const arcAdjustment = path.arc === null ? 0 : 0.04;
  const reverseAdjustment = reversePenalty * 0.28;
  const directAdjustment = path.arc === null ? 1 : 0.9;
  return {
    dampingFraction: 0.9,
    response: clamp(
      (0.42 + lengthProgress * 0.22 + curvature * 0.12 + reverseAdjustment + arcAdjustment) *
        0.7 *
        directAdjustment,
      0.12,
      2.2,
    ),
  };
}

function sampleCursorMotionPath(
  path: MotionPath,
  progress: number,
): {
  point: Point;
  tangent: Point;
} {
  const clampedProgress = clamp(progress, 0, 1);
  const rawSegmentIndex =
    clampedProgress === 1 ? path.segments.length - 1 : clampedProgress * path.segments.length;
  const segmentIndex = Math.floor(rawSegmentIndex);
  const segment = path.segments[segmentIndex];
  if (!segment) {
    throw new Error("Cursor motion path has no segment for progress");
  }
  const previousSegment = path.segments[segmentIndex - 1];
  const segmentStart = segmentIndex === 0 ? path.start : previousSegment?.end;
  if (!segmentStart) {
    throw new Error("Cursor motion path segment is missing its start point");
  }
  const segmentProgress = clampedProgress === 1 ? 1 : rawSegmentIndex - segmentIndex;
  return {
    point: cubicBezierPoint(
      segmentStart,
      segment.control1,
      segment.control2,
      segment.end,
      segmentProgress,
    ),
    tangent: cubicBezierTangent(
      segmentStart,
      segment.control1,
      segment.control2,
      segment.end,
      segmentProgress,
    ),
  };
}

function cursorRotationForTangent(tangent: Point): number {
  if (distanceBetween({ x: 0, y: 0 }, tangent) < 0.001) {
    return wrapDegrees(-44);
  }
  const normalized = normalizePoint(tangent);
  return wrapDegrees(Math.atan2(normalized.y, normalized.x) * (180 / Math.PI) + 90);
}

function boundRay(bounds: Size, start: Point, direction: Point, distance: number): Point {
  let boundedDistance = distance;
  if (direction.x < 0) {
    boundedDistance = Math.min(boundedDistance, start.x / -direction.x);
  }
  if (direction.x > 0) {
    boundedDistance = Math.min(boundedDistance, (bounds.width - start.x) / direction.x);
  }
  if (direction.y < 0) {
    boundedDistance = Math.min(boundedDistance, start.y / -direction.y);
  }
  if (direction.y > 0) {
    boundedDistance = Math.min(boundedDistance, (bounds.height - start.y) / direction.y);
  }
  return {
    x: start.x + direction.x * Math.max(0, boundedDistance),
    y: start.y + direction.y * Math.max(0, boundedDistance),
  };
}

function vectorForDegrees(degrees: number): Point {
  const radians = (Math.PI / 180) * degrees;
  return {
    x: Math.sin(radians),
    y: -Math.cos(radians),
  };
}

function cubicBezierPoint(
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  progress: number,
): Point {
  const inverse = 1 - progress;
  const startWeight = inverse * inverse * inverse;
  const control1Weight = 3 * inverse * inverse * progress;
  const control2Weight = 3 * inverse * progress * progress;
  const endWeight = progress * progress * progress;
  return {
    x:
      start.x * startWeight +
      control1.x * control1Weight +
      control2.x * control2Weight +
      end.x * endWeight,
    y:
      start.y * startWeight +
      control1.y * control1Weight +
      control2.y * control2Weight +
      end.y * endWeight,
  };
}

function cubicBezierTangent(
  start: Point,
  control1: Point,
  control2: Point,
  end: Point,
  progress: number,
): Point {
  const inverse = 1 - progress;
  return {
    x:
      3 * inverse * inverse * (control1.x - start.x) +
      6 * inverse * progress * (control2.x - control1.x) +
      3 * progress * progress * (end.x - control2.x),
    y:
      3 * inverse * inverse * (control1.y - start.y) +
      6 * inverse * progress * (control2.y - control1.y) +
      3 * progress * progress * (end.y - control2.y),
  };
}

function normalizePoint(point: Point): Point {
  const length = Math.sqrt(point.x * point.x + point.y * point.y);
  if (length < 0.001) return { x: 1, y: 0 };
  return {
    x: point.x / length,
    y: point.y / length,
  };
}

function pointAngleDegrees(point: Point): number {
  if (distanceBetween({ x: 0, y: 0 }, point) < 0.001) return 0;
  return Math.atan2(point.y, point.x) * (180 / Math.PI);
}

function midpointBetween(start: Point, end: Point): Point {
  return {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2,
  };
}

function pointWithinBounds(point: Point, bounds: Size, margin: number): boolean {
  return (
    point.x >= margin &&
    point.x <= bounds.width - margin &&
    point.y >= margin &&
    point.y <= bounds.height - margin
  );
}

function shortestRadiansDifference(start: number, end: number): number {
  let difference = end - start;
  while (difference > Math.PI) difference -= Math.PI * 2;
  while (difference < -Math.PI) difference += Math.PI * 2;
  return difference;
}

function distanceBetween(start: Point, end: Point): number {
  const x = end.x - start.x;
  const y = end.y - start.y;
  return Math.sqrt(x * x + y * y);
}

function interpolate(start: number, end: number, progress: number): number {
  return start + (end - start) * progress;
}

function wrapDegrees(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function requestFrame(callback: FrameRequestCallback): number {
  if (typeof window === "undefined") {
    callback(now());
    return 0;
  }
  if (window.requestAnimationFrame) {
    return window.requestAnimationFrame(callback);
  }
  return window.setTimeout(() => callback(now()), FRAME_DURATION_SECONDS * 1_000);
}

function cancelFrame(frame: number): void {
  if (typeof window === "undefined") return;
  if (window.cancelAnimationFrame) {
    window.cancelAnimationFrame(frame);
    return;
  }
  window.clearTimeout(frame);
}
