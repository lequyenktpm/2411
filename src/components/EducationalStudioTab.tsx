import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  Download,
  FileAudio,
  Film,
  FolderOpen,
  Layers,
  Loader2,
  Music,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Wand2,
} from 'lucide-react';
import { parseTranscriptAuto } from '../engine/transcriptParser';
import { TranscriptCue, WordTiming } from '../engine/types';

interface OutputFileEntry {
  name: string;
  relativePath: string;
  bytes: number;
  mtimeMs?: number;
}

interface EducationalStudioTabProps {
  onSendAudioCuesToStudio?: (audioFile: File | null, cues: TranscriptCue[], title?: string) => void;
}

const CHUNK_SIZE = 4 * 1024 * 1024;

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
    if (res.status === 413) {
      throw new Error('File tải lên vượt quá giới hạn dung lượng (tối đa 250MB).');
    }
    throw new Error(
      `Server trả về HTML (HTTP ${res.status}) thay vì JSON — kiểm tra server Node.js hoặc dung lượng file tải lên.`,
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(res.ok ? `${fallbackError}: JSON không hợp lệ.` : `${fallbackError} (HTTP ${res.status})`);
  }
}

async function uploadStudioFileChunked(
  jobId: string,
  role: string,
  file: File,
  signal?: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const appendQuery = offset > 0 ? '?append=1' : '';
    const res = await fetch(`/api/studio/job/${jobId}/file${appendQuery}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-role': role,
        'x-filename': encodeURIComponent(file.name),
      },
      body: slice,
      signal,
    });
    if (!res.ok) {
      const err = await parseApiJson<{ error?: string }>(res, `Upload ${role} thất bại`).catch(() => ({
        error: undefined,
      }));
      throw new Error(err.error || `Upload ${role} thất bại (HTTP ${res.status})`);
    }
  }
}

function buildKaraokeAssFromText(rawInput: string, highlightHex = '#FACC15'): string {
  const cues = parseTranscriptAuto(rawInput);
  const effectiveCues =
    cues.length > 0
      ? cues
      : rawInput
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((text, idx) => ({
            id: `k-${idx}`,
            start: idx * 3.5,
            end: (idx + 1) * 3.5,
            text,
            words: [],
          }));

  const cleanHex = highlightHex.replace('#', '');
  const bgrHighlight =
    cleanHex.length === 6
      ? `&H00${cleanHex.slice(4, 6)}${cleanHex.slice(2, 4)}${cleanHex.slice(0, 2)}`.toUpperCase()
      : '&H0015CCFA';

  const toAssTime = (sec: number) => {
    const cs = Math.max(0, Math.round(sec * 100));
    const hh = Math.floor(cs / 360000);
    const mm = Math.floor((cs % 360000) / 6000);
    const ss = Math.floor((cs % 6000) / 100);
    const c = cs % 100;
    return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
  };

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    'WrapStyle: 2',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Karaoke,Noto Sans,56,${bgrHighlight},&H00FFFFFF,&H000F172A,&H64000000,-1,0,0,0,100,100,0,0,1,3,1,2,48,48,140,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const cue of effectiveCues) {
    const words = cue.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (words.length === 0) continue;
    const totalCs = Math.max(20, Math.round((cue.end - cue.start) * 100));
    const perWordCs = Math.max(8, Math.floor(totalCs / words.length));
    const kBody = words.map((w) => `{\\kf${perWordCs}}${w}`).join(' ');
    lines.push(`Dialogue: 0,${toAssTime(cue.start)},${toAssTime(cue.end)},Karaoke,,0,0,0,,${kBody}`);
  }

  return lines.join('\n');
}

export const EducationalStudioTab: React.FC<EducationalStudioTabProps> = ({
  onSendAudioCuesToStudio,
}) => {
  const [subTab, setSubTab] = useState<'merge' | 'karaoke' | 'align'>('merge');

  // ── Shared Output Folder State ─────────────────────────────────────────────
  const [outputDir, setOutputDir] = useState<string>('output');
  const [outputFiles, setOutputFiles] = useState<OutputFileEntry[]>([]);
  const [previewVideoRelPath, setPreviewVideoRelPath] = useState<string | null>(null);
  const [folderStatusMsg, setFolderStatusMsg] = useState<string | null>(null);

  const refreshOutputFiles = useCallback(async () => {
    try {
      const res = await fetch('/api/output/files');
      if (!res.ok) return;
      const data = (await res.json()) as { outputDir?: string; files?: OutputFileEntry[] };
      setOutputDir(data.outputDir || 'output');
      const nextFiles = Array.isArray(data.files) ? data.files : [];
      setOutputFiles(nextFiles);
    } catch {
      // ignore offline
    }
  }, []);

  useEffect(() => {
    void refreshOutputFiles();
  }, [refreshOutputFiles]);

  const handleOpenOutputFolder = async () => {
    try {
      const res = await fetch('/api/output/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subPath: 'edu-studio' }),
      });
      const data = (await res.json().catch(() => ({}))) as { opened?: boolean; path?: string };
      if (data.opened) {
        setFolderStatusMsg(`Đã mở thư mục Output: ${data.path}`);
      } else {
        setFolderStatusMsg(
          `Đường dẫn lưu trên server: ${data.path || outputDir} (Môi trường web không mở Explorer cục bộ — xem/phát/tải file ở danh sách bên phải).`,
        );
      }
    } catch {
      // ignore
    }
  };

  // ── Sub-tab 1: Merge Video + Audio + Watermark + Outro ─────────────────────
  const [mergeVideoFile, setMergeVideoFile] = useState<File | null>(null);
  const [mergeAudioFile, setMergeAudioFile] = useState<File | null>(null);
  const [durationMode, setDurationMode] = useState<'loop-video' | 'shortest'>('loop-video');
  const [watermarkText, setWatermarkText] = useState('');
  const [watermarkCorner, setWatermarkCorner] = useState<
    'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  >('bottom-right');
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.65);
  const [outroText, setOutroText] = useState('');
  const [outroDuration, setOutroDuration] = useState(0);
  const [mergeOutputName, setMergeOutputName] = useState('lesson_merged');
  const [isMerging, setIsMerging] = useState(false);
  const [mergeStatus, setMergeStatus] = useState<string>('');
  const [mergeError, setMergeError] = useState<string | null>(null);
  const mergeAbortRef = useRef<AbortController | null>(null);
  const activeMergeJobIdRef = useRef<string | null>(null);

  const handleCancelMerge = () => {
    mergeAbortRef.current?.abort();
    if (activeMergeJobIdRef.current) {
      void fetch(`/api/studio/job/${activeMergeJobIdRef.current}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  };

  const handleRunMerge = async () => {
    if (!mergeVideoFile || !mergeAudioFile || isMerging) return;
    setMergeError(null);
    setIsMerging(true);
    setMergeStatus('Đang tạo job trên FFmpeg server...');
    const controller = new AbortController();
    mergeAbortRef.current = controller;

    try {
      const startRes = await fetch('/api/studio/job/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      const startData = await parseApiJson<{ jobId?: string; error?: string }>(
        startRes,
        'Không khởi tạo được job ghép video',
      );
      if (!startRes.ok || !startData.jobId) {
        throw new Error(startData.error || 'Không khởi tạo được job ghép video.');
      }
      const jobId = startData.jobId;
      activeMergeJobIdRef.current = jobId;

      setMergeStatus(`Đang tải Video (${mergeVideoFile.name})...`);
      await uploadStudioFileChunked(jobId, 'video', mergeVideoFile, controller.signal);

      setMergeStatus(`Đang tải Audio (${mergeAudioFile.name})...`);
      await uploadStudioFileChunked(jobId, 'audio', mergeAudioFile, controller.signal);

      setMergeStatus('FFmpeg đang ghép Video + Audio + Watermark/Outro...');
      const finishRes = await fetch(`/api/studio/job/${jobId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          durationMode,
          watermarkText,
          watermarkCorner,
          watermarkOpacity,
          outroText,
          outroDuration,
          outputName: mergeOutputName,
          savePath: 'edu-studio',
        }),
      });
      const data = await parseApiJson<{
        ok?: boolean;
        fileName?: string;
        relativePath?: string;
        savedPath?: string;
        error?: string;
      }>(finishRes, 'Ghép video thất bại');
      if (!finishRes.ok) {
        throw new Error(data.error || 'Ghép video thất bại.');
      }
      setMergeStatus(`Hoàn tất! Đã lưu ${data.fileName} (${data.savedPath})`);
      if (data.relativePath) {
        setPreviewVideoRelPath(data.relativePath);
      }
      await refreshOutputFiles();
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        setMergeStatus('Đã hủy tác vụ ghép video.');
      } else {
        setMergeError(err instanceof Error ? err.message : 'Lỗi FFmpeg ghép video.');
        setMergeStatus('');
      }
    } finally {
      activeMergeJobIdRef.current = null;
      mergeAbortRef.current = null;
      setIsMerging(false);
    }
  };

  // ── Sub-tab 2: Karaoke Sub (.ass) + Mix Audio/SFX/Voice + Video FX ─────────
  const [kmVideoFile, setKmVideoFile] = useState<File | null>(null);
  const [kmMusicFile, setKmMusicFile] = useState<File | null>(null);
  const [kmSfxFile, setKmSfxFile] = useState<File | null>(null);
  const [kmVoiceFile, setKmVoiceFile] = useState<File | null>(null);
  const [kmSrtInput, setKmSrtInput] = useState(
    `1\n00:00:00,200 --> 00:00:03,400\nWelcome to English Audio Video Studio.\n\n2\n00:00:03,600 --> 00:00:07,000\nLet us practice speaking naturally every day.`,
  );
  const [kmAssContent, setKmAssContent] = useState('');
  const [kmHighlightColor, setKmHighlightColor] = useState('#FACC15');
  const [kmEffect, setKmEffect] = useState('Fade cinematic');
  const [kmMuteOriginal, setKmMuteOriginal] = useState(false);
  const [kmRemoveDialogue, setKmRemoveDialogue] = useState(false);
  const [kmVoicePriority, setKmVoicePriority] = useState(true);
  const [kmOriginalVol, setKmOriginalVol] = useState(0.5);
  const [kmMusicVol, setKmMusicVol] = useState(0.3);
  const [kmSfxVol, setKmSfxVol] = useState(0.25);
  const [kmVoiceVol, setKmVoiceVol] = useState(1.0);
  const [kmVoiceStart, setKmVoiceStart] = useState(0);
  const [kmOutroSec, setKmOutroSec] = useState(0.5);
  const [kmOutputName, setKmOutputName] = useState('karaoke_lesson');
  const [isRenderingKm, setIsRenderingKm] = useState(false);
  const [kmStatus, setKmStatus] = useState('');
  const [kmError, setKmError] = useState<string | null>(null);
  const kmAbortRef = useRef<AbortController | null>(null);
  const activeKmJobIdRef = useRef<string | null>(null);

  const handleGenerateAss = () => {
    const ass = buildKaraokeAssFromText(kmSrtInput, kmHighlightColor);
    setKmAssContent(ass);
  };

  const handleCancelKaraokeMix = () => {
    kmAbortRef.current?.abort();
    if (activeKmJobIdRef.current) {
      void fetch(`/api/studio/job/${activeKmJobIdRef.current}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  };

  const handleRunKaraokeMix = async () => {
    if (!kmVideoFile || isRenderingKm) return;
    setKmError(null);
    setIsRenderingKm(true);
    setKmStatus('Đang tạo job Karaoke & Audio Mix...');
    const controller = new AbortController();
    kmAbortRef.current = controller;

    try {
      const startRes = await fetch('/api/studio/job/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      const startData = await parseApiJson<{ jobId?: string; error?: string }>(
        startRes,
        'Không tạo được Studio job',
      );
      if (!startRes.ok || !startData.jobId) {
        throw new Error(startData.error || 'Không tạo được Studio job.');
      }
      const jobId = startData.jobId;
      activeKmJobIdRef.current = jobId;

      setKmStatus(`Đang tải Video nền (${kmVideoFile.name})...`);
      await uploadStudioFileChunked(jobId, 'video', kmVideoFile, controller.signal);

      if (kmMusicFile) {
        setKmStatus(`Đang tải Nhạc nền (${kmMusicFile.name})...`);
        await uploadStudioFileChunked(jobId, 'music', kmMusicFile, controller.signal);
      }
      if (kmSfxFile) {
        setKmStatus(`Đang tải Ambient SFX (${kmSfxFile.name})...`);
        await uploadStudioFileChunked(jobId, 'sfx', kmSfxFile, controller.signal);
      }
      if (kmVoiceFile) {
        setKmStatus(`Đang tải Voiceover (${kmVoiceFile.name})...`);
        await uploadStudioFileChunked(jobId, 'voice', kmVoiceFile, controller.signal);
      }

      const finalAss =
        kmAssContent.trim() ||
        (kmSrtInput.trim() ? buildKaraokeAssFromText(kmSrtInput, kmHighlightColor) : '');

      setKmStatus('FFmpeg đang hòa âm Ducking & đốt phụ đề Karaoke (.ass)...');
      const mixRes = await fetch(`/api/studio/job/${jobId}/karaoke-mix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          assContent: finalAss,
          videoEffect: kmEffect,
          outroSeconds: kmOutroSec,
          muteOriginal: kmMuteOriginal,
          removeDialogue: kmRemoveDialogue,
          originalVolume: kmOriginalVol,
          musicVolume: kmMusicVol,
          sfxVolume: kmSfxVol,
          voiceVolume: kmVoiceVol,
          voiceStart: kmVoiceStart,
          voicePriority: kmVoicePriority,
          outputName: kmOutputName,
          savePath: 'edu-studio',
        }),
      });
      const data = await parseApiJson<{
        ok?: boolean;
        fileName?: string;
        relativePath?: string;
        savedPath?: string;
        error?: string;
      }>(mixRes, 'Lỗi render Karaoke & Mix');
      if (!mixRes.ok) {
        throw new Error(data.error || 'Lỗi render Karaoke & Mix.');
      }
      setKmStatus(`Hoàn tất! Đã lưu ${data.fileName} (${data.savedPath})`);
      if (data.relativePath) {
        setPreviewVideoRelPath(data.relativePath);
      }
      await refreshOutputFiles();
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        setKmStatus('Đã hủy tác vụ Karaoke & Mix.');
      } else {
        setKmError(err instanceof Error ? err.message : 'Lỗi FFmpeg Karaoke & Mix.');
        setKmStatus('');
      }
    } finally {
      activeKmJobIdRef.current = null;
      kmAbortRef.current = null;
      setIsRenderingKm(false);
    }
  };

  // ── Sub-tab 3: Reading Along & Whisper Word-Level Alignment ────────────────
  const [alignFile, setAlignFile] = useState<File | null>(null);
  const [alignAudioUrl, setAlignAudioUrl] = useState<string | null>(null);
  const [alignLang, setAlignLang] = useState('auto');
  const [alignModel, setAlignModel] = useState('large-v3-turbo');
  const [isAligning, setIsAligning] = useState(false);
  const [alignError, setAlignError] = useState<string | null>(null);
  const [alignCurrentSec, setAlignCurrentSec] = useState(0);
  const [alignResult, setAlignResult] = useState<{
    language?: string;
    modelUsed: string;
    backendUsed: string;
    durationSec: number;
    text: string;
    words: WordTiming[];
    cues: TranscriptCue[];
    srt: string;
  } | null>(null);
  const alignAudioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    return () => {
      if (alignAudioUrl) URL.revokeObjectURL(alignAudioUrl);
    };
  }, [alignAudioUrl]);

  const handleRunWordAlign = async () => {
    if (!alignFile || isAligning) return;
    setAlignError(null);
    setIsAligning(true);
    try {
      const extMatch = alignFile.name.match(/(\.[a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : '.mp3';
      const buf = await alignFile.arrayBuffer();
      const res = await fetch('/api/subtitles/align', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          'x-file-ext': ext,
          'x-source-lang': alignLang,
          'x-whisper-model': alignModel,
        },
        body: buf,
      });
      const data = await parseApiJson<{
        language?: string;
        modelUsed?: string;
        backendUsed?: string;
        durationSec?: number;
        text?: string;
        words?: WordTiming[];
        cues?: TranscriptCue[];
        srt?: string;
        error?: string;
      }>(res, 'Không thể căn chỉnh word-level');
      if (!res.ok) {
        throw new Error(data?.error || 'Không thể căn chỉnh word-level.');
      }
      setAlignResult({
        language: data.language,
        modelUsed: data.modelUsed || alignModel,
        backendUsed: data.backendUsed || 'faster-whisper',
        durationSec: Number(data.durationSec || 0),
        text: data.text || '',
        words: Array.isArray(data.words) ? data.words : [],
        cues: Array.isArray(data.cues) ? data.cues : [],
        srt: data.srt || '',
      });
    } catch (err) {
      setAlignError(err instanceof Error ? err.message : 'Lỗi chạy Whisper Local.');
    } finally {
      setIsAligning(false);
    }
  };

  const totalSizeMb = useMemo(
    () => (outputFiles.reduce((acc, f) => acc + f.bytes, 0) / (1024 * 1024)).toFixed(2),
    [outputFiles],
  );

  return (
    <div className="max-w-[1400px] w-full mx-auto p-4 lg:p-6 space-y-5">
      {/* Header Banner */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-slate-900">
            Educational Audio Video Studio 1.19 — FFmpeg Server &amp; Reading Along
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Ghép Video + Audio + Watermark/Outro, đốt phụ đề Karaoke (.ass) với Ducking nhạc nền &amp; SFX, và Reading Along căn chỉnh từng từ qua faster-whisper ({alignModel}).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void refreshOutputFiles()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Làm mới Output</span>
          </button>
          <button
            type="button"
            onClick={() => void handleOpenOutputFolder()}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
          >
            <FolderOpen className="w-3.5 h-3.5" />
            <span>Mở thư mục Output ({outputFiles.length} file)</span>
          </button>
        </div>
      </section>

      {folderStatusMsg && (
        <div className="px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2">
          <span>{folderStatusMsg}</span>
          <button
            type="button"
            onClick={() => setFolderStatusMsg(null)}
            className="text-emerald-700 font-semibold"
          >
            Đóng
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
        {/* Left 7 Cols: Educational Studio 1.19 Tool Tabs */}
        <div className="lg:col-span-7 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSubTab('merge')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                subTab === 'merge'
                  ? 'bg-white border-indigo-300 text-indigo-700 shadow-xs'
                  : 'border-transparent text-slate-600 hover:bg-white/60'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>1. Ghép Video + Audio &amp; Watermark</span>
            </button>

            <button
              type="button"
              onClick={() => setSubTab('karaoke')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                subTab === 'karaoke'
                  ? 'bg-white border-indigo-300 text-indigo-700 shadow-xs'
                  : 'border-transparent text-slate-600 hover:bg-white/60'
              }`}
            >
              <Music className="w-3.5 h-3.5" />
              <span>2. Karaoke Sub (.ass) &amp; Mix Audio</span>
            </button>

            <button
              type="button"
              onClick={() => setSubTab('align')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                subTab === 'align'
                  ? 'bg-white border-indigo-300 text-indigo-700 shadow-xs'
                  : 'border-transparent text-slate-600 hover:bg-white/60'
              }`}
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>3. Reading Along (Whisper Word-Level)</span>
            </button>
          </div>

          <div className="p-5 space-y-4">
            {subTab === 'merge' && (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                    <Film className="w-5 h-5 text-indigo-600 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-800 truncate">
                        {mergeVideoFile ? mergeVideoFile.name : 'Chọn Video nền (.mp4, .mov)'}
                      </div>
                      <div className="text-[11px] text-slate-500">Video gốc không tiếng hoặc giữ hình</div>
                    </div>
                    <input
                      type="file"
                      accept="video/*"
                      className="hidden"
                      onChange={(e) => setMergeVideoFile(e.target.files?.[0] ?? null)}
                    />
                  </label>

                  <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                    <FileAudio className="w-5 h-5 text-emerald-600 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-slate-800 truncate">
                        {mergeAudioFile ? mergeAudioFile.name : 'Chọn Audio giảng dạy (.mp3, .wav)'}
                      </div>
                      <div className="text-[11px] text-slate-500">Âm thanh chính cho video đầu ra</div>
                    </div>
                    <input
                      type="file"
                      accept="audio/*"
                      className="hidden"
                      onChange={(e) => setMergeAudioFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Xử lý độ dài Video so với Audio
                    </label>
                    <select
                      value={durationMode}
                      onChange={(e) => setDurationMode(e.target.value as 'loop-video' | 'shortest')}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                    >
                      <option value="loop-video">Tự lặp Video nền khớp hết độ dài Audio</option>
                      <option value="shortest">Cắt theo file ngắn hơn (Shortest)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Tên file đầu ra
                    </label>
                    <input
                      type="text"
                      value={mergeOutputName}
                      onChange={(e) => setMergeOutputName(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg font-mono"
                    />
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                  <div className="text-xs font-bold text-slate-800">Watermark &amp; Outro (Tùy chọn)</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-1">Chữ Watermark</label>
                      <input
                        type="text"
                        value={watermarkText}
                        onChange={(e) => setWatermarkText(e.target.value)}
                        placeholder="@EnglishChannel"
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-1">Góc đặt</label>
                      <select
                        value={watermarkCorner}
                        onChange={(e) => setWatermarkCorner(e.target.value as typeof watermarkCorner)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="bottom-right">Dưới phải</option>
                        <option value="bottom-left">Dưới trái</option>
                        <option value="top-right">Trên phải</option>
                        <option value="top-left">Trên trái</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-1">
                        Độ đậm ({Math.round(watermarkOpacity * 100)}%)
                      </label>
                      <input
                        type="range"
                        min={0.15}
                        max={1}
                        step={0.05}
                        value={watermarkOpacity}
                        onChange={(e) => setWatermarkOpacity(Number(e.target.value))}
                        className="w-full accent-indigo-600 mt-1.5"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] text-slate-600 mb-1">
                        Chữ Outro cuối video (2 dòng tối đa)
                      </label>
                      <input
                        type="text"
                        value={outroText}
                        onChange={(e) => setOutroText(e.target.value)}
                        placeholder="Subscribe for daily English lessons!"
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-600 mb-1">
                        Thời lượng Outro ({outroDuration}s)
                      </label>
                      <input
                        type="range"
                        min={0}
                        max={6}
                        step={0.5}
                        value={outroDuration}
                        onChange={(e) => setOutroDuration(Number(e.target.value))}
                        className="w-full accent-indigo-600 mt-1.5"
                      />
                    </div>
                  </div>
                </div>

                {mergeError && (
                  <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                    {mergeError}
                  </p>
                )}
                {mergeStatus && (
                  <p className="text-xs text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg p-2.5 font-medium">
                    {mergeStatus}
                  </p>
                )}

                <div className="flex items-center gap-2">
                  {isMerging ? (
                    <button
                      type="button"
                      onClick={handleCancelMerge}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-rose-600 rounded-lg hover:bg-rose-700"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span>Hủy ghép video</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!mergeVideoFile || !mergeAudioFile}
                      onClick={() => void handleRunMerge()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>Ghép Video + Audio (FFmpeg Server)</span>
                    </button>
                  )}
                </div>
              </>
            )}

            {subTab === 'karaoke' && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    { label: 'Video nền *', file: kmVideoFile, set: setKmVideoFile, accept: 'video/*' },
                    { label: 'Nhạc nền BGM', file: kmMusicFile, set: setKmMusicFile, accept: 'audio/*' },
                    { label: 'Ambient SFX', file: kmSfxFile, set: setKmSfxFile, accept: 'audio/*' },
                    { label: 'Voiceover', file: kmVoiceFile, set: setKmVoiceFile, accept: 'audio/*' },
                  ].map((slot) => (
                    <label
                      key={slot.label}
                      className="p-2.5 rounded-xl border border-dashed border-slate-300 bg-slate-50 hover:bg-indigo-50/40 cursor-pointer text-center space-y-1"
                    >
                      <Upload className="w-4 h-4 text-indigo-600 mx-auto" />
                      <div className="text-[11px] font-semibold text-slate-800 truncate">
                        {slot.file ? slot.file.name : slot.label}
                      </div>
                      <input
                        type="file"
                        accept={slot.accept}
                        className="hidden"
                        onChange={(e) => slot.set(e.target.files?.[0] ?? null)}
                      />
                    </label>
                  ))}
                </div>

                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-slate-700">
                      Nội dung SRT / Câu thoại để đốt Karaoke .ASS
                    </label>
                    <div className="flex items-center gap-2">
                      <label className="inline-flex items-center gap-1 text-[11px] text-slate-600">
                        <span>Màu hát:</span>
                        <input
                          type="color"
                          value={kmHighlightColor}
                          onChange={(e) => setKmHighlightColor(e.target.value)}
                          className="w-6 h-5 rounded border border-slate-200 cursor-pointer"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={handleGenerateAss}
                        className="px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-md hover:bg-indigo-100"
                      >
                        Sinh mã Karaoke .ASS →
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    <textarea
                      rows={5}
                      value={kmSrtInput}
                      onChange={(e) => setKmSrtInput(e.target.value)}
                      placeholder="Dán .SRT hoặc từng dòng câu..."
                      className="w-full p-2.5 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg"
                    />
                    <textarea
                      rows={5}
                      value={kmAssContent}
                      onChange={(e) => setKmAssContent(e.target.value)}
                      placeholder="Mã Karaoke .ASS tự động sinh (hoặc dán file .ass có sẵn)..."
                      className="w-full p-2.5 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg"
                    />
                  </div>
                </div>

                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Hiệu ứng Video FX
                      </label>
                      <select
                        value={kmEffect}
                        onChange={(e) => setKmEffect(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="Fade cinematic">Fade cinematic</option>
                        <option value="Soft vignette + fade">Soft vignette + fade</option>
                        <option value="Warm film + fade">Warm film + fade</option>
                        <option value="Cool tech + fade">Cool tech + fade</option>
                        <option value="Slow zoom + fade">Slow zoom + fade</option>
                        <option value="None">Không hiệu ứng</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Delay Voiceover (giây)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step={0.2}
                        value={kmVoiceStart}
                        onChange={(e) => setKmVoiceStart(Number(e.target.value))}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Tên file xuất
                      </label>
                      <input
                        type="text"
                        value={kmOutputName}
                        onChange={(e) => setKmOutputName(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    <label>
                      <span>Âm gốc: {Math.round(kmOriginalVol * 100)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.05}
                        value={kmOriginalVol}
                        onChange={(e) => setKmOriginalVol(Number(e.target.value))}
                        className="w-full accent-indigo-600"
                      />
                    </label>
                    <label>
                      <span>Nhạc nền: {Math.round(kmMusicVol * 100)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.05}
                        value={kmMusicVol}
                        onChange={(e) => setKmMusicVol(Number(e.target.value))}
                        className="w-full accent-indigo-600"
                      />
                    </label>
                    <label>
                      <span>SFX: {Math.round(kmSfxVol * 100)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.05}
                        value={kmSfxVol}
                        onChange={(e) => setKmSfxVol(Number(e.target.value))}
                        className="w-full accent-indigo-600"
                      />
                    </label>
                    <label>
                      <span>Voice: {Math.round(kmVoiceVol * 100)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={1.8}
                        step={0.05}
                        value={kmVoiceVol}
                        onChange={(e) => setKmVoiceVol(Number(e.target.value))}
                        className="w-full accent-indigo-600"
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-4 text-xs text-slate-700 pt-1">
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={kmVoicePriority}
                        onChange={(e) => setKmVoicePriority(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600"
                      />
                      <span>Tự giảm nhạc khi đọc (Sidechain Ducking)</span>
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={kmMuteOriginal}
                        onChange={(e) => setKmMuteOriginal(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600"
                      />
                      <span>Tắt tiếng video gốc</span>
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={kmRemoveDialogue}
                        onChange={(e) => setKmRemoveDialogue(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600"
                      />
                      <span>Khử giọng trung tâm (Karaoke Beat)</span>
                    </label>
                  </div>
                </div>

                {kmError && (
                  <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                    {kmError}
                  </p>
                )}
                {kmStatus && (
                  <p className="text-xs text-indigo-800 bg-indigo-50 border border-indigo-200 rounded-lg p-2.5 font-medium">
                    {kmStatus}
                  </p>
                )}

                <div className="flex items-center gap-2">
                  {isRenderingKm ? (
                    <button
                      type="button"
                      onClick={handleCancelKaraokeMix}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-rose-600 rounded-lg hover:bg-rose-700"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span>Hủy render</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!kmVideoFile}
                      onClick={() => void handleRunKaraokeMix()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>Render Karaoke &amp; Mix Audio (.mp4)</span>
                    </button>
                  )}
                </div>
              </>
            )}

            {subTab === 'align' && (
              <>
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-800 truncate">
                      {alignFile ? alignFile.name : 'Chọn Audio / Video để căn chỉnh từng từ (Reading Along)'}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      Dùng faster-whisper Built-in nội bộ, không cần API key
                    </div>
                  </div>
                  <label className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-indigo-700 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50 cursor-pointer">
                    <Upload className="w-3.5 h-3.5" />
                    <span>{alignFile ? 'Đổi file' : 'Chọn Audio / Video'}</span>
                    <input
                      type="file"
                      accept="audio/*,video/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0] ?? null;
                        setAlignFile(f);
                        setAlignError(null);
                        setAlignAudioUrl((prev) => {
                          if (prev) URL.revokeObjectURL(prev);
                          return f ? URL.createObjectURL(f) : null;
                        });
                      }}
                    />
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Model STT Built-in
                    </label>
                    <select
                      value={alignModel}
                      onChange={(e) => setAlignModel(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg font-mono"
                    >
                      <option value="large-v3-turbo">faster-whisper: large-v3-turbo</option>
                      <option value="Xenova/whisper-small">whisper-small</option>
                      <option value="Xenova/whisper-base">whisper-base</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Ngôn ngữ
                    </label>
                    <select
                      value={alignLang}
                      onChange={(e) => setAlignLang(e.target.value)}
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                    >
                      <option value="auto">Tự động</option>
                      <option value="en">English</option>
                      <option value="vi">Tiếng Việt</option>
                      <option value="ja">日本語</option>
                    </select>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={!alignFile || isAligning}
                  onClick={() => void handleRunWordAlign()}
                  className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                >
                  {isAligning ? <Loader2 className="w-4 h-4 animate-spin" /> : <Wand2 className="w-4 h-4" />}
                  <span>{isAligning ? 'Đang căn chỉnh word-level...' : 'Chạy Reading Along Alignment'}</span>
                </button>

                {alignError && (
                  <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                    {alignError}
                  </p>
                )}

                {alignAudioUrl && (
                  <audio
                    ref={alignAudioRef}
                    controls
                    src={alignAudioUrl}
                    onTimeUpdate={(e) => setAlignCurrentSec(e.currentTarget.currentTime)}
                    className="w-full h-9"
                  />
                )}

                {alignResult && (
                  <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="font-bold text-emerald-800 inline-flex items-center gap-1.5">
                        <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                        {alignResult.backendUsed} ({alignResult.modelUsed})
                        {alignResult.language ? ` · ${alignResult.language}` : ''} · {alignResult.words.length} từ
                      </span>
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => {
                            const blob = new Blob([alignResult.srt], { type: 'text/plain;charset=utf-8' });
                            const url = URL.createObjectURL(blob);
                            const a = document.createElement('a');
                            a.href = url;
                            a.download = 'aligned.srt';
                            a.click();
                            setTimeout(() => URL.revokeObjectURL(url), 4000);
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold bg-white border border-slate-200 rounded-md hover:bg-slate-100"
                        >
                          <Download className="w-3 h-3" />
                          <span>Tải .SRT</span>
                        </button>
                        {onSendAudioCuesToStudio && (
                          <button
                            type="button"
                            onClick={() =>
                              onSendAudioCuesToStudio(
                                alignFile,
                                alignResult.cues,
                                alignFile?.name.replace(/\.[^.]+$/, '') || 'Aligned Lesson',
                              )
                            }
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-white bg-indigo-600 rounded-md hover:bg-indigo-700"
                          >
                            <Play className="w-3 h-3 fill-current" />
                            <span>Nạp sang Studio 9:16</span>
                          </button>
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-1.5 max-h-48 overflow-y-auto p-2 bg-white rounded-lg border border-slate-200">
                      {alignResult.words.map((w, idx) => {
                        const active = alignCurrentSec >= w.start && alignCurrentSec <= w.end;
                        return (
                          <button
                            key={`${w.start}-${idx}`}
                            type="button"
                            onClick={() => {
                              if (alignAudioRef.current) {
                                alignAudioRef.current.currentTime = w.start;
                                void alignAudioRef.current.play().catch(() => undefined);
                              }
                            }}
                            title={`${w.start.toFixed(2)}s - ${w.end.toFixed(2)}s`}
                            className={`px-2 py-1 text-xs rounded-md transition-colors ${
                              active
                                ? 'bg-indigo-600 text-white font-bold shadow-xs'
                                : 'bg-slate-100 text-slate-800 hover:bg-indigo-50'
                            }`}
                          >
                            {w.word}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Right 5 Cols: Output Folder Player & Manager */}
        <div className="lg:col-span-5 bg-white border border-slate-200 rounded-xl p-4 space-y-3.5 sticky top-4">
          <div className="flex items-center justify-between gap-2 pb-2.5 border-b border-slate-100">
            <div className="min-w-0">
              <h2 className="text-sm font-bold text-slate-900">
                Thư mục Output ({outputFiles.length} file · {totalSizeMb} MB)
              </h2>
              <p className="text-[11px] text-slate-500 font-mono truncate">{outputDir}</p>
            </div>
            <button
              type="button"
              onClick={() => void handleOpenOutputFolder()}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 shrink-0"
            >
              <FolderOpen className="w-3.5 h-3.5" />
              <span>Mở thư mục</span>
            </button>
          </div>

          {previewVideoRelPath && (
            <div className="space-y-1.5">
              <div className="text-[11px] font-semibold text-indigo-700 font-mono truncate">
                Đang phát thử: {previewVideoRelPath}
              </div>
              <video
                key={previewVideoRelPath}
                controls
                autoPlay
                src={`/api/output/download?path=${encodeURIComponent(previewVideoRelPath)}&inline=1`}
                className="w-full max-h-[340px] rounded-xl bg-slate-950 border border-slate-200"
              />
            </div>
          )}

          <div className="divide-y divide-slate-100 max-h-[360px] overflow-y-auto border border-slate-200 rounded-xl">
            {outputFiles.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-500">
                Chưa có video nào trong thư mục Output. Hãy render ở bất kỳ tab nào để xem và tải lại tại đây.
              </div>
            ) : (
              outputFiles.map((f) => (
                <div
                  key={f.relativePath}
                  className="px-3 py-2.5 flex items-center justify-between gap-2 text-xs hover:bg-slate-50"
                >
                  <button
                    type="button"
                    onClick={() => setPreviewVideoRelPath(f.relativePath)}
                    className="min-w-0 text-left flex-1"
                  >
                    <div className="font-semibold text-slate-900 truncate">{f.name}</div>
                    <div className="text-[10px] text-slate-500 font-mono truncate">
                      {f.relativePath} · {(f.bytes / (1024 * 1024)).toFixed(2)} MB
                    </div>
                  </button>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => setPreviewVideoRelPath(f.relativePath)}
                      className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded-md"
                      title="Xem video"
                    >
                      <Play className="w-3.5 h-3.5" />
                    </button>
                    <a
                      href={`/api/output/download?path=${encodeURIComponent(f.relativePath)}`}
                      download={f.name}
                      className="p-1.5 text-emerald-700 hover:bg-emerald-50 rounded-md"
                      title="Tải về máy"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                    <button
                      type="button"
                      onClick={async () => {
                        await fetch(
                          `/api/output/file?path=${encodeURIComponent(f.relativePath)}`,
                          { method: 'DELETE' },
                        );
                        if (previewVideoRelPath === f.relativePath) {
                          setPreviewVideoRelPath(null);
                        }
                        void refreshOutputFiles();
                      }}
                      className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-md"
                      title="Xóa file"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
