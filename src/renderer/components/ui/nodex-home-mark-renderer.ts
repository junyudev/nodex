import {
  NODEX_HOME_MARK_FITTED_FRONT_BOUNDARY,
  NODEX_HOME_MARK_FITTED_TOP_BOUNDARY,
  NODEX_HOME_MARK_PACKED_BASE64,
  NODEX_HOME_MARK_VERTEX_COUNT,
  NODEX_HOME_MARK_VERTEX_STRIDE_BYTES,
} from "./nodex-home-mark-model.generated";
import type { NodexHomeMarkGlyphScene } from "./nodex-home-mark-glyph-scenes.generated";
import type { SrgbaColor } from "@/lib/css-color-srgba";
import {
  NODEX_HOME_MARK_BASE_ROTATION,
  resolveNodexHomeMarkFramebuffer,
  type NodexMarkMat3,
} from "@/lib/nodex-home-mark-motion";

const DESIGN_SIZE = 800;
const FRAME_COORD_SIZE = 1120;
const FRAME_CSS_SIZE = 78.4;
const FRAME_OFFSET = (FRAME_COORD_SIZE - DESIGN_SIZE) / 2;
const HERO_GEOMETRY_SCALE = 1.17;
const FITTED_SCALE = 544.3973872;
const FLIGHT_SCALE = 520;
const FITTED_PRINCIPAL = [396.941096, 404.431016] as const;
const REGULAR_BEVEL = 0.052;
const PANEL_MARGIN = 0.037;
const PANEL_RADIUS = 0.055;
const PANEL_VERTEX_COUNT = 36;
const GLYPH_SEGMENT_COUNT = 9;
const REAR_BOTTOM_LIFT = 0.1553330427;

const VERTEX_SHADER = `#version 300 es
  precision highp float;
  layout(location=0) in vec3 aFittedPosition;
  layout(location=1) in vec3 aFittedNormal;
  layout(location=2) in vec3 aRegularPosition;
  layout(location=3) in vec3 aRegularNormal;
  uniform vec2 uResolution;
  uniform float uScale;
  uniform vec2 uPrincipal;
  uniform mat3 uCamera;
  uniform mat3 uPose;
  uniform float uMorph;
  out vec3 vRegularPosition;
  out vec3 vRegularNormal;
  void main(){
    vec3 fittedPosition=aFittedPosition*.5;
    vec3 regularPosition=aRegularPosition*.5;
    vec3 position=mix(fittedPosition,regularPosition,uMorph);
    vec3 normal=normalize(mix(aFittedNormal,aRegularNormal,uMorph));
    vec3 cameraPosition=uCamera*(uPose*position);
    vec2 screen=uPrincipal+cameraPosition.xy*uScale;
    vec2 clip=vec2(screen.x/uResolution.x*2.0-1.0,1.0-screen.y/uResolution.y*2.0);
    gl_Position=vec4(clip,-cameraPosition.z,1.0);
    vRegularPosition=regularPosition;
    vRegularNormal=normalize(aRegularNormal);
  }
`;

const FRAGMENT_SHADER = `#version 300 es
  precision highp float;
  const int PANEL_VERTEX_COUNT=${PANEL_VERTEX_COUNT};
  in vec3 vRegularPosition;
  in vec3 vRegularNormal;
  uniform vec2 uTopBoundary[PANEL_VERTEX_COUNT];
  uniform vec2 uFrontBoundary[PANEL_VERTEX_COUNT];
  uniform vec2 uTopNormals[PANEL_VERTEX_COUNT];
  uniform vec2 uFrontNormals[PANEL_VERTEX_COUNT];
  uniform vec2 uResolution;
  uniform vec2 uFramebufferResolution;
  uniform float uAaHalfWidth;
  uniform vec4 uGlyphSegments[${GLYPH_SEGMENT_COUNT}];
  uniform float uGlyphRadii[${GLYPH_SEGMENT_COUNT}];
  uniform float uGlyphSegmentCount;
  uniform float uTopVisibility;
  uniform float uFrontVisibility;
  uniform float uMorph;
  uniform vec4 uColor;
  out vec4 outColor;

  float sdSegmentSquared(vec2 p,vec2 a,vec2 b){
    vec2 pa=p-a,ba=b-a;
    float h=clamp(dot(pa,ba)/max(dot(ba,ba),1e-8),0.0,1.0);
    vec2 delta=pa-ba*h;
    return dot(delta,delta);
  }
  float sdSegment(vec2 p,vec2 a,vec2 b){
    return sqrt(sdSegmentSquared(p,a,b));
  }
  float sdTopPanel(vec2 p){
    float maxPlane=-1e20,minDistanceSquared=1e20;
    for(int index=0;index<PANEL_VERTEX_COUNT;index++){
      vec2 a=uTopBoundary[index],b=uTopBoundary[(index+1)%PANEL_VERTEX_COUNT];
      maxPlane=max(maxPlane,dot(uTopNormals[index],p-a));
      minDistanceSquared=min(minDistanceSquared,sdSegmentSquared(p,a,b));
    }
    float minDistance=sqrt(minDistanceSquared);
    return maxPlane<=0.0?-minDistance:minDistance;
  }
  float sdFrontPanel(vec2 p){
    float maxPlane=-1e20,minDistanceSquared=1e20;
    for(int index=0;index<PANEL_VERTEX_COUNT;index++){
      vec2 a=uFrontBoundary[index],b=uFrontBoundary[(index+1)%PANEL_VERTEX_COUNT];
      maxPlane=max(maxPlane,dot(uFrontNormals[index],p-a));
      minDistanceSquared=min(minDistanceSquared,sdSegmentSquared(p,a,b));
    }
    float minDistance=sqrt(minDistanceSquared);
    return maxPlane<=0.0?-minDistance:minDistance;
  }
  float sdRoundRect(vec2 p,vec2 halfSize,float radius){
    vec2 q=abs(p)-halfSize+vec2(radius);
    return length(max(q,0.0))+min(max(q.x,q.y),0.0)-radius;
  }
  float faceOwnedDistance(float distance,float alignment){
    float ownership=smoothstep(.94,.995,alignment);
    return mix(max(distance,.08),distance,ownership);
  }
  float aaFill(float distance){
    float width=max(fwidth(distance)*uAaHalfWidth,1e-6);
    return 1.0-smoothstep(-width,width,distance);
  }
  void main(){
    vec2 fragmentScreen=vec2(
      gl_FragCoord.x/uFramebufferResolution.x*uResolution.x,
      (uFramebufferResolution.y-gl_FragCoord.y)/uFramebufferResolution.y*uResolution.y
    );
    vec3 regularNormal=normalize(vRegularNormal);
    float canonicalHalf=max(.06,.5-${REGULAR_BEVEL}-${PANEL_MARGIN});
    float radius=min(${PANEL_RADIUS},canonicalHalf);
    vec2 halfSize=vec2(canonicalHalf);

    float topDistance=uTopVisibility>.001?sdTopPanel(fragmentScreen):1e5;
    float frontDistance=uFrontVisibility>.001?sdFrontPanel(fragmentScreen):1e5;
    float white=aaFill(min(topDistance,frontDistance));
    float glyphDistance=1e5;
    for(int index=0;index<${GLYPH_SEGMENT_COUNT};index++){
      if(float(index)>=uGlyphSegmentCount) continue;
      vec4 segment=uGlyphSegments[index];
      glyphDistance=min(
        glyphDistance,
        sdSegment(fragmentScreen,segment.xy,segment.zw)-uGlyphRadii[index]
      );
    }
    float frontOwnership=smoothstep(.94,.995,regularNormal.z);
    if(uFrontVisibility>.001){
      white*=1.0-aaFill(glyphDistance)*aaFill(frontDistance)*frontOwnership;
    }

    float rightCenterY=mix(-${REAR_BOTTOM_LIFT}*.25,0.0,uMorph);
    float rightDistance=faceOwnedDistance(
      sdRoundRect(vec2(-vRegularPosition.z,vRegularPosition.y-rightCenterY),halfSize,radius),
      regularNormal.x
    );
    white=max(white,aaFill(rightDistance));

    float darkMask=clamp(1.0-white,0.0,1.0);
    outColor=vec4(uColor.rgb,darkMask*uColor.a);
  }
`;

const TARGET_BOUNDARY_COEFFICIENTS = buildTargetBoundaryCoefficients();

export interface NodexHomeMarkRenderFrame {
  rotation: NodexMarkMat3;
  morph: number;
  chargedScale: number;
  color: SrgbaColor;
  glyphScene: NodexHomeMarkGlyphScene;
}

export interface NodexHomeMarkRenderer {
  readonly canvas: HTMLCanvasElement;
  render(frame: NodexHomeMarkRenderFrame): void;
  dispose(): void;
}

interface RendererUniforms {
  resolution: WebGLUniformLocation;
  framebufferResolution: WebGLUniformLocation;
  aaHalfWidth: WebGLUniformLocation;
  scale: WebGLUniformLocation;
  principal: WebGLUniformLocation;
  camera: WebGLUniformLocation;
  pose: WebGLUniformLocation;
  morph: WebGLUniformLocation;
  color: WebGLUniformLocation;
  topBoundary: WebGLUniformLocation;
  frontBoundary: WebGLUniformLocation;
  topNormals: WebGLUniformLocation;
  frontNormals: WebGLUniformLocation;
  glyphSegments: WebGLUniformLocation;
  glyphRadii: WebGLUniformLocation;
  glyphSegmentCount: WebGLUniformLocation;
  topVisibility: WebGLUniformLocation;
  frontVisibility: WebGLUniformLocation;
}

function buildTargetBoundaryCoefficients(): Float32Array {
  const kappa = 0.5522847498307936;
  type Coefficient = readonly [number, number, number, number];
  type Segment =
    | { kind: "line"; end: Coefficient }
    | { kind: "cubic"; c1: Coefficient; c2: Coefficient; end: Coefficient };
  const start: Coefficient = [-1, -1, 0, 1];
  const segments: Segment[] = [
    { kind: "cubic", c1: [-1, -1, 0, 1 - kappa], c2: [-1, -1, 1 - kappa, 0], end: [-1, -1, 1, 0] },
    { kind: "line", end: [1, -1, -1, 0] },
    { kind: "cubic", c1: [1, -1, -1 + kappa, 0], c2: [1, -1, 0, 1 - kappa], end: [1, -1, 0, 1] },
    { kind: "line", end: [1, 1, 0, -1] },
    { kind: "cubic", c1: [1, 1, 0, -1 + kappa], c2: [1, 1, -1 + kappa, 0], end: [1, 1, -1, 0] },
    { kind: "line", end: [-1, 1, 1, 0] },
    { kind: "cubic", c1: [-1, 1, 1 - kappa, 0], c2: [-1, 1, 0, -1 + kappa], end: [-1, 1, 0, -1] },
    { kind: "line", end: start },
  ];
  const values: number[][] = [Array.from(start)];
  let current = start;
  for (const segment of segments) {
    if (segment.kind === "line") {
      values.push(Array.from(segment.end));
      current = segment.end;
      continue;
    }
    for (let step = 1; step <= 8; step += 1) {
      const amount = step / 8;
      const inverse = 1 - amount;
      values.push(
        current.map(
          (value, index) =>
            inverse ** 3 * value +
            3 * inverse ** 2 * amount * segment.c1[index] +
            3 * inverse * amount ** 2 * segment.c2[index] +
            amount ** 3 * segment.end[index],
        ),
      );
    }
    current = segment.end;
  }
  values.pop();
  return new Float32Array(values.flat());
}

function decodePackedVertices(): Int16Array {
  const binary = globalThis.atob(NODEX_HOME_MARK_PACKED_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Int16Array(bytes.buffer);
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Unable to allocate a Nodex mark shader.");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  const message = gl.getShaderInfoLog(shader) ?? "Unknown shader compile failure.";
  gl.deleteShader(shader);
  throw new Error(message);
}

function createProgram(gl: WebGL2RenderingContext): WebGLProgram {
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  let fragmentShader: WebGLShader | null = null;
  const program = gl.createProgram();
  try {
    fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
    if (!program) throw new Error("Unable to allocate the Nodex mark program.");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) ?? "Unknown program link failure.");
    }
    return program;
  } catch (error) {
    if (program) gl.deleteProgram(program);
    throw error;
  } finally {
    gl.deleteShader(vertexShader);
    if (fragmentShader) gl.deleteShader(fragmentShader);
  }
}

function requiredUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (!location) throw new Error(`Nodex mark shader omitted ${name}.`);
  return location;
}

function resolveUniforms(gl: WebGL2RenderingContext, program: WebGLProgram): RendererUniforms {
  return {
    resolution: requiredUniform(gl, program, "uResolution"),
    framebufferResolution: requiredUniform(gl, program, "uFramebufferResolution"),
    aaHalfWidth: requiredUniform(gl, program, "uAaHalfWidth"),
    scale: requiredUniform(gl, program, "uScale"),
    principal: requiredUniform(gl, program, "uPrincipal"),
    camera: requiredUniform(gl, program, "uCamera"),
    pose: requiredUniform(gl, program, "uPose"),
    morph: requiredUniform(gl, program, "uMorph"),
    color: requiredUniform(gl, program, "uColor"),
    topBoundary: requiredUniform(gl, program, "uTopBoundary[0]"),
    frontBoundary: requiredUniform(gl, program, "uFrontBoundary[0]"),
    topNormals: requiredUniform(gl, program, "uTopNormals[0]"),
    frontNormals: requiredUniform(gl, program, "uFrontNormals[0]"),
    glyphSegments: requiredUniform(gl, program, "uGlyphSegments[0]"),
    glyphRadii: requiredUniform(gl, program, "uGlyphRadii[0]"),
    glyphSegmentCount: requiredUniform(gl, program, "uGlyphSegmentCount"),
    topVisibility: requiredUniform(gl, program, "uTopVisibility"),
    frontVisibility: requiredUniform(gl, program, "uFrontVisibility"),
  };
}

function writeColumnMajor(matrix: NodexMarkMat3, target = new Float32Array(9)): Float32Array {
  target[0] = matrix[0];
  target[1] = matrix[3];
  target[2] = matrix[6];
  target[3] = matrix[1];
  target[4] = matrix[4];
  target[5] = matrix[7];
  target[6] = matrix[2];
  target[7] = matrix[5];
  target[8] = matrix[8];
  return target;
}

function matVec3(matrix: NodexMarkMat3, x: number, y: number, z: number) {
  return [
    matrix[0] * x + matrix[1] * y + matrix[2] * z,
    matrix[3] * x + matrix[4] * y + matrix[5] * z,
    matrix[6] * x + matrix[7] * y + matrix[8] * z,
  ] as const;
}

function writeScreenPoint(input: {
  target: Float32Array;
  targetOffset: number;
  fitted: ArrayLike<number>;
  fittedOffset: number;
  regularX: number;
  regularY: number;
  regularZ: number;
  morph: number;
  rotation: NodexMarkMat3;
  scale: number;
  principalX: number;
  principalY: number;
}) {
  const {
    target,
    targetOffset,
    fitted,
    fittedOffset,
    regularX,
    regularY,
    regularZ,
    morph,
    rotation,
    scale,
    principalX,
    principalY,
  } = input;
  const x = fitted[fittedOffset] + (regularX - fitted[fittedOffset]) * morph;
  const y = fitted[fittedOffset + 1] + (regularY - fitted[fittedOffset + 1]) * morph;
  const z = fitted[fittedOffset + 2] + (regularZ - fitted[fittedOffset + 2]) * morph;
  const posed = matVec3(rotation, x, y, z);
  const camera = matVec3(NODEX_HOME_MARK_BASE_ROTATION, posed[0], posed[1], posed[2]);
  target[targetOffset] = principalX + camera[0] * scale;
  target[targetOffset + 1] = principalY + camera[1] * scale;
}

function writeOutwardNormals(boundary: Float32Array, output: Float32Array) {
  let doubledArea = 0;
  for (let index = 0; index < PANEL_VERTEX_COUNT; index += 1) {
    const next = (index + 1) % PANEL_VERTEX_COUNT;
    doubledArea +=
      boundary[index * 2] * boundary[next * 2 + 1] - boundary[index * 2 + 1] * boundary[next * 2];
  }
  const orientation = doubledArea > 0 ? -1 : 1;
  for (let index = 0; index < PANEL_VERTEX_COUNT; index += 1) {
    const next = (index + 1) % PANEL_VERTEX_COUNT;
    const x = boundary[next * 2] - boundary[index * 2];
    const y = boundary[next * 2 + 1] - boundary[index * 2 + 1];
    const length = Math.hypot(x, y) || 1;
    output[index * 2] = (orientation * -y) / length;
    output[index * 2 + 1] = (orientation * x) / length;
  }
}

export function createNodexHomeMarkRenderer(input: {
  devicePixelRatio: number;
  onContextLost: () => void;
}): NodexHomeMarkRenderer | null {
  const canvas = document.createElement("canvas");
  canvas.dataset.nodexHomeMarkCanvas = "true";
  canvas.setAttribute("aria-hidden", "true");
  Object.assign(canvas.style, {
    position: "absolute",
    top: "-11.2px",
    left: "-11.2px",
    display: "block",
    width: `${FRAME_CSS_SIZE}px`,
    height: `${FRAME_CSS_SIZE}px`,
    visibility: "hidden",
    pointerEvents: "none",
  });
  const gl = canvas.getContext("webgl2", {
    alpha: true,
    antialias: true,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: false,
    failIfMajorPerformanceCaveat: true,
    powerPreference: "low-power",
  });
  if (!gl) return null;

  let disposed = false;
  let program: WebGLProgram | null = null;
  let vertexArray: WebGLVertexArrayObject | null = null;
  let vertexBuffer: WebGLBuffer | null = null;
  let contextLost = false;
  let uniforms: RendererUniforms;
  const topScreen = new Float32Array(PANEL_VERTEX_COUNT * 2);
  const frontScreen = new Float32Array(PANEL_VERTEX_COUNT * 2);
  const topNormals = new Float32Array(PANEL_VERTEX_COUNT * 2);
  const frontNormals = new Float32Array(PANEL_VERTEX_COUNT * 2);
  const glyphSegments = new Float32Array(GLYPH_SEGMENT_COUNT * 4);
  const glyphRadii = new Float32Array(GLYPH_SEGMENT_COUNT);
  const cameraMatrix = writeColumnMajor(NODEX_HOME_MARK_BASE_ROTATION);
  const poseMatrix = new Float32Array(9);

  const handleContextLost = () => {
    contextLost = true;
    input.onContextLost();
  };
  canvas.addEventListener("webglcontextlost", handleContextLost);

  /**
   * Release only resources owned by this renderer. The browser owns drawing
   * buffer retirement; forcing context loss here can invalidate a mailbox that
   * Chromium's compositor is still consuming during the SVG handoff.
   */
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    canvas.removeEventListener("webglcontextlost", handleContextLost);
    if (!contextLost) {
      if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      if (vertexArray) gl.deleteVertexArray(vertexArray);
      if (program) gl.deleteProgram(program);
    }
    vertexBuffer = null;
    vertexArray = null;
    program = null;
    canvas.remove();
  };

  try {
    program = createProgram(gl);
    uniforms = resolveUniforms(gl, program);
    vertexArray = gl.createVertexArray();
    vertexBuffer = gl.createBuffer();
    if (!vertexArray || !vertexBuffer) {
      throw new Error("Unable to allocate Nodex mark geometry.");
    }
    gl.bindVertexArray(vertexArray);
    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, decodePackedVertices(), gl.STATIC_DRAW);
    for (let attribute = 0; attribute < 4; attribute += 1) {
      gl.enableVertexAttribArray(attribute);
      gl.vertexAttribPointer(
        attribute,
        3,
        gl.SHORT,
        true,
        NODEX_HOME_MARK_VERTEX_STRIDE_BYTES,
        attribute * 6,
      );
    }
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  } catch (error) {
    console.warn("Nodex home mark will remain static.", error);
    dispose();
    return null;
  }

  const render = ({
    rotation,
    morph,
    chargedScale,
    color,
    glyphScene,
  }: NodexHomeMarkRenderFrame) => {
    if (disposed || !program || !vertexArray) return;
    const framebuffer = resolveNodexHomeMarkFramebuffer({
      devicePixelRatio: input.devicePixelRatio,
      chargedScale,
    });
    if (canvas.width !== framebuffer.size || canvas.height !== framebuffer.size) {
      canvas.width = framebuffer.size;
      canvas.height = framebuffer.size;
    }
    const scale = (FITTED_SCALE + (FLIGHT_SCALE - FITTED_SCALE) * morph) * HERO_GEOMETRY_SCALE;
    const principalX = FITTED_PRINCIPAL[0] + (400 - FITTED_PRINCIPAL[0]) * morph + FRAME_OFFSET;
    const principalY = FITTED_PRINCIPAL[1] + (400 - FITTED_PRINCIPAL[1]) * morph + FRAME_OFFSET;
    const canonicalHalf = Math.max(0.06, 0.5 - REGULAR_BEVEL - PANEL_MARGIN);
    const radius = Math.min(PANEL_RADIUS, canonicalHalf);

    for (let index = 0; index < PANEL_VERTEX_COUNT; index += 1) {
      const coefficientOffset = index * 4;
      const screenOffset = index * 2;
      const u =
        TARGET_BOUNDARY_COEFFICIENTS[coefficientOffset] * canonicalHalf +
        TARGET_BOUNDARY_COEFFICIENTS[coefficientOffset + 2] * radius;
      const v =
        TARGET_BOUNDARY_COEFFICIENTS[coefficientOffset + 1] * canonicalHalf +
        TARGET_BOUNDARY_COEFFICIENTS[coefficientOffset + 3] * radius;
      writeScreenPoint({
        target: topScreen,
        targetOffset: screenOffset,
        fitted: NODEX_HOME_MARK_FITTED_TOP_BOUNDARY,
        fittedOffset: index * 3,
        regularX: u,
        regularY: -0.5008,
        regularZ: v,
        morph,
        rotation,
        scale,
        principalX,
        principalY,
      });
      writeScreenPoint({
        target: frontScreen,
        targetOffset: screenOffset,
        fitted: NODEX_HOME_MARK_FITTED_FRONT_BOUNDARY,
        fittedOffset: index * 3,
        regularX: u,
        regularY: v,
        regularZ: 0.5008,
        morph,
        rotation,
        scale,
        principalX,
        principalY,
      });
    }
    writeOutwardNormals(topScreen, topNormals);
    writeOutwardNormals(frontScreen, frontNormals);
    glyphSegments.fill(0);
    glyphRadii.fill(0);
    for (let index = 0; index < glyphScene.segments.length; index += 1) {
      const segment = glyphScene.segments[index];
      const screenOffset = index * 4;
      writeScreenPoint({
        target: glyphSegments,
        targetOffset: screenOffset,
        fitted: segment.fittedA,
        fittedOffset: 0,
        regularX: segment.targetA[0],
        regularY: segment.targetA[1],
        regularZ: segment.targetA[2],
        morph,
        rotation,
        scale,
        principalX,
        principalY,
      });
      writeScreenPoint({
        target: glyphSegments,
        targetOffset: screenOffset + 2,
        fitted: segment.fittedB,
        fittedOffset: 0,
        regularX: segment.targetB[0],
        regularY: segment.targetB[1],
        regularZ: segment.targetB[2],
        morph,
        rotation,
        scale,
        principalX,
        principalY,
      });
    }

    const posedTop = matVec3(rotation, 0, -1, 0);
    const cameraTop = matVec3(NODEX_HOME_MARK_BASE_ROTATION, posedTop[0], posedTop[1], posedTop[2]);
    const posedFront = matVec3(rotation, 0, 0, 1);
    const cameraFront = matVec3(
      NODEX_HOME_MARK_BASE_ROTATION,
      posedFront[0],
      posedFront[1],
      posedFront[2],
    );
    const posedFrontX = matVec3(rotation, 1, 0, 0);
    const frontX = matVec3(
      NODEX_HOME_MARK_BASE_ROTATION,
      posedFrontX[0],
      posedFrontX[1],
      posedFrontX[2],
    );
    const posedFrontY = matVec3(rotation, 0, 1, 0);
    const frontY = matVec3(
      NODEX_HOME_MARK_BASE_ROTATION,
      posedFrontY[0],
      posedFrontY[1],
      posedFrontY[2],
    );
    const faceScale =
      Math.sqrt(Math.hypot(frontX[0], frontX[1]) * Math.hypot(frontY[0], frontY[1])) * scale;
    for (let index = 0; index < glyphScene.segments.length; index += 1) {
      glyphRadii[index] = glyphScene.segments[index].radius * faceScale;
    }

    gl.viewport(0, 0, framebuffer.size, framebuffer.size);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.disable(gl.CULL_FACE);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.useProgram(program);
    gl.bindVertexArray(vertexArray);
    gl.uniform2f(uniforms.resolution, FRAME_COORD_SIZE, FRAME_COORD_SIZE);
    gl.uniform2f(uniforms.framebufferResolution, framebuffer.size, framebuffer.size);
    gl.uniform1f(uniforms.aaHalfWidth, framebuffer.aaHalfWidth);
    gl.uniform1f(uniforms.scale, scale);
    gl.uniform2f(uniforms.principal, principalX, principalY);
    gl.uniformMatrix3fv(uniforms.camera, false, cameraMatrix);
    gl.uniformMatrix3fv(uniforms.pose, false, writeColumnMajor(rotation, poseMatrix));
    gl.uniform1f(uniforms.morph, morph);
    gl.uniform4f(uniforms.color, color[0], color[1], color[2], color[3]);
    gl.uniform2fv(uniforms.topBoundary, topScreen);
    gl.uniform2fv(uniforms.frontBoundary, frontScreen);
    gl.uniform2fv(uniforms.topNormals, topNormals);
    gl.uniform2fv(uniforms.frontNormals, frontNormals);
    gl.uniform4fv(uniforms.glyphSegments, glyphSegments);
    gl.uniform1fv(uniforms.glyphRadii, glyphRadii);
    gl.uniform1f(uniforms.glyphSegmentCount, glyphScene.segments.length);
    gl.uniform1f(uniforms.topVisibility, cameraTop[2]);
    gl.uniform1f(uniforms.frontVisibility, cameraFront[2]);
    gl.drawArrays(gl.TRIANGLES, 0, NODEX_HOME_MARK_VERTEX_COUNT);
    gl.bindVertexArray(null);
  };

  return { canvas, render, dispose };
}
