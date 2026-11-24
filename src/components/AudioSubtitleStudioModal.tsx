import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Download,
  FileAudio,
  Languages,
  Loader2,
  Mic,
  Play,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { parseTranscriptAuto } from '../engine/transcriptParser';
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
  const [ttsText, setTtsText] = useState<string>(() =>
    initialTranscriptText?.trim() ? initialTranscriptText : SAMPLE_TTS_SCRIPT,
  );
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
    modelUsed?: string;
  } | null>(null);
  const [editableSrt, setEditableSrt] = useState<string>('');

  const mediaInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/tts/voices')
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data?.providers)) {
          setProviders(data.providers);
          setHasGeminiKey(Boolean(data?.hasGeminiKey));
          setHasElevenLabsKey(Boolean(data?.hasElevenLabsKey));
          setFasterWhisperAvailable(Boolean(data?.fasterWhisperAvailable));
        }
      })
      .catch(() => undefined);
  }, [isOpen]);

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

  const handleSynthesize = async () => {
    const clean = ttsText.trim();
    if (!clean) {
      setTtsError('Hãy nhập nội dung văn bản (mỗi dòng 1 câu) để tạo giọng đọc.');
      return;
    }
    setTtsError(null);
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
      const data = await res.json();
      if (!res.ok || !data?.audioBase64) {
        throw new Error(data?.error || 'Không thể sinh Audio TTS.');
      }

      const safeName = `${ttsTitle.trim().replace(/[^a-zA-Z0-9-_]+/g, '_').slice(0, 32) || 'tts_audio'}.mp3`;
      const audioFile = base64ToFile(data.audioBase64, safeName, data.mimeType || 'audio/mpeg');
      const audioUrl = URL.createObjectURL(audioFile);

      setTtsResult((prev) => {
        if (prev?.audioUrl) URL.revokeObjectURL(prev.audioUrl);
        return {
          audioFile,
          audioUrl,
          audioBase64: data.audioBase64,
          cues: data.cues || [],
          srt: data.srt || '',
          providerUsed: data.providerUsed || provider,
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
    setIsAligningTts(true);
    try {
      const res = await fetch('/api/subtitles/align', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: ttsResult.audioBase64,
          ext: '.mp3',
          lang: selectedVoiceObj?.lang?.split('-')[0] || 'en',
          model: 'large-v3-turbo',
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || 'Không thể căn chỉnh word-level bằng Whisper.');
      }
      if (Array.isArray(data?.cues) && data.cues.length > 0) {
        setTtsResult((prev) =>
          prev
            ? {
                ...prev,
                cues: data.cues,
                srt: data.srt || prev.srt,
                providerUsed: `${prev.providerUsed} + ${data.backendUsed || 'whisper'} (${data.modelUsed || 'large-v3-turbo'})`,
              }
            : null,
        );
      }
    } catch (err) {
      setTtsError(err instanceof Error ? err.message : 'Lỗi căn chỉnh Whisper.');
    } finally {
      setIsAligningTts(false);
    }
  };

  const handleTranscribeMedia = async () => {
    if (!mediaFile) {
      setTranscribeError('Vui lòng chọn file Video (.mp4, .mov) hoặc Audio (.mp3, .wav, .m4a).');
      return;
    }
    setTranscribeError(null);
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
      const data = await res.json();
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
        modelUsed: data.modelUsed,
      });
      setSubFormatTab(outputFormat);
      setEditableSrt(data.srt || '');
    } catch (err) {
      setTranscribeError(err instanceof Error ? err.message : 'Lỗi bóc phụ đề.');
    } finally {
      setIsTranscribing(false);
    }
  };

  const handleApplyTranscribeToStudio = () => {
    if (!transcribeResult) return;
    const editedCues = parseTranscriptAuto(editableSrt);
    const finalCues = editedCues.length > 0 ? editedCues : transcribeResult.cues;
    const title = mediaFile ? mediaFile.name.replace(/\.[^.]+$/, '') : 'Video Subtitles';
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
                Giọng đọc miễn phí (Edge Neural · Google · Polly · ElevenLabs · Gemini) &amp; bóc sub nội bộ faster-whisper ({fasterWhisperAvailable ? 'Python Native sẵn sàng' : 'Built-in ONNX'})
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
            <span>1. Sinh Audio TTS Miễn phí + Sub đồng bộ</span>
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
            <span>2. Bóc file Sub (.srt / .vtt) từ Video hoặc Audio</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6 space-y-4">
          {tab === 'tts' ? (
            <>
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
                    {providers.map((p) => {
                      const disabled =
                        (p.id === 'gemini' && !hasGeminiKey) ||
                        (p.id === 'elevenlabs' && !hasElevenLabsKey);
                      return (
                        <option key={p.id} value={p.id} disabled={disabled}>
                          {p.name}
                          {disabled ? ' (Cần Secret trên Server)' : ''}
                        </option>
                      );
                    })}
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

              {/* Secret configuration clarity (server-side only, zero browser key inputs) */}
              <div className="px-3.5 py-2.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-600">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold">
                    Edge Neural · Google · Polly: Miễn phí (Không cần Key)
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded font-semibold ${
                      hasElevenLabsKey ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    ELEVENLABS_API_KEY: {hasElevenLabsKey ? 'Đã cấu hình' : 'Chưa đặt'}
                  </span>
                  <span
                    className={`px-2 py-0.5 rounded font-semibold ${
                      hasGeminiKey ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-200 text-slate-700'
                    }`}
                  >
                    GEMINI_API_KEY: {hasGeminiKey ? 'Đã cấu hình' : 'Chưa đặt'}
                  </span>
                </div>
                <span className="text-[10px] text-slate-500">
                  Bảo mật: API Key đặt trong mục Secrets của môi trường / file <code>.env</code> trên server.
                </span>
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
                    Nội dung đọc (mỗi dòng sẽ tự động tạo thành 1 mốc phụ đề khớp 100% thời lượng audio)
                  </label>
                  <span className="text-[11px] text-slate-500 tabular-nums">
                    {ttsText.split(/\r?\n/).filter((l) => l.trim()).length} câu
                  </span>
                </div>
                <textarea
                  rows={6}
                  value={ttsText}
                  onChange={(e) => setTtsText(e.target.value)}
                  placeholder="Nhập mỗi câu 1 dòng để sinh Audio + SRT tự động..."
                  className="w-full p-3 text-xs bg-slate-50 border border-slate-200 rounded-xl leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              {ttsError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">
                  {ttsError}
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
                  <span>{isSynthesizing ? 'Đang tạo giọng đọc & đo timestamp...' : 'Sinh Audio MP3 + Sub (.srt)'}</span>
                </button>
              </div>

              {ttsResult && (
                <div className="p-4 rounded-xl bg-emerald-50/70 border border-emerald-200 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-emerald-900 inline-flex items-center gap-1.5">
                      <Check className="w-4 h-4 text-emerald-600" />
                      Đã tạo xong Audio ({ttsResult.durationSec.toFixed(1)}s · {ttsResult.cues.length} câu · Engine: {ttsResult.providerUsed})
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
                        <Languages className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {isAligningTts
                          ? 'Đang căn chỉnh Whisper...'
                          : 'Căn chỉnh từng từ bằng Whisper Local (large-v3-turbo)'}
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
            /* Tab 2: Video / Audio Transcription */
            <>
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-bold text-slate-900">
                    {mediaFile ? `Đã chọn: ${mediaFile.name}` : 'Tải lên Video hoặc Audio để bóc phụ đề (tối đa 50MB)'}
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

              {/* STT Service, Model & Output Config (Default: faster-whisper Built-in / large-v3-turbo / srt) */}
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
                    <option value="gemini" disabled={!hasGeminiKey}>
                      Gemini AI {!hasGeminiKey ? '(Chưa có GEMINI_API_KEY)' : ''}
                    </option>
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
                <p className="sm:col-span-3 text-[11px] text-slate-600 leading-relaxed">
                  <strong>Cơ chế chạy nội bộ:</strong> Lần đầu chạy, server tự tải &amp; lưu cache mô hình ({fasterWhisperAvailable ? 'Python faster-whisper sẵn sàng' : 'ONNX @huggingface/transformers trên server'}), không cài gì vào trình duyệt hay PC người dùng; các lần sau chạy ngay từ cache.
                </p>
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
                    Dịch song ngữ thêm vào phụ đề (tùy chọn)
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

              {transcribeResult && (
                <div className="p-4 rounded-xl bg-white border border-emerald-200 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-emerald-800">
                      {transcribeResult.engineUsed ? `[${transcribeResult.engineUsed}${transcribeResult.modelUsed ? ` · ${transcribeResult.modelUsed}` : ''}] ` : ''}
                      Ngôn ngữ: {transcribeResult.language} · {transcribeResult.cues.length} dòng · {transcribeResult.durationSec.toFixed(1)}s
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
