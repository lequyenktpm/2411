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
  BackgroundImageConfig,
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
  highlightWord?: string;
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

export interface ReelLocaleStrings {
  code: 'vi' | 'en' | 'ja' | 'none';
  targetLanguageLabel: string;
  stageStepsQuiz: [string, string, string, string];
  stageStepsSimple: [string, string, string];
  roadmapLabel: string;
  introBadgeQuiz: string;
  introBadgeVocab: string;
  introBadgeDefault: string;
  introGoalPrefix: string;
  introRoadmapLine: string;
  introVisualSubtitle: string;
  readingBadgePrefix: string;
  vocabBadgePrefix: string;
  sentenceTitlePrefix: string;
  outroBadge: string;
  outroTitle: string;
  outroContentPrefix: string;
  outroTranslation: string;
  outroLabels: [string, string, string];
  quizAskTag: string;
  thinkCountdown: (sec: number) => string;
  chooseAnswerTitle: (sec: number) => string;
  chooseAnswerSubtitle: string;
  correctAnswerPill: (letter: string, opt: string) => string;
  correctAnswerCardTitle: (letter: string, opt: string) => string;
  correctBadge: string;
  correctStamp: string;
  correctOptionSublabel: string;
  contextPassageTitle: string;
  contextPassageUrl: string;
  listenChooseSubtext: string;
  defaultExplanation: (letter: string, opt: string) => string;
  lessonOverviewFormula: string;
  vocabPrefix: string;
  grammarPrefix: string;
  promptExampleBadge: string;
  promptExampleIntroContent: string;
  promptExampleTranslation: string;
  promptExampleVocabTranslation: string;
  promptExampleContextTitle: string;
  promptExampleExplanation: string;
  promptExampleOutroContent: string;
  promptExampleOutroTranslation: string;
  promptExampleOutroLabels: [string, string, string];
  promptExampleStickyLabels: [string, string];
}

export function getReelLocaleStrings(targetLang?: string): ReelLocaleStrings {
  const norm = (targetLang || 'Tiếng Việt').trim().toLowerCase();
  if (norm === '日本語' || norm === 'japanese' || norm === 'ja' || norm === 'tiếng nhật') {
    return {
      code: 'ja',
      targetLanguageLabel: '日本語 (Japanese)',
      stageStepsQuiz: ['1. 導入', '2. 読解', '3. クイズ', '4. まとめ'],
      stageStepsSimple: ['1. 導入', '2. 学習', '3. まとめ'],
      roadmapLabel: '構成',
      introBadgeQuiz: 'クイズレッスン',
      introBadgeVocab: '語彙レッスン',
      introBadgeDefault: '今日のレッスン',
      introGoalPrefix: '今日のテーマ:',
      introRoadmapLine: '流れ: 1. 導入 · 2. 読解と語彙 · 3. クイズ＆まとめ',
      introVisualSubtitle: '導入 · 読解＆単語 · クイズ · まとめ',
      readingBadgePrefix: 'リーディング',
      vocabBadgePrefix: '単語',
      sentenceTitlePrefix: '文',
      outroBadge: 'まとめ',
      outroTitle: 'レッスン振り返り',
      outroContentPrefix: '学習完了:',
      outroTranslation: '新しい単語と文法を毎日声に出して復習しましょう！',
      outroLabels: ['導入', '読解・単語', 'まとめ'],
      quizAskTag: '問題',
      thinkCountdown: (sec) => `⏱️ 考える時間: ${sec}秒`,
      chooseAnswerTitle: (sec) => `あと${sec}秒で選択`,
      chooseAnswerSubtitle: '時間内に正しい答えを選びましょう！',
      correctAnswerPill: (letter, opt) => `✓ 正解: ${letter}. ${opt}`,
      correctAnswerCardTitle: (letter, opt) => `正解: ${letter}. ${opt}`,
      correctBadge: '正解',
      correctStamp: '正解!',
      correctOptionSublabel: '正解',
      contextPassageTitle: '参照パッセージ',
      contextPassageUrl: 'https://english.practice/passage-check',
      listenChooseSubtext: '音声を聞いて正しい答えを選びましょう！',
      defaultExplanation: (letter, opt) => `正解は ${letter}. ${opt} です。`,
      lessonOverviewFormula: '今日の目標',
      vocabPrefix: '重要語彙:',
      grammarPrefix: '文法:',
      promptExampleBadge: '今日のレッスン',
      promptExampleIntroContent: '今日の学習: サバイバル読解 & be going to の使い方',
      promptExampleTranslation: '構成: 1. 導入 → 2. 読解と重要語彙 → 3. クイズ5秒',
      promptExampleVocabTranslation: '語彙: exciting (ワクワクする) · programme (番組)\\n文法: 現在形（番組内容の説明）',
      promptExampleContextTitle: '参照パッセージ',
      promptExampleExplanation: '本文に live in the mountains for ten days と書かれています。',
      promptExampleOutroContent: '重要語彙と be going to を声に出して復習しよう！',
      promptExampleOutroTranslation: '毎日音読して定着させましょう！',
      promptExampleOutroLabels: ['exciting / prize', 'be going to + V', 'クイズ完了'],
      promptExampleStickyLabels: ['exciting = ワクワクする', 'programme = 番組'],
    };
  }
  if (norm === 'english' || norm === 'en' || norm === 'none') {
    const isNone = norm === 'none';
    return {
      code: isNone ? 'none' : 'en',
      targetLanguageLabel: isNone
        ? 'English-only (clear concise English notes, no extra translation)'
        : 'English (clear concise English vocabulary & grammar notes)',
      stageStepsQuiz: ['1. Intro', '2. Read & Vocab', '3. Quiz 5s', '4. Recap'],
      stageStepsSimple: ['1. Intro', '2. Lesson', '3. Recap'],
      roadmapLabel: 'Lesson Flow',
      introBadgeQuiz: 'QUIZ LESSON',
      introBadgeVocab: 'VOCAB LESSON',
      introBadgeDefault: "TODAY'S LESSON",
      introGoalPrefix: "Today's Focus:",
      introRoadmapLine: 'Plan: 1. Intro · 2. Reading & Vocab · 3. Quiz & Recap',
      introVisualSubtitle: 'Intro · Reading & Vocab · Quiz · Recap',
      readingBadgePrefix: 'READING',
      vocabBadgePrefix: 'VOCAB',
      sentenceTitlePrefix: 'Line',
      outroBadge: 'RECAP',
      outroTitle: 'Lesson Recap',
      outroContentPrefix: 'Lesson Complete:',
      outroTranslation: 'Review key vocabulary & read aloud daily for fluency!',
      outroLabels: ['Listen Well', 'Read & Vocab', 'Speak Daily'],
      quizAskTag: 'QUESTION',
      thinkCountdown: (sec) => `⏱️ THINK: ${sec} SEC`,
      chooseAnswerTitle: (sec) => `CHOOSE IN ${sec}s`,
      chooseAnswerSubtitle: 'Pick the best option before time runs out!',
      correctAnswerPill: (letter, opt) => `✓ CORRECT: ${letter}. ${opt}`,
      correctAnswerCardTitle: (letter, opt) => `Correct Answer: ${letter}. ${opt}`,
      correctBadge: 'CORRECT',
      correctStamp: 'CORRECT!',
      correctOptionSublabel: 'Correct Answer',
      contextPassageTitle: 'REFERENCE PASSAGE',
      contextPassageUrl: 'https://english.practice/passage-check',
      listenChooseSubtext: 'Listen carefully and choose the best option!',
      defaultExplanation: (letter, opt) => `The correct answer is ${letter}. ${opt}.`,
      lessonOverviewFormula: "TODAY'S GOAL",
      vocabPrefix: 'Key Words:',
      grammarPrefix: 'Grammar:',
      promptExampleBadge: "TODAY'S LESSON",
      promptExampleIntroContent: "Today's Goal: Outdoor survival story & be going to for plans",
      promptExampleTranslation: 'Plan: 1. Intro → 2. Reading & Key Words → 3. Interactive Quiz',
      promptExampleVocabTranslation: 'Key Words: exciting (thrilling) · programme (TV show)\\nGrammar: Present Simple for describing TV plots',
      promptExampleContextTitle: 'REFERENCE PASSAGE',
      promptExampleExplanation: 'The passage states: live in the mountains for ten days.',
      promptExampleOutroContent: 'Review key vocabulary & practice be going to!',
      promptExampleOutroTranslation: 'Read aloud daily to lock in every new phrase!',
      promptExampleOutroLabels: ['exciting / prize', 'be going to + V', 'Quiz Ready'],
      promptExampleStickyLabels: ['exciting = thrilling', 'programme = TV show'],
    };
  }
  return {
    code: 'vi',
    targetLanguageLabel: targetLang || 'Tiếng Việt',
    stageStepsQuiz: ['1. Mở bài', '2. Đọc & Từ', '3. Quiz 5s', '4. Tổng kết'],
    stageStepsSimple: ['1. Giới thiệu', '2. Bài học', '3. Tổng kết'],
    roadmapLabel: 'Lộ trình',
    introBadgeQuiz: 'BÀI HỌC QUIZ',
    introBadgeVocab: 'BÀI HỌC TỪ VỰNG',
    introBadgeDefault: 'BÀI HỌC HÔM NAY',
    introGoalPrefix: 'Hôm nay học gì?',
    introRoadmapLine: 'Lộ trình: 1. Giới thiệu bài · 2. Đọc & Từ vựng · 3. Quiz & Tổng kết',
    introVisualSubtitle: 'Mở bài · Đọc & Từ · Quiz · Tổng kết',
    readingBadgePrefix: 'BÀI ĐỌC',
    vocabBadgePrefix: 'TỪ VỰNG',
    sentenceTitlePrefix: 'Câu',
    outroBadge: 'TỔNG KẾT',
    outroTitle: 'Tổng kết bài học',
    outroContentPrefix: 'Hoàn thành bài học:',
    outroTranslation: 'Nhớ ôn lại từ mới & cấu trúc ngữ pháp vừa học mỗi ngày nhé!',
    outroLabels: ['Giới thiệu', 'Đọc & Từ vựng', 'Tổng kết'],
    quizAskTag: 'ĐỌC CÂU HỎI',
    thinkCountdown: (sec) => `⏱️ SUY NGHĨ: ${sec} GIÂY`,
    chooseAnswerTitle: (sec) => `CHỌN ĐÁP ÁN TRONG ${sec}s`,
    chooseAnswerSubtitle: 'Hãy tự chọn đáp án trước khi hết giờ!',
    correctAnswerPill: (letter, opt) => `✓ ĐÁP ÁN ĐÚNG: ${letter}. ${opt}`,
    correctAnswerCardTitle: (letter, opt) => `Đáp án đúng: ${letter}. ${opt}`,
    correctBadge: 'ĐÁP ÁN ĐÚNG',
    correctStamp: 'CORRECT!',
    correctOptionSublabel: 'Đáp án đúng',
    contextPassageTitle: 'ĐOẠN VĂN BÀI ĐỌC',
    contextPassageUrl: 'https://english.practice/reading-context',
    listenChooseSubtext: 'Lắng nghe và chọn phương án đúng!',
    defaultExplanation: (letter, opt) => `Đáp án đúng là ${letter}. ${opt}`,
    lessonOverviewFormula: 'MỤC TIÊU BÀI HỌC',
    vocabPrefix: 'Từ khó:',
    grammarPrefix: 'Ngữ pháp:',
    promptExampleBadge: 'BÀI HỌC HÔM NAY',
    promptExampleIntroContent: 'Hôm nay học gì? Đọc hiểu về thử thách sinh tồn & cấu trúc be going to',
    promptExampleTranslation: 'Lộ trình: 1. Giới thiệu → 2. Đọc & Từ khó → 3. Quiz có đoạn văn đối chiếu',
    promptExampleVocabTranslation: 'Từ khó: exciting (thú vị) · programme (chương trình)\\nNgữ pháp: Hiện tại đơn kể nội dung phim/TV',
    promptExampleContextTitle: 'ĐOẠN VĂN ĐỐI CHIẾU',
    promptExampleExplanation: 'Đoạn văn nêu rõ: live in the mountains for ten days.',
    promptExampleOutroContent: 'Review vocabulary & practice be going to!',
    promptExampleOutroTranslation: 'Ôn lại từ khó & luyện đọc to mỗi ngày nhé!',
    promptExampleOutroLabels: ['exciting / prize', 'be going to + V', 'Quiz Ready'],
    promptExampleStickyLabels: ['exciting = thú vị', 'programme = chương trình'],
  };
}

const COMMON_GLOSSARY_MULTI: Array<{ re: RegExp; vi: string; en: string; ja: string }> = [
  { re: /\bcomfort zone\b/i, vi: 'comfort zone (vùng an toàn)', en: 'comfort zone (familiar routine)', ja: 'comfort zone（安心領域）' },
  { re: /\bprogramme\b|\bprogram\b/i, vi: 'programme (chương trình)', en: 'programme (TV show)', ja: 'programme（番組）' },
  { re: /\bexciting\b/i, vi: 'exciting (thú vị)', en: 'exciting (thrilling)', ja: 'exciting（ワクワクする）' },
  { re: /\bmountains?\b/i, vi: 'mountain (ngọn núi)', en: 'mountain (high peak)', ja: 'mountain（山）' },
  { re: /\bdifficult\b/i, vi: 'difficult (khó khăn)', en: 'difficult (hard to do)', ja: 'difficult（難しい）' },
  { re: /\bdangerous\b/i, vi: 'dangerous (nguy hiểm)', en: 'dangerous (unsafe)', ja: 'dangerous（危険な）' },
  { re: /\bcomfortable\b/i, vi: 'comfortable (thoải mái)', en: 'comfortable (cozy)', ja: 'comfortable（快適な）' },
  { re: /\bpossible\b/i, vi: 'possible (có thể)', en: 'possible (achievable)', ja: 'possible（可能な）' },
  { re: /\bprize\b/i, vi: 'prize (giải thưởng)', en: 'prize (reward)', ja: 'prize（賞・賞金）' },
  { re: /\bfinishes?\b/i, vi: 'finish (kết thúc)', en: 'finish (complete)', ja: 'finish（終える）' },
  { re: /\bsteak\b/i, vi: 'steak (bít tết)', en: 'steak (grilled beef)', ja: 'steak（ステーキ）' },
  { re: /\blong hot bath\b/i, vi: 'hot bath (tắm nước nóng)', en: 'hot bath (warm soak)', ja: 'hot bath（熱いお風呂）' },
  { re: /\beveryone\b/i, vi: 'everyone (mọi người)', en: 'everyone (all people)', ja: 'everyone（みんな）' },
  { re: /\busually\b/i, vi: 'usually (thường xuyên)', en: 'usually (most of the time)', ja: 'usually（たいてい）' },
  { re: /\bsometimes\b/i, vi: 'sometimes (đôi khi)', en: 'sometimes (occasionally)', ja: 'sometimes（時々）' },
  { re: /\btomorrow\b/i, vi: 'tomorrow (ngày mai)', en: 'tomorrow (next day)', ja: 'tomorrow（明日）' },
  { re: /\bbreakfast\b/i, vi: 'breakfast (bữa sáng)', en: 'breakfast (morning meal)', ja: 'breakfast（朝食）' },
  { re: /\bquiet\b/i, vi: 'quiet (yên tĩnh)', en: 'quiet (peaceful)', ja: 'quiet（静かな）' },
  { re: /\bcheck in\b/i, vi: 'check in (nhận phòng)', en: 'check in (register at hotel)', ja: 'check in（チェックインする）' },
  { re: /\bpolite\b/i, vi: 'polite (lịch sự)', en: 'polite (courteous)', ja: 'polite（丁寧な）' },
  { re: /\bsafe\b/i, vi: 'safe (an toàn)', en: 'safe (protected)', ja: 'safe（安全な）' },
  { re: /\bwin\b/i, vi: 'win (giành chiến thắng)', en: 'win (come first)', ja: 'win（勝つ）' },
  { re: /\bplans?\b/i, vi: 'plan (kế hoạch)', en: 'plan (future intention)', ja: 'plan（計画）' },
  { re: /\bspend\b/i, vi: 'spend (chi tiêu)', en: 'spend (pay money)', ja: 'spend（使う・費やす）' },
  { re: /\bsave\b/i, vi: 'save (tiết kiệm)', en: 'save (keep money)', ja: 'save（貯金する）' },
  { re: /\btravel\b/i, vi: 'travel (du lịch)', en: 'travel (visit places)', ja: 'travel（旅行する）' },
];

export function extractVocabAndGrammarNote(
  sentence: string,
  targetLang = 'Tiếng Việt',
): { vocabNote?: string; grammarNote?: string } {
  const s = sentence.trim();
  const locale = getReelLocaleStrings(targetLang);
  if (!s || locale.code === 'none') return {};

  const vocabHits: string[] = [];
  for (const item of COMMON_GLOSSARY_MULTI) {
    if (item.re.test(s) && vocabHits.length < 3) {
      vocabHits.push(
        locale.code === 'ja' ? item.ja : locale.code === 'en' ? item.en : item.vi,
      );
    }
  }

  let grammarNote: string | undefined;
  if (/\b(?:am|is|are|'m|'re|'s)\s+going\s+to\b/i.test(s)) {
    grammarNote =
      locale.code === 'ja'
        ? `${locale.grammarPrefix} be going to + V（未来の予定）`
        : locale.code === 'en'
          ? `${locale.grammarPrefix} be going to + V (future plans)`
          : 'Ngữ pháp: be going to + V (dự định tương lai)';
  } else if (/\bneed\s+to\s+[a-z]+/i.test(s)) {
    grammarNote =
      locale.code === 'ja'
        ? `${locale.grammarPrefix} need to + V（〜する必要がある）`
        : locale.code === 'en'
          ? `${locale.grammarPrefix} need to + V (necessity)`
          : 'Ngữ pháp: need to + V (cần phải làm gì)';
  } else if (/\b(?:could|would)\s+(?:i|we|you)\b/i.test(s)) {
    grammarNote =
      locale.code === 'ja'
        ? `${locale.grammarPrefix} Could / Would + S + V（丁寧な依頼）`
        : locale.code === 'en'
          ? `${locale.grammarPrefix} Could / Would + S + V (polite request)`
          : 'Ngữ pháp: Could/Would + S + V (hỏi lịch sự)';
  } else if (/\b(?:is|are|am)\s+[a-z]+ing\b/i.test(s)) {
    grammarNote =
      locale.code === 'ja'
        ? `${locale.grammarPrefix} 現在進行形（be + V-ing）`
        : locale.code === 'en'
          ? `${locale.grammarPrefix} Present Continuous (be + V-ing)`
          : 'Ngữ pháp: Hiện tại tiếp diễn (be + V-ing)';
  } else if (/\b(?:usually|sometimes|every\s+day)\b/i.test(s)) {
    grammarNote =
      locale.code === 'ja'
        ? `${locale.grammarPrefix} 現在形（習慣・頻度副詞）`
        : locale.code === 'en'
          ? `${locale.grammarPrefix} Present Simple (habits & frequency)`
          : 'Ngữ pháp: Hiện tại đơn (thói quen/trạng từ tần suất)';
  } else if (/\bstarts?\s+on\b|\bat\s+\d{1,2}[:.]\d{2}/i.test(s)) {
    grammarNote =
      locale.code === 'ja'
        ? `${locale.grammarPrefix} on + 曜日 · at + 時刻`
        : locale.code === 'en'
          ? `${locale.grammarPrefix} Prepositions: on + day · at + exact time`
          : 'Cụm giới từ: on + thứ · at + giờ cụ thể';
  }

  const vocabNote = vocabHits.length > 0 ? `${locale.vocabPrefix} ${vocabHits.join(' · ')}` : undefined;
  return { vocabNote, grammarNote };
}

function pickConciseQuizExcerpt(
  sentences: string[],
  question: string,
  answerText: string,
  fallbackText: string,
): string | undefined {
  if (sentences.length > 0) {
    const queryWords = new Set(
      `${question} ${answerText}`
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !['the', 'and', 'for', 'are', 'that', 'with', 'this', 'from', 'what', 'when', 'where', 'how', 'why', 'does', 'true', 'false'].includes(w)),
    );
    const scored = sentences.map((s, idx) => {
      const lower = s.toLowerCase();
      let score = 0;
      queryWords.forEach((w) => {
        if (lower.includes(w)) score += 1;
      });
      return { s, idx, score };
    });
    const best = [...scored].sort((a, b) => b.score - a.score || a.idx - b.idx)[0];
    if (best) {
      const chosen = [best.s];
      if (best.s.length < 130 && best.idx + 1 < sentences.length) {
        const nextS = sentences[best.idx + 1];
        if (best.s.length + nextS.length + 1 <= 240) {
          chosen.push(nextS);
        }
      }
      return chosen.join(' ');
    }
  }
  const clean = fallbackText.replace(/\n+/g, ' ').trim();
  if (!clean) return undefined;
  if (clean.length <= 220) return clean;
  const firstTwo = clean.split(/(?<=[.!?])\s+/).slice(0, 2).join(' ').trim();
  return firstTwo.length > 10 ? firstTwo.slice(0, 240) : clean.slice(0, 220);
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

function computeContextualFallbackVisual(
  card: ReelCard,
  idx: number,
  total: number,
  targetLang?: string,
): ReelCardVisualConfig {
  const locale = getReelLocaleStrings(targetLang);
  if (card.type === 'intro') {
    return {
      variant: 'bs-card-header',
      formula: card.badge || locale.lessonOverviewFormula,
      title: card.title,
      subtitle: locale.introVisualSubtitle,
      highlightWord: locale.introBadgeDefault,
      sceneIcon: 'graduation',
    };
  }
  if (card.type === 'outro') {
    return {
      variant: 'css-bento-stats',
      title: card.title || locale.outroTitle,
      labels: locale.outroLabels,
      sceneIcon: 'sparkles',
    };
  }
  if (card.type === 'quiz') {
    return {
      variant: 'bs-accordion-faq',
      title: card.title || `Quiz Challenge #${idx}`,
      subtitle: card.translation || locale.listenChooseSubtext,
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

function defaultVisualForCard(
  card: ReelCard,
  idx: number,
  total: number,
  targetLang?: string,
): ReelCardVisualConfig {
  const fallback = computeContextualFallbackVisual(card, idx, total, targetLang);
  if (!card.visual) {
    return fallback;
  }
  return {
    ...fallback,
    ...card.visual,
    variant: card.visual.variant || fallback.variant,
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
  const locale = getReelLocaleStrings(options?.targetLang);
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
      badge:
        mode === 'quiz'
          ? locale.introBadgeQuiz
          : mode === 'vocab'
            ? locale.introBadgeVocab
            : locale.introBadgeDefault,
      title: docTitle,
      content: `${locale.introGoalPrefix} ${docTitle}`,
      translation: locale.code !== 'none' ? locale.introRoadmapLine : undefined,
      ttsText: introSpeech,
      durationSec: estimateCardSpeechDuration(introSpeech),
      visual: {
        variant: 'bs-card-header',
        formula: locale.lessonOverviewFormula,
        title: docTitle,
        subtitle: locale.introVisualSubtitle,
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

  let readingSentences: string[] = [];

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
          badge: `${locale.vocabBadgePrefix} #${cards.length}`,
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

    readingSentences = sentences;

    for (const s of sentences.slice(0, 10)) {
      const cleanSpoken = sanitizeTtsSpeech(s);
      if (!cleanSpoken) continue;
      const notes = extractVocabAndGrammarNote(s, options?.targetLang);
      const combinedNote = [notes.vocabNote, notes.grammarNote].filter(Boolean).join('\n') || undefined;
      const ctx = resolveContextualVisualForCue(`${docTitle} ${s}`, s);
      cards.push({
        id: makeCardId(cards.length),
        type: 'vocab',
        badge: `${locale.readingBadgePrefix} #${cards.length}`,
        title: `${locale.sentenceTitlePrefix} ${cards.length} · ${docTitle}`,
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

      const snippetContext = pickConciseQuizExcerpt(
        readingSentences,
        question,
        finalOpts[safeAnsIdx] || '',
        readingChunk,
      );

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
        explanation: explanation || locale.defaultExplanation(letter, finalOpts[safeAnsIdx]),
        ttsText: questionSpeech,
        ttsAnswerText: answerSpeech,
        durationSec: Number(
          (estimateCardSpeechDuration(questionSpeech) + 5 + estimateCardSpeechDuration(answerSpeech)).toFixed(2),
        ),
        visual: snippetContext
          ? {
              variant: 'css-browser-mockup',
              title: docTitle,
              formula: locale.contextPassageTitle,
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
        badge: `${locale.readingBadgePrefix} #${cards.length}`,
        title: `${locale.sentenceTitlePrefix} ${cards.length} · ${docTitle}`,
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
    badge: locale.outroBadge,
    title: locale.outroTitle,
    content: `${locale.outroContentPrefix} ${docTitle}`,
    translation: locale.code !== 'none' ? locale.outroTranslation : undefined,
    ttsText: outroSpeech,
    durationSec: estimateCardSpeechDuration(outroSpeech),
    visual: {
      variant: 'css-bento-stats',
      title: 'Speak Fluently!',
      labels: locale.outroLabels,
      sceneIcon: 'sparkles',
    },
  });

  // Ensure every card has a lively visual config
  const enrichedCards = cards.map((card, idx) => ({
    ...card,
    visual: defaultVisualForCard(card, idx, cards.length, options?.targetLang),
  }));

  return { title: docTitle, mode, cards: enrichedCards };
}

export const TYPOGRAPHY_MOBILE_READABILITY_PROMPT_BLOCK = `## TYPOGRAPHY & MOBILE READABILITY

**1. Nguyên tắc bắt buộc**
- Tất cả nội dung quan trọng trên visual phải đọc được rõ ràng trên điện thoại ở chế độ toàn màn hình 9:16.
- Không được hiển thị từ vựng, cụm từ chính hoặc thông điệp quan trọng bằng chữ quá nhỏ.
- Không tự động thu nhỏ font để nhét nhiều nội dung vào một component.

**2. Kích thước chữ đề xuất**
| Thành phần | Font size |
| --- | --- |
| Tiêu đề chính | 44–56 |
| Nội dung nổi bật | 36–44 |
| Labels / Callouts | 32–40 |
| Nội dung phụ | 28–32 |
| Chú thích nhỏ | Không dưới 24 |

**3. Quy định riêng cho \`labels\`**
- \`labels\` phải được hiển thị như các nội dung nổi bật (prominent callouts), không phải micro badges.
- Font đậm, độ tương phản cao, khoảng cách đủ rộng.
- Nếu có 3 labels, bố trí thành 3 vùng rõ ràng, không ép cả 3 vào một hàng với chữ nhỏ.
- Có thể xuống dòng tối đa 2 dòng nếu cần.

**4. Quy định cho \`customPrimitives\`**
- Mọi primitive \`text\` phải khai báo \`fontSize\` rõ ràng.
- Text chính nên dùng 36–48.
- Không sử dụng fontSize 16–24 cho từ vựng hoặc thông tin quan trọng.
- Không hy sinh khả năng đọc để trang trí.`;

export function buildEnglishReelsWebAiPrompt(params: {
  sourceText: string;
  sourceUrl?: string;
  title?: string;
  mode: ReelMode;
  targetLang: string;
  style?: PromptVideoStyle;
  compositionId?: LayoutCompositionId | 'ai-decide';
}): string {
  const locale = getReelLocaleStrings(params.targetLang);

  const modeInstruction =
    params.mode === 'auto'
      ? 'Tự động nhận diện dạng bài phù hợp nhất trong 3 dạng: "reading", "quiz", hoặc "vocab" (nếu bài có cả đoạn đọc + câu hỏi quiz thì giữ ĐẦY ĐỦ cả phần đọc lẫn phần quiz 5s!).'
      : `Bắt buộc xử lý theo dạng bài: "${params.mode}".`;

  const { variantsListText, sceneIconsListText } = getCatalogSummaryForPrompt();

  const exampleTimelinePromptHint =
    params.compositionId && params.compositionId !== 'ai-decide'
      ? `Ưu tiên bố cục "${params.compositionId}" nhưng VẪN giữ đầy đủ các thẻ UI minh họa & Quiz 5s cho từng card.`
      : 'Chọn component minh họa (`visual.variant` + tùy biến `title`, `subtitle`, `labels`, `value`, `sceneIcon`) khớp từng đoạn bài học.';

  const targetLangConstraint =
    locale.code === 'none'
      ? 'KHÔNG viết tiếng Việt hay bản dịch thừa trong `badge`, `translation`, `explanation`, `visual.subtitle`, `visual.labels` — toàn bộ text hiển thị trên thẻ phải viết bằng English ngắn gọn, rõ nghĩa.'
      : `BẮT BUỘC viết toàn bộ \`badge\`, \`translation\`, \`explanation\`, \`visual.subtitle\`, \`visual.labels\` (nếu là nhãn giải thích) bằng ngôn ngữ mục tiêu: **${locale.targetLanguageLabel}**. Không trộn lẫn ngôn ngữ khác!`;

  return [
    '# VAI TRÒ',
    'Bạn là giáo viên tiếng Anh bản ngữ & đạo diễn kịch bản video bài giảng dọc 9:16 (TikTok / Reels / Shorts), tương thích chuẩn JSON cố định của English Reels Studio + KineticSub Studio.',
    '',
    '# CẤU TRÚC BÀI GIẢNG BẮT BUỘC (KHÔNG ĐƯỢC CHỈ XUẤT SUBTITLE TRƠN)',
    'Video bài học PHẢI sinh động, có lộ trình rõ ràng gồm 4 phần:',
    '1. **Mở đầu (`type: "intro"`)**: Giới thiệu rõ **mục tiêu bài học** (VD: "Welcome to today\'s lesson on ..."). Chọn `visual.variant: "bs-card-header"` hoặc `"css-roadmap-steps"`.',
    '2. **Nội dung bài đọc / Từ vựng (`type: "vocab"`)**:',
    '   - **KHÔNG** nhồi nhét phiên âm `/IPA/` rườm rà trừ khi thật sự cần cho từ cực khó.',
    `   - Ở trường \`"translation"\`, giải thích ngắn gọn từ khó & ngữ pháp bằng **${locale.targetLanguageLabel}** (tránh văn bản dài dòng khiến chữ bị tràn hoặc cắt mất).`,
    '   - Nếu có nhiều câu trong bài đọc, tách câu hợp lý (1–2 ý ngắn gọn trên mỗi card) để màn hình 9:16 hiển thị ĐẦY ĐỦ không bị mất chữ.',
    '3. **Thử thách Quiz tương tác (`type: "quiz"`)**:',
    '   - Giữ số câu hỏi vừa phải (**tối đa 2–4 câu** chất lượng cao, KHÔNG nhồi quá nhiều).',
    '   - Giữ câu hỏi (`"content"`) và các đáp án (`"options"`) súc tích, đầy đủ nghĩa (KHÔNG tự cắt lửng, tránh mỗi option dài lê thê 20+ từ).',
    '   - **QUAN TRỌNG**: Nếu Quiz hỏi về bài đọc trước đó, chỉ trích **1–2 câu bằng chứng trực tiếp liên quan nhất** vào `"contextExcerpt"` (tối đa ~200 ký tự, câu hoàn chỉnh) để vừa vặn, dễ đọc rõ nét trên điện thoại trong 5 giây suy nghĩ!',
    '   - Lời đọc `"ttsText"` PHẢI có **lời dẫn mở Quiz + khoảng nghỉ** trước khi đọc câu hỏi (VD: `"Now let\'s test your understanding! ... Question one: ..."`), rồi đọc các phương án A, B..., cuối cùng nói `"Take five seconds to think."`.',
    '   - Đặt `"thinkSec": 5` để hệ thống đếm ngược 5s im lặng trước khi đọc `"ttsAnswerText"` công bố đáp án.',
    '4. **Tổng kết (`type: "outro"`)**: Bắt buộc có lời đọc `"ttsText"` tổng kết bài học qua component `"css-bento-stats"` hoặc `"bs-list-group"`.',
    '',
    TYPOGRAPHY_MOBILE_READABILITY_PROMPT_BLOCK,
    '',
    '# TÙY BIẾN UI COMPONENT & TỰ VẼ SÁNG TẠO (BOOTSTRAP 5 / MODERN CSS + `customPrimitives`)',
    'Trên MỖI thẻ trong `cards`, hãy điền object `"visual"` để chọn & **tùy biến trực tiếp nội dung/nhãn** trên 50+ UI component Bootstrap 5 / Modern CSS / Vector sẵn có trong hệ thống:',
    variantsListText,
    `- Icon hợp lệ cho \`visual.sceneIcon\`: ${sceneIconsListText}`,
    '- **Cách 1 — Tùy biến tham số trên component sẵn có**: Đặt `"variant"` đúng mã ở trên (VD `"bs-card-header"`, `"css-sticky-note"`, `"bs-badge-cluster"`, `"css-magnifying-word"`, `"bs-modal-quiz"`, `"css-flashcard-flip"`, `"css-grammar-equation"`, `"bs-alert-tip"`, `"bs-pricing-tier"`, `"css-bento-stats"`, `"hotel-desk"`, `"shopping-price"`...) kèm `"title"`, `"subtitle"`, `"labels"` (mảng 2–3 cụm callout rõ nghĩa), `"value"` (0..1), `"formula"`, `"highlightWord"`, `"sceneIcon"`.',
    '- **Cách 2 — Tự thiết kế component UI mới hoàn toàn qua `visual.customPrimitives[]`**:',
    '  + Hệ tọa độ quanh tâm `(0, 0)`, vùng an toàn `x: -380..380`, `y: -145..145`.',
    '  + Các hình hỗ trợ: `rect`, `pill`, `circle`, `ellipse`, `line`/`arrow`, `polygon`, `icon`, `text` (mọi `text` BẮT BUỘC có `"fontSize"` >= 24, text chính 36–48).',
    '',
    '# LUẬT KHÔNG ĐỤNG HÀNG (ĐA DẠNG COMPONENT)',
    '- **KHÔNG lặp lại `visual.variant`** trên 2 thẻ liên tiếp trong cùng 1 video.',
    '- Khi thẻ Quiz có `contextExcerpt`, ưu tiên `"variant": "css-browser-mockup"` với `speechText` chứa 1–2 câu bằng chứng trực tiếp.',
    '',
    '# NHIỆM VỤ XỬ LÝ NGUỒN DỮ LIỆU',
    params.sourceUrl ? `- URL nguồn: ${params.sourceUrl}` : '',
    params.title ? `- Tiêu đề gợi ý: ${params.title}` : '',
    '1. Lọc bỏ hoàn toàn tiêu đề khung bài tập/worksheet (VD: `"## Practice Reading English Exercises for Beginner – Plans"`, `"English Reading Exercises for Beginner"`, `"## Exercise 1"`, `"Part 1"`, menu web, markdown). Không bao giờ đưa chúng vào `cards` hay `ttsText`!',
    `2. ${modeInstruction}`,
    `3. ${targetLangConstraint}`,
    `4. ${exampleTimelinePromptHint}`,
    '',
    '# QUY TẮC VÀNG CHO GIỌNG ĐỌC TTS ("ttsText" & "ttsAnswerText")',
    '- "ttsText" và "ttsAnswerText" PHẢI là 100% tiếng Anh tự nhiên để máy đọc thành giọng giáo viên.',
    '- TUYỆT ĐỐI KHÔNG đưa ký tự `&` (viết thành `and`), IPA `/.../`, emoji, URL, hay ký hiệu markdown vào `ttsText` / `ttsAnswerText`.',
    '- Riêng thẻ `quiz`: `"ttsText"` bắt đầu bằng lời dẫn Quiz (`"Now let\'s test your understanding! ... Question 1: ..."`), rồi đọc lựa chọn + `"Take five seconds to think."`.',
    '',
    `# ĐỊNH DẠNG JSON CỐ ĐỊNH BẮT BUỘC TRẢ VỀ (MINH HỌA THEO NGÔN NGỮ: ${locale.targetLanguageLabel})`,
    '```json',
    '{',
    '  "title": "Outside the Comfort Zone",',
    '  "mode": "reading | quiz | vocab",',
    '  "cards": [',
    '    {',
    '      "type": "intro",',
    `      "badge": ${JSON.stringify(locale.promptExampleBadge)},`,
    '      "title": "Outside the Comfort Zone",',
    `      "content": ${JSON.stringify(locale.promptExampleIntroContent)},`,
    `      "translation": ${JSON.stringify(locale.promptExampleTranslation)},`,
    '      "ttsText": "Welcome to today\'s English lesson on Outside the Comfort Zone. Listen to the story, learn useful vocabulary and grammar, then answer a short quiz.",',
    '      "visual": {',
    '        "variant": "bs-card-header",',
    '        "formula": "TODAY LESSON GOAL",',
    '        "title": "Outside the Comfort Zone",',
    `        "subtitle": ${JSON.stringify(locale.introVisualSubtitle)},`,
    '        "sceneIcon": "graduation"',
    '      }',
    '    },',
    '    {',
    '      "type": "vocab",',
    `      "badge": ${JSON.stringify(`${locale.readingBadgePrefix} #1`)},`,
    '      "title": "Mountain Challenge",',
    '      "content": "In this exciting new TV programme, ten people go and live in the mountains for ten days.",',
    `      "translation": ${JSON.stringify(locale.promptExampleVocabTranslation)},`,
    '      "ttsText": "In this exciting new TV programme, ten people go and live in the mountains for ten days.",',
    '      "visual": {',
    '        "variant": "css-sticky-note",',
    '        "title": "KEY VOCAB & GRAMMAR",',
    `        "labels": ${JSON.stringify(locale.promptExampleStickyLabels)},`,
    '        "sceneIcon": "book"',
    '      }',
    '    },',
    '    {',
    '      "type": "quiz",',
    '      "badge": "QUIZ #1",',
    '      "title": "Check Understanding",',
    '      "contextExcerpt": "In this exciting new TV programme, ten people go and live in the mountains for ten days.",',
    '      "content": "How long do the ten people live in the mountains?",',
    '      "translation": "How long do they live in the mountains?",',
    '      "options": ["Five days", "Ten days", "Two weeks"],',
    '      "answerIndex": 1,',
    '      "thinkSec": 5,',
    `      "explanation": ${JSON.stringify(locale.promptExampleExplanation)},`,
    '      "ttsText": "Now let\'s test your understanding! ... Question one: How long do the ten people live in the mountains? ... A, Five days. B, Ten days. C, Two weeks. Take five seconds to think.",',
    '      "ttsAnswerText": "Time is up! The correct answer is B, Ten days. The text says they live in the mountains for ten days.",',
    '      "visual": {',
    '        "variant": "css-browser-mockup",',
    `        "title": ${JSON.stringify(locale.promptExampleContextTitle)},`,
    '        "speechText": "In this exciting new TV programme, ten people go and live in the mountains for ten days.",',
    '        "sceneIcon": "book"',
    '      }',
    '    },',
    '    {',
    '      "type": "outro",',
    `      "badge": ${JSON.stringify(locale.outroBadge)},`,
    '      "title": "Key Takeaways",',
    `      "content": ${JSON.stringify(locale.promptExampleOutroContent)},`,
    `      "translation": ${JSON.stringify(locale.promptExampleOutroTranslation)},`,
    '      "ttsText": "Great job! Today you practiced Outside the Comfort Zone. Review the new words and keep speaking English every day.",',
    '      "visual": {',
    '        "variant": "css-bento-stats",',
    '        "title": "Lesson Complete!",',
    `        "labels": ${JSON.stringify(locale.promptExampleOutroLabels)},`,
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
  let body = fenced && fenced[1] ? fenced[1].trim() : trimmed;
  if (!fenced) {
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      body = trimmed.slice(firstBrace, lastBrace + 1);
    }
  }
  return body.replace(/,\s*([}\]])/g, '$1');
}

function parseCardVisualConfig(rawVisual: unknown): ReelCardVisualConfig | undefined {
  if (!rawVisual || typeof rawVisual !== 'object') return undefined;
  const v = rawVisual as Record<string, unknown>;
  const normalizedVariant =
    typeof v.variant === 'string'
      ? v.variant.trim().toLowerCase().replace(/_/g, '-')
      : '';
  const variant =
    normalizedVariant && isKnownIllustrationVariant(normalizedVariant)
      ? (normalizedVariant as IllustrationVariant)
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

  const parsedNumVal =
    typeof v.value === 'number'
      ? v.value
      : typeof v.value === 'string' && v.value.trim() !== ''
        ? Number(v.value.trim())
        : NaN;

  const normalizedNumVal = Number.isFinite(parsedNumVal)
    ? parsedNumVal > 1 && parsedNumVal <= 100
      ? Number((parsedNumVal / 100).toFixed(3))
      : Math.max(0, Math.min(1, parsedNumVal))
    : undefined;

  const out: ReelCardVisualConfig = {
    variant,
    title: typeof v.title === 'string' && v.title.trim() ? v.title.trim() : undefined,
    subtitle: typeof v.subtitle === 'string' && v.subtitle.trim() ? v.subtitle.trim() : undefined,
    labels: labels && labels.length > 0 ? labels : undefined,
    value: normalizedNumVal,
    formula: typeof v.formula === 'string' && v.formula.trim() ? v.formula.trim() : undefined,
    highlightWord:
      typeof v.highlightWord === 'string' && v.highlightWord.trim() ? v.highlightWord.trim() : undefined,
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
    !out.highlightWord &&
    !out.sceneIcon &&
    !out.speechText &&
    !out.customPrimitives
  ) {
    return undefined;
  }
  return out;
}

export function parseEnglishReelsAiJson(
  rawText: string,
  options?: { targetLang?: string },
): ParsedEnglishReelsResponse | null {
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

      const content = String(c.content || c.text || c.spokenText || c.ttsText || c.title || '').trim();
      const title = String(c.title || content || `Card ${idx + 1}`).trim();
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
      const optionsArr = Array.isArray(c.options)
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
        options: optionsArr && optionsArr.length > 0 ? optionsArr : undefined,
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
      cardObj.visual = defaultVisualForCard(cardObj, idx, rawCards.length, options?.targetLang);
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
        const elType = ('type' in el && el.type) || ('kind' in el && el.kind) || '';
        const elText = el.text || ('content' in el && el.content) || '';
        if (
          elText &&
          (elType === 'sentence_card' ||
            elType === 'sentence-card' ||
            elType === 'text' ||
            elType === 'topic_pill' ||
            elType === 'pill')
        ) {
          cards.push({
            id: makeCardId(cards.length),
            type: cards.length === 0 ? 'intro' : 'vocab',
            badge: String(elType || 'CARD').toUpperCase(),
            title: elText,
            content: elText,
            translation: el.subtext || undefined,
            ttsText: elText,
            durationSec: estimateCardSpeechDuration(elText),
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
  targetLang?: string,
): { variant: IllustrationVariant; data: IllustrationPropData } {
  const fallback = defaultVisualForCard(card, idx, total, targetLang);
  const custom = card.visual;
  const ctxFallback = resolveContextualVisualForCue(
    `${card.title} ${card.content} ${card.translation || ''}`,
    card.title,
  );

  // Respect explicit card custom visual in default 'story-scenes' or 'custom',
  // but when user explicitly picks another Bố cục KineticSub layout, re-compose visibly!
  let chosenVariant: IllustrationVariant =
    custom?.variant || fallback.variant || ctxFallback.variant || 'bs-card-header';

  if (card.type !== 'quiz' && compositionId && compositionId !== 'story-scenes' && compositionId !== 'custom') {
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

  const baseLabels = custom?.labels || fallback.labels;
  const baseTitle = custom?.title || fallback.title || card.title;
  const baseSubtitle =
    custom?.subtitle ||
    fallback.subtitle ||
    [card.phonetic, card.translation].filter(Boolean).join(' · ') ||
    card.content;

  const data: IllustrationPropData = {
    ...ctxFallback.data,
    title: baseTitle,
    subtitle: baseSubtitle,
    labels: baseLabels,
    value: custom?.value ?? fallback.value,
    formula: custom?.formula || fallback.formula,
    speechText: custom?.speechText || fallback.speechText || card.content,
    sceneIcon: custom?.sceneIcon || fallback.sceneIcon || ctxFallback.sceneIcon,
    customPrimitives: custom?.customPrimitives,
  };

  // Populate structured sub-fields for composition-specific illustration renderers
  if (chosenVariant === 'flow-diagram' && (!data.nodes || data.nodes.length === 0)) {
    const srcLabels = baseLabels && baseLabels.length >= 2 ? baseLabels : [baseTitle, 'Focus', 'Practice'];
    const cols = ['#2563EB', '#16A34A', '#7C3AED'];
    const icons: Array<'chat' | 'check' | 'star'> = ['chat', 'check', 'star'];
    data.nodes = srcLabels.slice(0, 3).map((lbl, i) => ({
      label: lbl,
      icon: icons[i % icons.length],
      color: cols[i % cols.length],
    }));
    data.value = (idx + 1) / Math.max(1, total);
  } else if (chosenVariant === 'checklist-card' && (!data.checklist || data.checklist.length === 0)) {
    const items =
      baseLabels && baseLabels.length > 0
        ? baseLabels.slice(0, 3).map((lbl) => ({ text: lbl, ok: true }))
        : [{ text: card.title, ok: true }, ...(card.translation ? [{ text: card.translation.split('\n')[0], ok: true }] : [])];
    data.checklist = items;
  } else if (chosenVariant === 'dialogue-upgrade' && (!data.upgrades || data.upgrades.length === 0)) {
    data.upgrades = [
      { prompt: card.title, upgrade: (baseLabels && baseLabels[0]) || 'Key Point', badgeColor: '#2563EB' },
      ...(baseLabels && baseLabels[1] ? [{ prompt: baseSubtitle.slice(0, 28), upgrade: baseLabels[1], badgeColor: '#16A34A' }] : []),
    ];
  } else if (chosenVariant === 'spatial-boxes' && (!data.boxes || data.boxes.length === 0)) {
    const srcLabels = baseLabels && baseLabels.length >= 2 ? baseLabels : [card.badge || card.type.toUpperCase(), card.title];
    const icons: Array<'dot' | 'surface' | 'cube'> = ['dot', 'surface', 'cube'];
    const accents = ['#2563EB', '#16A34A', '#7C3AED'];
    data.boxes = srcLabels.slice(0, 3).map((lbl, i) => ({
      title: lbl,
      subtitle: i === 0 ? card.badge : undefined,
      icon: icons[i % icons.length],
      accent: accents[i % accents.length],
    }));
  } else if (chosenVariant === 'phrase-icon-split' && (!data.nodes || data.nodes.length === 0)) {
    const words = card.content.split(/\s+/).filter(Boolean);
    const splitIdx = Math.max(1, words.length - 1);
    data.speechText = words.slice(0, splitIdx).join(' ');
    data.highlightWord = words[splitIdx] || card.title;
    data.nodes = (baseLabels && baseLabels.length > 0 ? baseLabels : [card.badge, 'Focus']).slice(0, 3).map((lbl, i) => ({
      label: lbl,
      color: i === 0 ? '#64748B' : '#4F46E5',
    }));
  }

  return { variant: chosenVariant, data };
}

export function reelCardsToLessonProject(
  cards: ReelCard[],
  options?: {
    title?: string;
    subtitle?: string;
    theme?: CanvasThemeId;
    compositionId?: LayoutCompositionId;
    targetLang?: string;
    backgroundImage?: BackgroundImageConfig;
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

  const locale = getReelLocaleStrings(options?.targetLang);

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
      backgroundImage: options?.backgroundImage,
      watermark: options?.watermark,
    };
  }

  const hasQuiz = safeCards.some((c) => c.type === 'quiz');
  const stageSteps = hasQuiz ? locale.stageStepsQuiz : locale.stageStepsSimple;
  const compId = options?.compositionId || 'story-scenes';

  const compLayoutProfile: Record<
    string,
    {
      showStrip: boolean;
      stripY: number;
      pillY: number;
      illY: number;
      cardY: number;
      pillBg?: string;
      pillColor?: string;
      cardBg?: string;
      cardText?: string;
      emphasisColor?: string;
    }
  > = {
    'story-scenes': { showStrip: true, stripY: 170, pillY: 295, illY: 545, cardY: 975 },
    'flow-steps': {
      showStrip: true,
      stripY: 170,
      pillY: 295,
      illY: 545,
      cardY: 975,
      pillBg: '#E0E7FF',
      pillColor: '#3730A3',
      cardBg: '#EEF2FF',
      cardText: '#1E1B4B',
      emphasisColor: '#4F46E5',
    },
    'gauge-tone': {
      showStrip: false,
      stripY: 170,
      pillY: 205,
      illY: 500,
      cardY: 955,
      pillBg: '#DCFCE7',
      pillColor: '#065F46',
      emphasisColor: '#059669',
    },
    'checklist-cards': {
      showStrip: false,
      stripY: 170,
      pillY: 205,
      illY: 515,
      cardY: 975,
      pillBg: '#F3E8FF',
      pillColor: '#6B21A8',
      emphasisColor: '#7C3AED',
    },
    'dialogue-upgrade': {
      showStrip: false,
      stripY: 170,
      pillY: 205,
      illY: 525,
      cardY: 985,
      pillBg: '#FEF3C7',
      pillColor: '#92400E',
      cardBg: '#FFFBEB',
      cardText: '#451A03',
      emphasisColor: '#D97706',
    },
    'timeline-track': {
      showStrip: true,
      stripY: 170,
      pillY: 295,
      illY: 545,
      cardY: 975,
      pillBg: '#CCFBF1',
      pillColor: '#0F766E',
      cardBg: '#F0FDFA',
      cardText: '#134E4A',
      emphasisColor: '#0D9488',
    },
    'spatial-contrast': {
      showStrip: true,
      stripY: 170,
      pillY: 295,
      illY: 545,
      cardY: 975,
      pillBg: '#1E293B',
      pillColor: '#F8FAFC',
      cardBg: '#FEFCE8',
      cardText: '#1C1917',
      emphasisColor: '#CA8A04',
    },
    'avatar-dialogue': {
      showStrip: false,
      stripY: 170,
      pillY: 205,
      illY: 520,
      cardY: 975,
      pillBg: '#FFE4E6',
      pillColor: '#BE123C',
      cardBg: '#FFF1F2',
      cardText: '#1F2937',
      emphasisColor: '#E11D48',
    },
    'clock-spotlight': {
      showStrip: false,
      stripY: 170,
      pillY: 205,
      illY: 520,
      cardY: 975,
      pillBg: '#FDE68A',
      pillColor: '#78350F',
      cardBg: '#FFFBEB',
      cardText: '#1C1917',
      emphasisColor: '#B45309',
    },
    'phrase-icon-split': {
      showStrip: true,
      stripY: 170,
      pillY: 295,
      illY: 585,
      cardY: 1020,
    },
  };
  const activeProfile = compLayoutProfile[compId] ?? compLayoutProfile['story-scenes'];

  const elements: LessonProject['elements'] = [];

  safeCards.forEach((card, idx) => {
    const win = cardWindows[idx];
    const { start, end } = win;
    const visualSpec = resolveVisualPayloadForReelCard(
      card,
      idx,
      safeCards.length,
      options?.compositionId,
      options?.targetLang,
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
        label: `${locale.roadmapLabel} #${idx + 1}`,
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
          label: `Quiz #${idx + 1}`,
          startTime: start,
          endTime: win.questionEnd,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 295, width: 640, scale: 1, zIndex: 16 },
          props: {
            kind: 'topic-pill',
            text: `${card.badge || 'QUIZ'} · ${locale.quizAskTag}`,
            bgColor: '#FEF3C7',
            textColor: '#B45309',
          },
        });
      }

      const hasContextExcerpt = Boolean(card.contextExcerpt?.trim());

      // Phase 2 Countdown Pills + Animated Progress Bar
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
            label: `Countdown ${remain}s`,
            startTime: t0,
            endTime: t1,
            enterAnimation: 'pop-up',
            exitAnimation: 'fade-out',
            layout: { x: 540, y: 295, width: 640, scale: 1, zIndex: 18 },
            props: {
              kind: 'topic-pill',
              text: locale.thinkCountdown(remain),
              bgColor: remain <= 2 ? '#FEE2E2' : '#FEF3C7',
              textColor: remain <= 2 ? '#B91C1C' : '#B45309',
            },
          });

          elements.push({
            id: `reel-q-countdown-meter-${idx}-${s}`,
            type: 'illustration-prop',
            label: `Timer ${remain}s`,
            startTime: t0,
            endTime: t1,
            enterAnimation: 'fade-scale',
            exitAnimation: 'fade-out',
            layout: {
              x: 540,
              y: hasContextExcerpt ? 1315 : 500,
              width: hasContextExcerpt ? 780 : 840,
              scale: hasContextExcerpt ? 0.72 : 0.94,
              zIndex: 10,
            },
            props: {
              kind: 'illustration-prop',
              variant: 'bs-progress-meter',
              data: {
                title: locale.chooseAnswerTitle(remain),
                subtitle: locale.chooseAnswerSubtitle,
                value: Number(((s + 1) / wholeSecs).toFixed(2)),
                sceneIcon: 'clock',
              },
            },
          });
        }
      }

      // Phase 3 Pill: Answer Reveal! (NEVER truncated mid-word)
      if (end - win.answerStart > 0.15) {
        elements.push({
          id: `reel-q-pill-ans-${idx}`,
          type: 'topic-pill',
          label: `${locale.correctBadge} #${idx + 1}`,
          startTime: win.answerStart,
          endTime: end,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 295, width: 880, scale: 1, zIndex: 18 },
          props: {
            kind: 'topic-pill',
            text: locale.correctAnswerPill(ansLetter, ansOpt),
            bgColor: '#DCFCE7',
            textColor: '#15803D',
          },
        });

        elements.push({
          id: `reel-q-ans-prop-${idx}`,
          type: 'illustration-prop',
          label: `Answer Card #${idx + 1}`,
          startTime: win.answerStart,
          endTime: end,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 515, width: 840, scale: 0.96, zIndex: 11 },
          props: {
            kind: 'illustration-prop',
            variant: 'bs-alert-tip',
            data: {
              title: locale.correctAnswerCardTitle(ansLetter, ansOpt),
              speechText: card.explanation || locale.defaultExplanation(ansLetter, ansOpt),
              highlightWord: locale.correctBadge,
              sceneIcon: 'sparkles',
            },
          },
        });
      }

      // Passage Context Card (concise direct-evidence excerpt kept visible throughout Question + Think countdown)
      if (card.contextExcerpt?.trim()) {
        const preRevealEnd = Math.max(start + 0.1, win.answerStart);
        elements.push({
          id: `reel-q-context-${idx}`,
          type: 'illustration-prop',
          label: `${locale.contextPassageTitle} #${idx + 1}`,
          startTime: start,
          endTime: preRevealEnd,
          enterAnimation: 'fade-scale',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 525, width: 880, scale: 0.94, zIndex: 9 },
          props: {
            kind: 'illustration-prop',
            variant: 'css-browser-mockup',
            data: {
              title: options?.title || locale.contextPassageTitle,
              formula: locale.contextPassageUrl,
              speechText: card.contextExcerpt.trim(),
              sceneIcon: 'book',
            },
          },
        });
      } else if (win.questionEnd - start > 0.15) {
        elements.push({
          id: `reel-q-ask-prop-${idx}`,
          type: 'illustration-prop',
          label: `Quiz Visual #${idx + 1}`,
          startTime: start,
          endTime: win.questionEnd,
          enterAnimation: 'fade-scale',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 500, width: 840, scale: 0.96, zIndex: 9 },
          props: {
            kind: 'illustration-prop',
            variant: visualSpec.variant,
            data: visualSpec.data,
          },
        });
      }

      // Question Sentence Card
      const preRevealEnd = Math.max(start + 0.1, win.answerStart);
      if (preRevealEnd - start > 0.1) {
        elements.push({
          id: `reel-qcard-pre-${idx}`,
          type: 'sentence-card',
          label: `Quiz Q #${idx + 1}`,
          startTime: start,
          endTime: preRevealEnd,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: hasContextExcerpt ? 840 : 830, width: 880, scale: 1, zIndex: 20 },
          props: {
            kind: 'sentence-card',
            text: card.content,
            subtext: card.translation || locale.listenChooseSubtext,
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
          label: `Quiz Answer #${idx + 1}`,
          startTime: win.answerStart,
          endTime: end,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 830, width: 880, scale: 1, zIndex: 22 },
          props: {
            kind: 'sentence-card',
            text: `${ansLetter}. ${ansOpt}`,
            subtext: card.explanation ? card.content : card.translation || card.content,
            badge: 'check',
            stampText: locale.correctStamp,
            stampColor: '#16A34A',
            emphasisColor: '#16A34A',
            bgColor: isDark ? 'rgba(6, 78, 59, 0.94)' : '#ECFDF5',
            textColor: isDark ? '#ECFDF5' : '#064E3B',
          },
        });
      }

      // Options Strip: FULL option text (never truncated mid-word!)
      elements.push({
        id: `reel-quiz-opts-${idx}`,
        type: 'comparison-strip',
        label: `Options #${idx + 1}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'slide-up',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: hasContextExcerpt ? 1085 : 1175, width: 920, scale: 1, zIndex: 20 },
        props: {
          kind: 'comparison-strip',
          items: card.options.slice(0, 4).map((opt, oIdx) => ({
            label: `${String.fromCharCode(65 + oIdx)}. ${opt}`,
            sublabel: oIdx === safeAnsIdx ? locale.correctOptionSublabel : undefined,
            activateAt: oIdx === safeAnsIdx ? win.answerStart : end + 9,
            accentColor: oIdx === safeAnsIdx ? '#16A34A' : '#64748B',
          })),
        },
      });

      // Bottom Karaoke Subtitles
      elements.push({
        id: `reel-karaoke-q-${idx}`,
        type: 'karaoke-card',
        label: `Sub Q #${idx + 1}`,
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
          label: `Sub A #${idx + 1}`,
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
    const displayHeadline =
      card.type === 'vocab' &&
      card.title &&
      card.title !== card.content &&
      !card.title.startsWith('Reading Point') &&
      !card.title.startsWith('Lesson Point') &&
      !card.title.startsWith('Câu ') &&
      !card.title.startsWith('Line ') &&
      !card.title.startsWith('文 ')
        ? `${card.title}${card.phonetic ? ` ${card.phonetic}` : ''}`
        : card.content;
    const displaySub =
      card.type === 'vocab' &&
      card.title &&
      card.title !== card.content &&
      !card.title.startsWith('Reading Point') &&
      !card.title.startsWith('Lesson Point') &&
      !card.title.startsWith('Câu ') &&
      !card.title.startsWith('Line ') &&
      !card.title.startsWith('文 ')
        ? `${card.content}${card.translation ? ` — ${card.translation}` : ''}`
        : [card.phonetic, card.translation].filter(Boolean).join(' · ') || undefined;

    if (compId === 'word-reveal') {
      // @xun52000 Bold Typography Layout: clean top badge pill + large focal sentence card (no cluttered prop)
      elements.push({
        id: `reel-pill-${idx}`,
        type: 'topic-pill',
        label: `${card.badge || card.type}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'pop-up',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: 245, width: 640, scale: 1, zIndex: 14 },
        props: {
          kind: 'topic-pill',
          text: card.badge || card.type.toUpperCase(),
          bgColor: isDark ? '#334155' : '#E0E7FF',
          textColor: isDark ? '#FACC15' : '#3730A3',
        },
      });

      elements.push({
        id: `reel-card-${idx}`,
        type: 'sentence-card',
        label: `Word Reveal #${idx + 1}: ${card.title.slice(0, 28)}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'fade-scale',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: 740, width: 900, scale: 1, zIndex: 20 },
        props: {
          kind: 'sentence-card',
          text: displayHeadline,
          subtext: displaySub,
          badge: card.type === 'outro' ? 'check' : 'none',
          emphasisWord: card.type === 'vocab' ? card.title : undefined,
          emphasisColor: isDark ? '#FACC15' : '#4F46E5',
          bgColor: isDark ? 'rgba(30, 41, 59, 0.95)' : '#FFFFFF',
          textColor: isDark ? '#F8FAFC' : '#0F172A',
        },
      });
    } else if (compId === '3d-shapes') {
      // 3D Shapes Layout: 3D pill + extruded 3D headline card + staircase or detail card
      elements.push({
        id: `reel-3d-pill-${idx}`,
        type: 'shape-3d',
        label: `3D Pill #${idx + 1}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'drop-in',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: 225, width: 580, height: 108, scale: 1, zIndex: 16 },
        props: {
          kind: 'shape-3d',
          shapeType: 'pill_3d',
          fill: isDark ? '#334155' : '#EEF2FF',
          shadow: true,
          highlight: true,
          depth: 8,
          cornerRadius: 54,
          textContent: card.badge || card.type.toUpperCase(),
          textColor: isDark ? '#FACC15' : '#4338CA',
          textSize: 'body',
          textWeight: 'bold',
        },
      });

      elements.push({
        id: `reel-3d-card-${idx}`,
        type: 'shape-3d',
        label: `3D Card #${idx + 1}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'pop-up',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: 520, width: 860, height: 290, scale: 1, zIndex: 18 },
        props: {
          kind: 'shape-3d',
          shapeType: 'card_3d',
          fill:
            card.type === 'outro'
              ? '#10B981'
              : card.type === 'intro'
                ? '#4F46E5'
                : idx % 2 === 0
                  ? '#0EA5E9'
                  : '#6366F1',
          shadow: true,
          highlight: true,
          depth: 14,
          cornerRadius: 30,
          textContent: displayHeadline,
          textColor: '#FFFFFF',
          textSize: displayHeadline.length > 96 ? 'body' : 'headline',
          textWeight: 'bold',
        },
      });

      if (visualSpec.data.labels && visualSpec.data.labels.length >= 2) {
        elements.push({
          id: `reel-3d-staircase-${idx}`,
          type: 'shape-3d',
          label: `3D Steps #${idx + 1}`,
          startTime: start,
          endTime: end,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 980, width: 860, height: 320, scale: 1, zIndex: 16 },
          props: {
            kind: 'shape-3d',
            shapeType: 'staircase_3d',
            fill: '#F59E0B',
            shadow: true,
            highlight: true,
            depth: 12,
            cornerRadius: 20,
            textColor: '#FFFFFF',
            stepLabels: visualSpec.data.labels.slice(0, 3),
          },
        });
      } else if (displaySub) {
        elements.push({
          id: `reel-card-${idx}`,
          type: 'sentence-card',
          label: `Note #${idx + 1}`,
          startTime: start,
          endTime: end,
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 960, width: 880, scale: 1, zIndex: 20 },
          props: {
            kind: 'sentence-card',
            text: displaySub,
            badge: card.type === 'outro' ? 'check' : 'none',
            bgColor: isDark ? 'rgba(15, 23, 42, 0.94)' : '#FFFFFF',
            textColor: isDark ? '#F8FAFC' : '#0F172A',
          },
        });
      }
    } else {
      if (activeProfile.showStrip) {
        elements.push({
          id: `reel-stage-${idx}`,
          type: 'comparison-strip',
          label: `${locale.roadmapLabel} #${idx + 1}`,
          startTime: start,
          endTime: end,
          enterAnimation: 'fade-scale',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: activeProfile.stripY, width: 920, scale: 1, zIndex: 12 },
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
      }

      elements.push({
        id: `reel-pill-${idx}`,
        type: 'topic-pill',
        label: `${card.badge || card.type}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'pop-up',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: activeProfile.pillY, width: 640, scale: 1, zIndex: 14 },
        props: {
          kind: 'topic-pill',
          text: card.badge || card.type.toUpperCase(),
          bgColor:
            activeProfile.pillBg ??
            (card.type === 'intro'
              ? '#E0E7FF'
              : card.type === 'outro'
                ? '#DCFCE7'
                : '#DBEAFE'),
          textColor:
            activeProfile.pillColor ??
            (card.type === 'intro'
              ? '#3730A3'
              : card.type === 'outro'
                ? '#15803D'
                : '#1D4ED8'),
        },
      });

      elements.push({
        id: `reel-prop-${idx}`,
        type: 'illustration-prop',
        label: `Visual #${idx + 1}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'fade-scale',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: activeProfile.illY, width: 860, scale: 0.96, zIndex: 10 },
        props: {
          kind: 'illustration-prop',
          variant: visualSpec.variant,
          data: visualSpec.data,
        },
      });

      elements.push({
        id: `reel-card-${idx}`,
        type: 'sentence-card',
        label: `Card #${idx + 1}: ${card.title.slice(0, 28)}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'pop-up',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: activeProfile.cardY, width: 880, scale: 1, zIndex: 20 },
        props: {
          kind: 'sentence-card',
          text: displayHeadline,
          subtext: displaySub,
          badge: card.type === 'outro' ? 'check' : 'none',
          emphasisWord: card.type === 'vocab' && !card.title.startsWith('Reading') ? card.title : undefined,
          emphasisColor: activeProfile.emphasisColor ?? (card.type === 'outro' ? '#16A34A' : '#2563EB'),
          bgColor: isDark ? 'rgba(15, 23, 42, 0.94)' : (activeProfile.cardBg ?? '#FFFFFF'),
          textColor: isDark ? '#F8FAFC' : (activeProfile.cardText ?? '#0F172A'),
        },
      });
    }

    elements.push({
      id: `reel-karaoke-${idx}`,
      type: 'karaoke-card',
      label: `Karaoke #${idx + 1}`,
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
    compositionId: compId,
    backgroundImage: options?.backgroundImage,
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
