import { buildSceneGenerationPrompt, PromptVideoStyle } from './aiPromptBuilder';
import { applyCompositionToProject } from './illustrationLayouts';
import {
  FlexibleSceneDocument,
  parseScenePlanJson,
  scenePlanToProject,
} from './scenePlanAdapter';
import { interpolateWordTimings } from './transcriptParser';
import {
  CanvasThemeId,
  LayoutCompositionId,
  LessonProject,
  TranscriptCue,
} from './types';
import { resolveContextualVisualForCue } from './vectorComponentDb';

export type ReelCardType = 'intro' | 'vocab' | 'quiz' | 'outro';
export type ReelMode = 'auto' | 'reading' | 'quiz' | 'vocab';

export interface ReelCard {
  id: string;
  type: ReelCardType;
  badge: string;
  title: string;
  content: string;
  phonetic?: string;
  translation?: string;
  ttsText: string;
  options?: string[];
  answerIndex?: number;
  explanation?: string;
  durationSec?: number;
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
    /(?=^(?:#{1,3}\s+|(?:Task|Exercise|Part|Reading|Quiz|Vocabulary|Activity|Lesson)\s*\d*[:.\-–\s]))/gim;
  const rawParts = cleaned
    .split(headingRe)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40);

  if (rawParts.length <= 1) {
    const firstLine = cleaned.split('\n')[0]?.replace(/^#+\s*/, '').trim().slice(0, 72);
    return [
      {
        id: 'ex-1',
        title: firstLine || 'Bài học chính',
        mode: detectReelMode(cleaned),
        rawText: cleaned,
      },
    ];
  }

  return rawParts.slice(0, 10).map((part, idx) => {
    const firstLine = part.split('\n')[0]?.replace(/^#+\s*/, '').trim().slice(0, 72);
    return {
      id: `ex-${idx + 1}`,
      title: firstLine || `Bài tập ${idx + 1}`,
      mode: detectReelMode(part),
      rawText: part,
    };
  });
}

export function estimateCardSpeechDuration(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Number(Math.max(2.2, Math.min(18, words / 2.4 + 0.65)).toFixed(2));
}

export function buildReelCardsRuleBased(
  rawText: string,
  options?: {
    title?: string;
    mode?: ReelMode;
    targetLang?: string;
  },
): { title: string; mode: Exclude<ReelMode, 'auto'>; cards: ReelCard[] } {
  const cleaned = rawText.replace(/\r\n/g, '\n').trim();
  const lines = cleaned
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const mode =
    options?.mode && options.mode !== 'auto' ? options.mode : detectReelMode(cleaned);
  const docTitle =
    options?.title?.trim() ||
    lines[0]?.replace(/^#+\s*/, '').slice(0, 72) ||
    'English Practice Reel';

  const cards: ReelCard[] = [
    {
      id: makeCardId(0),
      type: 'intro',
      badge: mode === 'quiz' ? 'QUIZ CHALLENGE' : mode === 'vocab' ? 'VOCAB BOOST' : 'READING FOCUS',
      title: docTitle,
      content: docTitle,
      translation:
        options?.targetLang && options.targetLang !== 'none'
          ? `Luyện tập ${mode.toUpperCase()} (${options.targetLang})`
          : undefined,
      ttsText: docTitle,
      durationSec: estimateCardSpeechDuration(docTitle),
    },
  ];

  if (mode === 'vocab') {
    for (let i = 0; i < lines.length && cards.length < 14; i++) {
      const line = lines[i];
      const match = line.match(
        /^([^/\-–—:=]+?)(?:\s+(\/[^/]+\/))?\s*(?:[-–—:=]|→)\s*(.+)$/,
      );
      if (match) {
        const word = match[1].replace(/^\d+[.)]\s*/, '').trim();
        const phonetic = match[2]?.trim();
        const meaning = match[3].trim();
        cards.push({
          id: makeCardId(cards.length),
          type: 'vocab',
          badge: `WORD #${cards.length}`,
          title: word,
          content: word,
          phonetic,
          translation: meaning,
          ttsText: word,
          durationSec: estimateCardSpeechDuration(word),
        });
      }
    }
  } else if (mode === 'quiz') {
    // Parse numbered questions + A/B/C/D or True/False
    const qBlocks = cleaned.split(/(?=^(?:Q?\d+[.)]\s+))/gm).map((b) => b.trim()).filter(Boolean);
    for (const block of qBlocks.slice(0, 10)) {
      const blockLines = block.split('\n').map((l) => l.trim()).filter(Boolean);
      if (blockLines.length === 0) continue;
      const question = blockLines[0].replace(/^Q?\d+[.)]\s*/i, '').trim();
      if (question.length < 5) continue;

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
          if (letterIdx >= 0 && letterIdx < Math.max(2, opts.length)) {
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

      cards.push({
        id: makeCardId(cards.length),
        type: 'quiz',
        badge: `QUESTION ${cards.length}`,
        title: `Question ${cards.length}`,
        content: question,
        options: opts.length > 0 ? opts : ['True', 'False'],
        answerIndex: Math.min(answerIndex, Math.max(0, (opts.length || 2) - 1)),
        explanation: explanation || undefined,
        ttsText: question,
        durationSec: estimateCardSpeechDuration(question),
      });
    }
  }

  // Reading or fallback sentences if vocab/quiz yielded no items
  if (cards.length <= 1) {
    const sentences = cleaned
      .replace(/\n+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 6);
    for (const s of sentences.slice(0, 12)) {
      cards.push({
        id: makeCardId(cards.length),
        type: 'reading' === mode ? 'vocab' : 'vocab',
        badge: `LINE #${cards.length}`,
        title: `Part ${cards.length}`,
        content: s,
        ttsText: s,
        durationSec: estimateCardSpeechDuration(s),
      });
    }
  }

  cards.push({
    id: makeCardId(cards.length),
    type: 'outro',
    badge: 'SUMMARY',
    title: 'Save & Practice!',
    content: 'Follow for daily English practice!',
    translation:
      options?.targetLang && options.targetLang !== 'none'
        ? 'Lưu lại và luyện nói mỗi ngày!'
        : undefined,
    ttsText: 'Follow for daily English practice!',
    durationSec: 2.8,
  });

  return { title: docTitle, mode, cards };
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
      ? 'Tự động nhận diện dạng bài phù hợp nhất trong 3 dạng: "reading", "quiz" (True/False hoặc Comprehension trắc nghiệm), hoặc "vocab".'
      : `Bắt buộc xử lý theo dạng bài: "${params.mode}".`;

  const exampleTimelinePromptHint =
    params.compositionId && params.compositionId !== 'ai-decide'
      ? `Nếu tạo thêm cảnh minh họa trong sceneJson, ưu tiên bố cục "${params.compositionId}".`
      : 'Tự chọn kiểu dàn cảnh & minh họa khớp ngữ cảnh câu từ trong KineticSub Studio.';

  return [
    '# VAI TRÒ',
    'Bạn là chuyên gia biên tập nội dung giảng dạy tiếng Anh cho video ngắn dọc 9:16 (TikTok / Reels / Shorts), tương thích chuẩn JSON cố định của English Reels Studio + KineticSub Studio.',
    '',
    '# NHIỆM VỤ XỬ LÝ NGUỒN DỮ LIỆU',
    params.sourceUrl ? `- URL nguồn: ${params.sourceUrl}` : '',
    params.title ? `- Tiêu đề gợi ý: ${params.title}` : '',
    '1. Lọc bỏ hoàn toàn phần rác nếu còn sót: thanh điều hướng, menu, footer, quảng cáo, nút chia sẻ, bình luận.',
    `2. ${modeInstruction}`,
    `3. Điền đầy đủ trường "translation" bằng ngôn ngữ: ${targetLanguageLabel}.`,
    '4. Nếu là bài Reading dài, chia thành các thẻ ngắn dễ đọc trên màn hình 9:16 (mỗi thẻ 1–2 câu rõ nghĩa).',
    '5. Nếu là Quiz (True/False hoặc Comprehension), điền đủ "options" (mảng string), "answerIndex" (0-based), và "explanation" giải thích ngắn gọn.',
    '6. Nếu là Vocab, điền "title" (từ/cụm từ), "phonetic" (IPA nếu có), "content" (câu ví dụ ngắn hoặc chính từ vựng), "translation" (nghĩa).',
    `7. ${exampleTimelinePromptHint}`,
    '',
    '# ĐỊNH DẠNG JSON CỐ ĐỊNH BẮT BUỘC TRẢ VỀ (CHỈ OUTPUT ĐÚNG 1 OBJECT JSON HỢP LỆ)',
    '```json',
    '{',
    '  "title": "Tên bài học ngắn gọn",',
    '  "mode": "reading | quiz | vocab",',
    '  "cards": [',
    '    {',
    '      "type": "intro | vocab | quiz | outro",',
    '      "badge": "HOOK | WORD #1 | QUIZ 1 | SUMMARY",',
    '      "title": "Tiêu đề thẻ hoặc Từ vựng chính",',
    '      "content": "Câu tiếng Anh chính hiển thị trên thẻ",',
    '      "phonetic": "/fəˈnet.ɪk/ (tùy chọn)",',
    '      "translation": "Bản dịch tiếng Việt / giải thích nghĩa",',
    '      "ttsText": "Câu tiếng Anh chuẩn để đọc TTS (không chứa emoji)",',
    '      "options": ["Đáp án A", "Đáp án B"],',
    '      "answerIndex": 0,',
    '      "explanation": "Giải thích đáp án (chỉ cần cho quiz)"',
    '    }',
    '  ],',
    '  "sceneJson": {',
    '    "title": "Tên bài học",',
    '    "theme": "pastel-sunrise | mint-breeze | soft-lavender | warm-sand | studio-slate",',
    '    "compositionId": "story-scenes | split-compare | word-reveal | 3d-shapes | ...",',
    '    "scenes": [',
    '      {',
    '        "id": "sc1",',
    '        "elements": [',
    '          { "type": "topic_pill", "start": 0, "end": 4, "y": 335, "text": "Topic" },',
    '          { "type": "illustration", "variant": "lightbulb-tip", "start": 0, "end": 4, "y": 620 },',
    '          { "type": "sentence_card", "start": 0, "end": 4, "y": 980, "text": "Main sentence", "badge": "check" }',
    '        ]',
    '      }',
    '    ]',
    '  }',
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
    parsed.cards.forEach((rawCard, idx) => {
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

      const ttsText = String(c.ttsText || content || title).trim();
      const options = Array.isArray(c.options)
        ? c.options.map((o) => String(o).trim()).filter(Boolean)
        : undefined;

      cards.push({
        id: makeCardId(idx),
        type,
        badge: String(c.badge || type.toUpperCase()).trim(),
        title,
        content: content || title,
        phonetic: typeof c.phonetic === 'string' && c.phonetic.trim() ? c.phonetic.trim() : undefined,
        translation:
          typeof c.translation === 'string' && c.translation.trim()
            ? c.translation.trim()
            : undefined,
        ttsText,
        options: options && options.length > 0 ? options : undefined,
        answerIndex: typeof c.answerIndex === 'number' ? Math.max(0, c.answerIndex) : undefined,
        explanation:
          typeof c.explanation === 'string' && c.explanation.trim()
            ? c.explanation.trim()
            : undefined,
        durationSec: estimateCardSpeechDuration(ttsText),
      });
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

export function reelCardsToLessonProject(
  cards: ReelCard[],
  options?: {
    title?: string;
    subtitle?: string;
    theme?: CanvasThemeId;
    compositionId?: LayoutCompositionId;
    cardDurationsSec?: number[];
    audioFileName?: string;
    sceneJsonOverride?: FlexibleSceneDocument | null;
  },
): LessonProject {
  const safeCards = cards.length > 0 ? cards : buildReelCardsRuleBased('Practice English daily.').cards;
  const cues: TranscriptCue[] = [];
  let cursor = 0;

  safeCards.forEach((card, idx) => {
    const speech = (card.ttsText || card.content || card.title || 'Next').trim();
    const measured = options?.cardDurationsSec?.[idx];
    const dur =
      typeof measured === 'number' && Number.isFinite(measured) && measured > 0.25
        ? measured
        : card.durationSec && card.durationSec > 0.5
          ? card.durationSec
          : estimateCardSpeechDuration(speech);

    const start = Number(cursor.toFixed(3));
    const end = Number((cursor + dur).toFixed(3));
    cues.push({
      id: card.id || `reel-cue-${idx + 1}`,
      start,
      end,
      text: speech,
      words: interpolateWordTimings(speech, start, end),
    });
    cursor = end + 0.08;
  });

  const totalDuration = Number(Math.max(3, cursor).toFixed(2));
  const theme: CanvasThemeId = options?.theme ?? 'pastel-sunrise';
  const isDark = theme === 'studio-slate';

  // If user pasted full custom sceneJson from AI Web and didn't override composition, respect it!
  if (options?.sceneJsonOverride && !options.compositionId) {
    const words = cues.flatMap((c) => c.words);
    return scenePlanToProject(words, options.sceneJsonOverride, {
      title: options.title || options.sceneJsonOverride.title || 'English Reels Studio',
      theme,
      audioFileName: options.audioFileName,
      cuesOverride: cues,
    });
  }

  const elements: LessonProject['elements'] = [];

  // Build synchronized visual cards per ReelCard
  safeCards.forEach((card, idx) => {
    const cue = cues[idx];
    const start = cue.start;
    const end = cue.end;

    // 1. Topic pill at top
    elements.push({
      id: `reel-pill-${idx}`,
      type: 'topic-pill',
      label: `Nhãn: ${card.badge || card.type}`,
      startTime: start,
      endTime: end,
      enterAnimation: 'pop-up',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 270, width: 420, scale: 1, zIndex: 14 },
      props: {
        kind: 'topic-pill',
        text: card.badge || card.type.toUpperCase(),
        bgColor:
          card.type === 'quiz'
            ? '#FEF3C7'
            : card.type === 'intro'
              ? '#E0E7FF'
              : card.type === 'outro'
                ? '#DCFCE7'
                : '#DBEAFE',
        textColor:
          card.type === 'quiz'
            ? '#B45309'
            : card.type === 'intro'
              ? '#3730A3'
              : card.type === 'outro'
                ? '#15803D'
                : '#1D4ED8',
      },
    });

    // 2. Context-matched illustration vector component in upper-middle stage
    const contextVisual = resolveContextualVisualForCue(
      `${card.title} ${card.content} ${card.translation || ''}`,
      card.title,
    );
    elements.push({
      id: `reel-prop-${idx}`,
      type: 'illustration-prop',
      label: `Minh họa #${idx + 1}`,
      startTime: start,
      endTime: end,
      enterAnimation: 'fade-scale',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 580, width: 520, scale: 1, zIndex: 8 },
      props: {
        kind: 'illustration-prop',
        variant: contextVisual.variant,
        data: contextVisual.data,
      },
    });

    // 3. Quiz options OR Sentence Card
    if (card.type === 'quiz' && card.options && card.options.length > 0) {
      elements.push({
        id: `reel-qcard-${idx}`,
        type: 'sentence-card',
        label: `Câu hỏi #${idx + 1}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'pop-up',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: 920, width: 880, scale: 1, zIndex: 20 },
        props: {
          kind: 'sentence-card',
          text: card.content,
          subtext: card.explanation || card.translation,
          badge: 'none',
          emphasisColor: '#4F46E5',
          bgColor: isDark ? 'rgba(15, 23, 42, 0.92)' : '#FFFFFF',
          textColor: isDark ? '#F8FAFC' : '#0F172A',
        },
      });

      elements.push({
        id: `reel-quiz-opts-${idx}`,
        type: 'comparison-strip',
        label: `Lựa chọn #${idx + 1}`,
        startTime: start,
        endTime: end,
        enterAnimation: 'slide-up',
        exitAnimation: 'fade-out',
        layout: { x: 540, y: 1200, width: 900, scale: 1, zIndex: 18 },
        props: {
          kind: 'comparison-strip',
          items: card.options.slice(0, 3).map((opt, oIdx) => ({
            label: `${String.fromCharCode(65 + oIdx)}. ${opt.slice(0, 22)}`,
            sublabel: oIdx === (card.answerIndex ?? 0) ? 'Đúng' : undefined,
            activateAt: start + (end - start) * 0.55,
            accentColor: oIdx === (card.answerIndex ?? 0) ? '#16A34A' : '#64748B',
          })),
        },
      });
    } else {
      const displayHeadline =
        card.type === 'vocab' && card.title !== card.content
          ? `${card.title}${card.phonetic ? ` ${card.phonetic}` : ''}`
          : card.content;
      const displaySub =
        card.type === 'vocab' && card.title !== card.content
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
        layout: { x: 540, y: 985, width: 860, scale: 1, zIndex: 20 },
        props: {
          kind: 'sentence-card',
          text: displayHeadline,
          subtext: displaySub,
          badge: card.type === 'outro' ? 'check' : 'none',
          emphasisWord: card.type === 'vocab' ? card.title : undefined,
          emphasisColor: '#2563EB',
          bgColor: isDark ? 'rgba(15, 23, 42, 0.92)' : '#FFFFFF',
          textColor: isDark ? '#F8FAFC' : '#0F172A',
        },
      });
    }

    // 4. Karaoke subtitle card at bottom
    elements.push({
      id: `reel-karaoke-${idx}`,
      type: 'karaoke-card',
      label: `Sub động #${idx + 1}`,
      startTime: start,
      endTime: end,
      enterAnimation: 'slide-up',
      exitAnimation: 'fade-out',
      layout: { x: 540, y: 1510, width: 880, scale: 1, zIndex: 35 },
      props: {
        kind: 'karaoke-card',
        cueId: cue.id,
        words: cue.words,
        variant: isDark ? 'dark-bar' : 'white-card',
        activeColor: isDark ? '#FACC15' : '#2563EB',
        inactiveColor: isDark ? '#CBD5E1' : '#9CA3AF',
        spokenColor: isDark ? '#FFFFFF' : '#111827',
      },
    });
  });

  const baseProject: LessonProject = {
    id: `reels-${Date.now().toString(36)}`,
    title: options?.title || safeCards[0]?.title || 'English Reels Studio Video',
    subtitle: options?.subtitle || 'English Reels Studio × KineticSub 9:16',
    theme,
    compositionId: options?.compositionId || 'story-scenes',
    duration: totalDuration,
    fps: 30,
    audioFileName: options?.audioFileName,
    cues,
    elements,
  };

  return options?.compositionId
    ? applyCompositionToProject(baseProject, options.compositionId, { theme })
    : baseProject;
}

export function buildReelPromptBundleForSubtitles(
  cues: TranscriptCue[],
  title: string,
  style: PromptVideoStyle = 'tiktok-cards',
): string {
  return buildSceneGenerationPrompt(cues, { title, style });
}
