import { computeElementFrameState, easeInOutCubic, clamp01 } from './animationMath';
import { getCustomComponentByVariant } from './customComponentStore';
import { VectorPrimitive } from './customComponentTypes';
import {
  BackgroundFitMode,
  CANVAS_THEMES,
  ComparisonStripProps,
  DynamicSceneSpec,
  IllustrationPropProps,
  IllustrationSceneIcon,
  KaraokeCardProps,
  LessonProject,
  SceneElement,
  SentenceCardProps,
  Shape3DProps,
  ThemePalette,
  ToneMeterProps,
  TopicPillProps,
  WordStackProps,
} from './types';

export const STAGE_WIDTH = 1080;
export const STAGE_HEIGHT = 1920;

const FONT_DISPLAY = '"Outfit", "Plus Jakarta Sans", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif';
const FONT_SANS = '"Plus Jakarta Sans", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif';

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fillCardWithShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  shadowAlpha = 0.08,
) {
  ctx.save();
  ctx.shadowColor = `rgba(15, 23, 42, ${shadowAlpha})`;
  ctx.shadowBlur = 32;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = fill;
  drawRoundedRectPath(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.restore();
}

const bgImageCache = new Map<string, HTMLImageElement>();
const bgImageLoading = new Map<string, Promise<HTMLImageElement | null>>();

export function computeBackgroundImageDrawRect(
  imgW: number,
  imgH: number,
  stageW = STAGE_WIDTH,
  stageH = STAGE_HEIGHT,
  fit: BackgroundFitMode = 'cover',
): { dx: number; dy: number; dw: number; dh: number } {
  const safeImgW = Math.max(1, imgW);
  const safeImgH = Math.max(1, imgH);
  const scale =
    fit === 'contain'
      ? Math.min(stageW / safeImgW, stageH / safeImgH)
      : Math.max(stageW / safeImgW, stageH / safeImgH);
  const dw = Math.round(safeImgW * scale);
  const dh = Math.round(safeImgH * scale);
  const dx = Math.round((stageW - dw) / 2);
  const dy = Math.round((stageH - dh) / 2);
  return { dx, dy, dw, dh };
}

export async function ensureProjectAssetsLoaded(project: LessonProject): Promise<void> {
  const dataUrl = project.backgroundImage?.dataUrl;
  if (!dataUrl || typeof Image === 'undefined') return;
  const cached = bgImageCache.get(dataUrl);
  if (cached && cached.complete && cached.naturalWidth > 0) return;

  const pending = bgImageLoading.get(dataUrl);
  if (pending) {
    await pending;
    return;
  }

  const p = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      bgImageCache.set(dataUrl, img);
      bgImageLoading.delete(dataUrl);
      resolve(img);
    };
    img.onerror = () => {
      bgImageLoading.delete(dataUrl);
      resolve(null);
    };
    img.src = dataUrl;
  });
  bgImageLoading.set(dataUrl, p);
  await p;
}

function getCachedBgImage(dataUrl: string): HTMLImageElement | null {
  const cached = bgImageCache.get(dataUrl);
  if (cached && cached.complete && cached.naturalWidth > 0) return cached;
  if (!bgImageLoading.has(dataUrl) && typeof Image !== 'undefined') {
    const img = new Image();
    const p = new Promise<HTMLImageElement | null>((resolve) => {
      img.onload = () => {
        bgImageCache.set(dataUrl, img);
        bgImageLoading.delete(dataUrl);
        resolve(img);
      };
      img.onerror = () => {
        bgImageLoading.delete(dataUrl);
        resolve(null);
      };
    });
    bgImageLoading.set(dataUrl, p);
    img.src = dataUrl;
    if (img.complete && img.naturalWidth > 0) {
      bgImageCache.set(dataUrl, img);
      bgImageLoading.delete(dataUrl);
      return img;
    }
  }
  return null;
}

function drawVectorPrimitives(
  ctx: CanvasRenderingContext2D,
  primitives: VectorPrimitive[],
  time: number,
  extraCustomDraw?: (icon: IllustrationSceneIcon) => void,
) {
  for (const prim of primitives) {
    ctx.save();
    if (typeof prim.opacity === 'number') {
      ctx.globalAlpha *= clamp01(prim.opacity);
    }
    const px = prim.x ?? 0;
    const py = prim.y ?? 0;

    if (prim.shape === 'rect' || prim.shape === 'pill') {
      const w = prim.w ?? 200;
      const h = prim.h ?? 110;
      const r = prim.shape === 'pill' ? h / 2 : (prim.radius ?? 22);
      if (prim.shadow && prim.fill) {
        fillCardWithShadow(ctx, px, py, w, h, r, prim.fill, 0.09);
      }
      drawRoundedRectPath(ctx, px, py, w, h, r);
      if (prim.fill && !prim.shadow) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.lineWidth ?? 3;
        ctx.stroke();
      }
    } else if (prim.shape === 'circle') {
      const r = prim.r ?? 44;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      if (prim.fill) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.lineWidth ?? 4;
        ctx.stroke();
      }
    } else if (prim.shape === 'ellipse') {
      const rx = prim.rx ?? 64;
      const ry = prim.ry ?? 40;
      ctx.beginPath();
      ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
      if (prim.fill) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.lineWidth ?? 4;
        ctx.stroke();
      }
    } else if (prim.shape === 'arc') {
      const r = prim.r ?? 48;
      ctx.strokeStyle = prim.stroke || prim.fill || '#2563EB';
      ctx.lineWidth = prim.lineWidth ?? 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(px, py, r, prim.startAngle ?? 0, prim.endAngle ?? Math.PI);
      ctx.stroke();
    } else if (prim.shape === 'polygon' && Array.isArray(prim.points) && prim.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(prim.points[0][0], prim.points[0][1]);
      for (let i = 1; i < prim.points.length; i++) {
        ctx.lineTo(prim.points[i][0], prim.points[i][1]);
      }
      ctx.closePath();
      if (prim.fill) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.lineWidth ?? 3;
        ctx.stroke();
      }
    } else if (prim.shape === 'line' || prim.shape === 'arrow') {
      const x2 = prim.x2 ?? px + 80;
      const y2 = prim.y2 ?? py;
      const col = prim.stroke || prim.fill || '#1E293B';
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = prim.lineWidth ?? 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (prim.shape === 'arrow') {
        const ang = Math.atan2(y2 - py, x2 - px);
        const head = Math.max(12, (prim.lineWidth ?? 6) * 2.4);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - 0.52), y2 - head * Math.sin(ang - 0.52));
        ctx.lineTo(x2 - head * Math.cos(ang + 0.52), y2 - head * Math.sin(ang + 0.52));
        ctx.closePath();
        ctx.fill();
      }
    } else if (prim.shape === 'text') {
      const size = prim.fontSize ?? 28;
      const weight = prim.fontWeight ?? 700;
      ctx.font = `${weight} ${size}px ${FONT_DISPLAY}`;
      ctx.fillStyle = prim.fill || '#0F172A';
      ctx.textAlign = prim.align ?? 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(prim.text || '', px, py, prim.w ? Math.max(80, prim.w) : undefined);
    } else if (prim.shape === 'icon' && extraCustomDraw) {
      const bounce = Math.sin(time * 2.5) * 3;
      ctx.translate(px, py + bounce);
      ctx.scale(0.85, 0.85);
      extraCustomDraw((prim.icon || 'sparkles') as IllustrationSceneIcon);
    }

    ctx.restore();
  }
}

function drawSceneIcon(ctx: CanvasRenderingContext2D, kind: IllustrationSceneIcon) {
  ctx.save();
  if (kind === 'tv') {
    fillCardWithShadow(ctx, -92, -62, 184, 124, 28, '#1E293B', 0.12);
    ctx.fillStyle = '#93C5FD';
    drawRoundedRectPath(ctx, -72, -44, 144, 78, 16);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(-12, -22);
    ctx.lineTo(28, -2);
    ctx.lineTo(-12, 18);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-28, 72);
    ctx.lineTo(28, 72);
    ctx.stroke();
  } else if (kind === 'eye') {
    ctx.fillStyle = '#DBEAFE';
    ctx.beginPath();
    ctx.ellipse(0, 0, 78, 48, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2563EB';
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0F172A';
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'watch') {
    ctx.fillStyle = '#1D4ED8';
    ctx.beginPath();
    ctx.arc(0, 0, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#BFDBFE';
    ctx.beginPath();
    ctx.arc(0, 0, 22, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'listen') {
    ctx.fillStyle = '#FDE68A';
    ctx.beginPath();
    ctx.ellipse(-8, 0, 36, 48, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(18, 0, 38, -0.7, 0.7);
    ctx.stroke();
  } else if (kind === 'walk') {
    ctx.fillStyle = '#FDBA74';
    ctx.beginPath();
    ctx.arc(0, -36, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#EA580C';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(0, 28);
    ctx.moveTo(0, 4);
    ctx.lineTo(-28, 22);
    ctx.moveTo(0, 4);
    ctx.lineTo(26, 18);
    ctx.moveTo(0, 28);
    ctx.lineTo(-18, 58);
    ctx.moveTo(0, 28);
    ctx.lineTo(22, 58);
    ctx.stroke();
  } else if (kind === 'airplane') {
    ctx.fillStyle = '#DBEAFE';
    ctx.beginPath();
    ctx.arc(0, 0, 62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2563EB';
    ctx.beginPath();
    ctx.moveTo(0, -44);
    ctx.lineTo(12, -10);
    ctx.lineTo(48, 6);
    ctx.lineTo(48, 18);
    ctx.lineTo(12, 8);
    ctx.lineTo(8, 34);
    ctx.lineTo(22, 46);
    ctx.lineTo(-22, 46);
    ctx.lineTo(-8, 34);
    ctx.lineTo(-12, 8);
    ctx.lineTo(-48, 18);
    ctx.lineTo(-48, 6);
    ctx.lineTo(-12, -10);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'luggage') {
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(-18, -36);
    ctx.lineTo(-18, -56);
    ctx.lineTo(18, -56);
    ctx.lineTo(18, -36);
    ctx.stroke();
    fillCardWithShadow(ctx, -42, -36, 84, 88, 18, '#F59E0B', 0.12);
    ctx.fillStyle = '#FEF3C7';
    drawRoundedRectPath(ctx, -26, -16, 52, 16, 8);
    ctx.fill();
    ctx.fillStyle = '#1E293B';
    ctx.beginPath();
    ctx.arc(-26, 56, 7, 0, Math.PI * 2);
    ctx.arc(26, 56, 7, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'menu') {
    fillCardWithShadow(ctx, -50, -56, 100, 112, 16, '#FFF7ED', 0.12);
    ctx.fillStyle = '#EA580C';
    drawRoundedRectPath(ctx, -50, -56, 100, 26, 12);
    ctx.fill();
    ctx.fillStyle = '#FDBA74';
    drawRoundedRectPath(ctx, -32, -14, 64, 10, 5);
    ctx.fill();
    drawRoundedRectPath(ctx, -32, 6, 48, 10, 5);
    ctx.fill();
    drawRoundedRectPath(ctx, -32, 26, 56, 10, 5);
    ctx.fill();
  } else if (kind === 'cup') {
    fillCardWithShadow(ctx, -46, -24, 92, 72, 20, '#FFFFFF', 0.1);
    ctx.fillStyle = '#38BDF8';
    drawRoundedRectPath(ctx, -36, -12, 72, 50, 14);
    ctx.fill();
    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(48, 12, 16, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  } else if (kind === 'shopping-bag') {
    ctx.strokeStyle = '#BE185D';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(0, -34, 20, Math.PI, 0);
    ctx.stroke();
    fillCardWithShadow(ctx, -44, -30, 88, 86, 16, '#EC4899', 0.12);
    ctx.fillStyle = '#FCE7F3';
    ctx.beginPath();
    ctx.arc(-16, -12, 5, 0, Math.PI * 2);
    ctx.arc(16, -12, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'price-tag') {
    ctx.save();
    ctx.rotate(-0.2);
    fillCardWithShadow(ctx, -52, -32, 104, 64, 16, '#10B981', 0.12);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(-32, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `800 30px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$%', 12, 2);
    ctx.restore();
  } else if (kind === 'stethoscope') {
    ctx.fillStyle = '#FEE2E2';
    ctx.beginPath();
    ctx.arc(0, 0, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#EF4444';
    drawRoundedRectPath(ctx, -12, -34, 24, 68, 8);
    ctx.fill();
    drawRoundedRectPath(ctx, -34, -12, 68, 24, 8);
    ctx.fill();
  } else if (kind === 'sun') {
    ctx.fillStyle = '#FACC15';
    ctx.beginPath();
    ctx.arc(0, 0, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (let r = 0; r < 8; r++) {
      const a = (r * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 44, Math.sin(a) * 44);
      ctx.lineTo(Math.cos(a) * 58, Math.sin(a) * 58);
      ctx.stroke();
    }
  } else if (kind === 'rain' || kind === 'umbrella') {
    ctx.fillStyle = '#93C5FD';
    ctx.beginPath();
    ctx.arc(-18, -14, 26, 0, Math.PI * 2);
    ctx.arc(16, -18, 30, 0, Math.PI * 2);
    ctx.arc(38, -6, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    [-22, 0, 22].forEach((dx) => {
      ctx.beginPath();
      ctx.moveTo(dx, 22);
      ctx.lineTo(dx - 8, 46);
      ctx.stroke();
    });
  } else if (kind === 'snowflake') {
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (let r = 0; r < 3; r++) {
      const a = (r * Math.PI) / 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * -48, Math.sin(a) * -48);
      ctx.lineTo(Math.cos(a) * 48, Math.sin(a) * 48);
      ctx.stroke();
    }
  } else if (kind === 'book') {
    fillCardWithShadow(ctx, -56, -42, 54, 84, 10, '#FFFFFF', 0.1);
    fillCardWithShadow(ctx, 2, -42, 54, 84, 10, '#F8FAFC', 0.1);
    ctx.strokeStyle = '#4F46E5';
    ctx.lineWidth = 6;
    drawRoundedRectPath(ctx, -56, -42, 112, 84, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -42);
    ctx.lineTo(0, 42);
    ctx.stroke();
  } else if (kind === 'pencil') {
    ctx.save();
    ctx.rotate(-0.6);
    fillCardWithShadow(ctx, -16, -48, 32, 88, 6, '#FACC15', 0.1);
    ctx.fillStyle = '#FCA5A5';
    drawRoundedRectPath(ctx, -16, -54, 32, 18, 6);
    ctx.fill();
    ctx.fillStyle = '#1E293B';
    ctx.beginPath();
    ctx.moveTo(-16, 40);
    ctx.lineTo(16, 40);
    ctx.lineTo(0, 62);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (kind === 'graduation') {
    ctx.fillStyle = '#312E81';
    ctx.beginPath();
    ctx.moveTo(0, -42);
    ctx.lineTo(62, -12);
    ctx.lineTo(0, 18);
    ctx.lineTo(-62, -12);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#4338CA';
    drawRoundedRectPath(ctx, -32, 8, 64, 30, 10);
    ctx.fill();
    ctx.strokeStyle = '#FACC15';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(46, -10);
    ctx.lineTo(46, 30);
    ctx.stroke();
  } else if (kind === 'laptop') {
    fillCardWithShadow(ctx, -58, -42, 116, 74, 12, '#1E293B', 0.12);
    ctx.fillStyle = '#60A5FA';
    drawRoundedRectPath(ctx, -46, -32, 92, 54, 8);
    ctx.fill();
    ctx.fillStyle = '#94A3B8';
    drawRoundedRectPath(ctx, -74, 34, 148, 14, 7);
    ctx.fill();
  } else if (kind === 'calendar') {
    fillCardWithShadow(ctx, -50, -46, 100, 96, 18, '#FFFFFF', 0.1);
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, -50, -46, 100, 30, 14);
    ctx.fill();
    ctx.fillStyle = '#0F172A';
    ctx.font = `800 32px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('15', 0, 18);
  } else if (kind === 'briefcase') {
    ctx.strokeStyle = '#78350F';
    ctx.lineWidth = 7;
    drawRoundedRectPath(ctx, -20, -52, 40, 20, 8);
    ctx.stroke();
    fillCardWithShadow(ctx, -54, -34, 108, 82, 18, '#92400E', 0.12);
    ctx.fillStyle = '#FACC15';
    drawRoundedRectPath(ctx, -14, -4, 28, 16, 6);
    ctx.fill();
  } else if (kind === 'clock') {
    fillCardWithShadow(ctx, -54, -54, 108, 108, 54, '#FFFFFF', 0.12);
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, 48, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#0F172A';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -26);
    ctx.moveTo(0, 0);
    ctx.lineTo(22, 10);
    ctx.stroke();
  } else if (kind === 'car' || kind === 'bus') {
    fillCardWithShadow(ctx, -60, -26, 120, 56, 16, kind === 'bus' ? '#F59E0B' : '#3B82F6', 0.12);
    ctx.fillStyle = '#DBEAFE';
    drawRoundedRectPath(ctx, -42, -16, 84, 24, 8);
    ctx.fill();
    ctx.fillStyle = '#0F172A';
    ctx.beginPath();
    ctx.arc(-34, 34, 12, 0, Math.PI * 2);
    ctx.arc(34, 34, 12, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'home') {
    ctx.fillStyle = '#F97316';
    ctx.beginPath();
    ctx.moveTo(0, -54);
    ctx.lineTo(62, -6);
    ctx.lineTo(-62, -6);
    ctx.closePath();
    ctx.fill();
    fillCardWithShadow(ctx, -46, -8, 92, 60, 12, '#FFFBEB', 0.1);
    ctx.fillStyle = '#B45309';
    drawRoundedRectPath(ctx, -14, 12, 28, 40, 8);
    ctx.fill();
  } else if (kind === 'dumbbell') {
    ctx.fillStyle = '#475569';
    drawRoundedRectPath(ctx, -48, -6, 96, 12, 6);
    ctx.fill();
    ctx.fillStyle = '#2563EB';
    drawRoundedRectPath(ctx, -56, -28, 18, 56, 8);
    ctx.fill();
    drawRoundedRectPath(ctx, 38, -28, 18, 56, 8);
    ctx.fill();
  } else if (kind === 'music' || kind === 'mic') {
    ctx.fillStyle = '#7C3AED';
    drawRoundedRectPath(ctx, -16, -46, 32, 54, 16);
    ctx.fill();
    ctx.strokeStyle = '#7C3AED';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, -8, 28, 0, Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 20);
    ctx.lineTo(0, 44);
    ctx.moveTo(-20, 44);
    ctx.lineTo(20, 44);
    ctx.stroke();
  } else if (kind === 'camera') {
    fillCardWithShadow(ctx, -54, -34, 108, 72, 18, '#1E293B', 0.12);
    ctx.fillStyle = '#38BDF8';
    ctx.beginPath();
    ctx.arc(0, 2, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(-8, -6, 6, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'heart') {
    ctx.fillStyle = '#EC4899';
    ctx.beginPath();
    ctx.arc(-20, -14, 22, 0, Math.PI * 2);
    ctx.arc(20, -14, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-40, -6);
    ctx.lineTo(40, -6);
    ctx.lineTo(0, 42);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'sparkles') {
    ctx.fillStyle = '#FACC15';
    const drawStar4 = (sx: number, sy: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(sx, sy - r);
      ctx.quadraticCurveTo(sx, sy, sx + r, sy);
      ctx.quadraticCurveTo(sx, sy, sx, sy + r);
      ctx.quadraticCurveTo(sx, sy, sx - r, sy);
      ctx.quadraticCurveTo(sx, sy, sx, sy - r);
      ctx.fill();
    };
    drawStar4(-6, -4, 42);
    ctx.fillStyle = '#38BDF8';
    drawStar4(34, -30, 20);
    ctx.fillStyle = '#A855F7';
    drawStar4(32, 28, 16);
  } else if (kind === 'brain') {
    ctx.fillStyle = '#F472B6';
    ctx.beginPath();
    ctx.arc(-18, -6, 28, 0, Math.PI * 2);
    ctx.arc(18, -6, 28, 0, Math.PI * 2);
    ctx.arc(0, -24, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#9D174D';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, -38);
    ctx.lineTo(0, 24);
    ctx.stroke();
  } else if (kind === 'lightning') {
    ctx.fillStyle = '#FACC15';
    ctx.beginPath();
    ctx.moveTo(8, -54);
    ctx.lineTo(-28, 4);
    ctx.lineTo(2, 4);
    ctx.lineTo(-10, 54);
    ctx.lineTo(30, -6);
    ctx.lineTo(-2, -6);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'scale') {
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(0, -40);
    ctx.lineTo(0, 42);
    ctx.moveTo(-48, -22);
    ctx.lineTo(48, -22);
    ctx.moveTo(-26, 42);
    ctx.lineTo(26, 42);
    ctx.stroke();
    ctx.fillStyle = '#3B82F6';
    ctx.beginPath();
    ctx.arc(-48, 12, 18, 0, Math.PI);
    ctx.fill();
    ctx.fillStyle = '#10B981';
    ctx.beginPath();
    ctx.arc(48, 12, 18, 0, Math.PI);
    ctx.fill();
  } else if (kind === 'gift') {
    fillCardWithShadow(ctx, -46, -26, 92, 74, 14, '#EF4444', 0.12);
    ctx.fillStyle = '#FACC15';
    ctx.fillRect(-8, -26, 16, 74);
    ctx.fillRect(-46, 2, 92, 14);
  } else if (kind === 'wallet') {
    fillCardWithShadow(ctx, -52, -34, 104, 72, 18, '#0F766E', 0.12);
    ctx.fillStyle = '#14B8A6';
    drawRoundedRectPath(ctx, 10, -10, 46, 26, 10);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(26, 3, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'map-pin') {
    ctx.fillStyle = '#EF4444';
    ctx.beginPath();
    ctx.arc(0, -16, 34, Math.PI, 0);
    ctx.lineTo(0, 48);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(0, -14, 14, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'globe') {
    ctx.fillStyle = '#38BDF8';
    ctx.beginPath();
    ctx.arc(0, 0, 48, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(0, 0, 22, 48, 0, 0, Math.PI * 2);
    ctx.moveTo(-48, 0);
    ctx.lineTo(48, 0);
    ctx.stroke();
  } else if (kind === 'handshake' || kind === 'chat') {
    fillCardWithShadow(ctx, -54, -36, 108, 68, 22, '#4F46E5', 0.12);
    ctx.fillStyle = '#FFFFFF';
    [-22, 0, 22].forEach((dx) => {
      ctx.beginPath();
      ctx.arc(dx, -2, 6, 0, Math.PI * 2);
      ctx.fill();
    });
  } else {
    // Crisp smartphone fallback
    fillCardWithShadow(ctx, -40, -70, 80, 140, 18, '#0F172A', 0.1);
    ctx.fillStyle = '#38BDF8';
    drawRoundedRectPath(ctx, -28, -54, 56, 100, 12);
    ctx.fill();
  }
  ctx.restore();
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines: string[] = [];

  const pushWrappedWord = (word: string) => {
    if (ctx.measureText(word).width <= maxWidth) {
      lines.push(word);
      return;
    }
    let chunk = '';
    for (const ch of word) {
      const next = chunk + ch;
      if (ctx.measureText(next).width <= maxWidth || chunk.length === 0) {
        chunk = next;
      } else {
        lines.push(chunk);
        chunk = ch;
      }
    }
    if (chunk) lines.push(chunk);
  };

  let current = '';
  for (const word of words) {
    if (!current) {
      if (ctx.measureText(word).width <= maxWidth) {
        current = word;
      } else {
        pushWrappedWord(word);
        current = lines.pop() ?? '';
      }
      continue;
    }
    const candidate = `${current} ${word}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      if (ctx.measureText(word).width <= maxWidth) {
        current = word;
      } else {
        pushWrappedWord(word);
        current = lines.pop() ?? '';
      }
    }
  }
  if (current) lines.push(current);
  return lines;
}

function drawComparisonStrip(
  ctx: CanvasRenderingContext2D,
  props: ComparisonStripProps,
  width: number,
  time: number,
) {
  const count = Math.max(1, props.items.length);
  const gap = 22;
  const itemW = (width - gap * (count - 1)) / count;
  const itemH = 112;
  const startX = -width / 2;
  const startY = -itemH / 2;

  // Determine active index: latest item whose activateAt <= time
  let activeIdx = -1;
  props.items.forEach((item, idx) => {
    if (item.activateAt !== undefined && time >= item.activateAt) {
      activeIdx = idx;
    }
  });

  props.items.forEach((item, idx) => {
    const x = startX + idx * (itemW + gap);
    const isActive = idx === activeIdx;
    const accent = item.accentColor || '#2563EB';

    fillCardWithShadow(
      ctx,
      x,
      startY,
      itemW,
      itemH,
      30,
      isActive ? '#FFFFFF' : 'rgba(255,255,255,0.86)',
      isActive ? 0.12 : 0.05,
    );

    if (isActive) {
      ctx.save();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 5;
      drawRoundedRectPath(ctx, x, startY, itemW, itemH, 30);
      ctx.stroke();
      ctx.restore();
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    let fontSize = 40;
    const maxLabelW = itemW - 28;
    ctx.font = `700 ${fontSize}px ${FONT_DISPLAY}`;
    while (fontSize > 22 && ctx.measureText(item.label).width > maxLabelW) {
      fontSize -= 2;
      ctx.font = `700 ${fontSize}px ${FONT_DISPLAY}`;
    }
    const showSublabel = Boolean(
      item.sublabel &&
        !(
          !isActive &&
          item.activateAt !== undefined &&
          time < item.activateAt &&
          /đáp\s*án/i.test(item.sublabel)
        ),
    );
    ctx.fillStyle = isActive ? accent : '#475569';
    ctx.fillText(item.label, x + itemW / 2, showSublabel ? startY + 42 : startY + itemH / 2);

    if (showSublabel && item.sublabel) {
      ctx.font = `600 22px ${FONT_SANS}`;
      ctx.fillStyle = isActive ? '#334155' : '#94A3B8';
      ctx.fillText(item.sublabel, x + itemW / 2, startY + 84);
    }
  });
}

function drawTopicPill(ctx: CanvasRenderingContext2D, props: TopicPillProps) {
  let fontSize = 34;
  ctx.font = `700 ${fontSize}px ${FONT_SANS}`;
  while (fontSize > 22 && ctx.measureText(props.text).width > 720) {
    fontSize -= 2;
    ctx.font = `700 ${fontSize}px ${FONT_SANS}`;
  }
  const textW = ctx.measureText(props.text).width;
  const pillW = Math.min(820, Math.max(240, textW + 76));
  const pillH = 74;

  fillCardWithShadow(ctx, -pillW / 2, -pillH / 2, pillW, pillH, 37, props.bgColor, 0.05);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = props.textColor;
  ctx.fillText(props.text, 0, 2, pillW - 44);
}

function drawIllustrationProp(
  ctx: CanvasRenderingContext2D,
  props: IllustrationPropProps,
  time: number,
) {
  const floatOffset = Math.sin(time * 2.2) * 8;
  ctx.save();
  ctx.translate(0, floatOffset);

  if (props.data?.customPrimitives && props.data.customPrimitives.length > 0) {
    drawVectorPrimitives(ctx, props.data.customPrimitives, time, (icon) => drawSceneIcon(ctx, icon));
    ctx.restore();
    return;
  }

  const customDef = getCustomComponentByVariant(props.variant);
  if (customDef && customDef.primitives && customDef.primitives.length > 0) {
    drawVectorPrimitives(ctx, customDef.primitives, time, (icon) => drawSceneIcon(ctx, icon));
    ctx.restore();
    return;
  }

  if (props.variant === 'cafe-water') {
    // Glass of water on the left
    ctx.save();
    ctx.translate(-225, 65);
    ctx.fillStyle = '#E0F2FE';
    ctx.beginPath();
    ctx.moveTo(-36, -64);
    ctx.lineTo(36, -64);
    ctx.lineTo(26, 68);
    ctx.lineTo(-26, 68);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#60A5FA';
    ctx.beginPath();
    ctx.moveTo(-31, -20);
    ctx.lineTo(31, -20);
    ctx.lineTo(24, 62);
    ctx.lineTo(-24, 62);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#93C5FD';
    ctx.lineWidth = 4;
    ctx.strokeRect(-1, -1, 2, 2); // noop clean state
    ctx.restore();

    // Minimalist cafe shop center
    fillCardWithShadow(ctx, -125, -80, 250, 220, 24, '#FFFDF9', 0.08);
    // Roof stripes
    const stripeW = 250 / 5;
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#EF4444' : '#FFFFFF';
      drawRoundedRectPath(ctx, -135 + i * (270 / 5), -110, 270 / 5, 58, 12);
      ctx.fill();
    }
    // Window
    ctx.fillStyle = '#BAE6FD';
    drawRoundedRectPath(ctx, -98, -22, 108, 92, 16);
    ctx.fill();
    // Door
    ctx.fillStyle = '#92400E';
    drawRoundedRectPath(ctx, 28, -12, 72, 152, 14);
    ctx.fill();
    ctx.fillStyle = '#FBBF24';
    ctx.beginPath();
    ctx.arc(84, 64, 7, 0, Math.PI * 2);
    ctx.fill();

    // Friendly character on right
    ctx.save();
    ctx.translate(220, 15);
    ctx.fillStyle = '#F472B6';
    drawRoundedRectPath(ctx, -46, 36, 92, 68, 30);
    ctx.fill();
    ctx.fillStyle = '#FDE68A';
    ctx.beginPath();
    ctx.arc(0, -14, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#451A03';
    ctx.beginPath();
    ctx.arc(0, -24, 42, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#1E293B';
    ctx.beginPath();
    ctx.arc(-14, -12, 4.5, 0, Math.PI * 2);
    ctx.arc(14, -12, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, -2, 14, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.restore();
  } else if (props.variant === 'coffee-cup') {
    fillCardWithShadow(ctx, -95, -50, 190, 130, 32, '#FFFFFF', 0.08);
    ctx.fillStyle = '#92400E';
    ctx.beginPath();
    ctx.ellipse(0, -34, 72, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(105, 10, 32, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  } else if (props.variant === 'friends-chat') {
    // Two friendly people chatting with speech bubbles
    const drawPerson = (px: number, shirt: string, hair: string) => {
      ctx.save();
      ctx.translate(px, 24);
      ctx.fillStyle = shirt;
      drawRoundedRectPath(ctx, -46, 36, 92, 70, 30);
      ctx.fill();
      ctx.fillStyle = '#FDE68A';
      ctx.beginPath();
      ctx.arc(0, -14, 42, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = hair;
      ctx.beginPath();
      ctx.arc(0, -24, 42, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#1E293B';
      ctx.beginPath();
      ctx.arc(-13, -12, 4.5, 0, Math.PI * 2);
      ctx.arc(13, -12, 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1E293B';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, -2, 13, 0.15 * Math.PI, 0.85 * Math.PI);
      ctx.stroke();
      ctx.restore();
    };
    drawPerson(-130, '#3B82F6', '#1E293B');
    drawPerson(130, '#EC4899', '#78350F');
    // Small chat bubble above
    fillCardWithShadow(ctx, -68, -118, 136, 72, 24, '#FFFFFF', 0.08);
    ctx.fillStyle = '#2563EB';
    [-26, 0, 26].forEach((dx, i) => {
      const bounce = Math.sin(time * 5 + i * 0.9) * 4;
      ctx.beginPath();
      ctx.arc(dx, -82 + bounce, 7, 0, Math.PI * 2);
      ctx.fill();
    });
  } else if (props.variant === 'office-work') {
    // Minimalist office monitor / desk & calendar
    fillCardWithShadow(ctx, -165, -95, 330, 195, 28, '#FFFFFF', 0.08);
    ctx.fillStyle = '#E0E7FF';
    drawRoundedRectPath(ctx, -135, -65, 270, 125, 16);
    ctx.fill();
    // Tie / collar badge in center + calendar card
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, -108, -42, 108, 80, 12);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 28px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FRI', -54, -2);
    // Email lines on right
    ctx.fillStyle = '#6366F1';
    drawRoundedRectPath(ctx, 18, -36, 94, 14, 7);
    ctx.fill();
    ctx.fillStyle = '#94A3B8';
    drawRoundedRectPath(ctx, 18, -8, 76, 12, 6);
    ctx.fill();
    drawRoundedRectPath(ctx, 18, 18, 86, 12, 6);
    ctx.fill();
    // Stand
    ctx.fillStyle = '#CBD5E1';
    drawRoundedRectPath(ctx, -40, 100, 80, 20, 8);
    ctx.fill();
  } else if (props.variant === 'hotel-desk') {
    // Formal hotel reception bell + keycard
    fillCardWithShadow(ctx, -160, -70, 320, 165, 28, '#FFFDF9', 0.08);
    ctx.fillStyle = '#7C3AED';
    drawRoundedRectPath(ctx, -125, 24, 250, 44, 16);
    ctx.fill();
    // Bell dome
    ctx.fillStyle = '#F59E0B';
    ctx.beginPath();
    ctx.arc(0, 18, 68, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#FDE68A';
    drawRoundedRectPath(ctx, -12, -66, 24, 16, 8);
    ctx.fill();
    // Sparkle
    const pulse = 0.7 + 0.3 * Math.sin(time * 4);
    ctx.fillStyle = `rgba(124, 58, 237, ${pulse})`;
    ctx.beginPath();
    ctx.arc(82, -52, 8, 0, Math.PI * 2);
    ctx.fill();
  } else if (props.variant === 'lightbulb-tip') {
    const glow = 0.28 + 0.14 * Math.sin(time * 3.5);
    ctx.fillStyle = `rgba(250, 204, 21, ${glow})`;
    ctx.beginPath();
    ctx.arc(0, -18, 118, 0, Math.PI * 2);
    ctx.fill();
    // Bulb glass
    ctx.fillStyle = '#FACC15';
    ctx.beginPath();
    ctx.arc(0, -24, 72, 0, Math.PI * 2);
    ctx.fill();
    drawRoundedRectPath(ctx, -36, 26, 72, 42, 14);
    ctx.fill();
    // Screw base
    ctx.fillStyle = '#475569';
    drawRoundedRectPath(ctx, -32, 68, 64, 34, 12);
    ctx.fill();
    // Inner filament check
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-22, -20);
    ctx.lineTo(-4, 0);
    ctx.lineTo(26, -34);
    ctx.stroke();
  } else if (props.variant === 'ear-listen') {
    fillCardWithShadow(ctx, -140, -90, 280, 180, 44, '#FFFFFF', 0.08);
    // Headphones arc + sound waves
    ctx.strokeStyle = '#4F46E5';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 6, 58, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, -74, -4, 28, 56, 14);
    ctx.fill();
    drawRoundedRectPath(ctx, 46, -4, 28, 56, 14);
    ctx.fill();
    // Equalizer bars in middle
    [0, 1, 2].forEach((i) => {
      const h = 22 + 28 * Math.abs(Math.sin(time * 5 + i * 0.9));
      ctx.fillStyle = '#0284C7';
      drawRoundedRectPath(ctx, -22 + i * 18, 20 - h / 2, 10, h, 5);
      ctx.fill();
    });
  } else if (props.variant === 'speech-bubble') {
    fillCardWithShadow(ctx, -180, -90, 360, 160, 44, '#FFFFFF', 0.08);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(-40, 70);
    ctx.lineTo(10, 70);
    ctx.lineTo(-25, 118);
    ctx.closePath();
    ctx.fill();

    // Animated sound bars inside bubble
    const barHeights = [26, 52, 74, 44, 64, 34];
    barHeights.forEach((h, i) => {
      const pulse = Math.abs(Math.sin(time * 4 + i * 0.7));
      const bh = 22 + h * 0.65 * pulse;
      ctx.fillStyle = i % 2 === 0 ? '#4F46E5' : '#0284C7';
      drawRoundedRectPath(ctx, -105 + i * 38, -bh / 2 - 10, 18, bh, 9);
      ctx.fill();
    });
  } else if (props.variant === 'flow-diagram') {
    const nodes =
      props.data?.nodes && props.data.nodes.length >= 2
        ? props.data.nodes.slice(0, 3)
        : [
            { label: 'Present', icon: 'clock' as const, color: '#2563EB' },
            { label: 'Past', icon: 'history' as const, color: '#16A34A' },
            { label: 'Future', icon: 'rocket' as const, color: '#7C3AED' },
          ];
    const xs = nodes.length === 2 ? [-190, 190] : [-280, 0, 280];

    // Connecting arrows
    for (let i = 0; i < xs.length - 1; i++) {
      const ax1 = xs[i] + 74;
      const ax2 = xs[i + 1] - 74;
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax1, -24);
      ctx.lineTo(ax2 - 12, -24);
      ctx.stroke();
      ctx.fillStyle = '#94A3B8';
      ctx.beginPath();
      ctx.moveTo(ax2, -24);
      ctx.lineTo(ax2 - 20, -36);
      ctx.lineTo(ax2 - 20, -12);
      ctx.closePath();
      ctx.fill();
    }

    nodes.forEach((node, idx) => {
      const nx = xs[idx];
      const color = node.color || '#2563EB';
      ctx.save();
      ctx.shadowColor = 'rgba(15, 23, 42, 0.12)';
      ctx.shadowBlur = 22;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(nx, -24, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = color;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(nx, -24, 54, 0, Math.PI * 2);
      ctx.stroke();

      // Inner glyph
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (node.icon === 'rocket') {
        ctx.beginPath();
        ctx.moveTo(nx, -48);
        ctx.lineTo(nx + 16, -18);
        ctx.lineTo(nx - 16, -18);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(nx - 6, -18, 12, 16);
      } else if (node.icon === 'star') {
        ctx.beginPath();
        for (let s = 0; s < 5; s++) {
          const a1 = -Math.PI / 2 + (s * 2 * Math.PI) / 5;
          const a2 = a1 + Math.PI / 5;
          ctx.lineTo(nx + Math.cos(a1) * 22, -24 + Math.sin(a1) * 22);
          ctx.lineTo(nx + Math.cos(a2) * 10, -24 + Math.sin(a2) * 10);
        }
        ctx.closePath();
        ctx.fill();
      } else if (node.icon === 'check') {
        ctx.beginPath();
        ctx.moveTo(nx - 18, -24);
        ctx.lineTo(nx - 4, -10);
        ctx.lineTo(nx + 20, -38);
        ctx.stroke();
      } else if (node.icon === 'chat') {
        drawRoundedRectPath(ctx, nx - 22, -40, 44, 30, 10);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        [-10, 0, 10].forEach((dx) => {
          ctx.beginPath();
          ctx.arc(nx + dx, -25, 3.2, 0, Math.PI * 2);
          ctx.fill();
        });
      } else {
        // clock / history default
        ctx.beginPath();
        ctx.arc(nx, -24, 21, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(nx, -36);
        ctx.lineTo(nx, -24);
        ctx.lineTo(nx + 11, -18);
        ctx.stroke();
      }

      // Label pill below circle
      ctx.font = `800 28px ${FONT_DISPLAY}`;
      const lw = Math.min(240, Math.max(132, ctx.measureText(node.label).width + 38));
      fillCardWithShadow(ctx, nx - lw / 2, 46, lw, 46, 23, color, 0.08);
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.label, nx, 69, lw - 24);
    });
  } else if (props.variant === 'gauge-arc') {
    const val = clamp01((props.data?.value ?? 0.65) + Math.sin(time * 2.4) * 0.015);
    const segments = ['#EF4444', '#F97316', '#FACC15', '#4ADE80', '#16A34A'];
    const cx = 0;
    const cy = 58;
    const radius = 152;
    const segSpan = Math.PI / segments.length;
    const gapRad = 0.04;

    fillCardWithShadow(ctx, -370, -138, 740, 278, 36, '#FFFFFF', 0.09);

    segments.forEach((col, i) => {
      const a0 = Math.PI + i * segSpan + gapRad / 2;
      const a1 = Math.PI + (i + 1) * segSpan - gapRad / 2;
      ctx.strokeStyle = col;
      ctx.lineWidth = 34;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, a0, a1);
      ctx.stroke();
    });

    // Indicator dot along arc
    const needleAngle = Math.PI + val * Math.PI;
    const dotX = cx + Math.cos(needleAngle) * radius;
    const dotY = cy + Math.sin(needleAngle) * radius;
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(dotX, dotY, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#0F172A';
    ctx.stroke();
    ctx.restore();

    // Friendly emoji face inside arc
    ctx.fillStyle = val < 0.35 ? '#FECACA' : val > 0.65 ? '#BBF7D0' : '#FEF08A';
    ctx.beginPath();
    ctx.arc(0, 24, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1E293B';
    ctx.beginPath();
    ctx.arc(-18, 16, 5.5, 0, Math.PI * 2);
    ctx.arc(18, 16, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (val < 0.35) {
      ctx.arc(0, 48, 16, 1.15 * Math.PI, 1.85 * Math.PI);
    } else if (val > 0.6) {
      ctx.arc(0, 26, 20, 0.15 * Math.PI, 0.85 * Math.PI);
    } else {
      ctx.moveTo(-16, 36);
      ctx.lineTo(16, 36);
    }
    ctx.stroke();

    const statusText = props.data?.subtitle || 'Good & Polite';
    ctx.font = `700 28px ${FONT_SANS}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(statusText, 0, 106, 480);
  } else if (props.variant === 'timeline-track') {
    const progress = clamp01(props.data?.value ?? 0.68);
    const labels =
      props.data?.labels && props.data.labels.length >= 2
        ? props.data.labels.slice(0, 3)
        : ['Early', 'On time', 'Too late'];

    fillCardWithShadow(ctx, -430, -104, 860, 208, 34, '#FFFFFF', 0.09);

    // Track line
    const x0 = -320;
    const x1 = 320;
    const trackY = -20;
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, trackY);
    ctx.lineTo(x1, trackY);
    ctx.stroke();

    // Active progress fill
    const activeX = x0 + (x1 - x0) * progress;
    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, '#3B82F6');
    grad.addColorStop(1, '#10B981');
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x0, trackY);
    ctx.lineTo(activeX, trackY);
    ctx.stroke();

    // Start marker & Finish Flag
    ctx.fillStyle = '#3B82F6';
    ctx.beginPath();
    ctx.arc(x0, trackY, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x1, trackY + 6);
    ctx.lineTo(x1, trackY - 44);
    ctx.stroke();
    ctx.fillStyle = '#F59E0B';
    drawRoundedRectPath(ctx, x1, trackY - 44, 34, 22, 4);
    ctx.fill();

    // Moving runner dot
    ctx.save();
    ctx.shadowColor = 'rgba(16, 185, 129, 0.45)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#10B981';
    ctx.beginPath();
    ctx.arc(activeX, trackY, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(activeX, trackY, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Milestone labels
    const lxs = labels.length === 2 ? [-200, 200] : [-270, 0, 270];
    labels.forEach((lbl, i) => {
      const lx = lxs[i];
      const isCurrent = Math.abs(progress - i / Math.max(1, labels.length - 1)) < 0.35;
      ctx.fillStyle = isCurrent ? '#DCFCE7' : '#F1F5F9';
      drawRoundedRectPath(ctx, lx - 108, 28, 216, 46, 23);
      ctx.fill();
      ctx.font = `700 24px ${FONT_SANS}`;
      ctx.fillStyle = isCurrent ? '#15803D' : '#475569';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(lbl, lx, 51, 190);
    });
  } else if (props.variant === 'checklist-card') {
    const items =
      props.data?.checklist && props.data.checklist.length > 0
        ? props.data.checklist.slice(0, 4)
        : [
            { text: 'You are right.', ok: true },
            { text: 'We are on time.', ok: true },
            { text: 'They are here.', ok: true },
          ];
    const rowH = 66;
    const cardH = 74 + items.length * rowH;
    const cardW = 840;
    const topY = -cardH / 2;

    fillCardWithShadow(ctx, -cardW / 2, topY, cardW, cardH, 34, '#FFFFFF', 0.09);

    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Checklist', 0, topY + 34);

    items.forEach((item, idx) => {
      const ry = topY + 80 + idx * rowH;
      const isOk = item.ok !== false;
      ctx.fillStyle = isOk ? '#F0FDF4' : '#FEF2F2';
      drawRoundedRectPath(ctx, -cardW / 2 + 28, ry - 24, cardW - 56, 52, 18);
      ctx.fill();

      // Check or Cross circle
      const bx = -cardW / 2 + 64;
      ctx.fillStyle = isOk ? '#16A34A' : '#DC2626';
      ctx.beginPath();
      ctx.arc(bx, ry + 2, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (isOk) {
        ctx.moveTo(bx - 7, ry + 2);
        ctx.lineTo(bx - 2, ry + 8);
        ctx.lineTo(bx + 8, ry - 5);
      } else {
        ctx.moveTo(bx - 6, ry - 4);
        ctx.lineTo(bx + 6, ry + 8);
        ctx.moveTo(bx + 6, ry - 4);
        ctx.lineTo(bx - 6, ry + 8);
      }
      ctx.stroke();

      ctx.font = `700 30px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#0F172A';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.text, bx + 32, ry + 3, cardW - 140);
    });
  } else if (props.variant === 'dialogue-upgrade') {
    const rows =
      props.data?.upgrades && props.data.upgrades.length > 0
        ? props.data.upgrades.slice(0, 3)
        : [
            { prompt: 'Very good', upgrade: 'Wonderful', badgeColor: '#2563EB' },
            { prompt: 'Very tasty', upgrade: 'Delicious', badgeColor: '#16A34A' },
            { prompt: 'Very nice', upgrade: 'Amazing', badgeColor: '#7C3AED' },
          ];
    const rowH = 82;
    const totalH = rows.length * rowH;
    const startY = -totalH / 2 + rowH / 2;

    rows.forEach((row, idx) => {
      const ry = startY + idx * rowH;
      fillCardWithShadow(ctx, -430, ry - 34, 860, 68, 24, '#FFFFFF', 0.08);

      // Mini avatar
      ctx.fillStyle = '#FDE68A';
      ctx.beginPath();
      ctx.arc(-384, ry, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1E293B';
      ctx.beginPath();
      ctx.arc(-390, ry - 2, 2.5, 0, Math.PI * 2);
      ctx.arc(-378, ry - 2, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Prompt text (auto-fit font size so it never squishes)
      let promptFontPx = 25;
      while (promptFontPx > 19) {
        ctx.font = `600 ${promptFontPx}px ${FONT_SANS}`;
        if (ctx.measureText(row.prompt).width <= 366) break;
        promptFontPx -= 1;
      }
      ctx.fillStyle = '#334155';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.prompt, -350, ry + 1, 366);

      // Arrow
      ctx.fillStyle = '#94A3B8';
      ctx.font = `700 28px ${FONT_SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText('→', 42, ry);

      // Upgrade pill
      const bColor = row.badgeColor || '#16A34A';
      ctx.fillStyle = bColor;
      drawRoundedRectPath(ctx, 78, ry - 24, 336, 48, 24);
      ctx.fill();

      let upgFontPx = 25;
      while (upgFontPx > 18) {
        ctx.font = `700 ${upgFontPx}px ${FONT_DISPLAY}`;
        if (ctx.measureText(row.upgrade).width <= 300) break;
        upgFontPx -= 1;
      }
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(row.upgrade, 246, ry + 1, 300);
    });
  } else if (props.variant === 'clock-face') {
    const hour = props.data?.timeHour ?? 8;
    const minute = props.data?.timeMinute ?? 20;
    const formula = props.data?.formula || `${hour}:${String(minute).padStart(2, '0')}`;
    const sub = props.data?.subtitle || 'Use "past" / "to"';

    // Analog clock on left
    const cx = -165;
    const cy = 0;
    const r = 114;
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.12)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Shaded minute sector
    const startAng = -Math.PI / 2;
    const minAng = startAng + (minute / 60) * Math.PI * 2;
    if (minute > 0) {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.16)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r - 12, startAng, minAng);
      ctx.closePath();
      ctx.fill();
    }

    // 12 hour dots
    for (let h = 0; h < 12; h++) {
      const a = -Math.PI / 2 + (h / 12) * Math.PI * 2;
      ctx.fillStyle = h % 3 === 0 ? '#1E293B' : '#94A3B8';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (r - 18), cy + Math.sin(a) * (r - 18), h % 3 === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Hour & Minute hands
    const hourAng = -Math.PI / 2 + (((hour % 12) + minute / 60) / 12) * Math.PI * 2;
    ctx.strokeStyle = '#0F172A';
    ctx.lineCap = 'round';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(hourAng) * 58, cy + Math.sin(hourAng) * 58);
    ctx.stroke();

    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(minAng) * 86, cy + Math.sin(minAng) * 86);
    ctx.stroke();

    ctx.fillStyle = '#0F172A';
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();

    // Right readout card
    fillCardWithShadow(ctx, -10, -86, 390, 172, 32, '#FFFFFF', 0.09);
    ctx.font = `800 50px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#2563EB';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(formula, 185, -18, 350);
    ctx.font = `600 28px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(sub, 185, 42, 350);
  } else if (props.variant === 'spatial-boxes') {
    const boxes =
      props.data?.boxes && props.data.boxes.length >= 2
        ? props.data.boxes.slice(0, 3)
        : [
            { title: 'AT', subtitle: 'point', icon: 'dot' as const, accent: '#2563EB' },
            { title: 'ON', subtitle: 'surface', icon: 'surface' as const, accent: '#16A34A' },
            { title: 'IN', subtitle: 'space', icon: 'cube' as const, accent: '#7C3AED' },
          ];
    const gap = 24;
    const bw = boxes.length === 2 ? 360 : 276;
    const totalW = boxes.length * bw + (boxes.length - 1) * gap;
    const startX = -totalW / 2;

    boxes.forEach((box, idx) => {
      const bx = startX + idx * (bw + gap) + bw / 2;
      const accent = box.accent || '#2563EB';
      fillCardWithShadow(ctx, bx - bw / 2, -108, bw, 216, 30, '#FFFFFF', 0.09);

      // Icon container
      ctx.fillStyle = '#F8FAFC';
      drawRoundedRectPath(ctx, bx - bw / 2 + 20, -90, bw - 40, 88, 20);
      ctx.fill();

      if (box.icon === 'surface') {
        ctx.fillStyle = '#CBD5E1';
        drawRoundedRectPath(ctx, bx - 44, -40, 88, 16, 8);
        ctx.fill();
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(bx, -52, 14, 0, Math.PI * 2);
        ctx.fill();
      } else if (box.icon === 'cube') {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 4;
        ctx.strokeRect(bx - 26, -68, 52, 46);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(bx, -45, 11, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(bx, -46, 20, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.font = `800 36px ${FONT_DISPLAY}`;
      ctx.fillStyle = accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(box.title, bx, 34, bw - 36);

      if (box.subtitle) {
        ctx.font = `600 24px ${FONT_SANS}`;
        ctx.fillStyle = '#64748B';
        ctx.fillText(box.subtitle, bx, 76, bw - 36);
      }
    });
  } else if (props.variant === 'avatar-speech') {
    const speech = props.data?.speechText || 'Could I have some water, please?';
    const reaction = props.data?.reactionText || 'Polite!';

    // Speaker avatar on left
    ctx.save();
    ctx.translate(-295, 16);
    ctx.fillStyle = '#DBEAFE';
    ctx.beginPath();
    ctx.arc(0, 0, 82, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#3B82F6';
    drawRoundedRectPath(ctx, -46, 28, 92, 54, 24);
    ctx.fill();
    ctx.fillStyle = '#FDE68A';
    ctx.beginPath();
    ctx.arc(0, -14, 42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1E293B';
    ctx.beginPath();
    ctx.arc(0, -24, 42, Math.PI, 0);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(-13, -12, 4.5, 0, Math.PI * 2);
    ctx.arc(13, -12, 4.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(0, -2, 13, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.restore();

    // Speech bubble on right
    fillCardWithShadow(ctx, -185, -86, 585, 152, 34, '#FFFFFF', 0.09);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(-185, -18);
    ctx.lineTo(-218, 4);
    ctx.lineTo(-185, 20);
    ctx.closePath();
    ctx.fill();

    ctx.font = `700 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const lines = wrapTextLines(ctx, speech, 520).slice(0, 2);
    const lh = 44;
    const sy = -10 - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, -148, sy + i * lh, 520));

    // Reaction pill
    ctx.font = `700 22px ${FONT_SANS}`;
    const rw = Math.min(240, Math.max(120, ctx.measureText(reaction).width + 38));
    fillCardWithShadow(ctx, 400 - rw - 16, 46, rw, 42, 21, '#4F46E5', 0.08);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(reaction, 400 - rw / 2 - 16, 67, rw - 24);
  } else if (props.variant === 'phrase-icon-split') {
    const nodes = (props.data?.nodes ?? []).slice(0, 3);
    const quote = props.data?.speechText || 'I see TV every';
    const chip = (props.data?.highlightWord || 'night.').replace(/["“”]/g, '');
    const wrong = props.data?.subtitle;
    const iconKind = props.data?.sceneIcon || 'tv';

    fillCardWithShadow(ctx, -430, -236, 860, 128, 40, '#FFFFFF', 0.08);
    const slotW = nodes.length > 0 ? 760 / Math.max(nodes.length, 1) : 240;
    nodes.forEach((node, i) => {
      const nx = -380 + i * slotW + slotW / 2;
      ctx.font = `800 28px ${FONT_DISPLAY}`;
      ctx.fillStyle = node.color || '#475569';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.label, nx, -198, slotW - 24);
      if (node.sublabel) {
        ctx.font = `600 18px ${FONT_SANS}`;
        ctx.fillStyle = '#94A3B8';
        ctx.fillText(node.sublabel, nx, -168, slotW - 24);
      }
      if (i < nodes.length - 1) {
        ctx.fillStyle = '#CBD5E1';
        ctx.font = `700 22px ${FONT_SANS}`;
        ctx.fillText('→', nx + slotW / 2, -184);
      }
    });

    if (wrong) {
      fillCardWithShadow(ctx, -340, -88, 680, 50, 25, '#FFFFFF', 0.06);
      ctx.font = `700 26px ${FONT_SANS}`;
      ctx.fillStyle = '#0F172A';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(wrong, 0, -63, 640);
    }

    ctx.font = `800 58px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`"${quote}`, 0, 16, 860);

    ctx.save();
    ctx.translate(0, 118);
    drawSceneIcon(ctx, iconKind);
    ctx.restore();

    ctx.font = `700 36px ${FONT_DISPLAY}`;
    const chipW = Math.min(360, Math.max(150, ctx.measureText(chip).width + 48));
    fillCardWithShadow(ctx, -chipW / 2, 188, chipW, 58, 29, '#F8FAFC', 0.08);
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chip, 0, 217, chipW - 24);
  } else if (props.variant === 'airport-travel') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.fillStyle = '#2563EB';
    drawRoundedRectPath(ctx, -370, -110, 740, 52, 26);
    ctx.fill();
    ctx.font = `800 24px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOARDING PASS', -334, -84);
    ctx.textAlign = 'right';
    ctx.fillText('GATE B12', 334, -84);

    ctx.save();
    ctx.translate(-210, 22);
    ctx.scale(0.85, 0.85);
    drawSceneIcon(ctx, 'airplane');
    ctx.restore();

    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'left';
    ctx.fillText(props.data?.title || 'At the Airport', -100, -4, 420);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText(props.data?.subtitle || 'Check-in · Boarding · Window seat', -100, 44, 420);
  } else if (props.variant === 'restaurant-order') {
    fillCardWithShadow(ctx, -370, -112, 740, 224, 34, '#FFFDF7', 0.09);
    ctx.save();
    ctx.translate(-220, 0);
    drawSceneIcon(ctx, 'menu');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#9A3412';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Ordering Food', -105, -24, 430);
    ctx.font = `600 25px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || '"Could I see the menu, please?"', -105, 28, 430);
  } else if (props.variant === 'shopping-price') {
    fillCardWithShadow(ctx, -370, -112, 740, 224, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-225, 0);
    drawSceneIcon(ctx, 'shopping-bag');
    ctx.restore();
    ctx.save();
    ctx.translate(250, -32);
    ctx.scale(0.8, 0.8);
    drawSceneIcon(ctx, 'price-tag');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#BE185D';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Shopping & Price', -110, -14, 310);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || '"Can I try this on?"', -110, 34, 430);
  } else if (props.variant === 'doctor-health') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-220, 0);
    drawSceneIcon(ctx, 'stethoscope');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#DC2626';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Health & Clinic', -110, -20, 440);
    ctx.font = `600 25px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || '"I have a slight headache."', -110, 30, 440);
  } else if (props.variant === 'weather-forecast') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#F0F9FF', 0.09);
    ctx.save();
    ctx.translate(-220, 0);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'sun');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0369A1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Weather Forecast', -110, -20, 440);
    ctx.font = `600 25px ${FONT_SANS}`;
    ctx.fillStyle = '#334155';
    ctx.fillText(props.data?.speechText || "It's chilly & sunny outside", -110, 30, 440);
  } else if (props.variant === 'study-desk') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-225, 0);
    drawSceneIcon(ctx, 'book');
    ctx.restore();
    ctx.save();
    ctx.translate(275, -18);
    ctx.scale(0.68, 0.68);
    drawSceneIcon(ctx, 'pencil');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#3730A3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Study & Practice', -110, -20, 340);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || 'Review notes every day', -110, 30, 400);
  } else if (props.variant === 'commute-transport') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-210, -6);
    drawSceneIcon(ctx, props.data?.sceneIcon === 'car' ? 'car' : 'bus');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Daily Commute', -100, -20, 430);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || 'Catch the bus on time', -100, 30, 430);
  } else if (props.variant === 'home-routine') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFBEB', 0.09);
    ctx.save();
    ctx.translate(-215, 0);
    drawSceneIcon(ctx, 'home');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#92400E';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Home Routine', -105, -20, 430);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || 'Everyday daily habits', -105, 30, 430);
  } else if (props.variant === 'gym-fitness') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-215, 0);
    drawSceneIcon(ctx, 'dumbbell');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1D4ED8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Workout & Habit', -105, -20, 430);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || 'Stay consistent daily', -105, 30, 430);
  } else if (props.variant === 'phone-call') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#0F172A', 0.22);
    ctx.save();
    ctx.translate(-220, 0);
    ctx.scale(0.75, 0.75);
    drawSceneIcon(ctx, 'phone');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#38BDF8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Incoming Call', -115, -20, 440);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#CBD5E1';
    ctx.fillText(props.data?.speechText || '"Hold on, I’ll call you back"', -115, 30, 440);
  } else if (props.variant === 'tense-timeline') {
    const val = clamp01(props.data?.value ?? 0.5);
    const labels = props.data?.labels?.slice(0, 3) ?? ['Past', 'Present', 'Future'];
    fillCardWithShadow(ctx, -430, -112, 860, 224, 34, '#FFFFFF', 0.09);
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.fillText(props.data?.formula || 'TIME AXIS', 0, -76);
    const x0 = -300;
    const x1 = 300;
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, -14);
    ctx.lineTo(x1, -14);
    ctx.stroke();
    const xs = [-260, 0, 260];
    const cols = ['#64748B', '#2563EB', '#7C3AED'];
    labels.forEach((lbl, i) => {
      const mx = xs[i];
      const active = Math.abs(val - i * 0.5) < 0.26;
      ctx.fillStyle = active ? cols[i] : '#E2E8F0';
      ctx.beginPath();
      ctx.arc(mx, -14, active ? 20 : 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = active ? cols[i] : '#475569';
      ctx.font = `${active ? 800 : 600} 26px ${FONT_DISPLAY}`;
      ctx.fillText(lbl, mx, 46, 200);
    });
  } else if (props.variant === 'degree-scale') {
    const steps = props.data?.labels?.slice(0, 3) ?? ['Basic', 'Stronger', 'Native!'];
    const cols = ['#94A3B8', '#38BDF8', '#FACC15'];
    fillCardWithShadow(ctx, -430, -118, 860, 236, 34, '#FFFFFF', 0.09);
    ctx.font = `800 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'center';
    ctx.fillText(props.data?.title || 'Intensity Scale', 0, -82);
    steps.forEach((st, i) => {
      const bx = -255 + i * 255;
      const barH = 44 + i * 28;
      ctx.fillStyle = cols[i % cols.length];
      drawRoundedRectPath(ctx, bx - 95, 58 - barH, 190, barH, 16);
      ctx.fill();
      ctx.font = `800 26px ${FONT_DISPLAY}`;
      ctx.fillStyle = i === 2 ? '#0F172A' : '#FFFFFF';
      ctx.fillText(st, bx, 58 - barH / 2 + 2, 170);
    });
  } else if (props.variant === 'phrasal-split') {
    const parts = props.data?.labels?.slice(0, 2) ?? ['Verb', 'Particle'];
    fillCardWithShadow(ctx, -430, -116, 860, 232, 34, '#FFFFFF', 0.09);
    fillCardWithShadow(ctx, -370, -54, 240, 86, 24, '#DBEAFE', 0.05);
    ctx.font = `800 36px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1D4ED8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(parts[0], -250, -11, 210);
    ctx.fillStyle = '#64748B';
    ctx.fillText('+', -90, -11);
    fillCardWithShadow(ctx, -50, -54, 240, 86, 24, '#DCFCE7', 0.05);
    ctx.fillStyle = '#15803D';
    ctx.fillText(parts[1], 70, -11, 210);
    ctx.fillStyle = '#4F46E5';
    ctx.fillText('=', 228, -11);
    ctx.save();
    ctx.translate(325, -12);
    ctx.scale(0.65, 0.65);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'lightning');
    ctx.restore();
    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.formula || 'New idiomatic meaning!', 0, 74, 780);
  } else if (props.variant === 'idiom-split') {
    fillCardWithShadow(ctx, -430, -116, 860, 232, 34, '#FFFFFF', 0.09);
    ctx.fillStyle = '#FEF2F2';
    drawRoundedRectPath(ctx, -395, -72, 340, 144, 24);
    ctx.fill();
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#DC2626';
    ctx.textAlign = 'center';
    ctx.fillText('LITERAL (KHÔNG PHẢI)', -225, -36);
    ctx.font = `800 28px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#7F1D1D';
    ctx.fillText(props.data?.speechText || 'Word for word', -225, 22, 300);

    ctx.fillStyle = '#64748B';
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillText('≠', 0, 0);

    ctx.fillStyle = '#F0FDF4';
    drawRoundedRectPath(ctx, 55, -72, 340, 144, 24);
    ctx.fill();
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#16A34A';
    ctx.fillText('REAL MEANING', 225, -36);
    ctx.font = `800 28px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#14532D';
    ctx.fillText(props.data?.subtitle || 'Natural idiom sense', 225, 22, 300);
  } else if (props.variant === 'syllable-stress') {
    const syllables = props.data?.labels?.length ? props.data.labels.slice(0, 4) : ['re', 'CORD'];
    const stressedIdx = Math.min(syllables.length - 1, Math.max(0, Math.round(props.data?.value ?? 1)));
    fillCardWithShadow(ctx, -410, -116, 820, 232, 34, '#FFFFFF', 0.09);
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.fillText(props.data?.title || 'SYLLABLE STRESS', 0, -76);
    const gap = 150;
    const startX = -((syllables.length - 1) * gap) / 2;
    syllables.forEach((syl, idx) => {
      const sx = startX + idx * gap;
      const isStressed = idx === stressedIdx;
      ctx.fillStyle = isStressed ? '#4F46E5' : '#E2E8F0';
      ctx.beginPath();
      ctx.arc(sx, -10, isStressed ? 42 : 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `${isStressed ? 800 : 700} ${isStressed ? 28 : 22}px ${FONT_DISPLAY}`;
      ctx.fillStyle = isStressed ? '#FFFFFF' : '#475569';
      ctx.fillText(syl, sx, 60, 130);
    });
  } else if (props.variant === 'intonation-curve') {
    const rising = (props.data?.value ?? 0.8) >= 0.5;
    fillCardWithShadow(ctx, -410, -112, 820, 224, 34, '#FFFFFF', 0.09);
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.fillText(rising ? 'RISING INTONATION ↗' : 'FALLING INTONATION ↘', 0, -74);
    ctx.strokeStyle = rising ? '#2563EB' : '#10B981';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (rising) {
      ctx.moveTo(-260, 44);
      ctx.bezierCurveTo(-60, 40, 80, -34, 260, -40);
    } else {
      ctx.moveTo(-260, -34);
      ctx.bezierCurveTo(-60, -30, 80, 38, 260, 44);
    }
    ctx.stroke();
    ctx.font = `700 28px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.speechText || 'Watch the pitch flow!', 0, 76, 760);
  } else if (props.variant === 'bs-alert-tip') {
    // Bootstrap Callout / Alert Banner with left accent stripe, pill badge & icon
    fillCardWithShadow(ctx, -420, -112, 840, 224, 24, '#EFF6FF', 0.08);
    ctx.strokeStyle = '#BFDBFE';
    ctx.lineWidth = 3;
    drawRoundedRectPath(ctx, -420, -112, 840, 224, 24);
    ctx.stroke();
    // Left Bootstrap border-start accent bar
    ctx.fillStyle = '#2563EB';
    drawRoundedRectPath(ctx, -420, -112, 18, 224, 9);
    ctx.fill();
    // Icon circle
    ctx.fillStyle = '#DBEAFE';
    ctx.beginPath();
    ctx.arc(-326, 0, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(-326, 0);
    ctx.scale(0.62, 0.62);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'lightning');
    ctx.restore();
    // Badge pill
    ctx.fillStyle = '#2563EB';
    drawRoundedRectPath(ctx, -245, -72, 168, 36, 18);
    ctx.fill();
    ctx.font = `800 17px ${FONT_SANS}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HEADS UP!', -161, -54, 150);
    // Title & Body
    ctx.textAlign = 'left';
    ctx.font = `800 33px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1E3A8A';
    ctx.fillText(props.data?.title || 'Quick Grammar Alert', -245, 0, 610);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#334155';
    ctx.fillText(
      props.data?.speechText || props.data?.subtitle || 'Remember this polite pattern in daily English!',
      -245,
      54,
      610,
    );
  } else if (props.variant === 'bs-card-header') {
    // Bootstrap Card with Colored Header Bar + Body + Footer Pill
    fillCardWithShadow(ctx, -415, -132, 830, 264, 26, '#FFFFFF', 0.1);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2.5;
    drawRoundedRectPath(ctx, -415, -132, 830, 264, 26);
    ctx.stroke();
    // Top Header
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, -415, -132, 830, 68, 24);
    ctx.fill();
    ctx.fillRect(-415, -88, 830, 24);
    ctx.font = `800 24px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.formula || 'FEATURED LESSON CARD', -382, -98, 560);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    drawRoundedRectPath(ctx, 245, -114, 144, 34, 17);
    ctx.fill();
    ctx.font = `700 17px ${FONT_SANS}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText('BS5 CARD', 317, -97);
    // Body
    ctx.save();
    ctx.translate(-328, 32);
    ctx.scale(0.66, 0.66);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'book');
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'Key Sentence Structure', -240, 2, 620);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(
      props.data?.subtitle || props.data?.speechText || 'Clear, structured explanation for fast recall',
      -240,
      54,
      620,
    );
    // Subtle footer divider & chip
    ctx.strokeStyle = '#F1F5F9';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-382, 92);
    ctx.lineTo(382, 92);
    ctx.stroke();
    ctx.font = `700 18px ${FONT_SANS}`;
    ctx.fillStyle = '#6366F1';
    ctx.fillText('✓ Save this template for speaking', -382, 114, 720);
  } else if (props.variant === 'bs-progress-meter') {
    // Bootstrap Progress Bar with Milestone Badge & Striped Fill
    const pct = clamp01(props.data?.value ?? 0.78);
    const pctLabel = `${Math.round(pct * 100)}%`;
    fillCardWithShadow(ctx, -420, -112, 840, 224, 28, '#FFFFFF', 0.09);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -112, 840, 224, 28);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `800 30px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'Fluency Progress', -376, -54, 540);

    // % Badge pill on right
    ctx.fillStyle = '#DCFCE7';
    drawRoundedRectPath(ctx, 250, -76, 126, 44, 22);
    ctx.fill();
    ctx.font = `800 24px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#15803D';
    ctx.textAlign = 'center';
    ctx.fillText(pctLabel, 313, -54);

    // Track
    const barX = -376;
    const barW = 752;
    const barY = -8;
    const barH = 42;
    ctx.fillStyle = '#E2E8F0';
    drawRoundedRectPath(ctx, barX, barY, barW, barH, 21);
    ctx.fill();

    // Active Gradient Fill + Bootstrap stripes
    const fillW = Math.max(48, barW * pct);
    const grad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
    grad.addColorStop(0, '#0D6EFD');
    grad.addColorStop(1, '#10B981');
    ctx.save();
    drawRoundedRectPath(ctx, barX, barY, fillW, barH, 21);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, fillW, barH);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    const offset = (time * 36) % 36;
    for (let sx = barX - 40 + offset; sx < barX + fillW + 40; sx += 36) {
      ctx.beginPath();
      ctx.moveTo(sx, barY + barH);
      ctx.lineTo(sx + 16, barY);
      ctx.lineTo(sx + 30, barY);
      ctx.lineTo(sx + 14, barY + barH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.font = `600 22px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText(
      props.data?.subtitle || 'Step-by-step mastery · Keep practicing every day!',
      -376,
      68,
      740,
    );
  } else if (props.variant === 'bs-toast-notify') {
    // Bootstrap Floating Toast Notification
    fillCardWithShadow(ctx, -400, -116, 800, 232, 26, '#FFFFFF', 0.12);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -400, -116, 800, 232, 26);
    ctx.stroke();

    // Header row inside Toast
    ctx.fillStyle = '#F8FAFC';
    drawRoundedRectPath(ctx, -400, -116, 800, 62, 24);
    ctx.fill();
    ctx.fillRect(-400, -76, 800, 22);
    ctx.fillStyle = '#10B981';
    drawRoundedRectPath(ctx, -366, -98, 28, 28, 8);
    ctx.fill();
    ctx.font = `800 22px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Native Coach', -324, -84);
    ctx.font = `600 18px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'right';
    ctx.fillText('just now · ✓ verified', 366, -84);

    // Divider
    ctx.strokeStyle = '#E2E8F0';
    ctx.beginPath();
    ctx.moveTo(-400, -54);
    ctx.lineTo(400, -54);
    ctx.stroke();

    // Body
    ctx.save();
    ctx.translate(-310, 30);
    ctx.scale(0.6, 0.6);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'chat');
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.font = `800 32px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'New Phrase Unlocked!', -225, 4, 590);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#334155';
    ctx.fillText(
      props.data?.speechText || '"Sounds natural & friendly!"',
      -225,
      54,
      590,
    );
  } else if (props.variant === 'bs-list-group') {
    // Bootstrap Flush List Group with Numbered Badges
    const items = props.data?.labels?.slice(0, 3) ?? [
      '1. Listen to native rhythm',
      '2. Repeat out loud 3 times',
      '3. Use in a real sentence',
    ];
    fillCardWithShadow(ctx, -415, -132, 830, 264, 26, '#FFFFFF', 0.09);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -415, -132, 830, 264, 26);
    ctx.stroke();

    items.forEach((row, i) => {
      const ry = -84 + i * 84;
      if (i === 1) {
        ctx.fillStyle = '#EFF6FF';
        drawRoundedRectPath(ctx, -400, ry - 34, 800, 68, 16);
        ctx.fill();
      }
      if (i > 0) {
        ctx.strokeStyle = '#F1F5F9';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-395, ry - 42);
        ctx.lineTo(395, ry - 42);
        ctx.stroke();
      }
      // Circle badge
      ctx.fillStyle = i === 1 ? '#2563EB' : '#64748B';
      ctx.beginPath();
      ctx.arc(-352, ry, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `800 20px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${i + 1}`, -352, ry + 1);

      ctx.textAlign = 'left';
      ctx.font = `${i === 1 ? 800 : 700} 26px ${FONT_DISPLAY}`;
      ctx.fillStyle = i === 1 ? '#1D4ED8' : '#1E293B';
      ctx.fillText(row, -310, ry + 1, 610);

      // Right pill
      ctx.fillStyle = i === 1 ? '#2563EB' : '#F1F5F9';
      drawRoundedRectPath(ctx, 314, ry - 16, 74, 32, 16);
      ctx.fill();
      ctx.font = `700 16px ${FONT_SANS}`;
      ctx.fillStyle = i === 1 ? '#FFFFFF' : '#64748B';
      ctx.textAlign = 'center';
      ctx.fillText(i === 1 ? 'ACTIVE' : 'KEY', 351, ry + 1);
    });
  } else if (props.variant === 'bs-pricing-tier') {
    // Two-column Bootstrap Compare Tier Cards (Basic vs Recommended Pro)
    const leftTxt = props.data?.labels?.[0] || 'Textbook Style';
    const rightTxt = props.data?.labels?.[1] || 'Native Fluency';

    // Left Basic Card
    fillCardWithShadow(ctx, -420, -118, 392, 236, 26, '#FFFFFF', 0.07);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -118, 392, 236, 26);
    ctx.stroke();
    ctx.fillStyle = '#F1F5F9';
    drawRoundedRectPath(ctx, -386, -88, 120, 34, 17);
    ctx.fill();
    ctx.font = `700 17px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BASIC', -326, -71);
    ctx.font = `800 30px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#334155';
    ctx.fillText(leftTxt, -224, -4, 340);
    ctx.font = `600 21px ${FONT_SANS}`;
    ctx.fillStyle = '#94A3B8';
    ctx.fillText('✗ Stiff / Word-for-word', -224, 58, 340);

    // Right Recommended Highlighted Card
    fillCardWithShadow(ctx, 28, -126, 392, 252, 26, '#EEF2FF', 0.14);
    ctx.strokeStyle = '#4F46E5';
    ctx.lineWidth = 4;
    drawRoundedRectPath(ctx, 28, -126, 392, 252, 26);
    ctx.stroke();
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, 62, -98, 196, 36, 18);
    ctx.fill();
    ctx.font = `800 17px ${FONT_SANS}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('★ RECOMMENDED', 160, -80);
    ctx.font = `800 31px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#312E81';
    ctx.fillText(rightTxt, 224, -6, 340);
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#15803D';
    ctx.fillText('✓ Sounds 100% Natural', 224, 60, 340);
  } else if (props.variant === 'bs-accordion-faq') {
    // Bootstrap Accordion Q&A Drawer
    fillCardWithShadow(ctx, -420, -128, 840, 256, 26, '#FFFFFF', 0.09);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -128, 840, 256, 26);
    ctx.stroke();

    // Expanded Question header
    ctx.fillStyle = '#E0E7FF';
    drawRoundedRectPath(ctx, -420, -128, 840, 74, 24);
    ctx.fill();
    ctx.fillRect(-420, -78, 840, 24);
    ctx.font = `800 28px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#3730A3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Q: ${props.data?.title || 'Why do natives say this?'}`, -386, -90, 700);
    ctx.textAlign = 'right';
    ctx.fillText('▲', 386, -90);

    // Answer body
    ctx.textAlign = 'left';
    ctx.font = `600 25px ${FONT_SANS}`;
    ctx.fillStyle = '#1E293B';
    ctx.fillText(
      props.data?.speechText || props.data?.subtitle || 'A: It softens requests and builds instant rapport.',
      -386,
      0,
      768,
    );

    // Collapsed second drawer hint
    ctx.strokeStyle = '#E2E8F0';
    ctx.beginPath();
    ctx.moveTo(-420, 56);
    ctx.lineTo(420, 56);
    ctx.stroke();
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText('Q: Common mistake to avoid?', -386, 92, 660);
    ctx.textAlign = 'right';
    ctx.fillText('▼', 386, 92);
  } else if (props.variant === 'bs-breadcrumb-path') {
    // Bootstrap Breadcrumb / Pill Nav Step Card
    const crumbs = props.data?.labels?.slice(0, 3) ?? ['Context', 'Pattern', 'Fluent!'];
    fillCardWithShadow(ctx, -425, -104, 850, 208, 28, '#FFFFFF', 0.09);
    ctx.font = `700 20px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'LEARNING PATHWAY', 0, -64, 720);

    const xs = [-260, 0, 260];
    crumbs.forEach((c, i) => {
      const cx = xs[i];
      const active = i === crumbs.length - 1;
      ctx.fillStyle = active ? '#0D6EFD' : '#F1F5F9';
      drawRoundedRectPath(ctx, cx - 106, -24, 212, 66, 33);
      ctx.fill();
      ctx.font = `800 25px ${FONT_DISPLAY}`;
      ctx.fillStyle = active ? '#FFFFFF' : '#334155';
      ctx.fillText(c, cx, 10, 184);
      if (i < crumbs.length - 1) {
        ctx.font = `800 28px ${FONT_SANS}`;
        ctx.fillStyle = '#94A3B8';
        ctx.fillText('›', cx + 130, 10);
      }
    });
  } else if (props.variant === 'css-bento-stats') {
    // Modern 2x2 CSS Bento Grid
    const tiles = [
      { bg: '#EEF2FF', fg: '#4338CA', num: '01', lbl: props.data?.labels?.[0] || 'Core Word' },
      { bg: '#ECFDF5', fg: '#047857', num: '02', lbl: props.data?.labels?.[1] || 'Tone Check' },
      { bg: '#FFF7ED', fg: '#C2410C', num: '03', lbl: props.data?.labels?.[2] || 'Pronunciation' },
      { bg: '#FDF2F8', fg: '#BE185D', num: '★', lbl: props.data?.title || 'Real Example' },
    ];
    const coords = [
      [-420, -126],
      [12, -126],
      [-420, 8],
      [12, 8],
    ];
    tiles.forEach((tile, i) => {
      const [tx, ty] = coords[i];
      fillCardWithShadow(ctx, tx, ty, 408, 118, 22, tile.bg, 0.06);
      ctx.fillStyle = tile.fg;
      drawRoundedRectPath(ctx, tx + 18, ty + 31, 56, 56, 16);
      ctx.fill();
      ctx.font = `800 24px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tile.num, tx + 46, ty + 60);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#0F172A';
      ctx.font = `800 26px ${FONT_DISPLAY}`;
      ctx.fillText(tile.lbl, tx + 92, ty + 60, 294);
    });
  } else if (props.variant === 'css-glass-quote') {
    // Modern Glassmorphism Quote Callout
    const grad = ctx.createLinearGradient(-420, -124, 420, 124);
    grad.addColorStop(0, 'rgba(99, 102, 241, 0.16)');
    grad.addColorStop(1, 'rgba(236, 72, 153, 0.14)');
    fillCardWithShadow(ctx, -420, -124, 840, 248, 32, 'rgba(255,255,255,0.86)', 0.12);
    ctx.fillStyle = grad;
    drawRoundedRectPath(ctx, -420, -124, 840, 248, 32);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 4;
    ctx.stroke();

    // Big Quote Mark
    ctx.font = `800 84px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#6366F1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('“', -382, -52);

    ctx.textAlign = 'center';
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(
      props.data?.speechText || props.data?.title || 'Speak clearly, connect naturally.',
      0,
      -8,
      680,
    );

    // Author / Tag Pill
    ctx.fillStyle = '#FFFFFF';
    drawRoundedRectPath(ctx, -155, 48, 310, 44, 22);
    ctx.fill();
    ctx.font = `700 20px ${FONT_SANS}`;
    ctx.fillStyle = '#4F46E5';
    ctx.fillText(props.data?.subtitle || '✨ Native Takeaway', 0, 70, 280);
  } else if (props.variant === 'css-chat-thread') {
    // Modern 2-Bubble Dialogue Chat Thread
    fillCardWithShadow(ctx, -420, -132, 840, 264, 30, '#F8FAFC', 0.08);
    // Incoming left bubble
    fillCardWithShadow(ctx, -382, -100, 540, 82, 24, '#FFFFFF', 0.06);
    ctx.font = `600 25px ${FONT_SANS}`;
    ctx.fillStyle = '#334155';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.labels?.[0] || 'A: "Excuse me, is this seat taken?"', -352, -58, 480);

    // Outgoing right indigo bubble
    fillCardWithShadow(ctx, -160, 12, 542, 86, 24, '#4F46E5', 0.14);
    ctx.font = `700 25px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(props.data?.labels?.[1] || 'B: "Not at all! Go right ahead."', -130, 56, 480);
  } else if (props.variant === 'css-roadmap-steps') {
    // Modern CSS 3-Step Horizontal Stepper
    const steps = props.data?.labels?.slice(0, 3) ?? ['Spot It', 'Practice', 'Master'];
    const cols = ['#2563EB', '#7C3AED', '#10B981'];
    fillCardWithShadow(ctx, -425, -112, 850, 224, 30, '#FFFFFF', 0.09);
    // Connector line
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.moveTo(-260, -24);
    ctx.lineTo(260, -24);
    ctx.stroke();

    const xs = [-260, 0, 260];
    steps.forEach((lbl, i) => {
      const sx = xs[i];
      ctx.fillStyle = cols[i];
      ctx.beginPath();
      ctx.arc(sx, -24, 32, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `800 26px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`0${i + 1}`, sx, -23);

      ctx.font = `800 26px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#0F172A';
      ctx.fillText(lbl, sx, 48, 220);
    });
  } else if (props.variant === 'css-toggle-switch') {
    // Modern CSS Toggle Switch Comparison Card
    const isOn = (props.data?.value ?? 1) >= 0.5;
    fillCardWithShadow(ctx, -415, -112, 830, 224, 30, '#FFFFFF', 0.09);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#94A3B8';
    ctx.fillText(props.data?.labels?.[0] || 'OFF · Basic / Literal', -370, -48, 430);
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'ON · Native Mode', -370, 22, 460);

    // Toggle track
    const tx = 140;
    const ty = -46;
    ctx.fillStyle = isOn ? '#10B981' : '#CBD5E1';
    drawRoundedRectPath(ctx, tx, ty, 224, 92, 46);
    ctx.fill();
    // Knob
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(isOn ? tx + 176 : tx + 48, ty + 46, 36, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.font = `800 24px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(isOn ? 'ON' : 'OFF', isOn ? tx + 86 : tx + 140, ty + 48);
  } else if (props.variant === 'css-browser-mockup') {
    // Modern Browser Window Card with macOS Dots + URL bar + Multi-line Passage Context support
    const bodyText =
      props.data?.speechText ||
      props.data?.subtitle ||
      'Search · Learn · Speak with confidence';
    ctx.font = `600 23px ${FONT_SANS}`;
    const wrappedBody = wrapTextLines(ctx, bodyText, 750);
    const displayLines = wrappedBody.slice(0, 5);
    const extraH = Math.max(0, (displayLines.length - 2) * 32);
    const cardTop = -128 - Math.round(extraH / 2);
    const cardH = 256 + extraH;

    fillCardWithShadow(ctx, -415, cardTop, 830, cardH, 24, '#FFFFFF', 0.11);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -415, cardTop, 830, cardH, 24);
    ctx.stroke();

    // Top chrome bar
    ctx.fillStyle = '#F1F5F9';
    drawRoundedRectPath(ctx, -415, cardTop, 830, 56, 22);
    ctx.fill();
    ctx.fillRect(-415, cardTop + 34, 830, 22);

    // Traffic lights
    const dots = ['#EF4444', '#F59E0B', '#10B981'];
    dots.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(-374 + i * 26, cardTop + 28, 8, 0, Math.PI * 2);
      ctx.fill();
    });

    // URL pill
    ctx.fillStyle = '#FFFFFF';
    drawRoundedRectPath(ctx, -260, cardTop + 11, 560, 34, 17);
    ctx.fill();
    ctx.font = `600 17px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.formula || 'https://english.practice/reading-context', 20, cardTop + 28, 520);

    // Content area
    ctx.font = `800 29px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'Real-World English Context', 0, cardTop + 86, 750);

    ctx.font = `600 23px ${FONT_SANS}`;
    ctx.fillStyle = '#334155';
    displayLines.forEach((ln, idx) => {
      const lineTxt =
        idx === displayLines.length - 1 && wrappedBody.length > displayLines.length
          ? `${ln.slice(0, Math.max(8, ln.length - 3))}...`
          : ln;
      ctx.fillText(lineTxt, 0, cardTop + 128 + idx * 31, 750);
    });
  } else if (props.variant === 'css-grammar-equation') {
    // Grammar Token Pill Equation: [Part A] + [Part B] = [Result]
    const parts = props.data?.labels?.slice(0, 3) ?? ['Could you', 'V-inf', 'Polite!'];
    fillCardWithShadow(ctx, -430, -112, 860, 224, 30, '#FFFFFF', 0.09);
    ctx.font = `700 20px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'GRAMMAR FORMULA', 0, -72, 720);

    const boxes = [
      { x: -395, w: 220, bg: '#DBEAFE', fg: '#1D4ED8', txt: parts[0] },
      { x: -115, w: 220, bg: '#FEF3C7', fg: '#B45309', txt: parts[1] },
      { x: 165, w: 230, bg: '#DCFCE7', fg: '#15803D', txt: parts[2] },
    ];
    boxes.forEach((b) => {
      ctx.fillStyle = b.bg;
      drawRoundedRectPath(ctx, b.x, -26, b.w, 86, 22);
      ctx.fill();
      ctx.font = `800 26px ${FONT_DISPLAY}`;
      ctx.fillStyle = b.fg;
      ctx.fillText(b.txt, b.x + b.w / 2, 17, b.w - 22);
    });
    ctx.font = `800 32px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText('+', -145, 17);
    ctx.fillText('=', 135, 17);
  } else if (props.variant === 'css-flashcard-flip') {
    // Layered Stacked Flip Flashcard
    fillCardWithShadow(ctx, -340, -124, 680, 224, 28, '#E0E7FF', 0.06);
    fillCardWithShadow(ctx, -370, -104, 740, 224, 28, '#FFFFFF', 0.12);
    ctx.strokeStyle = '#C7D2FE';
    ctx.lineWidth = 2.5;
    drawRoundedRectPath(ctx, -370, -104, 740, 224, 28);
    ctx.stroke();

    ctx.fillStyle = '#EEF2FF';
    drawRoundedRectPath(ctx, -115, -82, 230, 34, 17);
    ctx.fill();
    ctx.font = `800 17px ${FONT_SANS}`;
    ctx.fillStyle = '#4338CA';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FLASHCARD · FLIP', 0, -65);

    ctx.font = `800 40px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'commute', 0, -4, 660);
    ctx.font = `600 25px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(
      props.data?.subtitle || props.data?.speechText || '/kəˈmjuːt/ · Đi làm hằng ngày',
      0,
      58,
      660,
    );
  } else if (props.variant === 'css-sticky-note') {
    // Sticky Note Card with Red Pushpin & Corner Fold
    ctx.save();
    ctx.rotate(-0.018);
    fillCardWithShadow(ctx, -375, -124, 750, 248, 22, '#FEF9C3', 0.12);
    ctx.strokeStyle = '#FDE047';
    ctx.lineWidth = 2.5;
    drawRoundedRectPath(ctx, -375, -124, 750, 248, 22);
    ctx.stroke();

    // Folded bottom-right corner
    ctx.fillStyle = '#FDE047';
    ctx.beginPath();
    ctx.moveTo(315, 124);
    ctx.lineTo(375, 68);
    ctx.lineTo(315, 68);
    ctx.closePath();
    ctx.fill();

    // Red pushpin top center
    ctx.fillStyle = '#EF4444';
    ctx.beginPath();
    ctx.arc(0, -112, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FCA5A5';
    ctx.beginPath();
    ctx.arc(-5, -116, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 18px ${FONT_SANS}`;
    ctx.fillStyle = '#B45309';
    ctx.fillText(props.data?.formula || 'QUICK NOTE · REMEMBER', 0, -68, 620);

    ctx.font = `800 35px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1E293B';
    ctx.fillText(props.data?.title || 'Soften requests with Could / Would', 0, -4, 670);

    ctx.font = `600 22px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    const rawSub =
      props.data?.subtitle || props.data?.speechText || 'Never use bare imperatives in polite settings!';
    const wrappedSub = wrapTextLines(ctx, rawSub, 630);
    const displaySub =
      wrappedSub.length > 2
        ? [wrappedSub[0], `${wrappedSub[1].slice(0, Math.max(4, wrappedSub[1].length - 1))}…`]
        : wrappedSub.slice(0, 2);
    const subStartY = displaySub.length === 2 ? 44 : 58;
    displaySub.forEach((line, idx) => {
      ctx.fillText(line, 0, subStartY + idx * 29, 640);
    });
    ctx.restore();
  } else if (props.variant === 'bs-badge-cluster') {
    // Bootstrap Pill Badge Cluster Card
    fillCardWithShadow(ctx, -420, -124, 840, 248, 28, '#FFFFFF', 0.1);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -124, 840, 248, 28);
    ctx.stroke();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 26px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'OTHER NATURAL WAYS TO SAY IT', 0, -72, 740);

    const pills = props.data?.labels?.slice(0, 3) ?? ['Could you...', 'Would you mind...', 'I was wondering...'];
    const palette = [
      { bg: '#DBEAFE', fg: '#1D4ED8' },
      { bg: '#DCFCE7', fg: '#15803D' },
      { bg: '#EDE9FE', fg: '#6D28D9' },
    ];
    const xs = pills.length === 2 ? [-195, 195] : [-258, 0, 258];
    const pw = pills.length === 2 ? 330 : 236;
    pills.forEach((txt, i) => {
      const col = palette[i % palette.length];
      ctx.fillStyle = col.bg;
      drawRoundedRectPath(ctx, xs[i] - pw / 2, -16, pw, 72, 36);
      ctx.fill();
      ctx.font = `800 24px ${FONT_DISPLAY}`;
      ctx.fillStyle = col.fg;
      ctx.fillText(txt, xs[i], 20, pw - 24);
    });

    ctx.font = `600 21px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText(props.data?.subtitle || 'Tap to level up vocabulary variety', 0, 86, 740);
  } else if (props.variant === 'css-magnifying-word') {
    // Spotlight Card + Magnifying Glass Icon
    fillCardWithShadow(ctx, -420, -122, 840, 244, 28, '#FFFFFF', 0.1);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -122, 840, 244, 28);
    ctx.stroke();

    // Spotlight lens circle on left
    ctx.fillStyle = '#EEF2FF';
    ctx.beginPath();
    ctx.arc(-270, -6, 66, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4F46E5';
    ctx.lineWidth = 8;
    ctx.stroke();
    // Handle
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-222, 42);
    ctx.lineTo(-190, 74);
    ctx.stroke();

    ctx.save();
    ctx.translate(-270, -6);
    ctx.scale(0.58, 0.58);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'eye');
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `800 18px ${FONT_SANS}`;
    ctx.fillStyle = '#4F46E5';
    ctx.fillText(props.data?.formula || 'CLOSER LOOK · NUANCE', -160, -64, 520);

    ctx.font = `800 36px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.highlightWord || props.data?.title || 'Keyword Spotlight', -160, -4, 540);

    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(
      props.data?.subtitle || props.data?.speechText || 'Zoom in on native phrasing & usage',
      -160,
      56,
      540,
    );
  } else if (props.variant === 'bs-modal-quiz') {
    // Bootstrap Modal Dialog Quiz Card
    fillCardWithShadow(ctx, -415, -130, 830, 260, 26, '#FFFFFF', 0.13);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -415, -130, 830, 260, 26);
    ctx.stroke();

    // Dark Indigo Modal Header
    ctx.fillStyle = '#1E1B4B';
    drawRoundedRectPath(ctx, -415, -130, 830, 62, 24);
    ctx.fill();
    ctx.fillRect(-415, -90, 830, 22);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `800 22px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(props.data?.formula || '⚡ QUICK CHECK MODAL', -380, -98, 560);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#A5B4FC';
    ctx.fillText('✕', 380, -98);

    ctx.textAlign = 'center';
    ctx.font = `800 30px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || props.data?.speechText || 'Which phrase sounds natural?', 0, -18, 760);

    const optA = props.data?.labels?.[0] || 'A. Option 1';
    const optB = props.data?.labels?.[1] || 'B. Option 2';
    ctx.fillStyle = '#EEF2FF';
    drawRoundedRectPath(ctx, -370, 38, 350, 62, 18);
    ctx.fill();
    ctx.fillStyle = '#ECFDF5';
    drawRoundedRectPath(ctx, 20, 38, 350, 62, 18);
    ctx.fill();

    ctx.font = `800 23px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#4338CA';
    ctx.fillText(optA, -195, 70, 320);
    ctx.fillStyle = '#15803D';
    ctx.fillText(optB, 195, 70, 320);
  } else if (props.variant === 'dynamic-scene' && props.data?.dynamicScene) {
    drawDynamicScene(ctx, props.data.dynamicScene, time);
  } else {
    // pronunciation-wave
    const bars = 9;
    for (let i = 0; i < bars; i++) {
      const pulse = 0.35 + 0.65 * Math.abs(Math.sin(time * 4.5 + i * 0.6));
      const bh = 120 * pulse;
      ctx.fillStyle = i % 3 === 0 ? '#EA580C' : i % 3 === 1 ? '#2563EB' : '#DB2777';
      drawRoundedRectPath(ctx, -160 + i * 38, -bh / 2, 22, bh, 11);
      ctx.fill();
    }
  }

  ctx.restore();
}

function drawDynamicScene(
  ctx: CanvasRenderingContext2D,
  spec: DynamicSceneSpec,
  time: number,
) {
  const motifs = spec.motifs?.length
    ? spec.motifs.slice(0, 3)
    : [{ icon: 'sparkles' as IllustrationSceneIcon, label: 'Key Focus', accent: '#4F46E5' }];

  if (spec.layout === 'split-compare' && motifs.length >= 2) {
    fillCardWithShadow(ctx, -430, -124, 860, 248, 34, '#FFFFFF', 0.09);
    if (spec.badgeText) {
      ctx.font = `700 22px ${FONT_SANS}`;
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'center';
      ctx.fillText(spec.badgeText, 0, -90);
    }
    const left = motifs[0];
    const right = motifs[1];
    const leftAccent = left.accent || '#DC2626';
    const rightAccent = right.accent || '#16A34A';

    // Left panel
    ctx.fillStyle = '#FEF2F2';
    drawRoundedRectPath(ctx, -395, -56, 336, 154, 24);
    ctx.fill();
    ctx.save();
    ctx.translate(-227, -4);
    ctx.scale(0.55, 0.55);
    drawSceneIcon(ctx, left.icon);
    ctx.restore();
    ctx.font = `800 26px ${FONT_DISPLAY}`;
    ctx.fillStyle = leftAccent;
    ctx.textAlign = 'center';
    ctx.fillText(left.label, -227, 68, 300);

    // Connector
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText(
      spec.connector === 'vs' ? 'VS' : spec.connector === 'equals' ? '=' : spec.connector === 'plus' ? '+' : '→',
      0,
      14,
    );

    // Right panel
    ctx.fillStyle = '#F0FDF4';
    drawRoundedRectPath(ctx, 59, -56, 336, 154, 24);
    ctx.fill();
    ctx.save();
    ctx.translate(227, -4);
    ctx.scale(0.55, 0.55);
    drawSceneIcon(ctx, right.icon);
    ctx.restore();
    ctx.font = `800 26px ${FONT_DISPLAY}`;
    ctx.fillStyle = rightAccent;
    ctx.fillText(right.label, 227, 68, 300);
    return;
  }

  if (spec.layout === 'triple-card-grid') {
    const gap = 22;
    const count = Math.max(2, Math.min(3, motifs.length));
    const cw = count === 2 ? 370 : 272;
    const startX = -((count * cw + (count - 1) * gap) / 2);
    motifs.slice(0, count).forEach((m, i) => {
      const cx = startX + i * (cw + gap) + cw / 2;
      fillCardWithShadow(ctx, cx - cw / 2, -110, cw, 220, 28, '#FFFFFF', 0.09);
      ctx.save();
      ctx.translate(cx, -32);
      ctx.scale(0.62, 0.62);
      drawSceneIcon(ctx, m.icon);
      ctx.restore();
      ctx.font = `800 28px ${FONT_DISPLAY}`;
      ctx.fillStyle = m.accent || '#2563EB';
      ctx.textAlign = 'center';
      ctx.fillText(m.label, cx, 52, cw - 28);
      if (m.sublabel) {
        ctx.font = `600 20px ${FONT_SANS}`;
        ctx.fillStyle = '#64748B';
        ctx.fillText(m.sublabel, cx, 86, cw - 28);
      }
    });
    return;
  }

  // Hero icon formula / default dynamic composer
  const hero = motifs[0];
  fillCardWithShadow(ctx, -380, -116, 760, 232, 34, '#FFFFFF', 0.09);
  ctx.save();
  ctx.translate(-225, 0);
  const pulseScale = 0.86 + Math.sin(time * 2.5) * 0.03;
  ctx.scale(pulseScale, pulseScale);
  drawSceneIcon(ctx, hero.icon);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (spec.badgeText) {
    ctx.font = `700 20px ${FONT_SANS}`;
    ctx.fillStyle = hero.accent || '#4F46E5';
    ctx.fillText(spec.badgeText.toUpperCase(), -100, -52, 430);
  }
  ctx.font = `800 34px ${FONT_DISPLAY}`;
  ctx.fillStyle = '#0F172A';
  ctx.fillText(spec.headline || hero.label, -100, 0, 440);
  if (spec.formula || spec.subtext || hero.sublabel) {
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(spec.formula || spec.subtext || hero.sublabel || '', -100, 48, 440);
  }
}

function drawSentenceCard(
  ctx: CanvasRenderingContext2D,
  props: SentenceCardProps,
  width: number,
) {
  ctx.font = `700 46px ${FONT_DISPLAY}`;
  const innerMaxW = width - 104;
  const lines = wrapTextLines(ctx, props.text, innerMaxW);
  const lineH = 60;

  ctx.font = `600 26px ${FONT_SANS}`;
  const subLines = props.subtext
    ? props.subtext
        .split(/\r?\n/)
        .flatMap((part) => wrapTextLines(ctx, part, innerMaxW))
        .slice(0, 3)
    : [];
  const subLineH = 34;
  const subH = subLines.length > 0 ? subLines.length * subLineH + 14 : 0;
  const cardH = Math.max(148, lines.length * lineH + subH + 74);
  const x = -width / 2;
  const y = -cardH / 2;

  const cardBg = props.bgColor || '#FFFFFF';
  const isDarkBg =
    cardBg !== '#FFFFFF' &&
    (cardBg.startsWith('#0') ||
      cardBg.startsWith('#1') ||
      cardBg.startsWith('#2') ||
      cardBg.includes('rgba') ||
      cardBg.includes('15, 23, 42'));
  const defaultTextColor = props.textColor || (isDarkBg ? '#F8FAFC' : '#0F172A');

  fillCardWithShadow(ctx, x, y, width, cardH, 38, cardBg, isDarkBg ? 0.3 : 0.1);

  // Render lines with optional emphasis word coloring
  ctx.font = `700 46px ${FONT_DISPLAY}`;
  ctx.textBaseline = 'middle';
  const totalContentH = (lines.length - 1) * lineH + subH;
  const startTextY = y + cardH / 2 - totalContentH / 2;
  const emphasisLower = props.emphasisWord?.trim().toLowerCase();

  lines.forEach((line, lineIdx) => {
    const lineY = startTextY + lineIdx * lineH;
    if (emphasisLower && line.toLowerCase().includes(emphasisLower)) {
      const lower = line.toLowerCase();
      const idx = lower.indexOf(emphasisLower);
      const before = line.slice(0, idx);
      const match = line.slice(idx, idx + emphasisLower.length);
      const after = line.slice(idx + emphasisLower.length);

      const totalW = ctx.measureText(line).width;
      let cursorX = -totalW / 2;
      ctx.textAlign = 'left';

      if (before) {
        ctx.fillStyle = defaultTextColor;
        ctx.fillText(before, cursorX, lineY);
        cursorX += ctx.measureText(before).width;
      }
      ctx.fillStyle = props.emphasisColor || (isDarkBg ? '#FACC15' : '#2563EB');
      ctx.fillText(match, cursorX, lineY);
      cursorX += ctx.measureText(match).width;
      if (after) {
        ctx.fillStyle = defaultTextColor;
        ctx.fillText(after, cursorX, lineY);
      }
    } else {
      ctx.textAlign = 'center';
      ctx.fillStyle = defaultTextColor;
      ctx.fillText(line, 0, lineY);
    }
  });

  if (subLines.length > 0) {
    ctx.font = `600 26px ${FONT_SANS}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = isDarkBg ? '#94A3B8' : '#475569';
    const subStartY = startTextY + (lines.length - 1) * lineH + 46;
    subLines.forEach((sLn, sIdx) => {
      ctx.fillText(sLn, 0, subStartY + sIdx * subLineH, innerMaxW);
    });
  }

  // Top-right badge (check, cross, or question)
  if (props.badge === 'check' || props.badge === 'cross' || props.badge === 'question') {
    const bx = x + width - 18;
    const by = y + 10;
    ctx.save();
    ctx.fillStyle =
      props.badge === 'check' ? '#16A34A' : props.badge === 'cross' ? '#DC2626' : '#4F46E5';
    ctx.beginPath();
    ctx.arc(bx, by, 30, 0, Math.PI * 2);
    ctx.fill();
    if (props.badge === 'question') {
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `800 34px ${FONT_DISPLAY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', bx, by + 1);
    } else {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (props.badge === 'check') {
        ctx.moveTo(bx - 12, by + 1);
        ctx.lineTo(bx - 3, by + 10);
        ctx.lineTo(bx + 13, by - 9);
      } else {
        ctx.moveTo(bx - 10, by - 10);
        ctx.lineTo(bx + 10, by + 10);
        ctx.moveTo(bx + 10, by - 10);
        ctx.lineTo(bx - 10, by + 10);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Optional stamp (e.g., RUDE / AVOID)
  if (props.stampText) {
    ctx.save();
    ctx.translate(x + width - 90, y + cardH - 12);
    ctx.rotate(-0.08);
    ctx.fillStyle = props.stampColor || '#DC2626';
    drawRoundedRectPath(ctx, -74, -24, 148, 48, 12);
    ctx.fill();
    ctx.font = `800 26px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.stampText, 0, 1);
    ctx.restore();
  }
}

function drawToneMeter(
  ctx: CanvasRenderingContext2D,
  props: ToneMeterProps,
  width: number,
  time: number,
) {
  const span = Math.max(0.1, props.animateEnd - props.animateStart);
  const progress = clamp01((time - props.animateStart) / span);
  const eased = easeInOutCubic(progress);
  const value = props.valueStart + (props.valueEnd - props.valueStart) * eased;

  // Title
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 24px ${FONT_SANS}`;
  ctx.fillStyle = '#64748B';
  ctx.fillText(props.title, 0, -48);

  // Gradient bar
  const barW = width;
  const barH = 22;
  const grad = ctx.createLinearGradient(-barW / 2, 0, barW / 2, 0);
  grad.addColorStop(0, '#DC2626');
  grad.addColorStop(0.5, '#F59E0B');
  grad.addColorStop(1, '#16A34A');

  ctx.fillStyle = grad;
  drawRoundedRectPath(ctx, -barW / 2, -barH / 2, barW, barH, barH / 2);
  ctx.fill();

  // Thumb
  const thumbX = -barW / 2 + barW * clamp01(value);
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.2)';
  ctx.shadowBlur = 16;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(thumbX, 0, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = value < 0.38 ? '#DC2626' : value > 0.65 ? '#16A34A' : '#F59E0B';
  ctx.stroke();
  ctx.restore();

  // Labels
  ctx.font = `700 28px ${FONT_SANS}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#DC2626';
  ctx.fillText(props.leftLabel, -barW / 2, 48);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#16A34A';
  ctx.fillText(props.rightLabel, barW / 2, 48);
}

function drawWordStack(
  ctx: CanvasRenderingContext2D,
  props: WordStackProps,
  width: number,
  time: number,
) {
  const rowH = 128;
  const gap = 28;
  const totalH = props.rows.length * rowH + (props.rows.length - 1) * gap;
  const startY = -totalH / 2;

  props.rows.forEach((row, idx) => {
    if (time < row.appearAt) return;
    const elapsed = Math.min(1, (time - row.appearAt) / 0.25);
    const scale = 0.88 + 0.12 * elapsed;

    ctx.save();
    ctx.globalAlpha *= elapsed;
    ctx.translate(0, startY + idx * (rowH + gap) + rowH / 2);
    ctx.scale(scale, scale);

    fillCardWithShadow(ctx, -width / 2, -rowH / 2, width, rowH, 34, '#FFFFFF', 0.09);

    ctx.font = `800 66px ${FONT_DISPLAY}`;
    ctx.textBaseline = 'middle';
    const prefixW = ctx.measureText(row.prefix).width;
    const suffixW = ctx.measureText(row.suffix).width;
    const fullW = prefixW + suffixW;
    const leftX = row.phonetic ? -width / 2 + 64 : -fullW / 2;

    ctx.textAlign = 'left';
    ctx.fillStyle = '#0F172A';
    ctx.fillText(row.prefix, leftX, 0);
    ctx.fillStyle = row.suffixColor;
    ctx.fillText(row.suffix, leftX + prefixW, 0);

    if (row.phonetic) {
      ctx.font = `600 32px ${FONT_SANS}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = '#64748B';
      ctx.fillText(row.phonetic, width / 2 - 58, 2);
    }

    ctx.restore();
  });
}

function adjustHex(hex: string, factor: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const nr = factor >= 1 ? clamp(r + (255 - r) * (factor - 1)) : clamp(r * factor);
  const ng = factor >= 1 ? clamp(g + (255 - g) * (factor - 1)) : clamp(g * factor);
  const nb = factor >= 1 ? clamp(b + (255 - b) * (factor - 1)) : clamp(b * factor);
  return `rgb(${nr}, ${ng}, ${nb})`;
}

function drawShape3D(
  ctx: CanvasRenderingContext2D,
  props: Shape3DProps,
  width: number,
  height: number,
) {
  const x = -width / 2;
  const y = -height / 2;
  const depth = Math.max(0, props.depth ?? 10);
  const darkFill = adjustHex(props.fill, 0.72);
  const lightEdge = adjustHex(props.fill, 1.35);

  if (props.shapeType === 'cube_3d') {
    const s = Math.min(width, height) * 0.48;
    const topY = -s * 0.95;
    const midY = -s * 0.42;
    const botY = s * 0.58;
    const sideY = s * 0.08;

    ctx.save();
    if (props.shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = 26;
      ctx.shadowOffsetY = 18;
    }
    // Left face (medium)
    ctx.fillStyle = props.fill;
    ctx.beginPath();
    ctx.moveTo(-s * 0.92, sideY - s * 0.48);
    ctx.lineTo(0, midY);
    ctx.lineTo(0, botY + s * 0.42);
    ctx.lineTo(-s * 0.92, sideY + s * 0.48);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Right face (dark)
    ctx.fillStyle = darkFill;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(s * 0.92, sideY - s * 0.48);
    ctx.lineTo(s * 0.92, sideY + s * 0.48);
    ctx.lineTo(0, botY + s * 0.42);
    ctx.closePath();
    ctx.fill();

    // Top face (bright)
    ctx.fillStyle = adjustHex(props.fill, 1.25);
    ctx.beginPath();
    ctx.moveTo(0, topY);
    ctx.lineTo(s * 0.92, sideY - s * 0.48);
    ctx.lineTo(0, midY);
    ctx.lineTo(-s * 0.92, sideY - s * 0.48);
    ctx.closePath();
    ctx.fill();

    if (props.highlight) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  } else if (props.shapeType === 'staircase_3d') {
    const steps = 3;
    const gap = 16;
    const stepW = (width - gap * (steps - 1)) / steps;
    const labels = props.stepLabels ?? ['Step 1', 'Step 2', 'Step 3'];

    for (let i = 0; i < steps; i++) {
      const ratio = 0.45 + i * 0.27;
      const sh = height * ratio;
      const sx = x + i * (stepW + gap);
      const sy = y + height - sh;

      // Extruded depth
      if (depth > 0) {
        ctx.fillStyle = darkFill;
        drawRoundedRectPath(ctx, sx, sy + depth, stepW, sh, 18);
        ctx.fill();
      }
      fillCardWithShadow(ctx, sx, sy, stepW, sh, 18, props.fill, props.shadow ? 0.25 : 0);

      // Top highlight face
      if (props.highlight) {
        ctx.fillStyle = lightEdge;
        drawRoundedRectPath(ctx, sx + 4, sy + 2, stepW - 8, 14, 7);
        ctx.fill();
      }

      const label = labels[i];
      if (label) {
        ctx.fillStyle = props.textColor || '#FFFFFF';
        ctx.font = `800 32px ${FONT_DISPLAY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, sx + stepW / 2, sy + sh / 2);
      }
    }
    return;
  } else {
    const radius =
      props.shapeType === 'pill_3d'
        ? height / 2
        : props.shapeType === 'rect_3d'
          ? 12
          : Math.min(props.cornerRadius ?? 28, height / 2);

    if (props.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 32;
      ctx.shadowOffsetX = 6;
      ctx.shadowOffsetY = 16 + depth;
      ctx.fillStyle = darkFill;
      drawRoundedRectPath(ctx, x, y + depth, width, height, radius);
      ctx.fill();
      ctx.restore();
    }

    if (depth > 0) {
      ctx.fillStyle = darkFill;
      drawRoundedRectPath(ctx, x, y + depth, width, height, radius);
      ctx.fill();
    }

    // Specular 3D face gradient for crisp depth
    const faceGrad = ctx.createLinearGradient(x, y, x, y + height);
    faceGrad.addColorStop(0, adjustHex(props.fill, 1.14));
    faceGrad.addColorStop(0.55, props.fill);
    faceGrad.addColorStop(1, adjustHex(props.fill, 0.88));
    ctx.fillStyle = faceGrad;
    drawRoundedRectPath(ctx, x, y, width, height, radius);
    ctx.fill();

    if (props.highlight) {
      ctx.save();
      ctx.strokeStyle = lightEdge;
      ctx.lineWidth = 4;
      drawRoundedRectPath(ctx, x + 2, y + 2, width - 4, height - 4, Math.max(4, radius - 2));
      ctx.stroke();
      ctx.restore();
    }
  }

  // Render attached text content
  if (props.textContent) {
    const sizeMap = {
      display: 64,
      headline: 48,
      body: 36,
      caption: 28,
      label: 24,
    };
    const weightMap = {
      regular: 400,
      medium: 500,
      bold: 700,
      black: 800,
    };
    const fSize = sizeMap[props.textSize ?? 'headline'];
    const fWeight = weightMap[props.textWeight ?? 'bold'];
    ctx.font = `${fWeight} ${fSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = props.textColor || '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = wrapTextLines(ctx, props.textContent, width - 64);
    const lineH = fSize * 1.24;
    const startY = -((lines.length - 1) * lineH) / 2;
    lines.forEach((ln, idx) => {
      ctx.fillText(ln, 0, startY + idx * lineH);
    });
  }
}

function drawKaraokeCard(
  ctx: CanvasRenderingContext2D,
  props: KaraokeCardProps,
  width: number,
  time: number,
) {
  const words = props.words;
  if (words.length === 0) return;

  const isDarkBar = props.variant === 'dark-bar';
  ctx.font = `700 42px ${FONT_DISPLAY}`;
  const maxLineW = width - 104;
  const asciiSpaceW = Math.max(14, ctx.measureText(' ').width * 1.45);
  const isCjkOnly = (s: string) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(s) && !/[A-Za-z0-9]/.test(s);
  const gapBetween = (a: string, b: string) => (isCjkOnly(a) && isCjkOnly(b) ? 3 : asciiSpaceW);

  // Build wrapped lines of WordTiming tokens
  const allLines: { tokens: typeof words; lineWidth: number }[] = [];
  let currentLine: typeof words = [];
  let currentW = 0;

  for (const token of words) {
    const wWidth = ctx.measureText(token.word).width;
    const prevWord = currentLine.length > 0 ? currentLine[currentLine.length - 1].word : null;
    const sep = prevWord ? gapBetween(prevWord, token.word) : 0;
    const nextW = currentLine.length === 0 ? wWidth : currentW + sep + wWidth;
    if (nextW > maxLineW && currentLine.length > 0) {
      allLines.push({ tokens: currentLine, lineWidth: currentW });
      currentLine = [token];
      currentW = wWidth;
    } else {
      currentLine.push(token);
      currentW = nextW;
    }
  }
  if (currentLine.length > 0) {
    allLines.push({ tokens: currentLine, lineWidth: currentW });
  }

  // Group into pages of at most 2 lines so long narration never overflows vertically
  const pages: { tokens: typeof words; lineWidth: number }[][] = [];
  for (let i = 0; i < allLines.length; i += 2) {
    pages.push(allLines.slice(i, i + 2));
  }

  let activePageIdx = 0;
  if (pages.length > 1) {
    const foundIdx = pages.findIndex((page) => {
      const first = page[0]?.tokens[0];
      const lastLine = page[page.length - 1];
      const last = lastLine?.tokens[lastLine.tokens.length - 1];
      return first && last && time <= last.end + 0.02;
    });
    activePageIdx = foundIdx === -1 ? pages.length - 1 : foundIdx;
  }

  const lines = pages[activePageIdx] ?? allLines.slice(0, 2);
  const lineH = 62;
  const cardH = Math.max(134, lines.length * lineH + 64);
  const x = -width / 2;
  const y = -cardH / 2;

  fillCardWithShadow(
    ctx,
    x,
    y,
    width,
    cardH,
    isDarkBar ? 28 : 36,
    isDarkBar ? 'rgba(15, 23, 42, 0.78)' : '#FFFFFF',
    isDarkBar ? 0.25 : 0.11,
  );

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const startY = y + cardH / 2 - ((lines.length - 1) * lineH) / 2;

  lines.forEach((line, lineIdx) => {
    let cursorX = -line.lineWidth / 2;
    const lineY = startY + lineIdx * lineH;

    line.tokens.forEach((token, tIdx) => {
      const isActive = time >= token.start && time <= token.end;
      const isSpoken = time > token.end;
      const tokenW = ctx.measureText(token.word).width;

      if (isActive) {
        ctx.save();
        ctx.fillStyle = token.highlightColor || props.activeColor;
        ctx.translate(cursorX + tokenW / 2, lineY);
        ctx.scale(1.04, 1.04);
        ctx.textAlign = 'center';
        ctx.fillText(token.word, 0, 0);
        ctx.restore();
      } else {
        ctx.fillStyle = isSpoken ? props.spokenColor : props.inactiveColor;
        ctx.fillText(token.word, cursorX, lineY);
      }

      const nextTok = line.tokens[tIdx + 1];
      cursorX += tokenW + (nextTok ? gapBetween(token.word, nextTok.word) : 0);
    });
  });
}

export function renderIllustrationVariantThumbnail(
  ctx: CanvasRenderingContext2D,
  variant: string,
  width: number,
  height: number,
  time = 0.6,
  primitivesOverride?: VectorPrimitive[],
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#F8FAFC';
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width / 2, height / 2);
  const scale = Math.min(width / 920, height / 340);
  ctx.scale(scale, scale);

  if (primitivesOverride && primitivesOverride.length > 0) {
    drawVectorPrimitives(ctx, primitivesOverride, time, (icon) => drawSceneIcon(ctx, icon));
  } else {
    drawIllustrationProp(ctx, { kind: 'illustration-prop', variant }, time);
  }
  ctx.restore();
}

export function renderProjectFrame(
  ctx: CanvasRenderingContext2D,
  project: LessonProject,
  time: number,
  selectedElementId?: string | null,
) {
  const palette = CANVAS_THEMES[project.theme] || CANVAS_THEMES['pastel-sunrise'];

  // 1. Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, STAGE_HEIGHT);
  bgGrad.addColorStop(0, palette.bgTop);
  bgGrad.addColorStop(1, palette.bgBottom);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

  // Soft ambient radial glows
  const glow1 = ctx.createRadialGradient(200, 320, 40, 200, 320, 560);
  glow1.addColorStop(0, palette.glowA);
  glow1.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

  const glow2 = ctx.createRadialGradient(880, 1420, 40, 880, 1420, 620);
  glow2.addColorStop(0, palette.glowB);
  glow2.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);

  // Optional uploaded background image (auto-resized/cropped cleanly to 1080x1920)
  if (project.backgroundImage?.dataUrl) {
    const img = getCachedBgImage(project.backgroundImage.dataUrl);
    if (img) {
      const rect = computeBackgroundImageDrawRect(
        img.naturalWidth || STAGE_WIDTH,
        img.naturalHeight || STAGE_HEIGHT,
        STAGE_WIDTH,
        STAGE_HEIGHT,
        project.backgroundImage.fit || 'cover',
      );
      ctx.save();
      ctx.drawImage(img, rect.dx, rect.dy, rect.dw, rect.dh);
      const scrim = clamp01(project.backgroundImage.scrimOpacity ?? 0.22);
      if (scrim > 0.01) {
        ctx.fillStyle = `rgba(15, 23, 42, ${scrim})`;
        ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
      }
      ctx.restore();
    }
  }

  // 2. Sort elements by zIndex
  const sorted = [...project.elements].sort((a, b) => a.layout.zIndex - b.layout.zIndex);

  for (const el of sorted) {
    const frame = computeElementFrameState(el, time);
    if (!frame.visible) continue;

    ctx.save();
    ctx.globalAlpha = frame.opacity;
    ctx.translate(el.layout.x, el.layout.y + frame.translateY);
    ctx.scale(frame.scale, frame.scale);

    switch (el.props.kind) {
      case 'comparison-strip':
        drawComparisonStrip(ctx, el.props, el.layout.width, time);
        break;
      case 'topic-pill':
        drawTopicPill(ctx, el.props);
        break;
      case 'illustration-prop':
        drawIllustrationProp(ctx, el.props, time);
        break;
      case 'sentence-card':
        drawSentenceCard(ctx, el.props, el.layout.width);
        break;
      case 'tone-meter':
        drawToneMeter(ctx, el.props, el.layout.width, time);
        break;
      case 'word-stack':
        drawWordStack(ctx, el.props, el.layout.width, time);
        break;
      case 'shape-3d':
        drawShape3D(ctx, el.props, el.layout.width, el.layout.height ?? 200);
        break;
      case 'karaoke-card':
        drawKaraokeCard(ctx, el.props, el.layout.width, time);
        break;
    }

    // Optional crisp selection guide on canvas when editing in studio
    if (selectedElementId && el.id === selectedElementId) {
      ctx.save();
      ctx.strokeStyle = '#4F46E5';
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 10]);
      const boxW = el.layout.width + 26;
      const boxH =
        el.type === 'shape-3d'
          ? (el.layout.height ?? 200) + 26
          : el.type === 'word-stack'
            ? 480
            : el.type === 'illustration-prop'
              ? 320
              : 170;
      drawRoundedRectPath(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 24);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // 3. Optional Watermark & Outro overlay (shared across Studio 9:16 & English Reels)
  const wm = project.watermark;
  if (wm) {
    if (wm.watermarkEnabled && wm.watermarkText.trim()) {
      const wmText = wm.watermarkText.trim();
      ctx.save();
      ctx.globalAlpha = Math.max(0.15, Math.min(1, wm.watermarkOpacity ?? 0.65));
      ctx.font = '700 24px "Plus Jakarta Sans", "Inter", sans-serif';
      const tw = ctx.measureText(wmText).width;
      const boxW = Math.min(STAGE_WIDTH - 80, tw + 36);
      const boxH = 48;
      const padX = 36;
      const padY = 44;
      const x =
        wm.watermarkCorner === 'top-left' || wm.watermarkCorner === 'bottom-left'
          ? padX
          : STAGE_WIDTH - padX - boxW;
      const y =
        wm.watermarkCorner === 'top-left' || wm.watermarkCorner === 'top-right'
          ? padY
          : STAGE_HEIGHT - padY - boxH;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.58)';
      drawRoundedRectPath(ctx, x, y, boxW, boxH, 14);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(wmText, x + 18, y + boxH / 2, boxW - 36);
      ctx.restore();
    }

    const outroLines = [wm.outroLine1?.trim() || '', wm.outroLine2?.trim() || ''].filter(Boolean);
    if (wm.outroSeconds > 0 && outroLines.length > 0 && project.duration > 0) {
      const outroStart = Math.max(0, project.duration - wm.outroSeconds);
      if (time >= outroStart) {
        const fadeDur = Math.min(0.55, wm.outroSeconds);
        const progress = fadeDur > 0 ? Math.min(1, (time - outroStart) / fadeDur) : 1;
        ctx.save();
        ctx.fillStyle = `rgba(15, 23, 42, ${(0.9 * progress).toFixed(3)})`;
        ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
        ctx.globalAlpha = progress;
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '800 54px "Outfit", "Plus Jakarta Sans", sans-serif';
        const lineGap = 76;
        const baseLineY = STAGE_HEIGHT / 2 - ((outroLines.length - 1) * lineGap) / 2;
        outroLines.forEach((line, idx) => {
          ctx.fillText(line, STAGE_WIDTH / 2, baseLineY + idx * lineGap, STAGE_WIDTH * 0.84);
        });
        ctx.restore();
      }
    }
  }
}

export function hitTestElements(
  elements: SceneElement[],
  canvasX: number,
  canvasY: number,
  time: number,
): SceneElement | null {
  const sorted = [...elements].sort((a, b) => b.layout.zIndex - a.layout.zIndex);
  for (const el of sorted) {
    const state = computeElementFrameState(el, time);
    if (!state.visible) continue;
    const halfW = (el.layout.width * state.scale) / 2;
    const halfH =
      el.type === 'shape-3d'
        ? ((el.layout.height ?? 200) * state.scale) / 2
        : el.type === 'word-stack'
          ? 230
          : el.type === 'illustration-prop'
            ? 160
            : 85;
    if (
      canvasX >= el.layout.x - halfW &&
      canvasX <= el.layout.x + halfW &&
      canvasY >= el.layout.y - halfH &&
      canvasY <= el.layout.y + halfH
    ) {
      return el;
    }
  }
  return null;
}
