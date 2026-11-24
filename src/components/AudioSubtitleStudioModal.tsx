import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  FileAudio,
  FileText,
  Languages,
  Loader2,
  Mic,
  Play,
  RefreshCw,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { parseTranscriptAuto, stripTimestampsFromScript } from '../engine/transcriptParser';
import { TranscriptCue } from '../engine/types';

export interface TtsVoiceOption {
  id: string;
  label: string;
  lang: string;
}

export interface TtsProviderInfo {
  id: string;
  name: string;
  voices: TtsVoiceOption[];
}

interface AudioSubtitleStudioModalProps {
  isOpen: boolean;
  initialTranscriptText?: string;
  onClose: () => void;
  onApplyAudioAndCues: (audioFile: File | null, cues: TranscriptCue[], title?: string) => void;
}

function base64ToFile(base64: string, fileName: string, mimeType = 'audio/mpeg'): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], fileName, { type: mimeType });
}

function downloadTextFile(content: string, fileName: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function parseApiJson<T = Record<string, any>>(
  res: Response,
  fallbackError: string,
): Promise<T> {
  const rawText = await res.text();
  const trimmed = rawText.trim();
  if (!trimmed) {
    if (!res.ok) throw new Error(`${fallbackError} (HTTP ${res.status})`);
    return {} as T;
  }
  if (trimmed.startsWith('<')) {
    if (res.status === 413) {
      throw new Error('File tải lên vượt giới hạn dung lượng (tối đa 250MB).');
    }
    if (res.status === 504 || res.status === 502) {
      throw new Error(
        `Server phản hồi quá hạn (HTTP ${res.status}) khi tải/chạy model Whisper. Hãy thử bấm "Tải trước Model Whisper" hoặc chọn model whisper-small.`,
      );
    }
    throw new Error(
      `Server trả về HTML (HTTP ${res.status}) thay vì JSON — hãy kiểm tra server Node.js hoặc dung lượng file tải lên.`,
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(
      res.ok ? `${fallbackError}: Dữ liệu JSON không hợp lệ.` : `${fallbackError} (HTTP ${res.status})`,
    );
  }
}

const SAMPLE_TTS_SCRIPT = `Stop saying very tired all the time.
Instead, try saying I am exhausted.
At the airport, keep your boarding pass ready at the gate.
Practice speaking one natural phrase every morning.`;

export const AudioSubtitleStudioModal: React.FC<AudioSubtitleStudioModalProps> = ({
  isOpen,
  initialTranscriptText,
  onClose,
  onApplyAudioAndCues,
}) => {
  const [tab, setTab] = useState<'tts' | 'transcribe'>('tts');

  // TTS state
  const [providers, setProviders] = useState<TtsProviderInfo[]>([]);
  const [hasGeminiKey, setHasGeminiKey] = useState(false);
  const [hasElevenLabsKey, setHasElevenLabsKey] = useState(false);
  const [fasterWhisperAvailable, setFasterWhisperAvailable] = useState(false);
  const [provider, setProvider] = useState<string>('auto');
  const [voice, setVoice] = useState<string>('en-US-JennyNeural');
  const [rate, setRate] = useState<number>(1.0);
  const [ttsTitle, setTtsTitle] = useState<string>('Luyện nói tiếng Anh tự nhiên');
  const [ttsText, setTtsText] = useState<string>(() => {
    const cleaned = initialTranscriptText?.trim()
      ? stripTimestampsFromScript(initialTranscriptText)
      : '';
    return cleaned || SAMPLE_TTS_SCRIPT;
  });
  const [autoAlignWhisper, setAutoAlignWhisper] = useState<boolean>(true);
  const [ttsWhisperModel, setTtsWhisperModel] = useState<string>('large-v3-turbo');
  const [ttsAlignNote, setTtsAlignNote] = useState<string | null>(null);
  const [isSynthesizing, setIsSynthesizing] = useState(false);
  const [isAligningTts, setIsAligningTts] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const [ttsResult, setTtsResult] = useState<{
    audioFile: File;
    audioUrl: string;
    audioBase64: string;
    cues: TranscriptCue[];
    srt: string;
    providerUsed: string;
    detectedLanguage?: string;
    durationSec: number;
  } | null>(null);

  // Transcribe state (defaults: faster-whisper Built-in, large-v3-turbo, .srt)
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [sttService, setSttService] = useState<'faster-whisper' | 'whisper' | 'gemini'>('faster-whisper');
  const [whisperModel, setWhisperModel] = useState<string>('large-v3-turbo');
  const [outputFormat, setOutputFormat] = useState<'srt' | 'vtt'>('srt');
  const [sourceLang, setSourceLang] = useState<string>('auto');
  const [translateLang, setTranslateLang] = useState<string>('none');
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcribeError, setTranscribeError] = useState<string | null>(null);
  const [subFormatTab, setSubFormatTab] = useState<'srt' | 'vtt'>('srt');
  const [transcribeResult, setTranscribeResult] = useState<{
    language: string;
    durationSec: number;
    cues: TranscriptCue[];
    srt: string;
    vtt: string;
    audioFile: File | null;
    engineUsed?: string;
    translationEngineUsed?: string;
    modelUsed?: string;
  } | null>(null);
  const [editableSrt, setEditableSrt] = useState<string>('');

  // Whisper cache status & standalone translation state
  const [cachedOnnxModels, setCachedOnnxModels] = useState<string[]>([]);
  const [isPreloadingWhisper, setIsPreloadingWhisper] = useState(false);
  const [whisperPreloadMsg, setWhisperPreloadMsg] = useState<string | null>(null);

  const [standaloneTargetLang, setStandaloneTargetLang] = useState<string>('Vietnamese');
  const [standaloneBilingual, setStandaloneBilingual] = useState<boolean>(true);
  const [standaloneSourceText, setStandaloneSourceText] = useState<string>('');
  const [standaloneSourceName, setStandaloneSourceName] = useState<string>('');
  const [isTranslatingSubs, setIsTranslatingSubs] = useState(false);
  const [translateSubError, setTranslateSubError] = useState<string | null>(null);
  const [translateSubStatus, setTranslateSubStatus] = useState<string | null>(null);

  const mediaInputRef = useRef<HTMLInputElement>(null);
  const srtFileInputRef = useRef<HTMLInputElement>(null);

  const refreshWhisperStatus = () => {
    fetch('/api/whisper/status')
      .then((r) => parseApiJson<{ fasterWhisperAvailable?: boolean; cachedOnnxModels?: string[] }>(r, 'Lỗi kiểm tra Whisper'))
      .then((data) => {
        setFasterWhisperAvailable(Boolean(data?.fasterWhisperAvailable));
        if (Array.isArray(data?.cachedOnnxModels)) {
          setCachedOnnxModels(data.cachedOnnxModels);
        }
      })
      .catch(() => undefined);
  };

  useEffect(() => {
    if (!isOpen) return;
    if (initialTranscriptText?.trim()) {
      const cleaned = stripTimestampsFromScript(initialTranscriptText);
      if (cleaned) setTtsText(cleaned);
    }
    fetch('/api/tts/voices')
      .then((r) => parseApiJson<{
        providers?: TtsProviderInfo[];
        hasGeminiKey?: boolean;
        hasElevenLabsKey?: boolean;
        fasterWhisperAvailable?: boolean;
        whisperStatus?: { cachedOnnxModels?: string[] };
      }>(r, 'Lỗi tải danh sách giọng TTS'))
      .then((data) => {
        if (Array.isArray(data?.providers)) {
          setProviders(data.providers);
          setHasGeminiKey(Boolean(data?.hasGeminiKey));
          setHasElevenLabsKey(Boolean(data?.hasElevenLabsKey));
          setFasterWhisperAvailable(Boolean(data?.fasterWhisperAvailable));
          if (Array.isArray(data?.whisperStatus?.cachedOnnxModels)) {
            setCachedOnnxModels(data.whisperStatus.cachedOnnxModels);
          }
        }
      })
      .catch(() => undefined);
    refreshWhisperStatus();
  }, [isOpen, initialTranscriptText]);

  useEffect(() => {
    return () => {
      if (ttsResult?.audioUrl) URL.revokeObjectURL(ttsResult.audioUrl);
    };
  }, [ttsResult]);

  const availableVoices = useMemo(() => {
    if (provider === 'auto') {
      return providers.flatMap((p) => {
        if (p.id === 'gemini' && !hasGeminiKey) return [];
        if (p.id === 'elevenlabs' && !hasElevenLabsKey) return [];
        return p.voices;
      });
    }
    return providers.find((p) => p.id === provider)?.voices ?? [];
  }, [providers, provider, hasGeminiKey, hasElevenLabsKey]);

  useEffect(() => {
    if (availableVoices.length > 0 && !availableVoices.some((v) => v.id === voice)) {
      setVoice(availableVoices[0].id);
    }
  }, [availableVoices, voice]);

  if (!isOpen) return null;

  const selectedVoiceObj = availableVoices.find((v) => v.id === voice);

  const alignAudioWithWhisperAuto = async (audioBase64: string, modelId: string) => {
    const res = await fetch('/api/subtitles/align', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audioBase64,
        ext: '.mp3',
        lang: 'auto',
        model: modelId,
      }),
    });
    const data = await parseApiJson<{
      cues?: TranscriptCue[];
      srt?: string;
      language?: string;
      backendUsed?: string;
      modelUsed?: string;
      error?: string;
    }>(res, 'Không thể căn chỉnh word-level bằng Whisper');
    if (!res.ok) {
      throw new Error(data?.error || 'Không thể căn chỉnh word-level bằng Whisper.');
    }
    return data;
  };

  const handleSynthesize = async () => {
    const clean = stripTimestampsFromScript(ttsText).trim();
    if (!clean) {
      setTtsError('Hãy nhập nội dung văn bản (mỗi dòng 1 câu) để tạo giọng đọc.');
      return;
    }
    if (clean !== ttsText.trim()) {
      setTtsText(clean);
    }
    setTtsError(null);
    setTtsAlignNote(null);
    setIsSynthesizing(true);
    try {
      const res = await fetch('/api/tts/synthesize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          voice,
          lang: selectedVoiceObj?.lang || 'en-US',
          rate,
          text: clean,
        }),
      });
      const data = await parseApiJson<{
        audioBase64?: string;
        mimeType?: string;
        cues?: TranscriptCue[];
        srt?: string;
        providerUsed?: string;
        durationSec?: number;
        error?: string;
      }>(res, 'Không thể sinh Audio TTS');
      if (!res.ok || !data?.audioBase64) {
        throw new Error(data?.error || 'Không thể sinh Audio TTS.');
      }

      let finalCues: TranscriptCue[] = data.cues || [];
      let finalSrt = data.srt || '';
      let providerUsed = data.providerUsed || provider;
      let detectedLanguage: string | undefined;

      if (autoAlignWhisper) {
        setIsAligningTts(true);
        try {
          const aligned = await alignAudioWithWhisperAuto(data.audioBase64, ttsWhisperModel);
          if (Array.isArray(aligned?.cues) && aligned.cues.length > 0) {
            finalCues = aligned.cues;
            finalSrt = aligned.srt || finalSrt;
            detectedLanguage = aligned.language;
            providerUsed = `${providerUsed} + ${aligned.backendUsed || 'whisper'} (${aligned.modelUsed || ttsWhisperModel})`;
            setTtsAlignNote(
              `Đã tự động đồng bộ word-level qua Whisper (${aligned.modelUsed || ttsWhisperModel}) · Ngôn ngữ nhận diện: ${aligned.language || 'auto'}.`,
            );
          }
        } catch (alignErr) {
          setTtsAlignNote(
            `Đã tạo MP3 chuẩn FFmpeg (${alignErr instanceof Error ? `Whisper bỏ qua: ${alignErr.message}` : 'dùng timing đo trực tiếp theo câu'}).`,
          );
        } finally {
          setIsAligningTts(false);
        }
      }

      const safeName = `${ttsTitle.trim().replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 32) || 'tts_audio'}.mp3`;
      const audioFile = base64ToFile(data.audioBase64, safeName, data.mimeType || 'audio/mpeg');
      const audioUrl = URL.createObjectURL(audioFile);

      setTtsResult((prev) => {
        if (prev?.audioUrl) URL.revokeObjectURL(prev.audioUrl);
        return {
          audioFile,
          audioUrl,
          audioBase64: data.audioBase64!,
          cues: finalCues,
          srt: finalSrt,
          providerUsed,
          detectedLanguage,
          durationSec: Number(data.durationSec || 0),
        };
      });
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : 'Lỗi khi tạo Audio TTS.');
    } finally {
      setIsSynthesizing(false);
    }
  };

  const handleAlignTtsWithWhisper = async () => {
    if (!ttsResult?.audioBase64) return;
    setTtsError(null);
    setTtsAlignNote(null);
    setIsAligningTts(true);
    try {
      const data = await alignAudioWithWhisperAuto(ttsResult.audioBase64, ttsWhisperModel);
      if (Array.isArray(data?.cues) && data.cues.length > 0) {
        setTtsResult((prev) =>
          prev
            ? {
                ...prev,
                cues: data.cues!,
                srt: data.srt || prev.srt,
                detectedLanguage: data.language || prev.detectedLanguage,
                providerUsed: `${prev.providerUsed.split(' + ')[0]} + ${data.backendUsed || 'whisper'} (${data.modelUsed || ttsWhisperModel})`,
              }
            : null,
        );
        setTtsAlignNote(
          `Đã căn chỉnh lại qua Whisper (${data.modelUsed || ttsWhisperModel}) · Ngôn ngữ: ${data.language || 'auto'}.`,
        );
      }
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : 'Lỗi căn chỉnh Whisper.');
    } finally {
      setIsAligningTts(false);
    }
  };

  const handlePreloadWhisperModel = async () => {
    if (isPreloadingWhisper) return;
    setIsPreloadingWhisper(true);
    setTranscribeError(null);
    setWhisperPreloadMsg(`Đang tải & cache model ${whisperModel} trên server (lần đầu có thể mất 1-3 phút)...`);
    try {
      const res = await fetch('/api/whisper/preload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: whisperModel }),
      });
      const data = await parseApiJson<{
        backendUsed?: string;
        modelUsed?: string;
        status?: { fasterWhisperAvailable?: boolean; cachedOnnxModels?: string[] };
        error?: string;
      }>(res, 'Không tải trước được model Whisper');
      if (!res.ok) {
        throw new Error(data?.error || 'Không tải trước được model Whisper.');
      }
      if (data?.status?.cachedOnnxModels) {
        setCachedOnnxModels(data.status.cachedOnnxModels);
      }
      setWhisperPreloadMsg(
        `Model sẵn sàng trong cache: ${data.modelUsed || whisperModel} (${data.backendUsed || 'built-in'}).`,
      );
    } catch (err) {
      setWhisperPreloadMsg(null);
      setTranscribeError(err instanceof Error ? err.message : 'Lỗi tải trước model Whisper.');
    } finally {
      setIsPreloadingWhisper(false);
    }
  };

  const handleTranscribeMedia = async () => {
    if (!mediaFile) {
      setTranscribeError('Vui lòng chọn file Video (.mp4, .mov) hoặc Audio (.mp3, .wav, .m4a).');
      return;
    }
    setTranscribeError(null);
    setTranslateSubError(null);
    setTranslateSubStatus(null);
    setIsTranscribing(true);
    try {
      const extMatch = mediaFile.name.match(/(\.[a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : '.mp4';
      const buf = await mediaFile.arrayBuffer();
      const res = await fetch('/api/subtitles/transcribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-file-ext': ext,
          'x-engine': sttService,
          'x-whisper-model': whisperModel,
          'x-output-format': outputFormat,
          'x-source-lang': sourceLang,
          'x-translate-lang': translateLang,
        },
        body: buf,
      });
      const data = await parseApiJson<{
        language?: string;
        durationSec?: number;
        cues?: TranscriptCue[];
        srt?: string;
        vtt?: string;
        audioBase64?: string;
        audioMimeType?: string;
        engineUsed?: string;
        translationEngineUsed?: string;
        modelUsed?: string;
        error?: string;
      }>(res, 'Không thể bóc tách phụ đề');
      if (!res.ok) {
        throw new Error(data?.error || 'Không thể bóc tách phụ đề.');
      }

      let extractedAudio: File | null = mediaFile.type.startsWith('audio/') ? mediaFile : null;
      if (data?.audioBase64) {
        const base = mediaFile.name.replace(/\.[^.]+$/, '') || 'extracted';
        extractedAudio = base64ToFile(data.audioBase64, `${base}.mp3`, data.audioMimeType || 'audio/mpeg');
      }

      setTranscribeResult({
        language: data.language || sourceLang,
        durationSec: Number(data.durationSec || 0),
        cues: data.cues || [],
        srt: data.srt || '',
        vtt: data.vtt || '',
        audioFile: extractedAudio,
        engineUsed: data.engineUsed,
        translationEngineUsed: data.translationEngineUsed,
        modelUsed: data.modelUsed,
      });
      setSubFormatTab(outputFormat);
      setEditableSrt(data.srt || '');
      refreshWhisperStatus();
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : 'Lỗi bóc phụ đề.');
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleTranslateSubtitleSource = async () => {
    const sourceSrt = standaloneSourceText.trim() || editableSrt.trim() || transcribeResult?.srt || '';
    if (!sourceSrt) {
      setTranslateSubError('Hãy bóc phụ đề hoặc tải lên file .srt / .vtt / .txt trước khi dịch.');
      return;
    }
    setTranslateSubError(null);
    setTranslateSubStatus(null);
    setIsTranslatingSubs(true);
    try {
      const res = await fetch('/api/subtitles/translate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          srt: sourceSrt,
          targetLang: standaloneTargetLang,
          bilingual: standaloneBilingual,
        }),
      });
      const data = await parseApiJson<{
        cues?: TranscriptCue[];
        srt?: string;
        vtt?: string;
        engineUsed?: string;
        error?: string;
      }>(res, 'Không thể dịch phụ đề');
      if (!res.ok || !data?.srt) {
        throw new Error(data?.error || 'Không thể dịch phụ đề.');
      }

      setEditableSrt(data.srt);
      setSubFormatTab('srt');
      setTranscribeResult((prev) => ({
        language: prev?.language ? `${prev.language} → ${standaloneTargetLang}` : standaloneTargetLang,
        durationSec:
          prev?.durationSec ||
          (Array.isArray(data.cues) && data.cues.length > 0
            ? data.cues[data.cues.length - 1].end
            : 0),
        cues: data.cues || [],
        srt: data.srt!,
        vtt: data.vtt || '',
        audioFile: prev?.audioFile || null,
        engineUsed: prev?.engineUsed,
        translationEngineUsed: data.engineUsed,
        modelUsed: prev?.modelUsed,
      }));
      setTranslateSubStatus(
        `Đã dịch ${data.cues?.length ?? 0} câu sang ${standaloneTargetLang} (${standaloneBilingual ? 'Song ngữ' : 'Chỉ ngôn ngữ đích'}) bằng ${data.engineUsed || 'Translator'}.`,
      );
    } catch (err) {
      setTranslateSubError(err instanceof Error ? err.message : 'Lỗi dịch file phụ đề.');
    } finally {
      setIsTranslatingSubs(false);
    }
  };

  const handleApplyTranscribeToStudio = () => {
    if (!transcribeResult) return;
    const editedCues = parseTranscriptAuto(editableSrt);
    const finalCues = editedCues.length > 0 ? editedCues : transcribeResult.cues;
    const title =
      standaloneSourceName?.replace(/\.[^.]+$/, '') ||
      (mediaFile ? mediaFile.name.replace(/\.[^.]+$/, '') : 'Video Subtitles');
    onApplyAudioAndCues(transcribeResult.audioFile, finalCues, title);
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="audio-sub-studio-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 backdrop-blur-[2px] p-4"
    >
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 bg-slate-50/70">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center">
              <Mic className="w-4 h-4" />
            </div>
            <div>
              <h2 id="audio-sub-studio-title" className="text-base font-bold text-slate-900">
                Studio Sinh Audio TTS &amp; Whisper STT Đa Ngôn Ngữ
              </h2>
              <p className="text-xs text-slate-500">
                Sinh giọng nói từ kịch bản &amp; tự đồng bộ Whisper word-level, hoặc bóc/dịch phụ đề .srt/.vtt từ Video/Audio ({fasterWhisperAvailable ? 'Python faster-whisper sẵn sàng' : 'Built-in ONNX'})
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Đóng Studio Audio & Sub"
            className="p-2 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Subtabs */}
        <div className="px-6 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
          <button
            type="button"
            onClick={() => setTab('tts')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
              tab === 'tts'
                ? 'bg-white border-indigo-300 text-indigo-700 shadow-xs'
                : 'bg-transparent border-transparent text-slate-600 hover:bg-white/60'
            }`}
          >
            <FileAudio className="w-3.5 h-3.5" />
            <span>1. Sinh Audio TTS + Đồng bộ từng từ</span>
          </button>
          <button
            type="button"
            onClick={() => setTab('transcribe')}
            className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
              tab === 'transcribe'
                ? 'bg-white border-indigo-300 text-indigo-700 shadow-xs'
                : 'bg-transparent border-transparent text-slate-600 hover:bg-white/60'
            }`}
          >
            <Languages className="w-3.5 h-3.5" />
            <span>2. Bóc Sub (.srt / .vtt) &amp; Dịch file gốc</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {tab === 'tts' ? (
            <>
              <div className="px-3.5 py-2 rounded-xl bg-indigo-50/70 border border-indigo-200/80 text-[11px] text-indigo-900">
                <strong>Tab 1 (Từ chữ → Audio + Sub):</strong> Chỉ nhập lời thoại (đã tự động bỏ dòng timestamp như <code className="font-mono">00:00:00.000</code> để TTS không đọc nhầm). Sau khi tạo MP3, hệ thống sẽ tự đồng bộ từng từ bằng Whisper với chế độ nhận diện ngôn ngữ tự động (<code className="font-mono">auto</code>).
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Nhà cung cấp Giọng đọc (TTS)
                  </label>
                  <select
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    <option value="auto">Tự động miễn phí (Edge Neural → Google → Polly)</option>
                    {providers
                      .filter(
                        (p) =>
                          (p.id !== 'gemini' || hasGeminiKey) &&
                          (p.id !== 'elevenlabs' || hasElevenLabsKey),
                      )
                      .map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Giọng đọc &amp; Ngôn ngữ
                  </label>
                  <select
                    value={voice}
                    onChange={(e) => setVoice(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {availableVoices.map((v) => (
                      <option key={`${v.lang}-${v.id}`} value={v.id}>
                        {v.label} ({v.lang})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Tốc độ đọc: <span className="font-mono text-indigo-600">{rate.toFixed(2)}x</span>
                  </label>
                  <input
                    type="range"
                    min={0.75}
                    max={1.35}
                    step={0.05}
                    value={rate}
                    onChange={(e) => setRate(Number(e.target.value))}
                    className="w-full accent-indigo-600 mt-2"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                <div className="md:col-span-2">
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Tên bài giảng
                  </label>
                  <input
                    type="text"
                    value={ttsTitle}
                    onChange={(e) => setTtsTitle(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setTtsText(SAMPLE_TTS_SCRIPT)}
                  className="px-3 py-2 text-xs font-medium text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100"
                >
                  Nạp kịch bản mẫu 4 câu
                </button>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-semibold text-slate-700">
                    Lời thoại đọc (tự bỏ dòng timestamp nếu dán từ SRT/transcript)
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setTtsText((prev) => stripTimestampsFromScript(prev) || prev)}
                      className="text-[11px] font-medium text-indigo-600 hover:underline"
                    >
                      Làm sạch timestamp
                    </button>
                    <span className="text-[11px] text-slate-500 tabular-nums">
                      {ttsText.split(/\r?\n/).filter((l) => l.trim()).length} câu
                    </span>
                  </div>
                </div>
                <textarea
                  rows={6}
                  value={ttsText}
                  onChange={(e) => setTtsText(e.target.value)}
                  placeholder="Nhập mỗi câu 1 dòng để sinh Audio + đồng bộ từng từ tự động..."
                  className="w-full p-3 text-xs bg-slate-50 border border-slate-200 rounded-xl leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {/* Integrated Whisper auto-sync toggle right inside Tab 1 */}
              <div className="px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex items-center gap-2 text-xs text-slate-800 font-medium cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoAlignWhisper}
                    onChange={(e) => setAutoAlignWhisper(e.target.checked)}
                    className="rounded border-slate-300 text-indigo-600"
                  />
                  <span>
                    Tự động đồng bộ từng từ bằng Whisper Local sau khi sinh Audio (nhận diện ngôn ngữ <code className="font-mono text-indigo-700">auto</code>)
                  </span>
                </label>
                <select
                  aria-label="Model Whisper đồng bộ TTS"
                  value={ttsWhisperModel}
                  disabled={!autoAlignWhisper}
                  onChange={(e) => setTtsWhisperModel(e.target.value)}
                  className="px-2.5 py-1 text-[11px] font-mono bg-white border border-slate-200 rounded-lg disabled:opacity-50"
                >
                  <option value="large-v3-turbo">large-v3-turbo</option>
                  <option value="Xenova/whisper-small">whisper-small (Nhanh)</option>
                  <option value="Xenova/whisper-tiny">whisper-tiny (Siêu nhẹ)</option>
                </select>
              </div>

              {ttsError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">
                  {ttsError}
                </p>
              )}
              {ttsAlignNote && (
                <p className="text-xs text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg p-2.5">
                  {ttsAlignNote}
                </p>
              )}

              <div className="flex flex-wrap items-center justify-between gap-3">
                <button
                  type="button"
                  disabled={isSynthesizing}
                  onClick={() => void handleSynthesize()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-60"
                >
                  {isSynthesizing ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  <span>
                    {isAligningTts
                      ? `Đang đồng bộ từng từ qua Whisper (${ttsWhisperModel})...`
                      : isSynthesizing
                        ? 'Đang tạo giọng đọc & đo timestamp...'
                        : autoAlignWhisper
                          ? `Sinh Audio MP3 + Đồng bộ Whisper (${ttsWhisperModel})`
                          : 'Sinh Audio MP3 + Sub (.srt)'}
                  </span>
                </button>
              </div>

              {ttsResult && (
                <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-emerald-900 inline-flex items-center gap-1.5">
                      <Check className="w-4 h-4 text-emerald-600" />
                      Đã tạo xong Audio ({ttsResult.durationSec.toFixed(1)}s · {ttsResult.cues.length} câu
                      {ttsResult.detectedLanguage ? ` · ${ttsResult.detectedLanguage}` : ''} · {ttsResult.providerUsed})
                    </span>
                    <div className="flex items-center gap-2">
                      <a
                        href={ttsResult.audioUrl}
                        download={ttsResult.audioFile.name}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Tải .mp3</span>
                      </a>
                      <button
                        type="button"
                        onClick={() => downloadTextFile(ttsResult.srt, `${ttsTitle || 'subtitles'}.srt`)}
                        className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Tải .srt</span>
                      </button>
                    </div>
                  </div>

                  <audio controls src={ttsResult.audioUrl} className="w-full h-9" />

                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <button
                      type="button"
                      disabled={isAligningTts}
                      onClick={() => void handleAlignTtsWithWhisper()}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-indigo-700 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50"
                    >
                      {isAligningTts ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {isAligningTts
                          ? 'Đang căn chỉnh Whisper...'
                          : `Chạy lại đồng bộ Whisper (${ttsWhisperModel})`}
                      </span>
                    </button>

                    <button
                      type="button"
                      onClick={() => {
                        onApplyAudioAndCues(ttsResult.audioFile, ttsResult.cues, ttsTitle);
                        onClose();
                      }}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Nạp Audio + Phụ đề vào KineticSub Studio</span>
                    </button>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Tab 2: Video / Audio Transcription + Whisper Cache + Standalone Subtitle Translation */
            <>
              <div className="px-3.5 py-2 rounded-xl bg-slate-50 border border-slate-200 text-[11px] text-slate-600">
                <strong>Tab 2 (Audio/Video → .SRT/.VTT &amp; Dịch):</strong> Dùng khi bạn đã có file Video/Audio sẵn và muốn bóc lời thoại ra phụ đề <code className="font-mono">.srt</code>/<code className="font-mono">.vtt</code> hoặc dịch file gốc sang ngôn ngữ khác.
              </div>

              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-bold text-slate-900">
                    {mediaFile ? `Đã chọn: ${mediaFile.name}` : 'Tải lên Video hoặc Audio để bóc phụ đề (tối đa 250MB)'}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5">
                    Hỗ trợ MP4, MOV, MKV, MP3, WAV, M4A · Xuất .srt / .vtt và tách MP3 nạp thẳng vào Studio
                  </div>
                </div>
                <div>
                  <input
                    ref={mediaInputRef}
                    type="file"
                    accept="video/*,audio/*,.mp4,.mov,.mkv,.mp3,.wav,.m4a,.ogg,.webm"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null;
                      setMediaFile(f);
                      setTranscribeError(null);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => mediaInputRef.current?.click()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-indigo-700 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    <span>{mediaFile ? 'Đổi file Video/Audio' : 'Chọn Video / Audio'}</span>
                  </button>
                </div>
              </div>

              {/* STT Service, Model & Output Config */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3.5 rounded-xl bg-indigo-50/50 border border-indigo-200/80">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    STT Service
                  </label>
                  <select
                    value={sttService}
                    onChange={(e) => setSttService(e.target.value as 'faster-whisper' | 'whisper' | 'gemini')}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg font-medium"
                  >
                    <option value="faster-whisper">faster-whisper (Built-in)</option>
                    <option value="whisper">Local Whisper (ONNX Built-in)</option>
                    {hasGeminiKey && <option value="gemini">Gemini AI (Server Secret)</option>}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Model
                  </label>
                  <select
                    value={whisperModel}
                    disabled={sttService === 'gemini'}
                    onChange={(e) => setWhisperModel(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg font-mono disabled:opacity-50"
                  >
                    <option value="large-v3-turbo">large-v3-turbo</option>
                    <option value="Xenova/whisper-small">whisper-small (Nhanh)</option>
                    <option value="Xenova/whisper-base">whisper-base</option>
                    <option value="Xenova/whisper-tiny">whisper-tiny (Siêu nhẹ)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Output
                  </label>
                  <select
                    value={outputFormat}
                    onChange={(e) => {
                      const fmt = e.target.value as 'srt' | 'vtt';
                      setOutputFormat(fmt);
                      setSubFormatTab(fmt);
                    }}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg font-mono"
                  >
                    <option value="srt">srt (.srt)</option>
                    <option value="vtt">vtt (.vtt)</option>
                  </select>
                </div>

                <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-2 pt-1 border-t border-indigo-200/60">
                  <div className="text-[11px] text-slate-600 leading-relaxed">
                    <strong>Cache Model trên Server:</strong>{' '}
                    {cachedOnnxModels.length > 0
                      ? `Đã có sẵn ${cachedOnnxModels.join(', ')}`
                      : fasterWhisperAvailable
                        ? 'Python faster-whisper sẵn sàng (tự tải model lần đầu)'
                        : 'Chưa cache model nào — bấm tải trước hoặc bóc sub lần đầu sẽ tự tải.'}
                  </div>
                  <button
                    type="button"
                    disabled={isPreloadingWhisper || sttService === 'gemini'}
                    onClick={() => void handlePreloadWhisperModel()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-indigo-700 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50 disabled:opacity-50"
                  >
                    {isPreloadingWhisper ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <Download className="w-3 h-3" />
                    )}
                    <span>{isPreloadingWhisper ? 'Đang tải model...' : `Tải trước ${whisperModel}`}</span>
                  </button>
                </div>
                {whisperPreloadMsg && (
                  <p className="sm:col-span-3 text-[11px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 font-medium">
                    {whisperPreloadMsg}
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Ngôn ngữ gốc trong Video / Audio
                  </label>
                  <select
                    value={sourceLang}
                    onChange={(e) => setSourceLang(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="auto">Tự động nhận diện mọi ngôn ngữ</option>
                    <option value="English">English</option>
                    <option value="Vietnamese">Tiếng Việt</option>
                    <option value="Japanese">日本語 (Tiếng Nhật)</option>
                    <option value="Chinese">中文 (Tiếng Trung)</option>
                    <option value="Korean">한국어 (Tiếng Hàn)</option>
                    <option value="French">Français (Tiếng Pháp)</option>
                    <option value="Spanish">Español (Tiếng Tây Ban Nha)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Dịch song ngữ thêm vào phụ đề ({hasGeminiKey ? 'Gemini LLM + Miễn phí' : 'Dịch miễn phí tự động'})
                  </label>
                  <select
                    value={translateLang}
                    onChange={(e) => setTranslateLang(e.target.value)}
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="none">Chỉ giữ nguyên ngôn ngữ gốc</option>
                    <option value="Vietnamese">Thêm dịch Tiếng Việt</option>
                    <option value="English">Thêm dịch English</option>
                    <option value="Japanese">Thêm dịch Tiếng Nhật</option>
                    <option value="Chinese">Thêm dịch Tiếng Trung</option>
                    <option value="Korean">Thêm dịch Tiếng Hàn</option>
                  </select>
                </div>
              </div>

              <button
                type="button"
                disabled={isTranscribing || !mediaFile}
                onClick={() => void handleTranscribeMedia()}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
              >
                {isTranscribing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Languages className="w-4 h-4" />
                )}
                <span>
                  {isTranscribing
                    ? `Đang chạy ${sttService} (${whisperModel})...`
                    : `Bóc phụ đề (${sttService} · ${whisperModel} → .${outputFormat})`}
                </span>
              </button>

              {transcribeError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">
                  {transcribeError}
                </p>
              )}

              {/* Standalone Subtitle File / Source Translator */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="text-xs font-bold text-slate-900 inline-flex items-center gap-1.5">
                      <FileText className="w-3.5 h-3.5 text-indigo-600" />
                      <span>Dịch file gốc (.SRT / .VTT / Script) sang ngôn ngữ đích</span>
                    </div>
                    <p className="text-[11px] text-slate-500 mt-0.5">
                      Tự dùng Gemini LLM nếu server có cấu hình, hoặc tự chuyển sang dịch miễn phí (không cần API key). Có thể tải file <code className="font-mono">.srt</code> rời hoặc dịch trực tiếp kết quả vừa bóc.
                    </p>
                  </div>
                  <div>
                    <input
                      ref={srtFileInputRef}
                      type="file"
                      accept=".srt,.vtt,.txt,.json"
                      className="hidden"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const txt = await f.text();
                        setStandaloneSourceText(txt);
                        setStandaloneSourceName(f.name);
                        setEditableSrt(txt);
                        setTranslateSubError(null);
                      }}
                    />
                    <button
                      type="button"
                      onClick={() => srtFileInputRef.current?.click()}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-100"
                    >
                      <Upload className="w-3 h-3" />
                      <span>{standaloneSourceName ? `Đã nạp: ${standaloneSourceName}` : 'Chọn file .SRT / .VTT gốc'}</span>
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2.5">
                  <select
                    aria-label="Ngôn ngữ đích để dịch phụ đề"
                    value={standaloneTargetLang}
                    onChange={(e) => setStandaloneTargetLang(e.target.value)}
                    className="px-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="Vietnamese">Dịch sang Tiếng Việt</option>
                    <option value="English">Dịch sang English</option>
                    <option value="Japanese">Dịch sang 日本語 (Tiếng Nhật)</option>
                    <option value="Chinese">Dịch sang 中文 (Tiếng Trung)</option>
                    <option value="Korean">Dịch sang 한국어 (Tiếng Hàn)</option>
                    <option value="French">Dịch sang Français (Tiếng Pháp)</option>
                    <option value="Spanish">Dịch sang Español (Tiếng Tây Ban Nha)</option>
                  </select>

                  <label className="inline-flex items-center gap-1.5 text-xs text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={standaloneBilingual}
                      onChange={(e) => setStandaloneBilingual(e.target.checked)}
                      className="rounded border-slate-300 text-indigo-600"
                    />
                    <span>Giữ song ngữ (Dòng gốc + Bản dịch)</span>
                  </label>

                  <button
                    type="button"
                    disabled={isTranslatingSubs || (!standaloneSourceText.trim() && !editableSrt.trim() && !transcribeResult?.srt)}
                    onClick={() => void handleTranslateSubtitleSource()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                  >
                    {isTranslatingSubs ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Languages className="w-3.5 h-3.5" />
                    )}
                    <span>{isTranslatingSubs ? 'Đang dịch phụ đề...' : 'Dịch file gốc sang ngôn ngữ đích'}</span>
                  </button>
                </div>

                {translateSubError && (
                  <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
                    {translateSubError}
                  </p>
                )}
                {translateSubStatus && (
                  <p className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-lg p-2 font-medium">
                    {translateSubStatus}
                  </p>
                )}
              </div>

              {transcribeResult && (
                <div className="p-4 rounded-xl bg-white border border-emerald-200 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-emerald-800">
                      {transcribeResult.engineUsed ? `[${transcribeResult.engineUsed}${transcribeResult.modelUsed ? ` · ${transcribeResult.modelUsed}` : ''}] ` : ''}
                      Ngôn ngữ: {transcribeResult.language} · {transcribeResult.cues.length} dòng · {transcribeResult.durationSec.toFixed(1)}s
                      {transcribeResult.translationEngineUsed ? ` · Dịch: ${transcribeResult.translationEngineUsed}` : ''}
                    </span>
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => setSubFormatTab('srt')}
                        className={`px-2.5 py-1 text-[11px] font-semibold rounded border ${
                          subFormatTab === 'srt' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'bg-slate-50 border-slate-200 text-slate-600'
                        }`}
                      >
                        .SRT (Sửa trực tiếp)
                      </button>
                      <button
                        type="button"
                        onClick={() => setSubFormatTab('vtt')}
                        className={`px-2.5 py-1 text-[11px] font-semibold rounded border ${
                          subFormatTab === 'vtt' ? 'bg-indigo-50 border-indigo-300 text-indigo-700' : 'bg-slate-50 border-slate-200 text-slate-600'
                        }`}
                      >
                        .VTT
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadTextFile(editableSrt || transcribeResult.srt, 'subtitles.srt')}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded hover:bg-slate-100"
                      >
                        <Download className="w-3 h-3" />
                        <span>Tải .srt</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => downloadTextFile(transcribeResult.vtt, 'subtitles.vtt')}
                        className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded hover:bg-slate-100"
                      >
                        <Download className="w-3 h-3" />
                        <span>Tải .vtt</span>
                      </button>
                    </div>
                  </div>

                  {subFormatTab === 'srt' ? (
                    <textarea
                      rows={8}
                      value={editableSrt}
                      onChange={(e) => setEditableSrt(e.target.value)}
                      className="w-full p-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg leading-relaxed"
                    />
                  ) : (
                    <textarea
                      readOnly
                      rows={8}
                      value={transcribeResult.vtt}
                      className="w-full p-3 text-xs font-mono bg-slate-50 border border-slate-200 rounded-lg leading-relaxed"
                    />
                  )}

                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={handleApplyTranscribeToStudio}
                      className="inline-flex items-center gap-2 px-4 py-2 text-xs font-bold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                    >
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Nạp {transcribeResult.audioFile ? 'Audio + ' : ''}Phụ đề vào KineticSub Studio</span>
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
};
