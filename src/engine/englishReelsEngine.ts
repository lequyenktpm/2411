import { buildSceneGenerationPrompt, PromptVideoStyle } from './aiPromptBuilder';
import type { VectorPrimitive } from './customComponentTypes';
import { normalizeCustomComponent } from './customComponentStore';
import { resolveProjectOverlaps } from './layoutSolver';
import {
  cleanReadingWorksheetInput,
  isWorksheetScaffoldingLine,
} from './readingPromptBuilder';
import {
  FlexibleSceneDocument,
  parseScenePlanJson,
  scenePlanToProject,
} from './scenePlanAdapter';
import { interpolateWordTimings, stripTimestampsFromScript } from './transcriptParser';
import {
  CanvasThemeId,
  IllustrationPropData,
  IllustrationSceneIcon,
  IllustrationVariant,
  isDarkCanvasTheme,
  LayoutCompositionId,
  LessonProject,
  TranscriptCue,
  WatermarkOutroConfig,
} from './types';
import {
  getCatalogSummaryForPrompt,
  isKnownIllustrationVariant,
  resolveContextualVisualForCue,
} from './vectorComponentDb';

export type ReelCardType = 'intro' | 'vocab' | 'quiz' | 'outro';
export type ReelMode = 'auto' | 'reading' | 'quiz' | 'vocab';

export interface ReelCardVisualConfig {
  variant?: IllustrationVariant;
  title?: string;
  subtitle?: string;
  labels?: string[];
  value?: number;
  formula?: string;
  sceneIcon?: IllustrationSceneIcon;
  speechText?: string;
  customPrimitives?: VectorPrimitive[];
}

export interface ReelCard {
  id: string;
  type: ReelCardType;
  badge: string;
  title: string;
  content: string;
  phonetic?: string;
  translation?: string;
  grammarNote?: string;
  contextExcerpt?: string;
  ttsText: string;
  ttsAnswerText?: string;
  thinkSec?: number;
  options?: string[];
  answerIndex?: number;
  explanation?: string;
  durationSec?: number;
  visual?: ReelCardVisualConfig;
}

export interface ReelCardTimingMeta {
  totalSec: number;
  questionSec?: number;
  thinkSec?: number;
  answerSec?: number;
}

export interface ReelExtractedExercise {
  id: string;
  title: string;
  mode: Exclude<ReelMode, 'auto'>;
  rawText: string;
}

export interface ReelDirectoryLink {
  title: string;
  url: string;
}

export interface ReelScrapeResult {
  url: string;
  title: string;
  isDirectoryPage: boolean;
  links: ReelDirectoryLink[];
  rawText: string;
  exercises: ReelExtractedExercise[];
  detectedMode: Exclude<ReelMode, 'auto'>;
}

export interface ParsedEnglishReelsResponse {
  title: string;
  mode: Exclude<ReelMode, 'auto'>;
  cards: ReelCard[];
  sceneJson?: FlexibleSceneDocument | null;
}

function makeCardId(index: number): string {
  return `reel-card-${Date.now().toString(36)}-${index}-${Math.random().toString(36).slice(2, 5)}`;
}

export function detectReelMode(text: string): Exclude<ReelMode, 'auto'> {
  const lower = text.toLowerCase();
  const hasQuizSignals =
    /\btrue\s*\/\s*false\b|\btrue or false\b|\bmultiple choice\b|\bcomprehension\b/i.test(lower) ||
    /(^|\n)\s*(?:q?\d+[.)]|\([a-d]\)|[a-d][.)])\s+/i.test(text);
  if (hasQuizSignals) return 'quiz';

  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const vocabLineCount = lines.filter((l) =>
    /^[\w\s'-]{1,34}\s*(?:\/[^/]+\/\s*)?(?:[-–—:=]|→)\s*.+/.test(l),
  ).length;
  if (vocabLineCount >= 2 || (lines.length >= 3 && vocabLineCount >= lines.length * 0.45)) {
    return 'vocab';
  }
  return 'reading';
}

export function splitMultipleExercisesFromText(text: string): ReelExtractedExercise[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];

  const headingRe =
    /(?=^(?:#{1,3}\s+|(?:Task|Exercise|Part|Reading|Quiz|Vocabulary|Activity|Lesson)\s*\d+[:.\-–\s]))/gim;
  const rawParts = cleaned
    .split(headingRe)
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length < 30) return false;
      const bodyCheck = cleanReadingWorksheetInput(s);
      return bodyCheck.lines.length >= 1 && bodyCheck.bodyText.length >= 25;
    });

  if (rawParts.length <= 1) {
    const cleanedDoc = cleanReadingWorksheetInput(cleaned);
    return [
      {
        id: 'ex-1',
        title: cleanedDoc.title || 'Bài học chính',
        mode: detectReelMode(cleanedDoc.bodyText || cleaned),
        rawText: cleanedDoc.bodyText || cleaned,
      },
    ];
  }

  return rawParts.slice(0, 10).map((part, idx) => {
    const cleanedPart = cleanReadingWorksheetInput(part);
    return {
      id: `ex-${idx + 1}`,
      title: cleanedPart.title || `Bài tập ${idx + 1}`,
      mode: detectReelMode(cleanedPart.bodyText || part),
      rawText: cleanedPart.bodyText || part,
    };
  });
}

export function estimateCardSpeechDuration(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Number(Math.max(2.2, Math.min(18, words / 2.4 + 0.65)).toFixed(2));
}

function isMetadataNoiseLine(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  if (isWorksheetScaffoldingLine(t)) return true;
  if (
    /^(?:true\s*\/\s*false(?:\s+quiz)?|multiple\s*choice|comprehension(?:\s+quiz)?|vocabulary(?:\s+list)?|reading(?:\s+passage)?|answer\s*key)\s*:?$/i.test(
      t,
    )
  ) {
    return true;
  }
  if (/^(?:Answer|Key|Đáp án|Click here|Share|Read more|Subscribe)\b/i.test(t) && t.length < 45) {
    return true;
  }
  return false;
}

const COMMON_GLOSSARY_VI: Array<[RegExp, string]> = [
  [/\bcomfort zone\b/i, 'comfort zone (vùng an toàn)'],
  [/\bprogramme\b|\bprogram\b/i, 'programme (chương trình)'],
  [/\bexciting\b/i, 'exciting (thú vị)'],
  [/\bmountains?\b/i, 'mountain (ngọn núi)'],
  [/\bdifficult\b/i, 'difficult (khó khăn)'],
  [/\bdangerous\b/i, 'dangerous (nguy hiểm)'],
  [/\bcomfortable\b/i, 'comfortable (thoải mái)'],
  [/\bpossible\b/i, 'possible (có thể)'],
  [/\bprize\b/i, 'prize (giải thưởng)'],
  [/\bfinishes?\b/i, 'finish (kết thúc)'],
  [/\bsteak\b/i, 'steak (bít tết)'],
  [/\blong hot bath\b/i, 'hot bath (tắm nước nóng)'],
  [/\beveryone\b/i, 'everyone (mọi người)'],
  [/\busually\b/i, 'usually (thường xuyên)'],
  [/\bsometimes\b/i, 'sometimes (đôi khi)'],
  [/\btomorrow\b/i, 'tomorrow (ngày mai)'],
  [/\bbreakfast\b/i, 'breakfast (bữa sáng)'],
  [/\bquiet\b/i, 'quiet (yên tĩnh)'],
  [/\bcheck in\b/i, 'check in (nhận phòng)'],
  [/\bpolite\b/i, 'polite (lịch sự)'],
  [/\bsafe\b/i, 'safe (an toàn)'],
  [/\bwin\b/i, 'win (giành chiến thắng)'],
];

export function extractVocabAndGrammarNote(
  sentence: string,
  targetLang = 'Tiếng Việt',
): { vocabNote?: string; grammarNote?: string } {
  const s = sentence.trim();
  if (!s || targetLang === 'none') return {};

  const vocabHits: string[] = [];
  for (const [re, label] of COMMON_GLOSSARY_VI) {
    if (re.test(s) && vocabHits.length < 3) {
      vocabHits.push(label);
    }
  }

  let grammarNote: string | undefined;
  if (/\b(?:am|is|are|'m|'re|'s)\s+going\s+to\b/i.test(s)) {
    grammarNote = 'Ngữ pháp: be going to + V (dự định tương lai)';
  } else if (/\bneed\s+to\s+[a-z]+/i.test(s)) {
    grammarNote = 'Ngữ pháp: need to + V (cần phải làm gì)';
  } else if (/\b(?:could|would)\s+(?:i|we|you)\b/i.test(s)) {
    grammarNote = 'Ngữ pháp: Could/Would + S + V (hỏi lịch sự)';
  } else if (/\b(?:is|are|am)\s+[a-z]+ing\b/i.test(s)) {
    grammarNote = 'Ngữ pháp: Hiện tại tiếp diễn (be + V-ing)';
  } else if (/\b(?:usually|sometimes|every\s+day)\b/i.test(s)) {
    grammarNote = 'Ngữ pháp: Hiện tại đơn (thói quen/trạng từ tần suất)';
  } else if (/\bstarts?\s+on\b|\bat\s+\d{1,2}[:.]\d{2}/i.test(s)) {
    grammarNote = 'Cụm giới từ: on + thứ · at + giờ cụ thể';
  }

  const vocabNote = vocabHits.length > 0 ? `Từ khó: ${vocabHits.join(' · ')}` : undefined;
  return { vocabNote, grammarNote };
}

export function sanitizeTtsSpeech(raw: string): string {
  const withoutTimestamps = stripTimestampsFromScript(String(raw || ''));
  const keptLines = withoutTimestamps
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => {
      if (!l) return false;
      if (isMetadataNoiseLine(l)) return false;
      if (/^(?:answer|key|đáp án)\s*[:.]\s*[A-Da-d0-9]{1,2}\s*$/i.test(l)) return false;
      return true;
    });

  let text = keptLines
    .join(' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/\/[^/\s]{2,40}\//g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/[`*_~#>]+/g, ' ')
    .replace(
      /(?:^|\s)(?:Q?\d+[.)]|Task\s*\d+[:.]?|Part\s*\d+[:.]?|Exercise\s*\d+[:.]?|Question\s*\d+[:.]?|\([A-Da-d]\)|[A-Da-d][.)])\s+/gi,
      ' ',
    )
    .replace(
      /(?:^|\s)(?:Title|Topic|Badge|Word|Phrase|Example|Answer|Key|Explanation|Note|Đáp án|Giải thích)\s*:\s*/gi,
      ' ',
    )
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text) return '';
  if (!/[.!?…]$/.test(text)) {
    text = `${text}.`;
  }
  return text;
}

/**
 * Splits a Quiz card cleanly into two spoken TTS parts around the thinking countdown:
 * - questionSpeech: Conversational Quiz lead-in + short pause + question + options + thinking cue
 * - answerSpeech: Reads correct answer + explanation AFTER countdown finishes
 */
export function getQuizCardSpeechParts(
  card: ReelCard,
  quizPosition = 1,
): {
  questionSpeech: string;
  answerSpeech: string;
  thinkSec: number;
} {
  const opts = (card.options || []).filter((o) => o.trim().length > 0);
  const safeAnsIdx = Math.min(card.answerIndex ?? 0, Math.max(0, opts.length - 1));
  const thinkSec =
    card.type === 'quiz'
      ? Math.max(0, Math.min(10, Number(card.thinkSec ?? 5)))
      : 0;

  let questionSpeech = sanitizeTtsSpeech(card.ttsText || card.content || card.title);
  if (
    card.type === 'quiz' &&
    !/^(?:now|here is|let's|quick quiz|question|time for)/i.test(questionSpeech)
  ) {
    const leadIn =
      quizPosition <= 1
        ? "Now let's test your understanding! ... Question one:"
        : `Next question, number ${quizPosition}: ...`;
    questionSpeech = `${leadIn} ${questionSpeech}`;
  }
  if (
    card.type === 'quiz' &&
    opts.length > 0 &&
    !/(?:take\s+(?:five|\d+)\s+seconds|seconds?\s+to\s+think)/i.test(questionSpeech)
  ) {
    const optStr = opts
      .slice(0, 4)
      .map((o, i) => `${String.fromCharCode(65 + i)}, ${o}`)
      .join('. ');
    questionSpeech = sanitizeTtsSpeech(
      `${questionSpeech.replace(/[.!?]+$/, '')}. ... ${optStr}. ${
        thinkSec > 0 ? `Take ${thinkSec} seconds to think.` : ''
      }`,
    );
  }

  let answerSpeech = card.ttsAnswerText ? sanitizeTtsSpeech(card.ttsAnswerText) : '';
  if (card.type === 'quiz' && !answerSpeech && opts.length > 0) {
    const letter = String.fromCharCode(65 + safeAnsIdx);
    const ansLabel = opts[safeAnsIdx];
    const expl = card.explanation ? ` ${card.explanation}` : '';
    answerSpeech = sanitizeTtsSpeech(
      `Time is up! The correct answer is ${letter}, ${ansLabel}.${expl}`,
    );
  }

  return { questionSpeech, answerSpeech, thinkSec };
}

function defaultVisualForCard(card: ReelCard, idx: number, total: number): ReelCardVisualConfig {
  if (card.visual?.variant || card.visual?.customPrimitives?.length) {
    return card.visual;
  }
  if (card.type === 'intro') {
    return {
      variant: 'bs-card-header',
      formula: card.badge || 'ENGLISH LESSON OVERVIEW',
      title: card.title,
      subtitle: '1. Giới thiệu → 2. Đọc & Từ vựng → 3. Quiz 5s',
      sceneIcon: 'graduation',
    };
  }
  if (card.type === 'outro') {
    return {
      variant: 'css-bento-stats',
      title: card.title || 'Hoàn thành bài học!',
      labels: ['Nghe chuẩn', 'Đọc hiểu', 'Thực hành Quiz'],
      sceneIcon: 'sparkles',
    };
  }
  if (card.type === 'quiz') {
    return {
      variant: 'bs-accordion-faq',
      title: card.title || `Quiz Challenge #${idx}`,
      subtitle: card.translation || 'Chọn đáp án đúng trong 5 giây!',
      speechText: card.content,
      sceneIcon: 'brain',
    };
  }
  if (card.phonetic || card.translation) {
    const ctx = resolveContextualVisualForCue(
      `${card.title} ${card.content} ${card.translation || ''}`,
      card.title,
    );
    if (ctx.matchedRule !== 'fallback' && !ctx.variant.startsWith('bs-') && !ctx.variant.startsWith('css-')) {
      return {
        variant: ctx.variant,
        title: card.title,
        subtitle: [card.phonetic, card.translation].filter(Boolean).join(' · ') || card.content,
        sceneIcon: ctx.sceneIcon,
        speechText: card.content,
      };
    }
    return {
      variant: 'css-flashcard-flip',
      title: card.title || card.content,
      subtitle: [card.phonetic, card.translation].filter(Boolean).join(' · ') || 'Key Vocabulary',
      sceneIcon: ctx.sceneIcon,
    };
  }
  const ctx = resolveContextualVisualForCue(
    `${card.title} ${card.content}`,
    card.title,
  );
  if (ctx.matchedRule !== 'fallback') {
    return {
      variant: ctx.variant,
      title: card.title,
      subtitle: card.translation || card.content,
      sceneIcon: ctx.sceneIcon,
      speechText: card.content,
      ...ctx.data,
    };
  }
  const rotatingVariants: IllustrationVariant[] = [
    'css-browser-mockup',
    'bs-toast-notify',
    'css-glass-quote',
    'css-roadmap-steps',
  ];
  return {
    variant: rotatingVariants[idx % rotatingVariants.length],
    title: card.title || `Reading Part ${idx}/${Math.max(1, total - 1)}`,
    subtitle: card.translation || card.content,
    speechText: card.content,
    labels: ['Listen', 'Understand', 'Speak'],
    sceneIcon: 'book',
  };
}

export function buildReelCardsRuleBased(
  rawText: string,
  options?: {
    title?: string;
    mode?: ReelMode;
    targetLang?: string;
  },
): { title: string; mode: Exclude<ReelMode, 'auto'>; cards: ReelCard[] } {
  const worksheet = cleanReadingWorksheetInput(rawText, options?.title);
  const cleaned = worksheet.bodyText || rawText.replace(/\r\n/g, '\n').trim();
  const lines = worksheet.lines.filter((l) => Boolean(l) && !isMetadataNoiseLine(l));
  const mode =
    options?.mode && options.mode !== 'auto' ? options.mode : detectReelMode(cleaned);
  const docTitle = worksheet.title || 'English Practice Reel';
  const spokenTitle = sanitizeTtsSpeech(docTitle).replace(/[.!?]+$/, '');
  const introSpeech =
    mode === 'quiz'
      ? `Welcome to today's English lesson on ${spokenTitle}. First, read the key details, then answer our interactive quiz.`
      : mode === 'vocab'
        ? `Welcome to today's vocabulary lesson on ${spokenTitle}. Today we will learn essential phrases and their meanings.`
        : `Welcome to today's English reading lesson on ${spokenTitle}. Follow each sentence, learn key vocabulary and grammar, and finish strong.`;

  const cards: ReelCard[] = [
    {
      id: makeCardId(0),
      type: 'intro',
      badge: mode === 'quiz' ? 'BÀI HỌC QUIZ' : mode === 'vocab' ? 'BÀI HỌC TỪ VỰNG' : 'BÀI HỌC HÔM NAY',
      title: docTitle,
      content: `Hôm nay học gì? ${docTitle}`,
      translation:
        options?.targetLang && options.targetLang !== 'none'
          ? 'Lộ trình: 1. Giới thiệu bài · 2. Đọc & Từ vựng · 3. Quiz & Tổng kết'
          : undefined,
      ttsText: introSpeech,
      durationSec: estimateCardSpeechDuration(introSpeech),
      visual: {
        variant: 'bs-card-header',
        formula: 'TODAY LESSON GOAL',
        title: docTitle,
        subtitle: 'Mở bài · Đọc & Từ · Quiz · Tổng kết',
        sceneIcon: 'graduation',
      },
    },
  ];

  // Parse body reading/vocab lines BEFORE quiz section if mixed article + quiz!
  const explicitQuizIdx = cleaned.search(
    /(?:^|\n)\s*(?:True\s*\/\s*False(?:\s+Quiz)?|Multiple\s*Choice|Comprehension(?:\s+Quiz)?|Quiz\b|Question\s*1\b|Q\d+[.)])/im,
  );
  const quizSplitIdx =
    explicitQuizIdx >= 0
      ? explicitQuizIdx
      : mode === 'quiz'
        ? cleaned.search(/(?:^|\n)\s*Q?\d+[.)]\s+/im)
        : -1;
  const readingChunk =
    quizSplitIdx > 0
      ? cleaned.slice(0, quizSplitIdx).trim()
      : mode === 'quiz'
        ? ''
        : cleaned;

  let fullReadingContext = '';

  if (mode === 'vocab') {
    for (let i = 0; i < lines.length && cards.length < 12; i++) {
      const line = lines[i];
      if (line.startsWith('#')) continue;
      const match = line.match(
        /^([^/\-–—:=]+?)(?:\s+(\/[^/]+\/))?\s*(?:[-–—:=]|→)\s*(.+)$/,
      );
      if (match) {
        const word = match[1].replace(/^\d+[.)]\s*/, '').trim();
        const phonetic = match[2]?.trim();
        const meaning = match[3].trim();
        const cleanSpoken = sanitizeTtsSpeech(word);
        if (!cleanSpoken) continue;
        cards.push({
          id: makeCardId(cards.length),
          type: 'vocab',
          badge: `TỪ VỰNG #${cards.length}`,
          title: word,
          content: word,
          phonetic,
          translation: meaning,
          ttsText: cleanSpoken,
          durationSec: estimateCardSpeechDuration(cleanSpoken),
          visual: {
            variant: 'css-flashcard-flip',
            title: word,
            subtitle: meaning,
            sceneIcon: 'book',
          },
        });
      }
    }
  } else if (readingChunk) {
    const cleanReadingLines = readingChunk
      .split('\n')
      .map((l) => l.trim())
      .filter((l, idx) => {
        if (!l || isMetadataNoiseLine(l)) return false;
        if (idx === 0 && l.replace(/^#+\s*/, '').trim().toLowerCase() === docTitle.toLowerCase()) {
          return false;
        }
        return !/^(?:Q\d+[.)]|\([A-Da-d]\)|[A-Da-d][.)])\s+/i.test(l);
      })
      .map((l) => l.replace(/^#+\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter((l) => l.length >= 6);

    const sentences = cleanReadingLines
      .join(' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8 && !isMetadataNoiseLine(s));

    fullReadingContext = sentences.join(' ');

    for (const s of sentences.slice(0, 10)) {
      const cleanSpoken = sanitizeTtsSpeech(s);
      if (!cleanSpoken) continue;
      const notes = extractVocabAndGrammarNote(s, options?.targetLang);
      const combinedNote = [notes.vocabNote, notes.grammarNote].filter(Boolean).join('\n') || undefined;
      const ctx = resolveContextualVisualForCue(`${docTitle} ${s}`, s);
      cards.push({
        id: makeCardId(cards.length),
        type: 'vocab',
        badge: `BÀI ĐỌC #${cards.length}`,
        title: `Câu ${cards.length} · ${docTitle}`,
        content: s,
        translation: combinedNote,
        grammarNote: notes.grammarNote,
        ttsText: cleanSpoken,
        durationSec: estimateCardSpeechDuration(cleanSpoken),
        visual: {
          variant: ctx.matchedRule !== 'fallback' ? ctx.variant : 'css-browser-mockup',
          title: docTitle,
          subtitle: notes.vocabNote || notes.grammarNote || s.slice(0, 64),
          speechText: s,
          sceneIcon: ctx.sceneIcon,
          ...ctx.data,
        },
      });
    }
  }

  // Extract Quiz blocks (capped at 4 high-signal concise questions)
  const hasQuizBlocks = quizSplitIdx >= 0 || mode === 'quiz';

  if (hasQuizBlocks) {
    const quizSource = quizSplitIdx >= 0 ? cleaned.slice(quizSplitIdx) : cleaned;
    const qBlocks = quizSource
      .split(/(?=^(?:Q?\d+[.)]\s+))/gm)
      .map((b) => b.trim())
      .filter(Boolean);

    let quizCount = 0;
    for (const block of qBlocks) {
      if (quizCount >= 4) break;
      const blockLines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (blockLines.length === 0) continue;
      const firstLine = blockLines[0];
      const looksLikeQuizBlock =
        /^Q\d+[.)]\s+/i.test(firstLine) ||
        /\b(?:Answer|Key|Đáp án)[:\s]/i.test(block) ||
        /^(?:\([A-Da-d]\)|[A-Da-d][.)])\s+/m.test(block) ||
        (mode === 'quiz' && /^Q?\d+[.)]\s+/i.test(firstLine));
      if (!looksLikeQuizBlock) continue;

      const question = firstLine.replace(/^Q?\d+[.)]\s*/i, '').trim();
      if (question.length < 5 || isMetadataNoiseLine(question)) continue;

      const opts: string[] = [];
      let answerIndex = 0;
      let explanation = '';
      for (const bl of blockLines.slice(1)) {
        const optMatch = bl.match(/^(?:\(([A-Da-d])\)|([A-Da-d])[.)])\s+(.+)$/);
        if (optMatch) {
          opts.push(optMatch[3].trim());
          continue;
        }
        const ansMatch = bl.match(/^(?:Answer|Key|Đáp án)[:\s]+(.+)$/i);
        if (ansMatch) {
          const val = ansMatch[1].trim();
          const letterIdx = 'abcd'.indexOf(val.charAt(0).toLowerCase());
          if (letterIdx >= 0 && letterIdx < Math.max(2, opts.length || 4)) {
            answerIndex = letterIdx;
          } else if (/^false$/i.test(val)) {
            answerIndex = 1;
          }
          continue;
        }
        if (/^(?:Explanation|Giải thích)[:\s]+/i.test(bl)) {
          explanation = bl.replace(/^(?:Explanation|Giải thích)[:\s]+/i, '').trim();
        }
      }

      if (opts.length === 0 && /true\s*\/\s*false|\(T\/F\)/i.test(block)) {
        opts.push('True', 'False');
      }

      quizCount += 1;
      const finalOpts = opts.length > 0 ? opts : ['True', 'False'];
      const safeAnsIdx = Math.min(answerIndex, Math.max(0, finalOpts.length - 1));
      const letter = String.fromCharCode(65 + safeAnsIdx);
      const optSpoken = finalOpts
        .slice(0, 4)
        .map((o, i) => `${String.fromCharCode(65 + i)}, ${o}`)
        .join('. ');
      const leadIn =
        quizCount === 1
          ? "Now let's test your understanding! ... Question one:"
          : `Question ${quizCount}: ...`;
      const questionSpeech = sanitizeTtsSpeech(
        `${leadIn} ${question} ... ${optSpoken}. Take five seconds to think.`,
      );
      const answerSpeech = sanitizeTtsSpeech(
        `Time is up! The correct answer is ${letter}, ${finalOpts[safeAnsIdx]}.${explanation ? ` ${explanation}` : ''}`,
      );

      const snippetContext =
        fullReadingContext ||
        (readingChunk ? readingChunk.replace(/\n+/g, ' ').slice(0, 420) : undefined);

      cards.push({
        id: makeCardId(cards.length),
        type: 'quiz',
        badge: `QUIZ #${quizCount}`,
        title: `Quiz Question ${quizCount}`,
        content: question,
        contextExcerpt: snippetContext,
        options: finalOpts,
        answerIndex: safeAnsIdx,
        thinkSec: 5,
        explanation: explanation || `Đáp án đúng là ${letter}. ${finalOpts[safeAnsIdx]}`,
        ttsText: questionSpeech,
        ttsAnswerText: answerSpeech,
        durationSec: Number(
          (estimateCardSpeechDuration(questionSpeech) + 5 + estimateCardSpeechDuration(answerSpeech)).toFixed(2),
        ),
        visual: snippetContext
          ? {
              variant: 'css-browser-mockup',
              title: docTitle,
              formula: 'BÀI ĐỌC THAM KHẢO · ĐỐI CHIẾU ĐÁP ÁN',
              speechText: snippetContext,
              sceneIcon: 'book',
            }
          : {
              variant: 'bs-accordion-faq',
              title: 'QUIZ CHALLENGE (5s)',
              speechText: question,
              sceneIcon: 'brain',
            },
      });
    }
  }

  // Fallback sentences if cards still only has intro
  if (cards.length <= 1) {
    const cleanBodyLines = lines
      .filter((l, idx) => !(idx === 0 && l.replace(/^#+\s*/, '').trim().toLowerCase() === docTitle.toLowerCase()))
      .map((l) => l.replace(/^#+\s*/, '').replace(/^\d+[.)]\s*/, '').trim())
      .filter((l) => l.length >= 6 && !isMetadataNoiseLine(l));
    const sentences = cleanBodyLines
      .join(' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 8 && !isMetadataNoiseLine(s));

    for (const s of sentences.slice(0, 10)) {
      const cleanSpoken = sanitizeTtsSpeech(s);
      if (!cleanSpoken) continue;
      const notes = extractVocabAndGrammarNote(s, options?.targetLang);
      const combinedNote = [notes.vocabNote, notes.grammarNote].filter(Boolean).join('\n') || undefined;
      cards.push({
        id: makeCardId(cards.length),
        type: 'vocab',
        badge: `BÀI ĐỌC #${cards.length}`,
        title: `Câu ${cards.length} · ${docTitle}`,
        content: s,
        translation: combinedNote,
        grammarNote: notes.grammarNote,
        ttsText: cleanSpoken,
        durationSec: estimateCardSpeechDuration(cleanSpoken),
      });
    }
  }

  const outroSpeech = `Great job! Today you practiced ${spokenTitle}. Review the key vocabulary and practice reading aloud every day. See you in the next lesson!`;
  cards.push({
    id: makeCardId(cards.length),
    type: 'outro',
    badge: 'TỔNG KẾT',
    title: 'Lesson Recap',
    content: `Hoàn thành bài học: ${docTitle}`,
    translation:
      options?.targetLang && options.targetLang !== 'none'
        ? 'Nhớ ôn lại từ mới & cấu trúc ngữ pháp vừa học mỗi ngày nhé!'
        : undefined,
    ttsText: outroSpeech,
    durationSec: estimateCardSpeechDuration(outroSpeech),
    visual: {
      variant: 'css-bento-stats',
      title: 'Speak Fluently!',
      labels: ['Giới thiệu', 'Đọc & Từ vựng', 'Tổng kết'],
      sceneIcon: 'sparkles',
    },
  });

  // Ensure every card has a lively visual config
  const enrichedCards = cards.map((card, idx) => ({
    ...card,
    visual: defaultVisualForCard(card, idx, cards.length),
  }));

  return { title: docTitle, mode, cards: enrichedCards };
}

export function buildEnglishReelsWebAiPrompt(params: {
  sourceText: string;
  sourceUrl?: string;
  title?: string;
  mode: ReelMode;
  targetLang: string;
  style?: PromptVideoStyle;
  compositionId?: LayoutCompositionId | 'ai-decide';
}): string {
  const targetLanguageLabel =
    params.targetLang === 'none'
      ? 'Không cần dịch thêm nếu nguồn đã đủ nghĩa'
      : params.targetLang || 'Tiếng Việt';

  const modeInstruction =
    params.mode === 'auto'
      ? 'Tự động nhận diện dạng bài phù hợp nhất trong 3 dạng: "reading", "quiz", hoặc "vocab" (nếu bài có cả đoạn đọc + câu hỏi quiz thì giữ ĐẦY ĐỦ cả phần đọc lẫn phần quiz 5s!).'
      : `Bắt buộc xử lý theo dạng bài: "${params.mode}".`;

  const { variantsListText, sceneIconsListText } = getCatalogSummaryForPrompt();

  const exampleTimelinePromptHint =
    params.compositionId && params.compositionId !== 'ai-decide'
      ? `Ưu tiên bố cục "${params.compositionId}" nhưng VẪN giữ đầy đủ các thẻ UI minh họa & Quiz 5s cho từng card.`
      : 'Chọn component minh họa (`visual.variant` + tùy biến `title`, `subtitle`, `labels`, `value`, `sceneIcon`) khớp từng đoạn bài học.';

  return [
    '# VAI TRÒ',
    'Bạn là giáo viên tiếng Anh bản ngữ & đạo diễn kịch bản video bài giảng dọc 9:16 (TikTok / Reels / Shorts), tương thích chuẩn JSON cố định của English Reels Studio + KineticSub Studio.',
    '',
    '# CẤU TRÚC BÀI GIẢNG BẮT BUỘC (KHÔNG ĐƯỢC CHỈ XUẤT SUBTITLE TRƠN)',
    'Video bài học PHẢI sinh động, có lộ trình rõ ràng gồm 4 phần:',
    '1. **Mở đầu (`type: "intro"`)**: Giới thiệu rõ **Hôm nay học gì, mục tiêu bài học** (VD: "Welcome to today\'s lesson on ..."). Chọn `visual.variant: "bs-card-header"` hoặc `"css-roadmap-steps"`.',
    '2. **Nội dung bài đọc / Từ vựng (`type: "vocab"`)**:',
    '   - **KHÔNG** nhồi nhét phiên âm `/IPA/` rườm rà trừ khi thật sự cần cho từ cực khó.',
    '   - Thay vào đó, ở trường `"translation"`, hãy **dịch nghĩa các từ khó trong câu** (VD: `Từ khó: comfortable (thoải mái) · prize (giải thưởng)`) và **giải thích ngắn gọn ngữ pháp / cách dùng** (VD: `Ngữ pháp: be going to + V = dự định tương lai`).',
    '3. **Thử thách Quiz tương tác (`type: "quiz"`)**:',
    '   - Giữ số câu hỏi vừa phải (**tối đa 2–4 câu** chất lượng cao, KHÔNG nhồi quá nhiều).',
    '   - **QUAN TRỌNG**: Nếu Quiz hỏi về bài đọc trước đó, điền đoạn văn tham khảo đầy đủ vào trường `"contextExcerpt"` của thẻ Quiz để người xem ĐỌC ĐƯỢC NGUYÊN ĐOẠN VĂN trên màn hình trong lúc suy nghĩ!',
    '   - Lời đọc `"ttsText"` PHẢI có **lời dẫn mở Quiz + khoảng nghỉ** trước khi đọc câu hỏi (VD: `"Now let\'s test your understanding! ... Question one: ..."`), rồi đọc các phương án A, B..., cuối cùng nói `"Take five seconds to think."`.',
    '   - Đặt `"thinkSec": 5` để hệ thống đếm ngược 5s im lặng trước khi đọc `"ttsAnswerText"` công bố đáp án.',
    '4. **Tổng kết (`type: "outro"`)**: Bắt buộc có lời đọc `"ttsText"` tổng kết bài học qua component `"css-bento-stats"` hoặc `"bs-list-group"`.',
    '',
    '# TÙY BIẾN UI COMPONENT & TỰ VẼ SÁNG TẠO (BOOTSTRAP 5 / MODERN CSS + `customPrimitives`)',
    'Trên MỖI thẻ trong `cards`, hãy điền object `"visual"` để chọn & **tùy biến trực tiếp nội dung/nhãn** trên 50+ UI component Bootstrap 5 / Modern CSS / Vector sẵn có trong hệ thống:',
    variantsListText,
    `- Icon hợp lệ cho \`visual.sceneIcon\`: ${sceneIconsListText}`,
    '- **Cách 1 — Tùy biến tham số trên component sẵn có**: Đặt `"variant"` đúng mã ở trên (VD `"bs-card-header"`, `"css-sticky-note"`, `"bs-badge-cluster"`, `"css-magnifying-word"`, `"bs-modal-quiz"`, `"css-flashcard-flip"`, `"css-grammar-equation"`, `"bs-alert-tip"`, `"bs-pricing-tier"`, `"css-bento-stats"`, `"hotel-desk"`...) kèm `"title"`, `"subtitle"`, `"labels"` (mảng 2–4 nhãn ngắn), `"value"` (0..1), `"formula"`, `"highlightWord"`, `"sceneIcon"`.',
    '- **Cách 2 — Tự thiết kế component UI mới hoàn toàn qua `visual.customPrimitives[]`**:',
    '  + Hệ tọa độ quanh tâm `(0, 0)`, vùng an toàn `x: -380..380`, `y: -145..145`.',
    '  + Các hình hỗ trợ: `rect`, `pill`, `circle`, `ellipse`, `line`/`arrow`, `polygon`, `icon`, `text`.',
    '',
    '# LUẬT KHÔNG ĐỤNG HÀNG (ĐA DẠNG COMPONENT)',
    '- **KHÔNG lặp lại `visual.variant`** trên 2 thẻ liên tiếp trong cùng 1 video.',
    '- Khi thẻ Quiz có `contextExcerpt`, ưu tiên `"variant": "css-browser-mockup"` với `speechText` chứa đoạn văn ngữ cảnh.',
    '',
    '# NHIỆM VỤ XỬ LÝ NGUỒN DỮ LIỆU',
    params.sourceUrl ? `- URL nguồn: ${params.sourceUrl}` : '',
    params.title ? `- Tiêu đề gợi ý: ${params.title}` : '',
    '1. Lọc bỏ hoàn toàn tiêu đề khung bài tập/worksheet (VD: `"## Practice Reading English Exercises for Beginner – Plans"`, `"English Reading Exercises for Beginner"`, `"## Exercise 1"`, `"Part 1"`, menu web, markdown). Không bao giờ đưa chúng vào `cards` hay `ttsText`!',
    `2. ${modeInstruction}`,
    `3. Điền đầy đủ giải thích từ vựng/ngữ pháp ở "translation" và "explanation" bằng: ${targetLanguageLabel}.`,
    `4. ${exampleTimelinePromptHint}`,
    '',
    '# QUY TẮC VÀNG CHO GIỌNG ĐỌC TTS ("ttsText" & "ttsAnswerText")',
    '- "ttsText" và "ttsAnswerText" PHẢI là 100% tiếng Anh tự nhiên để máy đọc thành giọng giáo viên.',
    '- TUYỆT ĐỐI KHÔNG đưa ký tự `&` (viết thành `and`), IPA `/.../`, emoji, URL, hay ký hiệu markdown vào `ttsText` / `ttsAnswerText`.',
    '- Riêng thẻ `quiz`: `"ttsText"` bắt đầu bằng lời dẫn Quiz (`"Now let\'s test your understanding! ... Question 1: ..."`), rồi đọc lựa chọn + `"Take five seconds to think."`.',
    '',
    '# ĐỊNH DẠNG JSON CỐ ĐỊNH BẮT BUỘC TRẢ VỀ (CHỈ OUTPUT ĐÚNG 1 OBJECT JSON HỢP LỆ)',
    '```json',
    '{',
    '  "title": "Outside the Comfort Zone",',
    '  "mode": "reading | quiz | vocab",',
    '  "cards": [',
    '    {',
    '      "type": "intro",',
    '      "badge": "BÀI HỌC HÔM NAY",',
    '      "title": "Outside the Comfort Zone",',
    '      "content": "Hôm nay học gì? Đọc hiểu về thử thách sinh tồn & cấu trúc be going to",',
    '      "translation": "Lộ trình: 1. Giới thiệu → 2. Đọc & Từ khó → 3. Quiz có đoạn văn đối chiếu",',
    '      "ttsText": "Welcome to today\'s English lesson on Outside the Comfort Zone. Listen to the story, learn useful vocabulary and grammar, then answer a short quiz.",',
    '      "visual": {',
    '        "variant": "bs-card-header",',
    '        "formula": "TODAY LESSON GOAL",',
    '        "title": "Outside the Comfort Zone",',
    '        "subtitle": "1. Giới thiệu bài · 2. Từ khó & Ngữ pháp · 3. Quiz",',
    '        "sceneIcon": "graduation"',
    '      }',
    '    },',
    '    {',
    '      "type": "vocab",',
    '      "badge": "BÀI ĐỌC #1",',
    '      "title": "Mountain Challenge",',
    '      "content": "In this exciting new TV programme, ten people go and live in the mountains for ten days.",',
    '      "translation": "Từ khó: exciting (thú vị) · programme (chương trình)\\nNgữ pháp: Hiện tại đơn kể nội dung phim/TV",',
    '      "ttsText": "In this exciting new TV programme, ten people go and live in the mountains for ten days.",',
    '      "visual": {',
    '        "variant": "css-sticky-note",',
    '        "title": "KEY VOCAB & GRAMMAR",',
    '        "labels": ["exciting = thú vị", "programme = chương trình"],',
    '        "sceneIcon": "book"',
    '      }',
    '    },',
    '    {',
    '      "type": "quiz",',
    '      "badge": "QUIZ #1",',
    '      "title": "Check Understanding",',
    '      "contextExcerpt": "In this exciting new TV programme, ten people go and live in the mountains for ten days. The two people who do the best win a prize of 25,000 pounds.",',
    '      "content": "How long do the ten people live in the mountains?",',
    '      "translation": "10 người sống trên núi trong bao lâu?",',
    '      "options": ["Five days", "Ten days", "Two weeks"],',
    '      "answerIndex": 1,',
    '      "thinkSec": 5,',
    '      "explanation": "Đoạn văn nêu rõ: live in the mountains for ten days.",',
    '      "ttsText": "Now let\'s test your understanding! ... Question one: How long do the ten people live in the mountains? ... A, Five days. B, Ten days. C, Two weeks. Take five seconds to think.",',
    '      "ttsAnswerText": "Time is up! The correct answer is B, Ten days. The text says they live in the mountains for ten days.",',
    '      "visual": {',
    '        "variant": "css-browser-mockup",',
    '        "title": "ĐOẠN VĂN ĐỐI CHIẾU",',
    '        "speechText": "In this exciting new TV programme, ten people go and live in the mountains for ten days.",',
    '        "sceneIcon": "book"',
    '      }',
    '    },',
    '    {',
    '      "type": "outro",',
    '      "badge": "TỔNG KẾT",',
    '      "title": "Key Takeaways",',
    '      "content": "Review vocabulary & practice be going to!",',
    '      "translation": "Ôn lại từ khó & luyện đọc to mỗi ngày nhé!",',
    '      "ttsText": "Great job! Today you practiced Outside the Comfort Zone. Review the new words and keep speaking English every day.",',
    '      "visual": {',
    '        "variant": "css-bento-stats",',
    '        "title": "Lesson Complete!",',
    '        "labels": ["exciting / prize", "be going to + V", "Quiz Ready"],',
    '        "sceneIcon": "sparkles"',
    '      }',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    '# NỘI DUNG GỐC CẦN CHUYỂN HÓA',
    '"""',
    params.sourceText.trim().slice(0, 14000),
    '"""',
  ]
    .filter(Boolean)
    .join('\n');
}

function stripJsonCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) return fenced[1].trim();
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }
  return trimmed;
}

function parseCardVisualConfig(rawVisual: unknown): ReelCardVisualConfig | undefined {
  if (!rawVisual || typeof rawVisual !== 'object') return undefined;
  const v = rawVisual as Record<string, unknown>;
  const variant =
    typeof v.variant === 'string' && isKnownIllustrationVariant(v.variant.trim())
      ? (v.variant.trim() as IllustrationVariant)
      : undefined;

  const labels = Array.isArray(v.labels)
    ? v.labels.map((s) => String(s).trim()).filter(Boolean).slice(0, 4)
    : undefined;

  let customPrimitives: VectorPrimitive[] | undefined;
  if (Array.isArray(v.customPrimitives) && v.customPrimitives.length > 0) {
    const normalized = normalizeCustomComponent({
      variant: variant || 'custom-inline',
      label: String(v.title || 'Custom'),
      primitives: v.customPrimitives,
    });
    if (normalized && normalized.primitives.length > 0) {
      customPrimitives = normalized.primitives;
    }
  }

  const out: ReelCardVisualConfig = {
    variant,
    title: typeof v.title === 'string' && v.title.trim() ? v.title.trim() : undefined,
    subtitle: typeof v.subtitle === 'string' && v.subtitle.trim() ? v.subtitle.trim() : undefined,
    labels: labels && labels.length > 0 ? labels : undefined,
    value: typeof v.value === 'number' && Number.isFinite(v.value) ? Math.max(0, Math.min(1, v.value)) : undefined,
    formula: typeof v.formula === 'string' && v.formula.trim() ? v.formula.trim() : undefined,
    sceneIcon:
      typeof v.sceneIcon === 'string' && v.sceneIcon.trim()
        ? (v.sceneIcon.trim() as IllustrationSceneIcon)
        : undefined,
    speechText: typeof v.speechText === 'string' && v.speechText.trim() ? v.speechText.trim() : undefined,
    customPrimitives,
  };

  if (
    !out.variant &&
    !out.title &&
    !out.subtitle &&
    !out.labels &&
    out.value === undefined &&
    !out.formula &&
    !out.sceneIcon &&
    !out.speechText &&
    !out.customPrimitives
  ) {
    return undefined;
  }
  return out;
}

export function parseEnglishReelsAiJson(rawText: string): ParsedEnglishReelsResponse | null {
  if (!rawText || !rawText.trim()) return null;
  const cleaned = stripJsonCodeFences(rawText);
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(cleaned) as Record<string, unknown>;
  } catch {
    return null;
  }

  // Case 1: Fixed English Reels schema (`cards` array)
  if (Array.isArray(parsed.cards) && parsed.cards.length > 0) {
    const rawMode = String(parsed.mode || 'reading').toLowerCase();
    const mode: Exclude<ReelMode, 'auto'> =
      rawMode === 'quiz' || rawMode === 'vocab' ? rawMode : 'reading';

    const cards: ReelCard[] = [];
    const rawCards = parsed.cards;
    let quizSeq = 0;
    rawCards.forEach((rawCard, idx) => {
      if (!rawCard || typeof rawCard !== 'object') return;
      const c = rawCard as Record<string, unknown>;
      const rawType = String(c.type || '').toLowerCase();
      const type: ReelCardType =
        rawType === 'intro' || rawType === 'quiz' || rawType === 'outro'
          ? rawType
          : mode === 'quiz'
            ? 'quiz'
            : 'vocab';

      const content = String(c.content || c.text || c.title || '').trim();
      const title = String(c.title || content || `Thẻ ${idx + 1}`).trim();
      if (!content && !title) return;
      if (isMetadataNoiseLine(content)) return;

      const contextExcerpt =
        typeof c.contextExcerpt === 'string' && c.contextExcerpt.trim()
          ? c.contextExcerpt.trim()
          : undefined;
      const grammarNote =
        typeof c.grammarNote === 'string' && c.grammarNote.trim()
          ? c.grammarNote.trim()
          : undefined;

      const ttsText =
        sanitizeTtsSpeech(String(c.ttsText || content || title)) ||
        sanitizeTtsSpeech(content || title);
      const options = Array.isArray(c.options)
        ? c.options.map((o) => String(o).trim()).filter(Boolean)
        : undefined;
      const thinkSec =
        type === 'quiz'
          ? typeof c.thinkSec === 'number' && Number.isFinite(c.thinkSec)
            ? Math.max(0, Math.min(10, c.thinkSec))
            : 5
          : undefined;
      const rawAnsText =
        typeof c.ttsAnswerText === 'string' && c.ttsAnswerText.trim()
          ? sanitizeTtsSpeech(c.ttsAnswerText)
          : undefined;

      const cardObj: ReelCard = {
        id: makeCardId(idx),
        type,
        badge: String(c.badge || type.toUpperCase()).trim(),
        title,
        content: content || title,
        phonetic: typeof c.phonetic === 'string' && c.phonetic.trim() ? c.phonetic.trim() : undefined,
        translation:
          typeof c.translation === 'string' && c.translation.trim()
            ? c.translation.trim()
            : grammarNote,
        grammarNote,
        contextExcerpt,
        ttsText,
        ttsAnswerText: rawAnsText,
        thinkSec,
        options: options && options.length > 0 ? options : undefined,
        answerIndex: typeof c.answerIndex === 'number' ? Math.max(0, c.answerIndex) : undefined,
        explanation:
          typeof c.explanation === 'string' && c.explanation.trim()
            ? c.explanation.trim()
            : undefined,
        visual: parseCardVisualConfig(c.visual),
      };

      if (cardObj.type === 'quiz') quizSeq += 1;
      const quizParts = getQuizCardSpeechParts(cardObj, quizSeq || 1);
      if (cardObj.type === 'quiz' && cardObj.options?.length) {
        cardObj.ttsText = quizParts.questionSpeech || cardObj.ttsText;
        cardObj.ttsAnswerText = quizParts.answerSpeech || cardObj.ttsAnswerText;
        cardObj.durationSec = Number(
          (
            estimateCardSpeechDuration(quizParts.questionSpeech) +
            quizParts.thinkSec +
            (quizParts.answerSpeech ? estimateCardSpeechDuration(quizParts.answerSpeech) : 0)
          ).toFixed(2),
        );
      } else {
        cardObj.durationSec = estimateCardSpeechDuration(ttsText);
      }
      cardObj.visual = defaultVisualForCard(cardObj, idx, rawCards.length);
      cards.push(cardObj);
    });

    if (cards.length === 0) return null;

    let sceneJson: FlexibleSceneDocument | null = null;
    if (parsed.sceneJson && typeof parsed.sceneJson === 'object') {
      sceneJson = parseScenePlanJson(JSON.stringify(parsed.sceneJson));
    }

    return {
      title: String(parsed.title || cards[0]?.title || 'English Reels Project').trim(),
      mode,
      cards,
      sceneJson,
    };
  }

  // Case 2: KineticSub direct ScenePlan JSON pasted here
  const scenePlan = parseScenePlanJson(cleaned);
  if (scenePlan && scenePlan.scenes.length > 0) {
    const cards: ReelCard[] = [];
    for (const sc of scenePlan.scenes) {
      for (const el of sc.elements || []) {
        if (el.text && (el.type === 'sentence_card' || el.type === 'sentence-card' || el.type === 'topic_pill')) {
          cards.push({
            id: makeCardId(cards.length),
            type: cards.length === 0 ? 'intro' : 'vocab',
            badge: String(el.type || 'CARD').toUpperCase(),
            title: el.text,
            content: el.text,
            translation: el.subtext || undefined,
            ttsText: el.text,
            durationSec: estimateCardSpeechDuration(el.text),
          });
        }
      }
    }
    if (cards.length > 0) {
      return {
        title: scenePlan.title || 'KineticSub Imported Lesson',
        mode: 'reading',
        cards,
        sceneJson: scenePlan,
      };
    }
  }

  return null;
}

function resolveVisualPayloadForReelCard(
  card: ReelCard,
  idx: number,
  total: number,
  compositionId?: LayoutCompositionId,
): { variant: IllustrationVariant; data: IllustrationPropData } {
  const fallback = defaultVisualForCard(card, idx, total);
  const custom = card.visual;
  const ctxFallback = resolveContextualVisualForCue(
    `${card.title} ${card.content} ${card.translation || ''}`,
    card.title,
  );

  // Respect explicit card custom visual first, else composition signature when no explicit variant chosen
  let chosenVariant: IllustrationVariant =
    custom?.variant || fallback.variant || ctxFallback.variant || 'bs-card-header';

  if (!custom?.variant && card.type === 'vocab' && compositionId) {
    if (compositionId === 'flow-steps') chosenVariant = 'flow-diagram';
    else if (compositionId === 'gauge-tone') chosenVariant = 'gauge-arc';
    else if (compositionId === 'checklist-cards') chosenVariant = 'checklist-card';
    else if (compositionId === 'dialogue-upgrade') chosenVariant = 'dialogue-upgrade';
    else if (compositionId === 'timeline-track') chosenVariant = 'timeline-track';
    else if (compositionId === 'spatial-contrast') chosenVariant = 'spatial-boxes';
    else if (compositionId === 'avatar-dialogue') chosenVariant = 'avatar-speech';
    else if (compositionId === 'clock-spotlight') chosenVariant = 'clock-face';
    else if (compositionId === 'phrase-icon-split') chosenVariant = 'phrase-icon-split';
  }

  const data: IllustrationPropData = {
    ...ctxFallback.data,
    title: custom?.title || fallback.title || card.title,
    subtitle:
      custom?.subtitle ||
      fallback.subtitle ||
      [card.phonetic, card.translation].filter(Boolean).join(' · ') ||
      card.content,
    labels: custom?.labels || fallback.labels,
    value: custom?.value ?? fallback.value,
    formula: custom?.formula || fallback.formula,
    speechText: custom?.speechText || fallback.speechText || card.content,
    sceneIcon: custom?.sceneIcon || fallback.sceneIcon || ctxFallback.sceneIcon,
    customPrimitives: custom?.customPrimitives,
  };

  return { variant: chosenVariant, data };
}

export function reelCardsToLessonProject(
  cards: ReelCard[],
  options?: {
    title?: string;
    subtitle?: string;
    theme?: CanvasThemeId;
    compositionId?: LayoutCompositionId;
    cardDurationsSec?: number[];
    cardTimings?: ReelCardTimingMeta[];
    audioFileName?: string;
    sceneJsonOverride?: FlexibleSceneDocument | null;
    watermark?: WatermarkOutroConfig;
  },
): LessonProject {
  const safeCards =
    cards.length > 0 ? cards : buildReelCardsRuleBased('Practice English daily.').cards;
  const cues: TranscriptCue[] = [];
  const cardWindows: Array<{
    start: number;
    end: number;
    questionEnd: number;
    thinkStart: number;
    thinkEnd: number;
    answerStart: number;
    thinkSec: number;
    questionCue: TranscriptCue;
    answerCue?: TranscriptCue;
  }> = [];

  let cursor = 0;
  let quizOrderCounter = 0;

  safeCards.forEach((card, idx) => {
    const start = Number(cursor.toFixed(3));
    const timingOverride = options?.cardTimings?.[idx];
    const durOverride = options?.cardDurationsSec?.[idx];

    if (card.type === 'quiz' && card.options && card.options.length > 0) {
      quizOrderCounter += 1;
      const { questionSpeech, answerSpeech, thinkSec: baseThink } = getQuizCardSpeechParts(
        card,
        quizOrderCounter,
      );
      const qSpeech = questionSpeech || sanitizeTtsSpeech(card.content || card.title) || 'Quiz question.';
      const thinkSec = timingOverride?.thinkSec ?? baseThink;

      let qDur = timingOverride?.questionSec ?? estimateCardSpeechDuration(qSpeech);
      let aDur =
        timingOverride?.answerSec ??
        (answerSpeech ? estimateCardSpeechDuration(answerSpeech) : 2.6);

      if (!timingOverride && typeof durOverride === 'number' && Number.isFinite(durOverride) && durOverride > 1) {
        // Scale question/answer around exact thinkSec if single total duration supplied
        const remaining = Math.max(2.2, durOverride - Math.min(thinkSec, Math.max(0, durOverride - 2.2)));
        const qShare = qDur / Math.max(0.5, qDur + aDur);
        qDur = Number((remaining * qShare).toFixed(3));
        aDur = Number((remaining - qDur).toFixed(3));
      }

      const questionEnd = Number((start + qDur).toFixed(3));
      const thinkStart = questionEnd;
      const thinkEnd = Number((thinkStart + thinkSec).toFixed(3));
      const answerStart = thinkEnd;
      const end = Number((answerStart + aDur).toFixed(3));

      const questionCue: TranscriptCue = {
        id: `${card.id || `reel-cue-${idx + 1}`}-q`,
        start,
        end: questionEnd,
        text: qSpeech,
        words: interpolateWordTimings(qSpeech, start, questionEnd),
      };
      cues.push(questionCue);

      let answerCue: TranscriptCue | undefined;
      if (answerSpeech) {
        answerCue = {
          id: `${card.id || `reel-cue-${idx + 1}`}-a`,
          start: answerStart,
          end,
          text: answerSpeech,
          words: interpolateWordTimings(answerSpeech, answerStart, end),
        };
        cues.push(answerCue);
      }

      cardWindows.push({
        start,
        end,
        questionEnd,
        thinkStart,
        thinkEnd,
        answerStart,
        thinkSec,
        questionCue,
        answerCue,
      });
      cursor = end + 0.08;
    } else {
      const speech = (card.ttsText || card.content || card.title || 'Next').trim();
      const dur =
        timingOverride?.totalSec ??
        (typeof durOverride === 'number' && Number.isFinite(durOverride) && durOverride > 0.25
          ? durOverride
          : card.durationSec && card.durationSec > 0.5
            ? card.durationSec
            : estimateCardSpeechDuration(speech));

      const end = Number((start + dur).toFixed(3));
      const cue: TranscriptCue = {
        id: card.id || `reel-cue-${idx + 1}`,
        start,
        end,
        text: speech,
        words: interpolateWordTimings(speech, start, end),
      };
      cues.push(cue);
      cardWindows.push({
        start,
        end,
        questionEnd: end,
        thinkStart: end,
        thinkEnd: end,
        answerStart: end,
        thinkSec: 0,
        questionCue: cue,
      });
      cursor = end + 0.08;
    }
  });

  const baseTotalDuration = Number(Math.max(3, cursor).toFixed(2));
  const hasActiveOutro = Boolean(
    options?.watermark &&
      options.watermark.outroSeconds > 0 &&
      (options.watermark.outroLine1.trim() || options.watermark.outroLine2.trim()),
  );
  const outroExtraSec = hasActiveOutro ? Math.max(0, Number(options?.watermark?.outroSeconds || 0)) : 0;
  const totalDuration = Number((baseTotalDuration + outroExtraSec).toFixed(2));
  const theme: CanvasThemeId = options?.theme ?? 'pastel-sunrise';
  const isDark = isDarkCanvasTheme(theme);

  if (options?.sceneJsonOverride && !options.compositionId) {
    const words = cues.flatMap((c) => c.words);
    const built = scenePlanToProject(words, options.sceneJsonOverride, {
      title: options.title || options.sceneJsonOverride.title || 'English Reels Studio',
      theme,
      audioFileName: options.audioFileName,
      cuesOverride: cues,
    });
    return {
      ...built,
      duration: Number((built.duration + outroExtraSec).toFixed(2)),
      watermark: options?.watermark,
    };
  }

  const hasQuiz = safeCards.some((c) => c.type === 'quiz');
  const stageSteps = hasQuiz
    ? ['1. Mở bài', '2. Đọc & Từ', '3. Quiz 5s', '4. Tổng kết']
    : ['1. Giới thiệu', '2. Bài học', '3. Tổng kết'];

  const elements: LessonProject['elements'] = [];

  safeCards.forEach((card, idx) => {
    const win = cardWindows[idx];
    const { start, end } = win;
    const visualSpec = resolveVisualPayloadForReelCard(
      card,
      idx,
      safeCards.length,
      options?.compositionId,
    );

    const activeStepIdx =
      card.type === 'intro'
        ? 0
        : card.type === 'outro'
          ? stageSteps.length - 1
          : card.type === 'quiz' && hasQuiz
            ? 2
            : 1;

    // ── QUIZ CARD WITH 3-PHASE INTERACTIVE CHOREOGRAPHY ───────────────────────
    if (card.type === 'quiz' && card.options && card.options.length > 0) {
      const safeAnsIdx = Math.min(card.answerIndex ?? 0, card.options.length - 1);
      const ansLetter = String.fromCharCode(65 + safeAnsIdx);
      const ansOpt = card.options[safeAnsIdx];

      // Top Lesson Roadmap Strip (Quiz Step Highlighted)
      elements.push({
        id: `reel-stage-${idx}`,
        type: 'comparison-strip',
        label: `Lộ trình #${idx + 1}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'fade-scale',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: 170, width: 920, scale: 1, zIndex: 12 },
        props: {
          kind: 'comparison-strip',
          items: stageSteps.map((sLbl, sIdx) => ({
            label: sLbl,
            activateAt: sIdx === activeStepIdx ? start : end + 9,
            accentColor: '#D97706',
          })),
        },
      });

      // Phase 1 Pill: Question asking
      if (win.questionEnd - start > 0.15) {
        elements.push({
          id: `reel-q-pill-ask-${idx}`,
          type: 'topic-pill',
          label: `Quiz Hỏi #${idx + 1}`,
          startTime: start,
          endTime: win.questionEnd,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 295, width: 520, scale: 1, zIndex: 16 },
          props: {
            kind: 'topic-pill',
            text: `${card.badge || 'QUIZ'} · ĐỌC CÂU HỎI`,
            bgColor: '#FEF3C7',
            textColor: '#B45309',
          },
        });
      }

      const hasContextExcerpt = Boolean(card.contextExcerpt?.trim());

      // Phase 2 Countdown Pills (5s -> 4s -> 3s -> 2s -> 1s) + Animated Progress Bar (skip large meter if passage context card is shown)
      if (win.thinkSec >= 1) {
        const wholeSecs = Math.max(1, Math.round(win.thinkSec));
        const sliceDur = (win.thinkEnd - win.thinkStart) / wholeSecs;
        for (let s = 0; s < wholeSecs; s++) {
          const remain = wholeSecs - s;
          const t0 = Number((win.thinkStart + s * sliceDur).toFixed(3));
          const t1 = Number((win.thinkStart + (s + 1) * sliceDur).toFixed(3));
          if (t1 - t0 <= 0.08) continue;

          elements.push({
            id: `reel-q-countdown-pill-${idx}-${s}`,
            type: 'topic-pill',
            label: `Đếm ngược ${remain}s`,
            startTime: t0,
            endTime: t1,
            enterAnimation: 'pop-up',
            exitAnimation: 'fade-out',
            layout: { x: 540, y: 295, width: 540, scale: 1, zIndex: 18 },
            props: {
              kind: 'topic-pill',
              text: `⏱️ SUY NGHĨ: ${remain} GIÂY`,
              bgColor: remain <= 2 ? '#FEE2E2' : '#FEF3C7',
              textColor: remain <= 2 ? '#B91C1C' : '#B45309',
            },
          });

          elements.push({
            id: `reel-q-countdown-meter-${idx}-${s}`,
            type: 'illustration-prop',
            label: `Thanh đếm ${remain}s`,
            startTime: t0,
            endTime: t1,
            enterAnimation: 'fade-scale',
            exitAnimation: 'fade-out',
            layout: {
              x: 540,
              y: hasContextExcerpt ? 1275 : 500,
              width: hasContextExcerpt ? 760 : 840,
              scale: hasContextExcerpt ? 0.72 : 0.94,
              zIndex: 10,
            },
            props: {
              kind: 'illustration-prop',
              variant: 'bs-progress-meter',
              data: {
                title: `CHỌN ĐÁP ÁN TRONG ${remain}s`,
                subtitle: 'Hãy tự chọn đáp án trước khi hết giờ!',
                value: Number(((s + 1) / wholeSecs).toFixed(2)),
                sceneIcon: 'clock',
              },
            },
          });
        }
      }

      // Phase 3 Pill: Answer Reveal!
      if (end - win.answerStart > 0.15) {
        elements.push({
          id: `reel-q-pill-ans-${idx}`,
          type: 'topic-pill',
          label: `Đáp án #${idx + 1}`,
          startTime: win.answerStart,
          endTime: end,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 295, width: 580, scale: 1, zIndex: 18 },
          props: {
            kind: 'topic-pill',
            text: `✓ ĐÁP ÁN ĐÚNG: ${ansLetter}. ${ansOpt.slice(0, 20)}`,
            bgColor: '#DCFCE7',
            textColor: '#15803D',
          },
        });

        elements.push({
          id: `reel-q-ans-prop-${idx}`,
          type: 'illustration-prop',
          label: `Minh họa Đáp án #${idx + 1}`,
          startTime: win.answerStart,
          endTime: end,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 500, width: 840, scale: 0.94, zIndex: 11 },
          props: {
            kind: 'illustration-prop',
            variant: 'bs-alert-tip',
            data: {
              title: `Correct Answer: ${ansLetter}. ${ansOpt}`,
              speechText: card.explanation || 'Great catch!',
              sceneIcon: 'sparkles',
            },
          },
        });
      }

      // Passage Context Card (kept visible throughout Question + Think countdown when Quiz refers to reading text!)
      if (card.contextExcerpt?.trim()) {
        const preRevealEnd = Math.max(start + 0.1, win.answerStart);
        elements.push({
          id: `reel-q-context-${idx}`,
          type: 'illustration-prop',
          label: `Đoạn văn đối chiếu Quiz #${idx + 1}`,
          startTime: start,
          endTime: preRevealEnd,
          enterAnimation: 'fade-scale',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 525, width: 880, scale: 0.86, zIndex: 9 },
          props: {
            kind: 'illustration-prop',
            variant: 'css-browser-mockup',
            data: {
              title: options?.title || 'ĐOẠN VĂN BÀI ĐỌC',
              formula: 'ĐỌC KỸ ĐOẠN VĂN ĐỂ CHỌN ĐÁP ÁN',
              speechText: card.contextExcerpt.trim(),
              sceneIcon: 'book',
            },
          },
        });
      } else if (win.questionEnd - start > 0.15) {
        elements.push({
          id: `reel-q-ask-prop-${idx}`,
          type: 'illustration-prop',
          label: `Minh họa Quiz #${idx + 1}`,
          startTime: start,
          endTime: win.questionEnd,
          enterAnimation: 'fade-scale',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 500, width: 840, scale: 0.94, zIndex: 9 },
          props: {
            kind: 'illustration-prop',
            variant: visualSpec.variant,
            data: visualSpec.data,
          },
        });
      }

      // Question Sentence Card (stays before answer, then switches to Answer + Explanation card!)
      const preRevealEnd = Math.max(start + 0.1, win.answerStart);
      if (preRevealEnd - start > 0.1) {
        elements.push({
          id: `reel-qcard-pre-${idx}`,
          type: 'sentence-card',
          label: `Câu hỏi #${idx + 1}`,
          startTime: start,
          endTime: preRevealEnd,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: hasContextExcerpt ? 840 : 830, width: 880, scale: hasContextExcerpt ? 0.94 : 1, zIndex: 20 },
          props: {
            kind: 'sentence-card',
            text: card.content,
            subtext: card.translation || 'Lắng nghe và chọn phương án đúng!',
            badge: 'question',
            emphasisColor: '#D97706',
            bgColor: isDark ? 'rgba(15, 23, 42, 0.94)' : '#FFFFFF',
            textColor: isDark ? '#F8FAFC' : '#0F172A',
          },
        });
      }

      if (end - win.answerStart > 0.1) {
        elements.push({
          id: `reel-qcard-post-${idx}`,
          type: 'sentence-card',
          label: `Giải thích Quiz #${idx + 1}`,
          startTime: win.answerStart,
          endTime: end,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 830, width: 880, scale: 1, zIndex: 22 },
          props: {
            kind: 'sentence-card',
            text: `${ansLetter}. ${ansOpt}`,
            subtext: card.explanation || card.translation || card.content,
            badge: 'check',
            stampText: 'CORRECT!',
            stampColor: '#16A34A',
            emphasisColor: '#16A34A',
            bgColor: isDark ? 'rgba(6, 78, 59, 0.94)' : '#ECFDF5',
            textColor: isDark ? '#ECFDF5' : '#064E3B',
          },
        });
      }

      // Options Strip: stays across whole quiz card and highlights correct option AT win.answerStart!
      elements.push({
        id: `reel-quiz-opts-${idx}`,
        type: 'comparison-strip',
        label: `Phương án Quiz #${idx + 1}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'slide-up',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: hasContextExcerpt ? 1055 : 1185, width: 920, scale: hasContextExcerpt ? 0.92 : 1, zIndex: 20 },
        props: {
          kind: 'comparison-strip',
          items: card.options.slice(0, 4).map((opt, oIdx) => ({
            label: `${String.fromCharCode(65 + oIdx)}. ${opt.slice(0, 22)}`,
            sublabel: oIdx === safeAnsIdx ? 'Đáp án đúng' : undefined,
            activateAt: oIdx === safeAnsIdx ? win.answerStart : end + 9,
            accentColor: oIdx === safeAnsIdx ? '#16A34A' : '#64748B',
          })),
        },
      });

      // Bottom Karaoke Subtitles: Phase 1 (Question) + Phase 3 (Answer Explanation)
      elements.push({
        id: `reel-karaoke-q-${idx}`,
        type: 'karaoke-card',
        label: `Sub Câu hỏi #${idx + 1}`,
        startTime: start,
        endTime: Math.max(win.thinkEnd, win.questionEnd),
        enterAnimation: 'slide-up',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: 1585, width: 900, scale: 1, zIndex: 35 },
        props: {
          kind: 'karaoke-card',
          cueId: win.questionCue.id,
          words: win.questionCue.words,
          variant: isDark ? 'dark-bar' : 'white-card',
          activeColor: isDark ? '#FACC15' : '#D97706',
          inactiveColor: isDark ? '#CBD5E1' : '#9CA3AF',
          spokenColor: isDark ? '#FFFFFF' : '#111827',
        },
      });

      if (win.answerCue && end - win.answerStart > 0.1) {
        elements.push({
          id: `reel-karaoke-a-${idx}`,
          type: 'karaoke-card',
          label: `Sub Đáp án #${idx + 1}`,
          startTime: win.answerStart,
          endTime: end,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 1585, width: 900, scale: 1, zIndex: 36 },
          props: {
            kind: 'karaoke-card',
            cueId: win.answerCue.id,
            words: win.answerCue.words,
            variant: isDark ? 'dark-bar' : 'white-card',
            activeColor: '#16A34A',
            inactiveColor: isDark ? '#CBD5E1' : '#9CA3AF',
            spokenColor: isDark ? '#FFFFFF' : '#064E3B',
          },
        });
      }
      return;
    }

    // ── INTRO / READING / VOCAB / OUTRO LESSON SLIDE ──────────────────────────
    elements.push({
      id: `reel-stage-${idx}`,
      type: 'comparison-strip',
      label: `Lộ trình #${idx + 1}`,
      startTime: start,
      endTime: end,
      enterAnimation: 'fade-scale',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 170, width: 920, scale: 1, zIndex: 12 },
      props: {
        kind: 'comparison-strip',
        items: stageSteps.map((sLbl, sIdx) => ({
          label: sLbl,
          activateAt: sIdx === activeStepIdx ? start : end + 9,
          accentColor:
            card.type === 'intro' ? '#4F46E5' : card.type === 'outro' ? '#16A34A' : '#2563EB',
        })),
      },
    });

    elements.push({
      id: `reel-pill-${idx}`,
      type: 'topic-pill',
      label: `Nhãn: ${card.badge || card.type}`,
      startTime: start,
      endTime: end,
      enterAnimation: 'pop-up',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 295, width: 480, scale: 1, zIndex: 14 },
      props: {
        kind: 'topic-pill',
        text: card.badge || card.type.toUpperCase(),
        bgColor:
          card.type === 'intro'
            ? '#E0E7FF'
            : card.type === 'outro'
              ? '#DCFCE7'
              : '#DBEAFE',
        textColor:
          card.type === 'intro'
            ? '#3730A3'
            : card.type === 'outro'
              ? '#15803D'
              : '#1D4ED8',
      },
    });

    elements.push({
      id: `reel-prop-${idx}`,
      type: 'illustration-prop',
      label: `UI Minh họa #${idx + 1}`,
      startTime: start,
      endTime: end,
      enterAnimation: 'fade-scale',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 545, width: 860, scale: 0.96, zIndex: 10 },
      props: {
        kind: 'illustration-prop',
        variant: visualSpec.variant,
        data: visualSpec.data,
      },
    });

    const displayHeadline =
      card.type === 'vocab' && card.title && card.title !== card.content && !card.title.startsWith('Reading Point') && !card.title.startsWith('Lesson Point')
        ? `${card.title}${card.phonetic ? ` ${card.phonetic}` : ''}`
        : card.content;
    const displaySub =
      card.type === 'vocab' && card.title && card.title !== card.content && !card.title.startsWith('Reading Point') && !card.title.startsWith('Lesson Point')
        ? `${card.content}${card.translation ? ` — ${card.translation}` : ''}`
        : [card.phonetic, card.translation].filter(Boolean).join(' · ') || undefined;

    elements.push({
      id: `reel-card-${idx}`,
      type: 'sentence-card',
      label: `Thẻ #${idx + 1}: ${card.title.slice(0, 28)}`,
      startTime: start,
      endTime: end,
      enterAnimation: 'pop-up',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 975, width: 880, scale: 1, zIndex: 20 },
      props: {
        kind: 'sentence-card',
        text: displayHeadline,
        subtext: displaySub,
        badge: card.type === 'outro' ? 'check' : 'none',
        emphasisWord: card.type === 'vocab' && !card.title.startsWith('Reading') ? card.title : undefined,
        emphasisColor: card.type === 'outro' ? '#16A34A' : '#2563EB',
        bgColor: isDark ? 'rgba(15, 23, 42, 0.94)' : '#FFFFFF',
        textColor: isDark ? '#F8FAFC' : '#0F172A',
      },
    });

    elements.push({
      id: `reel-karaoke-${idx}`,
      type: 'karaoke-card',
      label: `Sub Karaoke #${idx + 1}`,
      startTime: start,
      endTime: end,
      enterAnimation: 'slide-up',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 1585, width: 900, scale: 1, zIndex: 35 },
      props: {
        kind: 'karaoke-card',
        cueId: win.questionCue.id,
        words: win.questionCue.words,
        variant: isDark ? 'dark-bar' : 'white-card',
        activeColor: isDark ? '#FACC15' : '#2563EB',
        inactiveColor: isDark ? '#CBD5E1' : '#9CA3AF',
        spokenColor: isDark ? '#FFFFFF' : '#111827',
      },
    });
  });

  const resolvedElements = resolveProjectOverlaps(elements);

  return {
    id: `reels-${Date.now().toString(36)}`,
    title: options?.title || safeCards[0]?.title || 'English Reels Studio Video',
    subtitle: options?.subtitle || 'English Reels Studio × KineticSub 9:16',
    theme,
    compositionId: options?.compositionId || 'story-scenes',
    duration: totalDuration,
    fps: 30,
    audioFileName: options?.audioFileName,
    cues,
    elements: resolvedElements,
    watermark: options?.watermark,
  };
}

export function buildReelPromptBundleForSubtitles(
  cues: TranscriptCue[],
  title: string,
  style: PromptVideoStyle = 'tiktok-cards',
): string {
  return buildSceneGenerationPrompt(cues, { title, style });
}
