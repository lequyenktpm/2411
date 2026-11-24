import { SceneElement } from './types';

export interface ElementFrameState {
  visible: boolean;
  opacity: number;
  scale: number;
  translateY: number;
  translateX: number;
}

export interface StaggerItemFrameState {
  visible: boolean;
  opacity: number;
  scale: number;
  translateY: number;
  progress: number;
}

export function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export function easeOutCubic(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 3);
}

export function easeOutQuart(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 4);
}

export function easeOutQuint(t: number): number {
  const x = clamp01(t);
  return 1 - Math.pow(1 - x, 5);
}

export function easeOutBack(t: number): number {
  const x = clamp01(t);
  const c1 = 1.45;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}

/**
 * Smooth spring-inspired curve for internal card rows, tiles, pills, and badges.
 */
export function computeStaggerItemState(
  elementElapsedSec: number,
  index: number,
  stepDelaySec = 0.085,
  itemDurationSec = 0.36,
): StaggerItemFrameState {
  const local = elementElapsedSec - index * stepDelaySec;
  if (local <= 0) {
    return {
      visible: false,
      opacity: 0,
      scale: 0.92,
      translateY: 22,
      progress: 0,
    };
  }
  const p = clamp01(local / Math.max(0.08, itemDurationSec));
  const opacity = easeOutCubic(p);
  const glide = easeOutQuart(p);
  const scaleEase = easeOutBack(p);

  return {
    visible: opacity > 0.01,
    opacity,
    scale: 0.92 + 0.08 * scaleEase,
    translateY: (1 - glide) * 20,
    progress: glide,
  };
}

export function computeElementFrameState(
  element: SceneElement,
  time: number,
  enterDur = 0.42,
  exitDur = 0.3,
): ElementFrameState {
  if (time < element.startTime || time > element.endTime) {
    return { visible: false, opacity: 0, scale: 0.9, translateY: 0, translateX: 0 };
  }

  const elapsed = time - element.startTime;
  const remaining = element.endTime - time;
  const lifespan = Math.max(0.12, element.endTime - element.startTime);

  const safeEnter = Math.min(enterDur, lifespan * 0.45);
  const safeExit = Math.min(exitDur, lifespan * 0.35);

  let opacity = 1;
  let scale = element.layout.scale || 1;
  let translateY = 0;
  let translateX = 0;

  if (elapsed < safeEnter && safeEnter > 0) {
    const p = elapsed / safeEnter;
    const easedCubic = easeOutCubic(p);
    const easedQuint = easeOutQuint(p);
    const easedBack = easeOutBack(p);
    opacity = easeOutCubic(clamp01(p * 1.15));

    switch (element.enterAnimation) {
      case 'pop-up':
        scale *= 0.88 + 0.12 * easedBack;
        translateY += (1 - easedQuint) * 32;
        break;
      case 'slide-up':
        scale *= 0.95 + 0.05 * easedQuint;
        translateY += (1 - easedQuint) * 48;
        break;
      case 'drop-in':
        scale *= 0.95 + 0.05 * easedQuint;
        translateY -= (1 - easedQuint) * 40;
        break;
      case 'fade-scale':
        scale *= 0.93 + 0.07 * easedCubic;
        translateY += (1 - easedQuint) * 14;
        break;
    }
  } else if (remaining < safeExit && safeExit > 0) {
    const p = remaining / safeExit; // 1 -> 0
    const eased = easeInOutCubic(p);
    opacity = eased;

    switch (element.exitAnimation) {
      case 'shrink':
        scale *= 0.91 + 0.09 * eased;
        translateY += (1 - eased) * 12;
        break;
      case 'slide-down':
        scale *= 0.96 + 0.04 * eased;
        translateY += (1 - eased) * 34;
        break;
      case 'fade-out':
        translateY -= (1 - eased) * 8;
        break;
    }
  }

  return {
    visible: opacity > 0.01,
    opacity: clamp01(opacity),
    scale,
    translateY,
    translateX,
  };
}

export interface IdleMotionState {
  translateY: number;
  scaleMultiplier: number;
}

function hashElementSeed(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (h * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h % 360) * (Math.PI / 180);
}

/**
 * Subtle idle float & breathing motion for illustrations, 3D shapes, and topic pills
 * once entrance settles, while keeping reading cards, karaoke, and meters steady.
 */
export function computeIdleMotion(element: SceneElement, time: number): IdleMotionState {
  if (time < element.startTime || time > element.endTime) {
    return { translateY: 0, scaleMultiplier: 1 };
  }
  if (
    element.type !== 'illustration-prop' &&
    element.type !== 'shape-3d' &&
    element.type !== 'topic-pill'
  ) {
    return { translateY: 0, scaleMultiplier: 1 };
  }

  const elapsed = time - element.startTime;
  const remaining = element.endTime - time;
  const enterFade = clamp01((elapsed - 0.38) / 0.35);
  const exitFade = clamp01((remaining - 0.15) / 0.28);
  const envelope = enterFade * exitFade;
  if (envelope <= 0.001) {
    return { translateY: 0, scaleMultiplier: 1 };
  }

  const phase = hashElementSeed(element.id || element.type);
  const t = time - element.startTime;

  if (element.type === 'shape-3d') {
    return {
      translateY: Math.sin(t * 2.0 + phase) * 6 * envelope,
      scaleMultiplier: 1 + Math.sin(t * 1.4 + phase) * 0.012 * envelope,
    };
  }
  if (element.type === 'illustration-prop') {
    return {
      translateY: Math.sin(t * 2.1 + phase) * 5 * envelope,
      scaleMultiplier: 1 + Math.sin(t * 1.45 + phase) * 0.008 * envelope,
    };
  }
  return {
    translateY: Math.sin(t * 2.3 + phase) * 2.5 * envelope,
    scaleMultiplier: 1,
  };
}
