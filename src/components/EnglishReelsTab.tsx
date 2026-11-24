import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  CopyPlus,
  Download,
  ExternalLink,
  Film,
  Globe,
  HelpCircle,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Sparkles,
  Stamp,
  Square,
  Trash2,
  Volume2,
} from 'lucide-react';
import {
  ensureProjectAssetsLoaded,
  renderProjectFrame,
  STAGE_HEIGHT,
  STAGE_WIDTH,
} from '../engine/canvasRenderer';
import {
  buildEnglishReelsWebAiPrompt,
  buildReelCardsRuleBased,
  estimateCardSpeechDuration,
  getQuizCardSpeechParts,
  parseEnglishReelsAiJson,
  ReelCard,
  ReelCardTimingMeta,
  ReelCardType,
  ReelCardVisualConfig,
  ReelMode,
  ReelScrapeResult,
  reelCardsToLessonProject,
  sanitizeTtsSpeech,
} from '../engine/englishReelsEngine';
import { LAYOUT_COMPOSITIONS } from '../engine/illustrationLayouts';
import {
  DEFAULT_MP4_EXPORT_SETTINGS,
  ExportFpsOption,
  ExportQualityId,
  ExportResolutionId,
} from '../engine/mp4Config';
import { ExportAbortedError, exportProjectToVideo } from '../engine/mp4Exporter';
import { FlexibleSceneDocument } from '../engine/scenePlanAdapter';
import { synthesizeAudioWithProgressJob } from '../engine/ttsSyncHelper';
import {
  CANVAS_THEMES,
  CanvasThemeId,
  IllustrationSceneIcon,
  IllustrationVariant,
  LayoutCompositionId,
  LessonProject,
  WatermarkCorner,
  WatermarkOutroConfig,
} from '../engine/types';
import {
  ALL_SCENE_ICONS,
  getEffectiveVectorCatalog,
} from '../engine/vectorComponentDb';
import { ApiKeyInlineControl } from './ApiKeyInlineControl';
import { TtsProviderInfo } from './AudioSubtitleStudioModal';
import { emitOutputUpdated } from './GlobalOutputPanel';
import { buildApiKeyHeaders, useClientApiKeys } from '../utils/apiKeysStore';

interface EnglishReelsTabProps {
  onSendToStudio: (project: LessonProject, audioFile: File | null) => void;
}

const SAMPLE_ARTICLE_TEXT = `## Hotel Check-in & Polite Requests
When arriving at a hotel, polite requests sound much warmer than direct commands.
1. I'd like to check in under the name Alex Morgan.
2. Could we have a quiet room on a higher floor?
3. What time is breakfast served tomorrow morning?

True / False Quiz
Q1. Direct commands like "Give me the room key" always sound friendlier than "Could I have".
(A) True
(B) False
Answer: B
Explanation: Modal verbs like "Could I" soften the request and sound polite in hospitality English.`;

function base64ToMp3File(base64: string, fileName: string): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], fileName, { type: 'audio/mpeg' });
}

async function parseApiJson<T = Record<string, any>>(
  res: Response,
  fallbackError: string,
): Promise<T> {
  const raw = await res.text();
  const trimmed = raw.trim();
  if (!trimmed) {
    if (!res.ok) throw new Error(`${fallbackError} (HTTP ${res.status})`);
    return {} as T;
  }
  if (trimmed.startsWith('<')) {
    throw new Error(`Server trả về HTML (HTTP ${res.status}) thay vì JSON.`);
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(res.ok ? `${fallbackError}: JSON không hợp lệ.` : `${fallbackError} (HTTP ${res.status})`);
  }
}

export const EnglishReelsTab: React.FC<EnglishReelsTabProps> = ({ onSendToStudio }) => {
  // ── 1. URL Scraper & Content ───────────────────────────────────────────────
  const [urlInput, setUrlInput] = useState('');
  const [isScraping, setIsScraping] = useState(false);
  const [scrapeError, setScrapeError] = useState<string | null>(null);
  const [scrapeResult, setScrapeResult] = useState<ReelScrapeResult | null>(null);

  const [lessonTitle, setLessonTitle] = useState('Hotel Check-in & Polite Requests');
  const [rawText, setRawText] = useState(SAMPLE_ARTICLE_TEXT);
  const [mode, setMode] = useState<ReelMode>('auto');
  const [targetLang, setTargetLang] = useState('Tiếng Việt');

  // ── 2. Web AI Prompt & JSON Paste ──────────────────────────────────────────
  const [pastedAiJson, setPastedAiJson] = useState('');
  const [aiJsonError, setAiJsonError] = useState<string | null>(null);
  const [aiJsonNotice, setAiJsonNotice] = useState<string | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [sceneJsonOverride, setSceneJsonOverride] = useState<FlexibleSceneDocument | null>(null);

  // ── 3. Cards Editor State ──────────────────────────────────────────────────
  const [cards, setCards] = useState<ReelCard[]>(() =>
    buildReelCardsRuleBased(SAMPLE_ARTICLE_TEXT, {
      title: 'Hotel Check-in & Polite Requests',
      mode: 'auto',
      targetLang: 'Tiếng Việt',
    }).cards,
  );
  const [activeCardIdx, setActiveCardIdx] = useState(0);

  // ── 4. TTS Multi-Provider & Live Video Render State ────────────────────────
  const [ttsProviders, setTtsProviders] = useState<TtsProviderInfo[]>([]);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [hasElevenLabsKey, setHasElevenLabsKey] = useState(false);
  const [ttsProvider, setTtsProvider] = useState('auto');
  const [ttsVoice, setTtsVoice] = useState('en-US-JennyNeural');
  const [ttsRate, setTtsRate] = useState(1.0);
  const [selectedTheme, setSelectedTheme] = useState<CanvasThemeId>('pastel-sunrise');
  const [selectedComposition, setSelectedComposition] = useState<LayoutCompositionId>('story-scenes');

  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [isGeneratingAiCards, setIsGeneratingAiCards] = useState(false);
  const [isPreviewingVoice, setIsPreviewingVoice] = useState(false);
  const [ttsProgress, setTtsProgress] = useState(0);
  const [ttsStageLabel, setTtsStageLabel] = useState('');
  const [studioError, setStudioError] = useState<string | null>(null);
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [watermarkConfig, setWatermarkConfig] = useState<WatermarkOutroConfig>({
    watermarkEnabled: false,
    watermarkText: '@EnglishReels',
    watermarkCorner: 'bottom-right',
    watermarkOpacity: 0.7,
    outroSeconds: 0,
    outroLine1: 'Thanks for watching!',
    outroLine2: 'Follow for more English tips',
  });
  const [isWatermarkExpanded, setIsWatermarkExpanded] = useState(false);

  // Live Video 9:16 preview & direct MP4 export state
  const [previewViewMode, setPreviewViewMode] = useState<'video' | 'cards'>('video');
  const [generatedAudioFile, setGeneratedAudioFile] = useState<File | null>(null);
  const [generatedAudioUrl, setGeneratedAudioUrl] = useState<string | null>(null);
  const [generatedDurations, setGeneratedDurations] = useState<number[] | undefined>(undefined);
  const [generatedTimings, setGeneratedTimings] = useState<ReelCardTimingMeta[] | undefined>(undefined);
  const [isVideoPlaying, setIsVideoPlaying] = useState(false);
  const [videoTime, setVideoTime] = useState(0.5);
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [exportStageLabel, setExportStageLabel] = useState('');
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [mp4Resolution, setMp4Resolution] = useState<ExportResolutionId>(DEFAULT_MP4_EXPORT_SETTINGS.resolution);
  const [mp4Quality, setMp4Quality] = useState<ExportQualityId>(DEFAULT_MP4_EXPORT_SETTINGS.quality);
  const [mp4Fps, setMp4Fps] = useState<ExportFpsOption>(DEFAULT_MP4_EXPORT_SETTINGS.fps);

  const videoCanvasRef = useRef<HTMLCanvasElement>(null);
  const lessonAudioRef = useRef<HTMLAudioElement>(null);
  const videoRafRef = useRef<number | null>(null);
  const lastRafTsRef = useRef<number | null>(null);
  const exportAbortRef = useRef<AbortController | null>(null);

  const { keys: clientKeys } = useClientApiKeys();

  const refreshTtsVoices = () => {
    fetch('/api/tts/voices', { headers: buildApiKeyHeaders() })
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.providers)) {
          setTtsProviders(data.providers);
          setHasGeminiKey(Boolean(data?.hasGeminiKey));
          setHasElevenLabsKey(Boolean(data?.hasElevenLabsKey));
        }
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    refreshTtsVoices();
  }, []);

  useEffect(() => {
    return () => {
      if (previewAudioUrl) URL.revokeObjectURL(previewAudioUrl);
    };
  }, [previewAudioUrl]);

  useEffect(() => {
    return () => {
      if (generatedAudioUrl) URL.revokeObjectURL(generatedAudioUrl);
    };
  }, [generatedAudioUrl]);

  const effectiveHasGeminiKey = hasGeminiKey || Boolean(clientKeys.geminiApiKey);
  const effectiveHasElevenLabsKey = hasElevenLabsKey || Boolean(clientKeys.elevenlabsApiKey);

  const availableVoices = useMemo(() => {
    if (ttsProvider === 'auto') {
      return ttsProviders.flatMap((p) => {
        if (p.id === 'gemini' && !effectiveHasGeminiKey) return [];
        if (p.id === 'elevenlabs' && !effectiveHasElevenLabsKey) return [];
        return p.voices;
      });
    }
    return ttsProviders.find((p) => p.id === ttsProvider)?.voices ?? [];
  }, [ttsProviders, ttsProvider, effectiveHasGeminiKey, effectiveHasElevenLabsKey]);

  useEffect(() => {
    if (availableVoices.length > 0 && !availableVoices.some((v) => v.id === ttsVoice)) {
      setTtsVoice(availableVoices[0].id);
    }
  }, [availableVoices, ttsVoice]);

  const vectorCatalog = useMemo(() => getEffectiveVectorCatalog(), []);

  const previewProject = useMemo(
    () =>
      reelCardsToLessonProject(cards, {
        title: lessonTitle,
        theme: selectedTheme,
        compositionId: sceneJsonOverride ? undefined : selectedComposition,
        cardDurationsSec:
          generatedDurations && generatedDurations.length === cards.length
            ? generatedDurations
            : undefined,
        cardTimings:
          generatedTimings && generatedTimings.length === cards.length
            ? generatedTimings
            : undefined,
        audioFileName: generatedAudioFile?.name,
        sceneJsonOverride,
        watermark: watermarkConfig,
      }),
    [
      cards,
      lessonTitle,
      selectedTheme,
      selectedComposition,
      generatedDurations,
      generatedTimings,
      generatedAudioFile?.name,
      sceneJsonOverride,
      watermarkConfig,
    ],
  );

  useEffect(() => {
    setVideoTime((prev) => Math.min(prev, Math.max(0.1, previewProject.duration)));
  }, [previewProject.duration]);

  useEffect(() => {
    if (previewViewMode !== 'video') return;
    const canvas = videoCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    void ensureProjectAssetsLoaded(previewProject).then(() => {
      renderProjectFrame(ctx, previewProject, videoTime, null);
    });
  }, [previewProject, videoTime, previewViewMode]);

  useEffect(() => {
    if (!isVideoPlaying) {
      if (videoRafRef.current !== null) cancelAnimationFrame(videoRafRef.current);
      lastRafTsRef.current = null;
      if (lessonAudioRef.current && !lessonAudioRef.current.paused) {
        lessonAudioRef.current.pause();
      }
      return;
    }

    if (lessonAudioRef.current && generatedAudioUrl) {
      lessonAudioRef.current.currentTime = videoTime;
      lessonAudioRef.current.play().catch(() => undefined);
    }

    const step = (now: number) => {
      if (lessonAudioRef.current && generatedAudioUrl && !lessonAudioRef.current.paused) {
        const nextT = lessonAudioRef.current.currentTime;
        if (nextT >= previewProject.duration) {
          setVideoTime(0);
          setIsVideoPlaying(false);
          return;
        }
        setVideoTime(nextT);
      } else {
        if (lastRafTsRef.current === null) lastRafTsRef.current = now;
        const dt = (now - lastRafTsRef.current) / 1000;
        lastRafTsRef.current = now;
        setVideoTime((prev) => {
          const next = prev + dt;
          if (next >= previewProject.duration) {
            setIsVideoPlaying(false);
            return 0;
          }
          return next;
        });
      }
      videoRafRef.current = requestAnimationFrame(step);
    };

    videoRafRef.current = requestAnimationFrame(step);
    return () => {
      if (videoRafRef.current !== null) cancelAnimationFrame(videoRafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVideoPlaying, previewProject.duration, generatedAudioUrl]);

  const webAiPrompt = useMemo(
    () =>
      buildEnglishReelsWebAiPrompt({
        sourceText: rawText,
        sourceUrl: urlInput.trim() || undefined,
        title: lessonTitle,
        mode,
        targetLang,
        compositionId: selectedComposition,
      }),
    [rawText, urlInput, lessonTitle, mode, targetLang, selectedComposition],
  );

  const safeActiveIdx = Math.min(activeCardIdx, Math.max(0, cards.length - 1));
  const activeCard = cards[safeActiveIdx] ?? null;

  const handleScrapeUrl = async (targetUrl?: string) => {
    const cleanUrl = (targetUrl ?? urlInput).trim();
    if (!cleanUrl) {
      setScrapeError('Vui lòng nhập URL bài học tiếng Anh (Reading / Quiz / Vocab).');
      return;
    }
    setUrlInput(cleanUrl);
    setScrapeError(null);
    setIsScraping(true);
    try {
      const res = await fetch('/api/scraper/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
      });
      const data = await parseApiJson<ReelScrapeResult & { error?: string }>(
        res,
        'Không thể bóc nội dung từ URL',
      );
      if (!res.ok) {
        throw new Error(data?.error || 'Không thể bóc nội dung từ URL.');
      }
      const result = data as ReelScrapeResult;
      setScrapeResult(result);
      if (result.title) setLessonTitle(result.title);
      if (result.rawText) {
        setRawText(result.rawText);
        if (result.detectedMode) setMode(result.detectedMode);
        const built = buildReelCardsRuleBased(result.rawText, {
          title: result.title,
          mode: result.detectedMode || 'auto',
          targetLang,
        });
        setCards(built.cards);
        setActiveCardIdx(0);
        setSceneJsonOverride(null);
      }
    } catch (err) {
      setScrapeError(err instanceof Error ? err.message : 'Lỗi bóc nội dung URL.');
    } finally {
      setIsScraping(false);
    }
  };

  const handleCopyPrompt = async () => {
    try {
      await navigator.clipboard.writeText(webAiPrompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch {
      setCopiedPrompt(false);
    }
  };

  const handleApplyPastedAiJson = () => {
    setAiJsonError(null);
    setAiJsonNotice(null);
    const parsed = parseEnglishReelsAiJson(pastedAiJson);
    if (!parsed) {
      setAiJsonError(
        'Không đọc được JSON định dạng chuẩn English Reels / KineticSub. Hãy copy toàn bộ đoạn JSON AI trả về.',
      );
      return;
    }
    setLessonTitle(parsed.title);
    setMode(parsed.mode);
    setCards(parsed.cards);
    setSceneJsonOverride(parsed.sceneJson ?? null);
    setActiveCardIdx(0);
    setAiJsonNotice(
      `Đã nạp ${parsed.cards.length} thẻ (${parsed.mode.toUpperCase()})${parsed.sceneJson ? ' kèm Scene JSON KineticSub' : ''}!`,
    );
  };

  const handleQuickRuleExtract = () => {
    setAiJsonError(null);
    const built = buildReelCardsRuleBased(rawText, {
      title: lessonTitle,
      mode,
      targetLang,
    });
    setCards(built.cards);
    setActiveCardIdx(0);
    setSceneJsonOverride(null);
    setAiJsonNotice(`Đã tách nhanh ${built.cards.length} thẻ (${built.mode.toUpperCase()}) từ nội dung.`);
  };

  // ── Card CRUD Helpers ──────────────────────────────────────────────────────
  const updateCard = (index: number, patch: Partial<ReelCard>) => {
    setCards((prev) =>
      prev.map((c, idx) => {
        if (idx !== index) return c;
        const next = { ...c, ...patch };
        if (patch.ttsText !== undefined) {
          next.durationSec = estimateCardSpeechDuration(patch.ttsText);
        }
        return next;
      }),
    );
  };

  const handleAddCard = (type: ReelCardType) => {
    const newCard: ReelCard =
      type === 'quiz'
        ? {
            id: `card-${Date.now().toString(36)}`,
            type: 'quiz',
            badge: `QUIZ #${cards.length + 1}`,
            title: `Question ${cards.length + 1}`,
            content: 'Which sentence sounds more polite?',
            translation: targetLang !== 'none' ? 'Câu nào nghe lịch sự hơn?' : undefined,
            ttsText: 'Which sentence sounds more polite?',
            options: ['Give me water', 'Could I have some water?'],
            answerIndex: 1,
            explanation: '"Could I" softens direct requests.',
            durationSec: 3.4,
          }
        : {
            id: `card-${Date.now().toString(36)}`,
            type: 'vocab',
            badge: `CARD #${cards.length + 1}`,
            title: 'Key Phrase',
            content: 'Excuse me, could you help me with this?',
            phonetic: '/ɪkˈskjuːz miː/',
            translation: targetLang !== 'none' ? 'Xin lỗi, bạn có thể giúp tôi việc này không?' : undefined,
            ttsText: 'Excuse me, could you help me with this?',
            durationSec: 3.5,
          };
    setCards((prev) => {
      const next = [...prev, newCard];
      setActiveCardIdx(next.length - 1);
      return next;
    });
  };

  const handleMoveCard = (idx: number, dir: -1 | 1) => {
    const target = idx + dir;
    if (target < 0 || target >= cards.length) return;
    setCards((prev) => {
      const next = [...prev];
      const [moved] = next.splice(idx, 1);
      next.splice(target, 0, moved);
      return next;
    });
    setActiveCardIdx(target);
  };

  const handleDuplicateCard = (idx: number) => {
    const source = cards[idx];
    if (!source) return;
    const copy: ReelCard = {
      ...source,
      id: `card-${Date.now().toString(36)}`,
      title: `${source.title} (Bản sao)`,
    };
    setCards((prev) => {
      const next = [...prev];
      next.splice(idx + 1, 0, copy);
      return next;
    });
    setActiveCardIdx(idx + 1);
  };

  const handleDeleteCard = (idx: number) => {
    if (cards.length <= 1) return;
    setCards((prev) => prev.filter((_, i) => i !== idx));
    setActiveCardIdx((prevIdx) => Math.max(0, Math.min(prevIdx, cards.length - 2)));
  };

  const selectedVoiceLang = availableVoices.find((v) => v.id === ttsVoice)?.lang || 'en-US';

  const updateCardVisual = (index: number, patch: Partial<ReelCardVisualConfig>) => {
    setCards((prev) =>
      prev.map((c, idx) =>
        idx === index ? { ...c, visual: { ...(c.visual || {}), ...patch } } : c,
      ),
    );
  };

  const handlePreviewSingleCardVoice = async () => {
    if (!activeCard) return;
    setIsPreviewingVoice(true);
    setTtsProgress(5);
    setTtsStageLabel('Đang tạo audio nghe thử thẻ...');
    setStudioError(null);
    try {
      const segments: Array<{ id: string; text: string; pauseAfterSec?: number }> = [];
      if (activeCard.type === 'quiz' && activeCard.options?.length) {
        const { questionSpeech, answerSpeech, thinkSec } = getQuizCardSpeechParts(activeCard);
        if (questionSpeech) {
          segments.push({ id: `${activeCard.id}-q`, text: questionSpeech, pauseAfterSec: thinkSec });
        }
        if (answerSpeech) {
          segments.push({ id: `${activeCard.id}-a`, text: answerSpeech, pauseAfterSec: 0 });
        }
      } else {
        const cleanSpeech =
          sanitizeTtsSpeech(activeCard.ttsText || activeCard.content || activeCard.title) ||
          activeCard.content;
        segments.push({ id: activeCard.id, text: cleanSpeech });
      }
      const data = await synthesizeAudioWithProgressJob(
        {
          provider: ttsProvider,
          voice: ttsVoice,
          lang: selectedVoiceLang,
          rate: ttsRate,
          segments,
        },
        (pct, lbl) => {
          setTtsProgress(pct);
          setTtsStageLabel(lbl);
        },
      );
      if (!data?.audioBase64) {
        throw new Error(data?.error || 'Không phát thử được TTS.');
      }
      const file = base64ToMp3File(data.audioBase64, 'preview.mp3');
      const nextUrl = URL.createObjectURL(file);
      setPreviewAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return nextUrl;
      });
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : 'Lỗi phát thử giọng đọc.');
    } finally {
      setIsPreviewingVoice(false);
      setTtsProgress(0);
      setTtsStageLabel('');
    }
  };

  const synthesizeLessonAudioBundle = async (): Promise<{
    audioFile: File;
    durations: number[] | undefined;
    timings: ReelCardTimingMeta[] | undefined;
    project: LessonProject;
  }> => {
    const segments: Array<{ id: string; text: string; pauseAfterSec?: number }> = [];
    const cardMapping: Array<{ qIdx: number; aIdx: number | null; thinkSec: number }> = [];

    for (const c of cards) {
      if (c.type === 'quiz' && c.options && c.options.length > 0) {
        const { questionSpeech, answerSpeech, thinkSec } = getQuizCardSpeechParts(c);
        const qIdx = segments.length;
        segments.push({
          id: `${c.id}-q`,
          text: questionSpeech || 'Quiz question.',
          pauseAfterSec: thinkSec,
        });
        let aIdx: number | null = null;
        if (answerSpeech) {
          aIdx = segments.length;
          segments.push({
            id: `${c.id}-a`,
            text: answerSpeech,
            pauseAfterSec: 0,
          });
        }
        cardMapping.push({ qIdx, aIdx, thinkSec });
      } else {
        const cleanSpeech =
          sanitizeTtsSpeech(c.ttsText || c.content || c.title) || 'Next lesson point.';
        const qIdx = segments.length;
        segments.push({ id: c.id, text: cleanSpeech, pauseAfterSec: 0 });
        cardMapping.push({ qIdx, aIdx: null, thinkSec: 0 });
      }
    }

    setTtsProgress(4);
    setTtsStageLabel('Đang tạo giọng đọc bài học...');
    const data = await synthesizeAudioWithProgressJob(
      {
        provider: ttsProvider,
        voice: ttsVoice,
        lang: selectedVoiceLang,
        rate: ttsRate,
        segments,
      },
      (pct, lbl) => {
        setTtsProgress(pct);
        setTtsStageLabel(lbl);
      },
    );
    if (!data?.audioBase64) {
      throw new Error(data?.error || 'Không thể tạo audio TTS từ server.');
    }

    const safeFileName = `${lessonTitle.replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 32) || 'english_reels'}.mp3`;
    const audioFile = base64ToMp3File(data.audioBase64, safeFileName);

    const segDurs: number[] = Array.isArray(data.segmentDurations) ? data.segmentDurations : [];
    const spokenDurs: number[] = Array.isArray(data.spokenDurations) ? data.spokenDurations : segDurs;
    const pauseDurs: number[] = Array.isArray(data.pauseDurations) ? data.pauseDurations : [];

    let timings: ReelCardTimingMeta[] | undefined;
    let durations: number[] | undefined;
    if (segDurs.length === segments.length) {
      timings = cardMapping.map((m) => {
        const qSpoken = spokenDurs[m.qIdx] ?? segDurs[m.qIdx] ?? 2.8;
        const pDur = pauseDurs[m.qIdx] ?? 0;
        const aSpoken = m.aIdx !== null ? segDurs[m.aIdx] ?? 2.6 : undefined;
        const totalSec = Number((qSpoken + pDur + (aSpoken ?? 0)).toFixed(3));
        return {
          totalSec,
          questionSec: m.aIdx !== null ? qSpoken : undefined,
          thinkSec: m.aIdx !== null ? pDur : undefined,
          answerSec: aSpoken,
        };
      });
      durations = timings.map((t) => t.totalSec);
    }

    const nextAudioUrl = URL.createObjectURL(audioFile);
    setGeneratedAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return nextAudioUrl;
    });
    setGeneratedAudioFile(audioFile);
    setGeneratedDurations(durations);
    setGeneratedTimings(timings);

    const proj = reelCardsToLessonProject(cards, {
      title: lessonTitle,
      theme: selectedTheme,
      compositionId: sceneJsonOverride ? undefined : selectedComposition,
      cardDurationsSec: durations,
      cardTimings: timings,
      audioFileName: safeFileName,
      sceneJsonOverride,
      watermark: watermarkConfig,
    });
    return { audioFile, durations, timings, project: proj };
  };

  const handleGeneratePreviewVideoAudio = async () => {
    if (cards.length === 0) return;
    setStudioError(null);
    setExportNotice(null);
    setIsGeneratingAudio(true);
    try {
      await synthesizeLessonAudioBundle();
      setPreviewViewMode('video');
      setVideoTime(0);
      setIsVideoPlaying(true);
      setExportNotice('Đã tạo giọng đọc chuẩn & đồng bộ vào Video 9:16 xem thử!');
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : 'Lỗi khi tạo Audio TTS.');
    } finally {
      setIsGeneratingAudio(false);
      setTtsProgress(0);
      setTtsStageLabel('');
    }
  };

  const handleDirectRenderVideo = async () => {
    if (cards.length === 0 || isExportingVideo) return;
    setIsVideoPlaying(false);
    setStudioError(null);
    setExportNotice(null);
    setIsExportingVideo(true);
    setExportProgress(0.02);
    setExportStageLabel('Đang chuẩn bị âm thanh & cảnh 9:16...');

    const controller = new AbortController();
    exportAbortRef.current = controller;

    try {
      let targetProject = previewProject;
      let targetAudio = generatedAudioFile;

      if (!targetAudio) {
        setExportStageLabel('Đang tạo giọng đọc bài học (TTS)...');
        const bundled = await synthesizeLessonAudioBundle();
        targetProject = bundled.project;
        targetAudio = bundled.audioFile;
      }

      if (controller.signal.aborted) {
        throw new ExportAbortedError();
      }

      const result = await exportProjectToVideo(
        targetProject,
        targetAudio,
        ({ progress, stageLabel }) => {
          setExportProgress(progress);
          setExportStageLabel(stageLabel);
        },
        {
          aspectRatio: '9:16',
          resolution: mp4Resolution,
          quality: mp4Quality,
          fps: mp4Fps,
        },
        {
          signal: controller.signal,
          alsoSaveToServerOutput: true,
          sourceTab: 'English Reels',
        },
      );

      emitOutputUpdated({ sourceTab: 'English Reels' });
      setExportNotice(
        `Đã xuất thành công ${result.fileName}${result.savedPath ? ` (lưu tại ${result.savedPath})` : ''}!`,
      );
    } catch (err) {
      if (err instanceof ExportAbortedError || controller.signal.aborted) {
        setExportNotice('Đã hủy quá trình render Video.');
      } else {
        setStudioError(err instanceof Error ? err.message : 'Không thể render Video MP4.');
      }
    } finally {
      exportAbortRef.current = null;
      setIsExportingVideo(false);
      setExportProgress(0);
      setExportStageLabel('');
    }
  };

  const handleServerAiGenerateCards = async () => {
    if (!effectiveHasGeminiKey || isGeneratingAiCards) return;
    setIsGeneratingAiCards(true);
    setAiJsonError(null);
    setAiJsonNotice(null);
    try {
      const res = await fetch('/api/ai/generate-scene', {
        method: 'POST',
        headers: buildApiKeyHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ prompt: webAiPrompt }),
      });
      const data = await parseApiJson<{ text?: string; error?: string }>(
        res,
        'Gemini không trả về kết quả hợp lệ',
      );
      if (!res.ok || !data?.text) {
        throw new Error(data?.error || 'Gemini không trả về kết quả hợp lệ.');
      }
      setPastedAiJson(data.text);
      const parsed = parseEnglishReelsAiJson(data.text);
      if (!parsed) {
        throw new Error('JSON AI trả về chưa khớp schema cards.');
      }
      setLessonTitle(parsed.title);
      setMode(parsed.mode);
      setCards(parsed.cards);
      setSceneJsonOverride(parsed.sceneJson ?? null);
      setActiveCardIdx(0);
      setAiJsonNotice(`AI Server đã tạo ${parsed.cards.length} thẻ bài học kèm lời đọc tự nhiên!`);
    } catch (err) {
      setAiJsonError(err instanceof Error ? err.message : 'Lỗi gọi Gemini AI trên server.');
    } finally {
      setIsGeneratingAiCards(false);
    }
  };

  const handleGenerateAndSendToStudio = async (withTtsAudio: boolean) => {
    if (cards.length === 0) return;
    setStudioError(null);

    if (!withTtsAudio) {
      onSendToStudio(previewProject, generatedAudioFile);
      return;
    }

    setIsGeneratingAudio(true);
    try {
      const bundled = await synthesizeLessonAudioBundle();
      onSendToStudio(bundled.project, bundled.audioFile);
    } catch (err) {
      setStudioError(err instanceof Error ? err.message : 'Lỗi khi tạo Audio TTS.');
    } finally {
      setIsGeneratingAudio(false);
    }
  };

  return (
    <div className="max-w-[1400px] w-full mx-auto p-4 lg:p-6 space-y-5">
      {/* Top Hero / URL Scraper Bar */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-bold text-slate-900">
              English Reels Studio — Bóc Bài Học · Prompt AI Web · Biên Tập Thẻ 9:16
            </h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Bóc nội dung URL (lọc quảng cáo/menu, phát hiện mục lục &amp; nhiều bài tập), tạo Prompt AI Web lấy JSON chuẩn hoặc tách thẻ tức thì rồi đẩy thẳng sang KineticSub Studio dựng MP4.
            </p>
          </div>
          <span className="text-xs font-medium text-indigo-700 tabular-nums whitespace-nowrap">
            {cards.length} thẻ đang soạn
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[260px]">
            <Globe className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="url"
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              placeholder="Dán URL bài học tiếng Anh (Reading, True/False, Comprehension, Vocabulary)..."
              className="w-full pl-9 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <button
            type="button"
            disabled={isScraping}
            onClick={() => void handleScrapeUrl()}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-60 whitespace-nowrap"
          >
            {isScraping ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Globe className="w-3.5 h-3.5" />}
            <span>{isScraping ? 'Đang bóc nội dung...' : 'Bóc nội dung URL'}</span>
          </button>
        </div>

        {scrapeError && (
          <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">
            {scrapeError}
          </p>
        )}

        {/* Directory / Sub-lesson Links if URL is a Table of Contents */}
        {scrapeResult && scrapeResult.links.length > 0 && (
          <div className="p-3 rounded-xl bg-indigo-50/60 border border-indigo-200 space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs font-semibold text-indigo-900">
              <span>
                {scrapeResult.isDirectoryPage
                  ? 'Phát hiện trang Mục Lục — bấm chọn bài học con để bóc trực tiếp:'
                  : `Tìm thấy ${scrapeResult.links.length} bài tập / liên kết con trên trang:`}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
              {scrapeResult.links.map((lk) => (
                <button
                  key={lk.url}
                  type="button"
                  onClick={() => void handleScrapeUrl(lk.url)}
                  className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-indigo-800 bg-white border border-indigo-200 rounded-md hover:bg-indigo-100 transition-colors"
                >
                  <span className="truncate max-w-[220px]">{lk.title}</span>
                  <ExternalLink className="w-3 h-3 shrink-0 opacity-60" />
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Multi-Exercise Picker */}
        {scrapeResult && scrapeResult.exercises.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 pt-1">
            <span className="text-[11px] font-semibold text-slate-600">Các bài tập con tách được:</span>
            {scrapeResult.exercises.map((ex) => (
              <button
                key={ex.id}
                type="button"
                onClick={() => {
                  setRawText(ex.rawText);
                  setMode(ex.mode);
                  setLessonTitle(ex.title);
                  const built = buildReelCardsRuleBased(ex.rawText, {
                    title: ex.title,
                    mode: ex.mode,
                    targetLang,
                  });
                  setCards(built.cards);
                  setActiveCardIdx(0);
                }}
                className="px-2.5 py-1 text-[11px] font-medium bg-slate-100 hover:bg-indigo-50 border border-slate-200 rounded-md text-slate-700"
              >
                {ex.title} ({ex.mode})
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Main 2-Column Workspace */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left: Content, Web AI Prompt & Card Editor */}
        <div className="lg:col-span-7 space-y-4">
          {/* Source Text + Prompt AI Web Box */}
          <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
              <div className="sm:col-span-1">
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Tên bài học
                </label>
                <input
                  type="text"
                  value={lessonTitle}
                  onChange={(e) => setLessonTitle(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Dạng bài nhận diện
                </label>
                <select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as ReelMode)}
                  className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                >
                  <option value="auto">Tự động (Reading / Quiz / Vocab)</option>
                  <option value="reading">Reading (Đoạn đọc)</option>
                  <option value="quiz">Quiz (True/False &amp; Comprehension)</option>
                  <option value="vocab">Vocabulary (Từ vựng &amp; IPA)</option>
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Bản dịch mục tiêu
                </label>
                <select
                  value={targetLang}
                  onChange={(e) => setTargetLang(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                >
                  <option value="Tiếng Việt">Dịch sang Tiếng Việt</option>
                  <option value="none">Không cần bản dịch</option>
                  <option value="English">Giải thích bằng English</option>
                  <option value="日本語">Dịch sang Tiếng Nhật</option>
                </select>
              </div>
            </div>

            <div>
              <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                <label className="text-[11px] font-semibold text-slate-700">
                  Nội dung đã lọc sạch (hoặc dán văn bản bài đọc / từ vựng / câu hỏi)
                </label>
                <div className="flex items-center gap-3">
                  {effectiveHasGeminiKey && (
                    <button
                      type="button"
                      disabled={isGeneratingAiCards}
                      onClick={() => void handleServerAiGenerateCards()}
                      className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 disabled:opacity-50"
                    >
                      {isGeneratingAiCards ? (
                        <Loader2 className="w-3 h-3 animate-spin" />
                      ) : (
                        <Sparkles className="w-3 h-3" />
                      )}
                      <span>{isGeneratingAiCards ? 'AI đang soạn bài...' : 'AI Server soạn Thẻ chuẩn'}</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={handleQuickRuleExtract}
                    className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-700"
                  >
                    Tách thẻ nhanh không cần AI →
                  </button>
                </div>
              </div>
              <textarea
                rows={5}
                value={rawText}
                onChange={(e) => setRawText(e.target.value)}
                className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>

            {/* Fixed-Schema Prompt Builder for External Web AI */}
            <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-bold text-slate-900">
                    Tạo Prompt gửi AI Web (ChatGPT / Gemini / Claude) → xuất JSON cố định
                  </h3>
                  <p className="text-[11px] text-slate-500">
                    Không cần API Key: AI Web sẽ lọc rác, nhận diện Reading/Quiz/Vocab, điền bản dịch và trả về đúng định dạng JSON của app.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void handleCopyPrompt()}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 whitespace-nowrap"
                >
                  {copiedPrompt ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedPrompt ? 'Đã chép Prompt!' : 'Sao chép Prompt AI Web'}</span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                <textarea
                  readOnly
                  rows={5}
                  value={webAiPrompt}
                  aria-label="Prompt AI Web cho English Reels"
                  className="w-full p-2 text-[10px] font-mono bg-white border border-slate-200 rounded-lg text-slate-700"
                />
                <div className="flex flex-col gap-1.5">
                  <textarea
                    rows={4}
                    value={pastedAiJson}
                    onChange={(e) => {
                      setPastedAiJson(e.target.value);
                      setAiJsonError(null);
                    }}
                    placeholder='Dán nguyên JSON từ AI Web trả về vào đây (hỗ trợ cả ```json ... ```)...'
                    className="w-full flex-1 p-2 text-[10px] font-mono bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500"
                  />
                  <button
                    type="button"
                    disabled={!pastedAiJson.trim()}
                    onClick={handleApplyPastedAiJson}
                    className="w-full py-1.5 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                  >
                    Nạp Thẻ &amp; Kịch bản từ JSON AI Web
                  </button>
                </div>
              </div>

              {aiJsonError && (
                <p className="text-[11px] text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
                  {aiJsonError}
                </p>
              )}
              {aiJsonNotice && (
                <p className="text-[11px] text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2 font-medium">
                  {aiJsonNotice}
                </p>
              )}
            </div>
          </section>

          {/* Interactive Card CRUD List + Editor */}
          <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900">
                Biên tập danh sách Thẻ ({cards.length} thẻ)
              </h2>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => handleAddCard('vocab')}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>+ Thẻ Đọc/Từ vựng</span>
                </button>
                <button
                  type="button"
                  onClick={() => handleAddCard('quiz')}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-semibold text-amber-800 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100"
                >
                  <HelpCircle className="w-3.5 h-3.5" />
                  <span>+ Thẻ Quiz</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
              {/* Card Stack Order */}
              <div className="md:col-span-5 space-y-1.5 max-h-[380px] overflow-y-auto pr-1">
                {cards.map((card, idx) => {
                  const selected = idx === safeActiveIdx;
                  return (
                    <div
                      key={card.id}
                      onClick={() => setActiveCardIdx(idx)}
                      className={`p-2.5 rounded-lg border cursor-pointer transition-colors ${
                        selected
                          ? 'bg-indigo-50/80 border-indigo-300'
                          : 'bg-slate-50/70 border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-1.5">
                        <span className="text-[10px] font-bold text-indigo-700 truncate">
                          #{idx + 1} · {card.badge || card.type.toUpperCase()}
                        </span>
                        <div className="flex items-center gap-0.5 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveCard(idx, -1);
                            }}
                            disabled={idx === 0}
                            title="Lên trên"
                            className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveCard(idx, 1);
                            }}
                            disabled={idx === cards.length - 1}
                            title="Xuống dưới"
                            className="p-1 text-slate-400 hover:text-slate-700 disabled:opacity-30"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDuplicateCard(idx);
                            }}
                            title="Nhân bản thẻ"
                            className="p-1 text-slate-400 hover:text-indigo-600"
                          >
                            <CopyPlus className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDeleteCard(idx);
                            }}
                            disabled={cards.length <= 1}
                            title="Xóa thẻ"
                            className="p-1 text-slate-400 hover:text-red-600 disabled:opacity-30"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                      <div className="text-xs font-medium text-slate-900 truncate mt-1">
                        {card.content || card.title}
                      </div>
                      {card.translation && (
                        <div className="text-[11px] text-slate-500 truncate">{card.translation}</div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Active Card Inspector */}
              {activeCard && (
                <div className="md:col-span-7 p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Loại thẻ
                      </label>
                      <select
                        value={activeCard.type}
                        onChange={(e) =>
                          updateCard(safeActiveIdx, { type: e.target.value as ReelCardType })
                        }
                        className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="intro">Intro (Mở đầu)</option>
                        <option value="vocab">Reading / Vocab</option>
                        <option value="quiz">Quiz (Câu hỏi)</option>
                        <option value="outro">Outro (Tổng kết)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Nhãn (Badge)
                      </label>
                      <input
                        type="text"
                        value={activeCard.badge}
                        onChange={(e) => updateCard(safeActiveIdx, { badge: e.target.value })}
                        className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Tiêu đề / Từ khóa chính
                    </label>
                    <input
                      type="text"
                      value={activeCard.title}
                      onChange={(e) => updateCard(safeActiveIdx, { title: e.target.value })}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                    />
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Nội dung hiển thị trên thẻ 9:16
                    </label>
                    <textarea
                      rows={2}
                      value={activeCard.content}
                      onChange={(e) =>
                        updateCard(safeActiveIdx, { content: e.target.value, ttsText: e.target.value })
                      }
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Phiên âm IPA (tùy chọn)
                      </label>
                      <input
                        type="text"
                        value={activeCard.phonetic || ''}
                        onChange={(e) => updateCard(safeActiveIdx, { phonetic: e.target.value })}
                        placeholder="/ˈnætʃ.ər.əl/"
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-mono"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Bản dịch / Nghĩa
                      </label>
                      <input
                        type="text"
                        value={activeCard.translation || ''}
                        onChange={(e) => updateCard(safeActiveIdx, { translation: e.target.value })}
                        placeholder="Điền bản dịch tiếng Việt..."
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>

                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Câu đọc TTS (tiếng Anh chuẩn)
                    </label>
                    <input
                      type="text"
                      value={activeCard.ttsText}
                      onChange={(e) => updateCard(safeActiveIdx, { ttsText: e.target.value })}
                      className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                    />
                  </div>

                  {activeCard.type === 'quiz' && (
                    <div className="pt-2 border-t border-slate-200 space-y-2">
                      <label className="block text-[11px] font-semibold text-amber-800">
                        Lựa chọn đáp án Quiz &amp; Đếm ngược suy nghĩ
                      </label>
                      <textarea
                        rows={3}
                        value={(activeCard.options || []).join('\n')}
                        onChange={(e) =>
                          updateCard(safeActiveIdx, {
                            options: e.target.value.split('\n').filter((o) => o.trim().length > 0),
                          })
                        }
                        className="w-full p-2 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                      <div className="grid grid-cols-4 gap-2">
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                            Đáp án đúng
                          </label>
                          <select
                            value={activeCard.answerIndex ?? 0}
                            onChange={(e) =>
                              updateCard(safeActiveIdx, { answerIndex: Number(e.target.value) })
                            }
                            className="w-full px-2 py-1 text-xs bg-white border border-slate-200 rounded-lg"
                          >
                            {(activeCard.options || ['True', 'False']).map((opt, oIdx) => (
                              <option key={oIdx} value={oIdx}>
                                {String.fromCharCode(65 + oIdx)}. {opt.slice(0, 14)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                            Suy nghĩ (giây)
                          </label>
                          <input
                            type="number"
                            min={0}
                            max={10}
                            value={activeCard.thinkSec ?? 5}
                            onChange={(e) =>
                              updateCard(safeActiveIdx, {
                                thinkSec: Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                              })
                            }
                            className="w-full px-2 py-1 text-xs bg-white border border-slate-200 rounded-lg tabular-nums"
                          />
                        </div>
                        <div className="col-span-2">
                          <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                            Giải thích đáp án (hiển thị)
                          </label>
                          <input
                            type="text"
                            value={activeCard.explanation || ''}
                            onChange={(e) =>
                              updateCard(safeActiveIdx, { explanation: e.target.value })
                            }
                            className="w-full px-2 py-1 text-xs bg-white border border-slate-200 rounded-lg"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                          Lời đọc công bố đáp án sau {activeCard.thinkSec ?? 5}s (tiếng Anh TTS)
                        </label>
                        <input
                          type="text"
                          value={activeCard.ttsAnswerText || ''}
                          onChange={(e) =>
                            updateCard(safeActiveIdx, { ttsAnswerText: e.target.value })
                          }
                          placeholder="Time is up! The correct answer is..."
                          className="w-full px-2 py-1 text-xs bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                    </div>
                  )}

                  {/* UI Component Customizer per Card */}
                  <div className="pt-2 border-t border-slate-200 space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-[11px] font-semibold text-indigo-800">
                        UI Component minh họa trên thẻ này
                      </label>
                      {activeCard.visual?.variant && (
                        <button
                          type="button"
                          onClick={() => updateCard(safeActiveIdx, { visual: undefined })}
                          className="text-[10px] text-slate-500 hover:text-indigo-600"
                        >
                          Đặt lại tự động
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                          Mẫu Component (Bootstrap / CSS / Kho)
                        </label>
                        <select
                          value={activeCard.visual?.variant || ''}
                          onChange={(e) =>
                            updateCardVisual(safeActiveIdx, {
                              variant: (e.target.value || undefined) as IllustrationVariant | undefined,
                            })
                          }
                          className="w-full px-2 py-1 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="">Tự động theo ngữ cảnh</option>
                          {vectorCatalog.map((item) => (
                            <option key={item.variant} value={item.variant}>
                              {item.label} ({item.variant})
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                          Icon minh họa
                        </label>
                        <select
                          value={activeCard.visual?.sceneIcon || ''}
                          onChange={(e) =>
                            updateCardVisual(safeActiveIdx, {
                              sceneIcon: (e.target.value || undefined) as IllustrationSceneIcon | undefined,
                            })
                          }
                          className="w-full px-2 py-1 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="">Tự chọn Icon</option>
                          {ALL_SCENE_ICONS.map((ic) => (
                            <option key={ic} value={ic}>
                              {ic}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="text"
                        value={activeCard.visual?.title || ''}
                        onChange={(e) => updateCardVisual(safeActiveIdx, { title: e.target.value })}
                        placeholder="Tiêu đề trong Component..."
                        className="w-full px-2 py-1 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                      <input
                        type="text"
                        value={(activeCard.visual?.labels || []).join(', ')}
                        onChange={(e) =>
                          updateCardVisual(safeActiveIdx, {
                            labels: e.target.value
                              .split(',')
                              .map((s) => s.trim())
                              .filter(Boolean),
                          })
                        }
                        placeholder="Các nhãn / bước (phẩy cách)..."
                        className="w-full px-2 py-1 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* Right: 9:16 Live Video Player, TTS Audio & Direct MP4 Export */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 space-y-3.5 sticky top-4">
          {generatedAudioUrl && (
            <audio
              ref={lessonAudioRef}
              src={generatedAudioUrl}
              onEnded={() => setIsVideoPlaying(false)}
            />
          )}

          {/* Mode Toggle: Video 9:16 Live Canvas vs Card Step View */}
          <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-slate-100">
            <div className="inline-flex rounded-lg bg-slate-100 p-0.5 border border-slate-200">
              <button
                type="button"
                onClick={() => setPreviewViewMode('video')}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                  previewViewMode === 'video'
                    ? 'bg-white text-indigo-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Film className="w-3.5 h-3.5" />
                <span>Video 9:16 Live</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setIsVideoPlaying(false);
                  setPreviewViewMode('cards');
                }}
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold rounded-md transition-colors ${
                  previewViewMode === 'cards'
                    ? 'bg-white text-indigo-700 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <BookOpen className="w-3.5 h-3.5" />
                <span>Xem từng Thẻ ({safeActiveIdx + 1}/{cards.length})</span>
              </button>
            </div>

            {previewViewMode === 'cards' && (
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  disabled={safeActiveIdx === 0}
                  onClick={() => setActiveCardIdx((i) => Math.max(0, i - 1))}
                  className="px-2 py-1 text-xs font-medium bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
                >
                  ←
                </button>
                <button
                  type="button"
                  disabled={safeActiveIdx >= cards.length - 1}
                  onClick={() => setActiveCardIdx((i) => Math.min(cards.length - 1, i + 1))}
                  className="px-2 py-1 text-xs font-medium bg-slate-100 rounded hover:bg-slate-200 disabled:opacity-40"
                >
                  →
                </button>
              </div>
            )}
          </div>

          {previewViewMode === 'video' ? (
            <div className="space-y-2.5">
              <div className="relative mx-auto w-full max-w-[270px] aspect-[9/16] rounded-[24px] overflow-hidden border border-slate-200 shadow-sm bg-slate-100">
                <canvas
                  ref={videoCanvasRef}
                  width={STAGE_WIDTH}
                  height={STAGE_HEIGHT}
                  className="w-full h-full block"
                />
                {isExportingVideo && (
                  <div className="absolute inset-0 bg-slate-900/75 backdrop-blur-[2px] flex flex-col items-center justify-center text-white p-4 text-center">
                    <p className="text-xs font-semibold mb-2">
                      {exportStageLabel || 'Đang render MP4...'}
                    </p>
                    <div className="w-40 h-1.5 bg-white/25 rounded-full overflow-hidden mb-1">
                      <div
                        className="h-full bg-indigo-400 transition-all duration-150"
                        style={{ width: `${Math.round(exportProgress * 100)}%` }}
                      />
                    </div>
                    <span className="text-[11px] tabular-nums text-white/85 mb-3">
                      {Math.round(exportProgress * 100)}%
                    </span>
                    <button
                      type="button"
                      onClick={() => exportAbortRef.current?.abort()}
                      className="inline-flex items-center gap-1 px-3 py-1.5 text-[11px] font-semibold bg-rose-600 hover:bg-rose-700 rounded-lg"
                    >
                      <Square className="w-3 h-3 fill-current" />
                      <span>Hủy render</span>
                    </button>
                  </div>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={isExportingVideo}
                  onClick={() => setIsVideoPlaying((p) => !p)}
                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50"
                >
                  {isVideoPlaying ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                  <span>{isVideoPlaying ? 'Tạm dừng' : 'Xem Video'}</span>
                </button>
                <button
                  type="button"
                  disabled={isExportingVideo}
                  onClick={() => {
                    setVideoTime(0);
                    if (lessonAudioRef.current) lessonAudioRef.current.currentTime = 0;
                    setIsVideoPlaying(true);
                  }}
                  title="Phát lại từ đầu"
                  className="p-1.5 text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
                <input
                  type="range"
                  aria-label="Tua thời gian video preview"
                  min={0}
                  max={previewProject.duration}
                  step={0.05}
                  value={videoTime}
                  onChange={(e) => {
                    const nextT = Number(e.target.value);
                    setVideoTime(nextT);
                    if (lessonAudioRef.current) lessonAudioRef.current.currentTime = nextT;
                  }}
                  className="flex-1 accent-indigo-600 h-1.5"
                />
                <span className="text-[11px] font-mono text-slate-500 tabular-nums">
                  {videoTime.toFixed(1)}s / {previewProject.duration.toFixed(1)}s
                </span>
              </div>
            </div>
          ) : (
            activeCard && (
              <div
                className="mx-auto w-full max-w-[290px] aspect-[9/16] rounded-[24px] p-5 flex flex-col justify-between border border-slate-200 shadow-sm"
                style={{
                  background: `linear-gradient(180deg, ${CANVAS_THEMES[selectedTheme]?.bgTop || '#F5F3FF'} 0%, ${CANVAS_THEMES[selectedTheme]?.bgBottom || '#FFF5EB'} 100%)`,
                  color: CANVAS_THEMES[selectedTheme]?.isDark ? '#F8FAFC' : '#0F172A',
                }}
              >
                <div className="flex justify-center pt-2">
                  <span className="px-3 py-1 text-[11px] font-bold tracking-wide bg-indigo-100 text-indigo-800 rounded-lg">
                    {activeCard.badge || activeCard.type.toUpperCase()}
                  </span>
                </div>

                <div className="bg-white text-slate-900 rounded-2xl p-4 shadow-sm border border-slate-200/80 space-y-2.5 text-center">
                  {activeCard.type === 'vocab' && activeCard.title !== activeCard.content && (
                    <div className="text-base font-extrabold text-indigo-700">{activeCard.title}</div>
                  )}
                  {activeCard.phonetic && (
                    <div className="text-xs font-mono text-slate-500">{activeCard.phonetic}</div>
                  )}
                  <div className="text-sm font-bold leading-snug text-slate-900">
                    {activeCard.content}
                  </div>
                  {activeCard.options && activeCard.options.length > 0 && (
                    <div className="space-y-1.5 pt-1 text-left">
                      {activeCard.options.map((opt, idx) => {
                        const isCorrect = idx === (activeCard.answerIndex ?? 0);
                        return (
                          <div
                            key={idx}
                            className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border flex items-center justify-between ${
                              isCorrect
                                ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                                : 'bg-slate-50 border-slate-200 text-slate-700'
                            }`}
                          >
                            <span>
                              {String.fromCharCode(65 + idx)}. {opt}
                            </span>
                            {isCorrect && <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {activeCard.translation && (
                    <div className="text-xs text-slate-600 pt-1 border-t border-slate-100">
                      {activeCard.translation}
                    </div>
                  )}
                  {activeCard.explanation && (
                    <div className="text-[11px] text-emerald-700 font-medium">
                      {activeCard.explanation}
                    </div>
                  )}
                </div>

                <div className="flex flex-col items-center gap-2 pb-1">
                  <button
                    type="button"
                    disabled={isPreviewingVoice}
                    onClick={() => void handlePreviewSingleCardVoice()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-slate-800 bg-white/95 border border-slate-200 rounded-lg hover:bg-white shadow-xs"
                  >
                    {isPreviewingVoice ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Volume2 className="w-3.5 h-3.5 text-indigo-600" />
                    )}
                    <span>Nghe thử thẻ này</span>
                  </button>
                  {previewAudioUrl && (
                    <audio controls autoPlay src={previewAudioUrl} className="w-full h-8" />
                  )}
                </div>
              </div>
            )
          )}

          {/* Watermark & Outro (Tùy chọn) */}
          <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-[11px]">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={() => setIsWatermarkExpanded((v) => !v)}
                className="inline-flex items-center gap-1.5 font-semibold text-slate-800 hover:text-indigo-700"
              >
                <Stamp className="w-3.5 h-3.5 text-indigo-600" />
                <span>Watermark &amp; Outro (Tùy chọn)</span>
                {(watermarkConfig.watermarkEnabled || watermarkConfig.outroSeconds > 0) && (
                  <span className="px-1.5 py-0.5 text-[9px] font-bold bg-emerald-100 text-emerald-700 rounded">
                    Bật
                  </span>
                )}
              </button>
              <button
                type="button"
                onClick={() => setIsWatermarkExpanded((v) => !v)}
                className="text-[10px] font-medium text-indigo-600 hover:underline"
              >
                {isWatermarkExpanded ? 'Thu gọn' : 'Chỉnh sửa'}
              </button>
            </div>
            {isWatermarkExpanded && (
              <div className="pt-2 border-t border-slate-200/80 space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <label className="inline-flex items-center gap-1.5 font-medium text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={watermarkConfig.watermarkEnabled}
                      onChange={(e) =>
                        setWatermarkConfig((prev) => ({
                          ...prev,
                          watermarkEnabled: e.target.checked,
                        }))
                      }
                      className="rounded border-slate-300 text-indigo-600"
                    />
                    <span>Hiện Watermark</span>
                  </label>
                  <input
                    type="text"
                    aria-label="Watermark Reels"
                    value={watermarkConfig.watermarkText}
                    onChange={(e) =>
                      setWatermarkConfig((prev) => ({
                        ...prev,
                        watermarkEnabled: true,
                        watermarkText: e.target.value,
                      }))
                    }
                    placeholder="@EnglishReels"
                    className="flex-1 min-w-[90px] px-2 py-1 bg-white border border-slate-200 rounded"
                  />
                  <select
                    aria-label="Góc Watermark Reels"
                    value={watermarkConfig.watermarkCorner}
                    onChange={(e) =>
                      setWatermarkConfig((prev) => ({
                        ...prev,
                        watermarkCorner: e.target.value as WatermarkCorner,
                      }))
                    }
                    className="px-2 py-1 bg-white border border-slate-200 rounded"
                  >
                    <option value="top-left">Trên Trái</option>
                    <option value="top-right">Trên Phải</option>
                    <option value="bottom-left">Dưới Trái</option>
                    <option value="bottom-right">Dưới Phải</option>
                  </select>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-slate-600">Độ mờ: {Math.round(watermarkConfig.watermarkOpacity * 100)}%</span>
                  <input
                    type="range"
                    min={0.15}
                    max={1}
                    step={0.05}
                    value={watermarkConfig.watermarkOpacity}
                    onChange={(e) =>
                      setWatermarkConfig((prev) => ({
                        ...prev,
                        watermarkOpacity: Number(e.target.value),
                      }))
                    }
                    className="w-20 accent-indigo-600 h-1"
                  />
                  <span className="text-slate-600 ml-auto">Outro (s):</span>
                  <input
                    type="number"
                    min={0}
                    max={10}
                    step={0.5}
                    value={watermarkConfig.outroSeconds}
                    onChange={(e) =>
                      setWatermarkConfig((prev) => ({
                        ...prev,
                        outroSeconds: Math.max(0, Math.min(10, Number(e.target.value) || 0)),
                      }))
                    }
                    className="w-14 px-1.5 py-0.5 bg-white border border-slate-200 rounded font-mono"
                  />
                </div>
                {watermarkConfig.outroSeconds > 0 && (
                  <div className="grid grid-cols-2 gap-1.5">
                    <input
                      type="text"
                      value={watermarkConfig.outroLine1}
                      onChange={(e) =>
                        setWatermarkConfig((prev) => ({ ...prev, outroLine1: e.target.value }))
                      }
                      placeholder="Outro dòng 1"
                      className="px-2 py-1 bg-white border border-slate-200 rounded"
                    />
                    <input
                      type="text"
                      value={watermarkConfig.outroLine2}
                      onChange={(e) =>
                        setWatermarkConfig((prev) => ({ ...prev, outroLine2: e.target.value }))
                      }
                      placeholder="Outro dòng 2"
                      className="px-2 py-1 bg-white border border-slate-200 rounded"
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Audio Engine & Video Output Settings */}
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Nhà cung cấp TTS
                </label>
                <select
                  value={ttsProvider}
                  onChange={(e) => setTtsProvider(e.target.value)}
                  className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                >
                  <option value="auto">Tự động miễn phí (Edge → Google → Polly)</option>
                  {ttsProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Giọng đọc ({ttsRate.toFixed(2)}x)
                </label>
                <select
                  value={ttsVoice}
                  onChange={(e) => setTtsVoice(e.target.value)}
                  className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                >
                  {availableVoices.map((v) => (
                    <option key={`${v.lang}-${v.id}`} value={v.id}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {(ttsProvider === 'elevenlabs' || ttsProvider === 'gemini') && (
              <ApiKeyInlineControl
                provider={ttsProvider === 'elevenlabs' ? 'elevenlabs' : 'gemini'}
                hasServerKey={ttsProvider === 'elevenlabs' ? hasElevenLabsKey : hasGeminiKey}
                onSaved={refreshTtsVoices}
                compact
              />
            )}

            <div>
              <input
                type="range"
                aria-label="Tốc độ đọc TTS"
                min={0.8}
                max={1.3}
                step={0.05}
                value={ttsRate}
                onChange={(e) => setTtsRate(Number(e.target.value))}
                className="w-full accent-indigo-600 h-1.5"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Tông nền Video
                </label>
                <select
                  value={selectedTheme}
                  onChange={(e) => setSelectedTheme(e.target.value as CanvasThemeId)}
                  className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                >
                  {Object.values(CANVAS_THEMES).map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Bố cục KineticSub
                </label>
                <select
                  value={selectedComposition}
                  onChange={(e) => setSelectedComposition(e.target.value as LayoutCompositionId)}
                  className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                >
                  {LAYOUT_COMPOSITIONS.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 border-t border-slate-200/80">
              <div>
                <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                  Độ phân giải
                </label>
                <select
                  value={mp4Resolution}
                  onChange={(e) => setMp4Resolution(e.target.value as ExportResolutionId)}
                  className="w-full px-2 py-1 text-[11px] bg-white border border-slate-200 rounded-lg"
                >
                  <option value="540p">540p</option>
                  <option value="720p">720p (HD)</option>
                  <option value="1080p">1080p (FHD)</option>
                  <option value="1440p">1440p (2K)</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                  Chất lượng
                </label>
                <select
                  value={mp4Quality}
                  onChange={(e) => setMp4Quality(e.target.value as ExportQualityId)}
                  className="w-full px-2 py-1 text-[11px] bg-white border border-slate-200 rounded-lg"
                >
                  <option value="standard">Chuẩn</option>
                  <option value="high">Cao</option>
                  <option value="ultra">Ultra</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-600 mb-1">
                  FPS
                </label>
                <select
                  value={mp4Fps}
                  onChange={(e) => setMp4Fps(Number(e.target.value) as ExportFpsOption)}
                  className="w-full px-2 py-1 text-[11px] bg-white border border-slate-200 rounded-lg"
                >
                  <option value={24}>24 fps</option>
                  <option value={30}>30 fps</option>
                  <option value={60}>60 fps</option>
                </select>
              </div>
            </div>
          </div>

          {(isGeneratingAudio || isPreviewingVoice) && (
            <div className="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-medium text-indigo-900">
                <span className="truncate">{ttsStageLabel || 'Đang tổng hợp Audio TTS...'}</span>
                <span className="font-mono tabular-nums shrink-0 ml-2">{ttsProgress}%</span>
              </div>
              <div className="w-full h-1.5 bg-indigo-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-600 transition-all duration-200"
                  style={{ width: `${Math.max(4, ttsProgress)}%` }}
                />
              </div>
            </div>
          )}

          {isExportingVideo && (
            <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 space-y-1.5">
              <div className="flex items-center justify-between text-[11px] font-medium text-emerald-900">
                <span className="truncate">{exportStageLabel || 'Đang render Video MP4...'}</span>
                <span className="font-mono font-bold tabular-nums shrink-0 ml-2">
                  {Math.round(exportProgress * 100)}%
                </span>
              </div>
              <div className="w-full h-1.5 bg-emerald-200 rounded-full overflow-hidden">
                <div
                  className="h-full bg-emerald-600 transition-all duration-200"
                  style={{ width: `${Math.max(4, Math.round(exportProgress * 100))}%` }}
                />
              </div>
            </div>
          )}

          {studioError && (
            <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">
              {studioError}
            </p>
          )}
          {exportNotice && (
            <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 font-medium">
              {exportNotice}
            </p>
          )}

          <div className="space-y-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={isGeneratingAudio || isExportingVideo || cards.length === 0}
                onClick={() => void handleGeneratePreviewVideoAudio()}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-xl hover:bg-indigo-100 disabled:opacity-50"
              >
                {isGeneratingAudio ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Volume2 className="w-3.5 h-3.5" />
                )}
                <span>
                  {isGeneratingAudio
                    ? `Đang tạo Audio ${ttsProgress}%...`
                    : generatedAudioFile
                      ? 'Tạo lại Audio & Xem'
                      : 'Tạo Audio & Xem Video'}
                </span>
              </button>

              {isExportingVideo ? (
                <button
                  type="button"
                  onClick={() => exportAbortRef.current?.abort()}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-bold text-white bg-rose-600 rounded-xl hover:bg-rose-700"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                  <span>Hủy render</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={isGeneratingAudio || cards.length === 0}
                  onClick={() => void handleDirectRenderVideo()}
                  className="inline-flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-bold text-white bg-indigo-600 rounded-xl hover:bg-indigo-700 disabled:opacity-50"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Render &amp; Tải MP4</span>
                </button>
              )}
            </div>

            <button
              type="button"
              disabled={isGeneratingAudio || isExportingVideo || cards.length === 0}
              onClick={() => void handleGenerateAndSendToStudio(false)}
              className="w-full inline-flex items-center justify-center gap-1.5 py-2 text-xs font-medium text-slate-700 hover:text-slate-900 bg-slate-100 rounded-lg hover:bg-slate-200"
            >
              <span>Chuyển sang KineticSub Studio (sửa timeline chi tiết)</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
