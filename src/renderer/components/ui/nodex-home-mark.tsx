import { animate, motionValue, type MotionValue } from "motion/react";
import { useLayoutEffect, useCallback, useEffect, useRef, type PointerEvent } from "react";
import { useResolvedReducedMotion } from "@/lib/use-reduced-motion";
import { setNodexHomeMarkLayerOwner } from "@/lib/nodex-home-mark-layer-ownership";
import { retireNodexHomeMarkRendererAfterPaint } from "@/lib/nodex-home-mark-renderer-retirement";
import {
  canMergeNodexMarkAxes,
  composeNodexMarkRotorPose,
  nodexMarkPoseDistanceDegrees,
  resolveNodexHomeMarkClickAxis,
  resolveNodexHomeMarkFieldMorph,
  type NodexMarkVec3,
} from "@/lib/nodex-home-mark-motion";
import type { NodexHomeMarkGlyphPerformance } from "@/lib/nodex-home-mark-glyph-performance";
import type {
  NodexHomeMarkGlyphScene,
  NodexHomeMarkGlyphSceneId,
} from "./nodex-home-mark-glyph-scenes.generated";
import type { NodexHomeMarkRenderer } from "./nodex-home-mark-renderer";

type RendererModule = typeof import("./nodex-home-mark-renderer");
type GlyphModule = typeof import("@/lib/nodex-home-mark-glyph-performance");
type AnimationControls = ReturnType<typeof animate>;

interface ActiveRotor {
  axis: NodexMarkVec3;
  progress: MotionValue<number>;
  targetTurns: number;
  generation: number;
  controls: AnimationControls | null;
}

let runtimeModulePromise: Promise<readonly [RendererModule, GlyphModule]> | null = null;

function preloadRuntime(): Promise<readonly [RendererModule, GlyphModule]> {
  runtimeModulePromise ??= Promise.all([
    import("./nodex-home-mark-renderer"),
    import("@/lib/nodex-home-mark-glyph-performance"),
  ]);
  return runtimeModulePromise;
}

function readElementColor(element: HTMLElement): readonly [number, number, number] {
  const channels = getComputedStyle(element)
    .color.match(/[\d.]+/g)
    ?.slice(0, 3);
  if (!channels || channels.length !== 3) return [223 / 255, 223 / 255, 223 / 255];
  return [Number(channels[0]) / 255, Number(channels[1]) / 255, Number(channels[2]) / 255];
}

export function NodexHomeMark() {
  const reducedMotion = useResolvedReducedMotion();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const visualRef = useRef<HTMLDivElement | null>(null);
  const staticMarkRef = useRef<SVGSVGElement | null>(null);
  const glyphPathRefs = useRef<(SVGPathElement | null)[]>([]);
  const glyphSceneRef = useRef<NodexHomeMarkGlyphScene | null>(null);
  const glyphSceneIdRef = useRef<NodexHomeMarkGlyphSceneId>("prompt");
  const performanceRef = useRef<NodexHomeMarkGlyphPerformance | null>(null);
  const rendererRef = useRef<NodexHomeMarkRenderer | null>(null);
  const rendererCreationRef = useRef<Promise<NodexHomeMarkRenderer | null> | null>(null);
  const rendererColorRef = useRef<readonly [number, number, number]>([
    223 / 255,
    223 / 255,
    223 / 255,
  ]);
  const activeRotorsRef = useRef<ActiveRotor[]>([]);
  const scaleMotionRef = useRef(motionValue(1));
  const scaleControlsRef = useRef<AnimationControls | null>(null);
  const scaleGenerationRef = useRef(0);
  const lifecycleGenerationRef = useRef(0);
  const renderFrameRef = useRef<number | null>(null);
  const handoffFrameRef = useRef<number | null>(null);
  const finishRendererRetirementRef = useRef<(() => void) | null>(null);
  const reducedMotionRef = useRef(reducedMotion);
  useLayoutEffect(() => {
    reducedMotionRef.current = reducedMotion;
  }, [reducedMotion]);

  const showStaticMark = useCallback(() => {
    setNodexHomeMarkLayerOwner({
      canvas: rendererRef.current?.canvas ?? null,
      owner: "svg",
      staticMark: staticMarkRef.current,
    });
  }, []);

  const applySvgScene = (scene: NodexHomeMarkGlyphScene) => {
    for (let index = 0; index < glyphPathRefs.current.length; index += 1) {
      const path = glyphPathRefs.current[index];
      if (!path) continue;
      const descriptor = scene.svgPaths[index];
      if (!descriptor) {
        path.style.visibility = "hidden";
        continue;
      }
      path.setAttribute("d", descriptor.d);
      path.setAttribute("transform", descriptor.transform);
      path.setAttribute("stroke-width", String(descriptor.strokeWidth));
      path.style.visibility = "visible";
    }
  };

  const resetSvgPrompt = useCallback(() => {
    const prompt = ["M305 352L411 438.203L305 535", "M458.035 565.638L579.966 558.361"];
    for (let index = 0; index < glyphPathRefs.current.length; index += 1) {
      const path = glyphPathRefs.current[index];
      if (!path) continue;
      const d = prompt[index];
      if (!d) {
        path.style.visibility = "hidden";
        continue;
      }
      path.setAttribute("d", d);
      path.setAttribute("transform", "translate(400 400) scale(1.17) translate(-400 -400)");
      path.setAttribute("stroke-width", "50");
      path.style.visibility = "visible";
    }
  }, []);

  const renderNow = () => {
    const visual = visualRef.current;
    if (!visual) return;
    const chargedScale = scaleMotionRef.current.get();
    visual.style.transform = `scale(${chargedScale})`;
    const renderer = rendererRef.current;
    const glyphScene = glyphSceneRef.current;
    if (!renderer || !glyphScene) return;
    const rotation = composeNodexMarkRotorPose(
      activeRotorsRef.current.map((rotor) => ({
        axis: rotor.axis,
        turns: rotor.progress.get(),
      })),
    );
    renderer.render({
      rotation,
      morph: resolveNodexHomeMarkFieldMorph(nodexMarkPoseDistanceDegrees(rotation)),
      chargedScale,
      color: rendererColorRef.current,
      glyphScene,
    });
  };

  const scheduleRender = () => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = requestAnimationFrame(() => {
      renderFrameRef.current = null;
      renderNow();
    });
  };

  const flushRender = () => {
    if (renderFrameRef.current !== null) cancelAnimationFrame(renderFrameRef.current);
    renderFrameRef.current = null;
    renderNow();
  };

  const cancelHandoff = useCallback(() => {
    if (handoffFrameRef.current === null) return;
    cancelAnimationFrame(handoffFrameRef.current);
    handoffFrameRef.current = null;
  }, []);

  const disposeRenderer = useCallback(() => {
    cancelHandoff();
    finishRendererRetirementRef.current?.();
    finishRendererRetirementRef.current = null;
    rendererCreationRef.current = null;
    rendererRef.current?.dispose();
    rendererRef.current = null;
    showStaticMark();
  }, [cancelHandoff, showStaticMark]);

  const disposeRuntime = useCallback(() => {
    lifecycleGenerationRef.current += 1;
    scaleGenerationRef.current += 1;
    if (renderFrameRef.current !== null) cancelAnimationFrame(renderFrameRef.current);
    renderFrameRef.current = null;
    cancelHandoff();
    scaleControlsRef.current?.stop();
    scaleControlsRef.current = null;
    for (const rotor of activeRotorsRef.current) rotor.controls?.stop();
    activeRotorsRef.current = [];
    performanceRef.current?.dispose();
    performanceRef.current = null;
    glyphSceneRef.current = null;
    glyphSceneIdRef.current = "prompt";
    resetSvgPrompt();
    disposeRenderer();
    scaleMotionRef.current.set(1);
    if (visualRef.current) visualRef.current.style.transform = "";
  }, [cancelHandoff, disposeRenderer, resetSvgPrompt]);

  const ensurePerformance = (module: GlyphModule): NodexHomeMarkGlyphPerformance => {
    const existing = performanceRef.current;
    if (existing) return existing;
    const performance = module.createNodexHomeMarkGlyphPerformance({
      onScene: (sceneId, scene) => {
        glyphSceneIdRef.current = sceneId;
        glyphSceneRef.current = scene;
        applySvgScene(scene);
        if (rendererRef.current) scheduleRender();
      },
    });
    performanceRef.current = performance;
    glyphSceneIdRef.current = performance.getSceneId();
    glyphSceneRef.current = performance.getScene();
    return performance;
  };

  const ensureRenderer = async (): Promise<NodexHomeMarkRenderer | null> => {
    if (rendererRef.current) return rendererRef.current;
    if (rendererCreationRef.current) return rendererCreationRef.current;
    const generation = lifecycleGenerationRef.current;
    const creation = preloadRuntime()
      .then(async ([rendererModule, glyphModule]) => {
        if (
          generation !== lifecycleGenerationRef.current ||
          reducedMotionRef.current ||
          !visualRef.current
        )
          return null;
        ensurePerformance(glyphModule);
        const renderer = rendererModule.createNodexHomeMarkRenderer({
          devicePixelRatio: globalThis.devicePixelRatio || 1,
          onContextLost: disposeRuntime,
        });
        if (!renderer || !hostRef.current) return null;
        rendererRef.current = renderer;
        rendererColorRef.current = readElementColor(hostRef.current);
        visualRef.current.append(renderer.canvas);
        flushRender();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (
          generation !== lifecycleGenerationRef.current ||
          rendererRef.current !== renderer ||
          reducedMotionRef.current
        ) {
          renderer.dispose();
          if (rendererRef.current === renderer) rendererRef.current = null;
          return null;
        }
        setNodexHomeMarkLayerOwner({
          canvas: renderer.canvas,
          owner: "canvas",
          staticMark: staticMarkRef.current,
        });
        return renderer;
      })
      .catch(() => null)
      .finally(() => {
        if (rendererCreationRef.current === creation) rendererCreationRef.current = null;
      });
    rendererCreationRef.current = creation;
    return creation;
  };

  const springOptions = (onComplete?: () => void) => ({
    type: "spring" as const,
    duration: 0.56,
    bounce: 0.15,
    onUpdate: scheduleRender,
    onComplete,
  });

  const handBackToSvg = () => {
    cancelHandoff();
    const generation = lifecycleGenerationRef.current;
    const settledSceneId = glyphSceneIdRef.current;
    flushRender();
    handoffFrameRef.current = requestAnimationFrame(() => {
      handoffFrameRef.current = null;
      if (
        generation !== lifecycleGenerationRef.current ||
        activeRotorsRef.current.length > 0 ||
        Math.abs(scaleMotionRef.current.get() - 1) > 0.001
      )
        return;
      if (settledSceneId !== glyphSceneIdRef.current) {
        handBackToSvg();
        return;
      }
      const renderer = rendererRef.current;
      setNodexHomeMarkLayerOwner({
        canvas: renderer?.canvas ?? null,
        owner: "svg",
        staticMark: staticMarkRef.current,
      });
      if (rendererRef.current === renderer) rendererRef.current = null;
      finishRendererRetirementRef.current?.();
      if (renderer) {
        const finishRetirement = retireNodexHomeMarkRendererAfterPaint({
          onDisposed: () => {
            if (finishRendererRetirementRef.current === finishRetirement) {
              finishRendererRetirementRef.current = null;
            }
          },
          renderer,
        });
        finishRendererRetirementRef.current = finishRetirement;
      } else {
        finishRendererRetirementRef.current = null;
      }
      if (visualRef.current) visualRef.current.style.transform = "";
    });
  };

  const releaseScale = () => {
    if (activeRotorsRef.current.length > 0) return;
    const generation = ++scaleGenerationRef.current;
    scaleControlsRef.current?.stop();
    scaleControlsRef.current = animate(
      scaleMotionRef.current,
      1,
      springOptions(() => {
        if (generation !== scaleGenerationRef.current || activeRotorsRef.current.length > 0) return;
        scaleControlsRef.current = null;
        handBackToSvg();
      }),
    );
  };

  const chargeScale = () => {
    cancelHandoff();
    scaleGenerationRef.current += 1;
    scaleControlsRef.current?.stop();
    scaleControlsRef.current = animate(scaleMotionRef.current, 1.17, springOptions());
  };

  const animateRotor = (rotor: ActiveRotor) => {
    const generation = ++rotor.generation;
    rotor.controls?.stop();
    rotor.controls = animate(
      rotor.progress,
      rotor.targetTurns,
      springOptions(() => {
        if (generation !== rotor.generation) return;
        const index = activeRotorsRef.current.indexOf(rotor);
        if (index >= 0) activeRotorsRef.current.splice(index, 1);
        rotor.controls = null;
        scheduleRender();
        releaseScale();
      }),
    );
  };

  const play = (axis: NodexMarkVec3) => {
    const mergeCandidate = activeRotorsRef.current.at(-1);
    if (mergeCandidate && canMergeNodexMarkAxes(mergeCandidate.axis, axis)) {
      mergeCandidate.targetTurns += 1;
      animateRotor(mergeCandidate);
      return;
    }
    const rotor: ActiveRotor = {
      axis,
      progress: motionValue(0),
      targetTurns: 1,
      generation: 0,
      controls: null,
    };
    activeRotorsRef.current.push(rotor);
    animateRotor(rotor);
  };

  const handlePointerEnter = () => {
    if (reducedMotion) return;
    if (globalThis.matchMedia?.("(pointer: fine)").matches === false) return;
    void preloadRuntime().then(([, glyphModule]) => {
      if (reducedMotionRef.current) return;
      ensurePerformance(glyphModule).startRandom();
    });
  };

  const handlePointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || reducedMotion) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const axis = resolveNodexHomeMarkClickAxis({
      clientX: event.clientX,
      clientY: event.clientY,
      left: bounds.left,
      top: bounds.top,
      width: bounds.width,
      height: bounds.height,
    });
    chargeScale();
    void ensureRenderer().then((renderer) => {
      if (!renderer || reducedMotionRef.current) {
        releaseScale();
        return;
      }
      play(axis);
      scheduleRender();
    });
  };

  useEffect(() => {
    if (reducedMotion) disposeRuntime();
  }, [disposeRuntime, reducedMotion]);

  useEffect(() => disposeRuntime, [disposeRuntime]);

  return (
    <div
      ref={hostRef}
      className="relative size-14 shrink-0 cursor-pointer touch-manipulation overflow-visible text-token-foreground opacity-30 select-none hover:opacity-40 motion-reduce:cursor-default"
      aria-hidden="true"
      data-nodex-home-mark="true"
      onPointerEnter={handlePointerEnter}
      onPointerUp={handlePointerUp}
    >
      <div ref={visualRef} className="relative size-14 origin-center">
        <svg
          ref={staticMarkRef}
          viewBox="0 0 800 800"
          className="size-14 overflow-visible"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <g transform="translate(400 400) scale(1.17) translate(-400 -400)">
            <path
              fillRule="evenodd"
              clipRule="evenodd"
              d="M516.873 75.5087392L118.087 100.056361C94.1999 101.687361 75.6836 122.231 75.6836 145.374V533.247C75.6836 554.992 83.1691 576.12 96.9608 593.302L182.945 700.417C196.847 717.735 218.725 727.272 241.359 725.88L683.965 698.635C706.65 697.237 724.31 679.047 724.31 657.08V216.106C724.31 202.514 717.448 192.0449767454 705.923 184.2539767454L565.813 84.9898232546C551.533 75.3358232546 534.255 74.3219392 516.873 75.5087392ZM137.862 152.3110570608C132.315 148.2040570608 134.955 136.8422343 141.923 136.3432343L519.555 113.0977657C531.588 112.2347657 543.543 113.628 553.273 120.522L629.043 174.203C631.918 176.241 630.57 179.2065641 627.008 179.4005641L227.097 204.0174359C214.994 204.6754359 203.048 198.7999429392 193.425 191.6759429392ZM208.339 270.767C208.339 257.775 218.835 247.044 232.257 246.313L655.075 223.286C668.158 222.574 679.168 232.633 679.168 245.295V627.132C679.168 640.1 668.71 650.82 655.315 651.582L235.172 675.487C220.615 676.317 208.339 665.13 208.339 651.037V270.767Z"
              fill="currentColor"
            />
          </g>
          {Array.from({ length: 3 }, (_, index) => (
            <path
              key={index}
              ref={(path) => {
                glyphPathRefs.current[index] = path;
              }}
              d={index === 0 ? "M305 352L411 438.203L305 535" : "M458.035 565.638L579.966 558.361"}
              transform="translate(400 400) scale(1.17) translate(-400 -400)"
              stroke="currentColor"
              strokeWidth="50"
              strokeLinecap="round"
              strokeLinejoin="round"
              style={{ visibility: index < 2 ? "visible" : "hidden" }}
            />
          ))}
        </svg>
      </div>
    </div>
  );
}
