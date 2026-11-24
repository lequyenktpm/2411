import { parseTranscriptAuto } from './transcriptParser';
import {
  TranscriptCue,
  WatermarkCorner,
  WatermarkOutroConfig,
  WordTiming,
} from './types';

export type EduWatermarkCorner = WatermarkCorner;
export type EduKaraokePosition = 'Dưới' | 'Giữa' | 'Trên';
export type EduKaraokeSize = 'Nhỏ' | 'Vừa' | 'Lớn';

export type EduWatermarkOutroConfig = WatermarkOutroConfig;

export interface KaraokeEffectSpec {
  id: string;
  description: string;
  mode: 'karaoke' | 'typewriter';
  activeColor: string;
  inactiveColor: string;
  outlineColor: string;
  border: number;
  shadow: number;
  blur: number;
  bold: number;
  box: boolean;
  pop: boolean;
}

export const KARAOKE_EFFECT_PRESETS: KaraokeEffectSpec[] = [
  {
    id: 'Classic Karaoke – tô màu từng từ',
    description: 'Chữ trắng, từ đang đọc chuyển tím theo tiến độ; viền tối rõ trên mọi nền.',
    mode: 'karaoke',
    activeColor: '#A78BFA',
    inactiveColor: '#FFFFFF',
    outlineColor: '#172033',
    border: 2.4,
    shadow: 1.2,
    blur: 0,
    bold: -1,
    box: false,
    pop: false,
  },
  {
    id: 'Neon Glow – phát sáng',
    description: 'Từ đang đọc chuyển xanh cyan, có viền và phát sáng nhẹ; hợp video tech/hiện đại.',
    mode: 'karaoke',
    activeColor: '#67E8F9',
    inactiveColor: '#F8FAFC',
    outlineColor: '#155E75',
    border: 3.2,
    shadow: 0.5,
    blur: 1.1,
    bold: -1,
    box: false,
    pop: false,
  },
  {
    id: 'Pop Bounce – bật nảy',
    description: 'Cả dòng bật nảy nhẹ khi xuất hiện; từ đang đọc chuyển vàng cam đậm nét.',
    mode: 'karaoke',
    activeColor: '#FBBF24',
    inactiveColor: '#FFFFFF',
    outlineColor: '#292014',
    border: 3.0,
    shadow: 1.0,
    blur: 0,
    bold: -1,
    box: false,
    pop: true,
  },
  {
    id: 'Soft Caption Card – thẻ nền mờ',
    description: 'Phụ đề nằm trên thẻ nền xanh đen bán trong suốt, bo kiểu caption cổ điển.',
    mode: 'karaoke',
    activeColor: '#C4B5FD',
    inactiveColor: '#FFFFFF',
    outlineColor: '#263449',
    border: 10.0,
    shadow: 0,
    blur: 0,
    bold: 0,
    box: true,
    pop: false,
  },
  {
    id: 'Minimal Outline – tối giản',
    description: 'Không thẻ nền; chữ trắng viền đen mảnh, từ đang đọc chuyển xanh lá nhẹ.',
    mode: 'karaoke',
    activeColor: '#86EFAC',
    inactiveColor: '#FFFFFF',
    outlineColor: '#000000',
    border: 1.5,
    shadow: 0.8,
    blur: 0,
    bold: 0,
    box: false,
    pop: false,
  },
  {
    id: 'Typewriter – hiện lần lượt',
    description: 'Câu hiện dần theo từng từ; từ mới xuất hiện được tô màu nhấn cho video từ vựng.',
    mode: 'typewriter',
    activeColor: '#FBBF24',
    inactiveColor: '#FFFFFF',
    outlineColor: '#172033',
    border: 2.2,
    shadow: 1.0,
    blur: 0,
    bold: -1,
    box: false,
    pop: false,
  },
];

function hexToAssBgr(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '').trim();
  const a = Math.max(0, Math.min(255, Math.round(alpha)))
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  if (clean.length === 6) {
    const r = clean.slice(0, 2);
    const g = clean.slice(2, 4);
    const b = clean.slice(4, 6);
    return `&H${a}${b}${g}${r}`.toUpperCase();
  }
  return `&H${a}FFFFFF`;
}

function toAssTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const hh = Math.floor(cs / 360000);
  const mm = Math.floor((cs % 360000) / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function escAssText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');
}

export function buildEduKaraokeAss(
  rawInput: string,
  options: {
    effectId?: string;
    activeColorOverride?: string;
    position?: EduKaraokePosition;
    size?: EduKaraokeSize;
    width?: number;
    height?: number;
  } = {},
): string {
  const spec =
    KARAOKE_EFFECT_PRESETS.find((e) => e.id === options.effectId) ?? KARAOKE_EFFECT_PRESETS[0];
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const position: EduKaraokePosition = options.position ?? 'Dưới';
  const size: EduKaraokeSize = options.size ?? 'Vừa';

  const sizeFactor = size === 'Nhỏ' ? 0.035 : size === 'Lớn' ? 0.056 : 0.045;
  const fontSize = Math.max(24, Math.min(92, Math.round(height * sizeFactor)));
  const align = position === 'Giữa' ? 5 : position === 'Trên' ? 8 : 2;
  const marginV = Math.max(36, Math.round(height * (position === 'Giữa' ? 0.0 : 0.065)));

  const activeBgr = hexToAssBgr(options.activeColorOverride || spec.activeColor);
  const inactiveBgr = hexToAssBgr(spec.inactiveColor);
  const outlineBgr = hexToAssBgr(spec.outlineColor);
  const backBgr = hexToAssBgr('#101827', 78);
  const borderStyle = spec.box ? 3 : 1;

  const parsedCues = parseTranscriptAuto(rawInput);
  const cues: TranscriptCue[] =
    parsedCues.length > 0
      ? parsedCues
      : rawInput
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((text, idx) => ({
            id: `k-${idx + 1}`,
            start: idx * 3.5,
            end: (idx + 1) * 3.5,
            text,
            words: [],
          }));

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Karaoke,Noto Sans,${fontSize},${activeBgr},${inactiveBgr},${outlineBgr},${backBgr},${spec.bold},0,0,0,100,100,0,0,${borderStyle},${spec.border.toFixed(1)},${spec.shadow.toFixed(1)},${align},${Math.round(width * 0.055)},${Math.round(width * 0.055)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const cue of cues) {
    const tokens = cue.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (tokens.length === 0) continue;
    const totalCs = Math.max(tokens.length * 4, Math.round((cue.end - cue.start) * 100));
    const weights = tokens.map((t) => Math.max(1, t.length));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const allocated: number[] = [];
    let remaining = totalCs;
    for (let i = 0; i < tokens.length; i++) {
      if (i === tokens.length - 1) {
        allocated.push(Math.max(2, remaining));
      } else {
        const cs = Math.max(2, Math.min(remaining - (tokens.length - i - 1) * 2, Math.round((totalCs * weights[i]) / weightSum)));
        allocated.push(cs);
        remaining -= cs;
      }
    }

    if (spec.mode === 'typewriter') {
      let cursor = cue.start;
      const prefix: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const tokenStart = cursor;
        cursor += allocated[i] / 100;
        prefix.push(tokens[i]);
        const eventEnd = i === tokens.length - 1 ? cue.end : Math.min(cue.end, cursor + 0.005);
        const visible = prefix.map((tok, j) =>
          j === prefix.length - 1
            ? `{\\1c${activeBgr}}${escAssText(tok)}{\\1c${inactiveBgr}}`
            : escAssText(tok),
        );
        const popTag =
          spec.pop && i === 0 ? '\\t(0,120,\\fscx112\\fscy112)\\t(120,240,\\fscx100\\fscy100)' : '';
        lines.push(
          `Dialogue: 0,${toAssTime(tokenStart)},${toAssTime(eventEnd)},Karaoke,,0,0,0,,{\\an${align}\\q2\\fad(60,70)${popTag}}${visible.join(' ')}`,
        );
      }
    } else {
      const kBody = tokens
        .map((w, idx) => `{\\kf${allocated[idx]}}${escAssText(w)}`)
        .join(' ');
      const blurTag = spec.blur > 0 ? `\\blur${spec.blur.toFixed(1)}` : '';
      const popTag = spec.pop ? '\\t(0,120,\\fscx112\\fscy112)\\t(120,240,\\fscx100\\fscy100)' : '';
      lines.push(
        `Dialogue: 0,${toAssTime(cue.start)},${toAssTime(cue.end)},Karaoke,,0,0,0,,{\\an${align}\\q2${blurTag}${popTag}}${kBody}`,
      );
    }
  }

  return lines.join('\n') + '\n';
}

export interface ReadingBookPalette {
  id: 'Sunny Yellow' | 'Sky Blue' | 'Mint Green' | 'Warm Cream' | 'Lavender';
  bgTop: string;
  bgBottom: string;
  pageBg: string;
  pageBorder: string;
  spineColor: string;
  headerBg: string;
  headerText: string;
  bodyText: string;
  highlightBg: string;
  highlightText: string;
  spokenText: string;
  accent: string;
}

export const READING_BOOK_PALETTES: ReadingBookPalette[] = [
  {
    id: 'Sunny Yellow',
    bgTop: '#FEF3C7',
    bgBottom: '#FDE68A',
    pageBg: '#FFFDF7',
    pageBorder: '#F59E0B',
    spineColor: '#D97706',
    headerBg: '#FEF08A',
    headerText: '#92400E',
    bodyText: '#1E293B',
    highlightBg: '#F59E0B',
    highlightText: '#FFFFFF',
    spokenText: '#334155',
    accent: '#D97706',
  },
  {
    id: 'Sky Blue',
    bgTop: '#E0F2FE',
    bgBottom: '#BAE6FD',
    pageBg: '#F8FDFF',
    pageBorder: '#38BDF8',
    spineColor: '#0284C7',
    headerBg: '#BAE6FD',
    headerText: '#075985',
    bodyText: '#0F172A',
    highlightBg: '#0284C7',
    highlightText: '#FFFFFF',
    spokenText: '#334155',
    accent: '#0284C7',
  },
  {
    id: 'Mint Green',
    bgTop: '#DCFCE7',
    bgBottom: '#BBF7D0',
    pageBg: '#F7FEF9',
    pageBorder: '#34D399',
    spineColor: '#059669',
    headerBg: '#BBF7D0',
    headerText: '#065F46',
    bodyText: '#0F172A',
    highlightBg: '#059669',
    highlightText: '#FFFFFF',
    spokenText: '#334155',
    accent: '#059669',
  },
  {
    id: 'Warm Cream',
    bgTop: '#F5EFE6',
    bgBottom: '#E8DFCA',
    pageBg: '#FFFBF2',
    pageBorder: '#D4A373',
    spineColor: '#9C6644',
    headerBg: '#FAEDCD',
    headerText: '#6F4E37',
    bodyText: '#2B2118',
    highlightBg: '#BC6C25',
    highlightText: '#FFFFFF',
    spokenText: '#5C4738',
    accent: '#BC6C25',
  },
  {
    id: 'Lavender',
    bgTop: '#F3E8FF',
    bgBottom: '#E9D5FF',
    pageBg: '#FDFBFF',
    pageBorder: '#A78BFA',
    spineColor: '#7C3AED',
    headerBg: '#E9D5FF',
    headerText: '#5B21B6',
    bodyText: '#1E1B4B',
    highlightBg: '#7C3AED',
    highlightText: '#FFFFFF',
    spokenText: '#4338CA',
    accent: '#7C3AED',
  },
];

export type ReadingIllustrationStyle = 'Flat 2D' | '2.5D' | '3D Cartoon';

export interface ReadingAlongRenderOptions {
  width: number;
  height: number;
  title: string;
  topicBadge?: string;
  text: string;
  words: WordTiming[];
  currentTime: number;
  totalDuration: number;
  paletteId: ReadingBookPalette['id'];
  illustrationStyle: ReadingIllustrationStyle;
  watermarkOutro: EduWatermarkOutroConfig;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

export function buildEstimatedReadingWords(text: string, totalDuration = 12): WordTiming[] {
  const tokens = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const weights = tokens.map((t) => Math.max(2, t.replace(/[^a-zA-Z0-9\u00C0-\u024F\u3040-\u30FF\u4E00-\u9FFF]/g, '').length + (/[,.!?]$/.test(t) ? 2.5 : 0)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const safeDur = Math.max(tokens.length * 0.25, totalDuration);
  let cursor = 0.15;
  const usable = Math.max(0.5, safeDur - 0.3);
  return tokens.map((word, idx) => {
    const dur = (weights[idx] / totalWeight) * usable;
    const start = Number(cursor.toFixed(3));
    const end = Number((cursor + dur).toFixed(3));
    cursor += dur;
    return { word, start, end };
  });
}

export function renderReadingAlongFrame(
  ctx: CanvasRenderingContext2D,
  opts: ReadingAlongRenderOptions,
): void {
  const { width, height } = opts;
  const isLandscape = width > height;
  const refH = isLandscape ? Math.round(height * 1.28) : height;
  const palette =
    READING_BOOK_PALETTES.find((p) => p.id === opts.paletteId) ?? READING_BOOK_PALETTES[0];

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0, palette.bgTop);
  grad.addColorStop(1, palette.bgBottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Decorative floating circles based on illustration style
  ctx.save();
  ctx.globalAlpha = opts.illustrationStyle === '3D Cartoon' ? 0.32 : 0.2;
  ctx.fillStyle = palette.pageBorder;
  ctx.beginPath();
  ctx.arc(width * 0.14, height * 0.1, Math.min(width, height) * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(width * 0.88, height * 0.86, Math.min(width, height) * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // Book outer shadow & cover
  const bookX = width * (isLandscape ? 0.045 : 0.065);
  const bookY = height * (isLandscape ? 0.065 : 0.085);
  const bookW = width * (isLandscape ? 0.91 : 0.87);
  const bookH = height * (isLandscape ? 0.86 : 0.81);

  if (opts.illustrationStyle !== 'Flat 2D') {
    ctx.save();
    ctx.fillStyle = palette.spineColor;
    roundRectPath(
      ctx,
      bookX + Math.min(width, height) * 0.014,
      bookY + Math.min(width, height) * 0.012,
      bookW,
      bookH,
      Math.min(width, height) * 0.036,
    );
    ctx.fill();
    ctx.restore();
  }

  // Book main page
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.16)';
  ctx.shadowBlur = Math.min(width, height) * 0.04;
  ctx.shadowOffsetY = Math.min(width, height) * 0.01;
  ctx.fillStyle = palette.pageBg;
  roundRectPath(ctx, bookX, bookY, bookW, bookH, Math.min(width, height) * 0.034);
  ctx.fill();
  ctx.lineWidth = Math.max(2, Math.min(width, height) * 0.004);
  ctx.strokeStyle = palette.pageBorder;
  ctx.stroke();
  ctx.restore();

  // Book header banner & illustration badge
  const padX = bookX + bookW * 0.06;
  const contentW = bookW * 0.88;
  const pillY = bookY + bookH * 0.045;
  const pillH = Math.max(24, refH * 0.03);

  if (opts.topicBadge) {
    ctx.save();
    ctx.fillStyle = palette.headerBg;
    roundRectPath(ctx, padX, pillY, Math.min(contentW * 0.72, Math.max(200, width * 0.42)), pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = palette.headerText;
    ctx.font = `700 ${Math.round(refH * 0.0155)}px "Plus Jakarta Sans", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.topicBadge, padX + 14, pillY + pillH / 2);
    ctx.restore();
  }

  // Mini book icon on top right of page
  ctx.save();
  const iconS = Math.min(54, Math.min(width, height) * 0.065);
  const iconX = bookX + bookW - padX * 0.35 - iconS - 12;
  const iconY = pillY - 2;
  ctx.fillStyle = palette.accent;
  if (opts.illustrationStyle === '3D Cartoon') {
    ctx.shadowColor = 'rgba(0,0,0,0.22)';
    ctx.shadowBlur = 8;
    ctx.shadowOffsetY = 4;
  }
  roundRectPath(ctx, iconX, iconY, iconS, iconS * 0.78, 10);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(iconX + iconS * 0.48, iconY + 6, 2.5, iconS * 0.78 - 12);
  ctx.restore();

  // Title
  const titleY = pillY + pillH + refH * 0.025;
  ctx.save();
  ctx.fillStyle = palette.headerText;
  ctx.font = `800 ${Math.round(refH * 0.026)}px "Outfit", "Plus Jakarta Sans", sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(opts.title || 'Reading Practice', padX, titleY, contentW - iconS - 12);
  ctx.restore();

  // Divider line
  const dividerY = titleY + refH * 0.044;
  ctx.strokeStyle = palette.headerBg;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX, dividerY);
  ctx.lineTo(padX + contentW, dividerY);
  ctx.stroke();

  // Layout words on the page
  const wordsList =
    opts.words.length > 0
      ? opts.words
      : buildEstimatedReadingWords(opts.text, opts.totalDuration);

  const fontSize = Math.max(15, Math.round(refH * 0.0235));
  const lineHeight = Math.round(fontSize * 1.72);
  const wordGap = Math.round(fontSize * 0.34);
  ctx.font = `600 ${fontSize}px "Plus Jakarta Sans", sans-serif`;

  interface PositionedWord {
    item: WordTiming;
    x: number;
    y: number;
    w: number;
    index: number;
  }

  const placed: PositionedWord[] = [];
  let curX = padX;
  let curY = dividerY + refH * 0.028;
  const maxY = bookY + bookH - refH * 0.07;

  for (let i = 0; i < wordsList.length; i++) {
    const item = wordsList[i];
    const m = ctx.measureText(item.word);
    const w = m.width;
    if (curX + w > padX + contentW && curX > padX) {
      curX = padX;
      curY += lineHeight;
    }
    if (curY > maxY) break;
    placed.push({ item, x: curX, y: curY, w, index: i });
    curX += w + wordGap;
  }

  // Find active word
  let activeIdx = placed.findIndex(
    (p) => opts.currentTime >= p.item.start && opts.currentTime <= p.item.end,
  );
  if (activeIdx === -1 && placed.length > 0) {
    for (let i = placed.length - 1; i >= 0; i--) {
      if (opts.currentTime >= placed[i].item.start) {
        activeIdx = i;
        break;
      }
    }
    if (activeIdx === -1) activeIdx = 0;
  }

  // Draw words
  for (let i = 0; i < placed.length; i++) {
    const p = placed[i];
    const isActive = i === activeIdx;
    const isSpoken = i < activeIdx;

    if (isActive) {
      ctx.save();
      ctx.fillStyle = palette.highlightBg;
      roundRectPath(
        ctx,
        p.x - 8,
        p.y - 6,
        p.w + 16,
        fontSize + 12,
        10,
      );
      ctx.fill();
      ctx.restore();
      ctx.fillStyle = palette.highlightText;
    } else if (isSpoken) {
      ctx.fillStyle = palette.spokenText;
    } else {
      ctx.fillStyle = palette.bodyText;
    }
    ctx.font = `${isActive ? 700 : 600} ${fontSize}px "Plus Jakarta Sans", sans-serif`;
    ctx.textBaseline = 'top';
    ctx.fillText(p.item.word, p.x, p.y);
  }

  // Pointing hand cursor under active word
  if (activeIdx >= 0 && placed[activeIdx]) {
    const target = placed[activeIdx];
    const handX = target.x + target.w / 2;
    const handY = target.y + fontSize + 10;
    const scale = Math.max(0.6, Math.min(width, height) / 1080);
    ctx.save();
    ctx.translate(handX, handY);
    ctx.scale(scale, scale);
    ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
    ctx.shadowBlur = 10;
    ctx.shadowOffsetY = 4;

    // Stylized pointing hand (index finger up)
    ctx.fillStyle = '#FDBA74';
    ctx.strokeStyle = '#7C2D12';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(-6, 4);
    ctx.lineTo(-6, 22);
    ctx.quadraticCurveTo(-18, 22, -18, 34);
    ctx.lineTo(-18, 48);
    ctx.quadraticCurveTo(-18, 62, 0, 62);
    ctx.quadraticCurveTo(22, 62, 22, 46);
    ctx.lineTo(22, 30);
    ctx.quadraticCurveTo(22, 20, 12, 20);
    ctx.lineTo(12, 4);
    ctx.quadraticCurveTo(12, -4, 3, -4);
    ctx.quadraticCurveTo(-6, -4, -6, 4);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Cuff
    ctx.fillStyle = palette.accent;
    roundRectPath(ctx, -14, 58, 32, 16, 6);
    ctx.fill();
    ctx.restore();
  }

  // Watermark overlay (always visible if enabled & non-empty)
  const wm = opts.watermarkOutro;
  if (wm.watermarkEnabled && wm.watermarkText.trim()) {
    ctx.save();
    ctx.globalAlpha = Math.max(0.15, Math.min(1, wm.watermarkOpacity));
    const wmFontSize = Math.max(14, Math.round(height * 0.02));
    ctx.font = `700 ${wmFontSize}px "Plus Jakarta Sans", sans-serif`;
    const wmText = wm.watermarkText.trim();
    const tw = ctx.measureText(wmText).width;
    const pad = Math.round(width * 0.032);
    const boxW = tw + 22;
    const boxH = wmFontSize + 14;
    const x =
      wm.watermarkCorner === 'top-left' || wm.watermarkCorner === 'bottom-left'
        ? pad
        : width - pad - boxW;
    const y =
      wm.watermarkCorner === 'top-left' || wm.watermarkCorner === 'top-right'
        ? pad
        : height - pad - boxH;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.52)';
    roundRectPath(ctx, x, y, boxW, boxH, 10);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(wmText, x + 11, y + boxH / 2);
    ctx.restore();
  }

  // Outro screen fade + 2 lines
  const outroText = [wm.outroLine1.trim(), wm.outroLine2.trim()].filter(Boolean).join('\n');
  if (wm.outroSeconds > 0 && outroText && opts.totalDuration > 0) {
    const outroStart = Math.max(0, opts.totalDuration - wm.outroSeconds);
    if (opts.currentTime >= outroStart) {
      const progress = Math.min(1, (opts.currentTime - outroStart) / Math.min(0.6, wm.outroSeconds));
      ctx.save();
      ctx.fillStyle = `rgba(15, 23, 42, ${(0.88 * progress).toFixed(3)})`;
      ctx.fillRect(0, 0, width, height);
      ctx.globalAlpha = progress;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lines = outroText.split('\n');
      const outroSize = Math.max(24, Math.round(height * 0.036));
      ctx.font = `800 ${outroSize}px "Outfit", "Plus Jakarta Sans", sans-serif`;
      const baseLineY = height / 2 - ((lines.length - 1) * outroSize * 1.4) / 2;
      lines.forEach((line, idx) => {
        ctx.fillText(line, width / 2, baseLineY + idx * outroSize * 1.4, width * 0.85);
      });
      ctx.restore();
    }
  }
}
