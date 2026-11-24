import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  CheckCircle2,
  Download,
  Eye,
  FileAudio,
  Film,
  FolderOpen,
  FolderPlus,
  Globe,
  Layers,
  Link2,
  Loader2,
  Music,
  Pause,
  Play,
  Sparkles,
  Square,
  Upload,
  Volume2,
  Wand2,
} from 'lucide-react';
import {
  buildEduKaraokeAss,
  buildEstimatedReadingWords,
  EduKaraokePosition,
  EduKaraokeSize,
  EduWatermarkCorner,
  EduWatermarkOutroConfig,
  KARAOKE_EFFECT_PRESETS,
  READING_BOOK_PALETTES,
  ReadingBookPalette,
  ReadingIllustrationStyle,
  renderReadingAlongFrame,
} from '../engine/eduStudioEffects';
import {
  ASPECT_RATIO_OPTIONS,
  DEFAULT_MP4_EXPORT_SETTINGS,
  ExportAspectRatioId,
  ExportFpsOption,
  ExportQualityId,
  ExportResolutionId,
  resolveMp4EncodingParams,
} from '../engine/mp4Config';
import { ExportAbortedError, exportProjectToServerDisk } from '../engine/mp4Exporter';
import { parseTranscriptAuto } from '../engine/transcriptParser';
import {
  alignAudioWithProgressJob,
  fetchTtsVoicesCatalog,
  synthesizeAudioAndSyncCues,
  TtsProviderItem,
} from '../engine/ttsSyncHelper';
import { LessonProject, TranscriptCue, WordTiming } from '../engine/types';
import { emitOutputUpdated } from './GlobalOutputPanel';

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
    throw new Error(
      res.ok ? `${fallbackError}: JSON không hợp lệ.` : `${fallbackError} (HTTP ${res.status})`,
    );
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

function getPreviewVideoCssFilter(effect: string): string {
  switch (effect) {
    case 'Warm film + fade':
      return 'contrast(1.06) saturate(1.15) sepia(0.14)';
    case 'Cool tech + fade':
      return 'contrast(1.06) saturate(1.08) hue-rotate(-8deg)';
    case 'Soft vignette + fade':
      return 'contrast(1.04) saturate(0.92)';
    default:
      return 'none';
  }
}

interface VideoSnapshotStripProps {
  videoUrl: string | null;
  videoFilterCss?: string;
  watermarkOutro: EduWatermarkOutroConfig;
  subtitleSampleText?: string;
  highlightColor?: string;
  subtitlePosition?: EduKaraokePosition;
  onSeek?: (timeSec: number) => void;
}

const VideoSnapshotStrip: React.FC<VideoSnapshotStripProps> = ({
  videoUrl,
  videoFilterCss = 'none',
  watermarkOutro,
  subtitleSampleText,
  highlightColor = '#FACC15',
  subtitlePosition = 'Dưới',
  onSeek,
}) => {
  const [snapshots, setSnapshots] = useState<Array<{ label: string; timeSec: number; dataUrl: string }>>([]);
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    if (!videoUrl) {
      setSnapshots([]);
      setIsCapturing(false);
      return;
    }

    let cancelled = false;
    setIsCapturing(true);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = videoUrl;

    const captureFrames = async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const onLoaded = () => {
            cleanup();
            resolve();
          };
          const onErr = () => {
            cleanup();
            reject(new Error('Không đọc được metadata video'));
          };
          const timer = window.setTimeout(() => {
            cleanup();
            resolve();
          }, 4000);
          const cleanup = () => {
            window.clearTimeout(timer);
            video.removeEventListener('loadeddata', onLoaded);
            video.removeEventListener('loadedmetadata', onLoaded);
            video.removeEventListener('error', onErr);
          };
          video.addEventListener('loadeddata', onLoaded);
          video.addEventListener('loadedmetadata', onLoaded);
          video.addEventListener('error', onErr);
        });

        if (cancelled) return;
        const dur = Number.isFinite(video.duration) && video.duration > 0.2 ? video.duration : 3;
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 360;
        const maxW = 320;
        const cw = maxW;
        const ch = Math.max(120, Math.round((maxW * vh) / vw));

        const targets = [
          { label: 'Đầu · 12%', timeSec: Math.max(0.05, dur * 0.12) },
          { label: 'Giữa · 50%', timeSec: Math.max(0.1, dur * 0.5) },
          { label: 'Cuối · 85%', timeSec: Math.max(0.15, dur * 0.85) },
        ];

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const nextSnaps: Array<{ label: string; timeSec: number; dataUrl: string }> = [];

        for (let i = 0; i < targets.length; i++) {
          if (cancelled) return;
          const target = targets[i];
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              window.clearTimeout(timeoutId);
              video.removeEventListener('seeked', finish);
              resolve();
            };
            const timeoutId = window.setTimeout(finish, 1800);
            video.addEventListener('seeked', finish);
            try {
              video.currentTime = Math.min(Math.max(0, dur - 0.05), target.timeSec);
            } catch {
              finish();
            }
          });

          if (cancelled) return;
          ctx.clearRect(0, 0, cw, ch);
          ctx.save();
          ctx.filter = videoFilterCss !== 'none' ? videoFilterCss : 'none';
          ctx.drawImage(video, 0, 0, cw, ch);
          ctx.restore();

          if (subtitleSampleText?.trim()) {
            const subText = subtitleSampleText.trim().slice(0, 48);
            ctx.save();
            ctx.font = 'bold 12px sans-serif';
            const tw = Math.min(cw - 24, ctx.measureText(subText).width + 18);
            const sy =
              subtitlePosition === 'Trên' ? 14 : subtitlePosition === 'Giữa' ? ch / 2 - 12 : ch - 34;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
            ctx.fillRect((cw - tw) / 2, sy, tw, 22);
            ctx.fillStyle = highlightColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(subText, cw / 2, sy + 11, cw - 28);
            ctx.restore();
          }

          if (watermarkOutro.watermarkEnabled && watermarkOutro.watermarkText.trim()) {
            ctx.save();
            ctx.globalAlpha = watermarkOutro.watermarkOpacity;
            ctx.font = 'bold 10px sans-serif';
            const wm = watermarkOutro.watermarkText.trim();
            const wmW = Math.min(cw - 16, ctx.measureText(wm).width + 12);
            const pad = 8;
            const wx = watermarkOutro.watermarkCorner.includes('left') ? pad : cw - wmW - pad;
            const wy = watermarkOutro.watermarkCorner.includes('top') ? pad : ch - 20 - pad;
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(wx, wy, wmW, 18);
            ctx.fillStyle = '#FFFFFF';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(wm, wx + 6, wy + 9, cw - 20);
            ctx.restore();
          }

          if (i === targets.length - 1 && watermarkOutro.outroSeconds > 0 && watermarkOutro.outroLine1.trim()) {
            ctx.save();
            ctx.fillStyle = 'rgba(79, 70, 229, 0.85)';
            ctx.fillRect(8, 8, Math.min(cw - 16, 130), 16);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold 9px sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(`+ Outro ${watermarkOutro.outroSeconds}s`, 14, 16);
            ctx.restore();
          }

          nextSnaps.push({
            label: target.label,
            timeSec: target.timeSec,
            dataUrl: canvas.toDataURL('image/jpeg', 0.8),
          });
        }

        if (!cancelled) {
          setSnapshots(nextSnaps);
        }
      } catch {
        if (!cancelled) setSnapshots([]);
      } finally {
        if (!cancelled) setIsCapturing(false);
        video.src = '';
      }
    };

    void captureFrames();
    return () => {
      cancelled = true;
      video.src = '';
    };
  }, [
    videoUrl,
    videoFilterCss,
    watermarkOutro.watermarkEnabled,
    watermarkOutro.watermarkText,
    watermarkOutro.watermarkCorner,
    watermarkOutro.watermarkOpacity,
    watermarkOutro.outroSeconds,
    watermarkOutro.outroLine1,
    subtitleSampleText,
    highlightColor,
    subtitlePosition,
  ]);

  if (!videoUrl) return null;

  return (
    <div className="pt-2 border-t border-slate-800 space-y-1.5">
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>Ảnh xem trước nhanh 3 mốc (bấm ảnh để tua nhanh)</span>
        {isCapturing && <span className="text-indigo-300">Đang chụp khung hình...</span>}
      </div>
      {snapshots.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {snapshots.map((snap) => (
            <button
              key={snap.label}
              type="button"
              onClick={() => onSeek?.(snap.timeSec)}
              className="group relative rounded-md overflow-hidden border border-slate-700 hover:border-indigo-400 bg-slate-950 text-left"
            >
              <img
                src={snap.dataUrl}
                alt={snap.label}
                className="w-full h-16 object-cover group-hover:opacity-90"
              />
              <div className="px-1.5 py-0.5 bg-slate-950/90 text-[10px] text-slate-300 font-mono flex items-center justify-between">
                <span>{snap.label}</span>
                <span>{snap.timeSec.toFixed(1)}s</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

interface WatermarkOutroSectionProps {
  config: EduWatermarkOutroConfig;
  onChange: (next: EduWatermarkOutroConfig) => void;
  title?: string;
}

const WatermarkOutroSection: React.FC<WatermarkOutroSectionProps> = ({
  config,
  onChange,
  title = 'Watermark & Outro (Tùy chọn)',
}) => (
  <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs font-bold text-slate-800">{title}</div>
      <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer">
        <input
          type="checkbox"
          checked={config.watermarkEnabled}
          onChange={(e) => onChange({ ...config, watermarkEnabled: e.target.checked })}
          className="rounded border-slate-300 text-indigo-600"
        />
        <span>Bật Watermark xuyên suốt video</span>
      </label>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">Nội dung Watermark</label>
        <input
          type="text"
          disabled={!config.watermarkEnabled}
          value={config.watermarkText}
          onChange={(e) => onChange({ ...config, watermarkText: e.target.value })}
          placeholder="@EnglishChannel"
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg disabled:opacity-50"
        />
      </div>
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">Góc đặt</label>
        <select
          disabled={!config.watermarkEnabled}
          value={config.watermarkCorner}
          onChange={(e) =>
            onChange({ ...config, watermarkCorner: e.target.value as EduWatermarkCorner })
          }
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg disabled:opacity-50"
        >
          <option value="bottom-right">Dưới phải</option>
          <option value="bottom-left">Dưới trái</option>
          <option value="top-right">Trên phải</option>
          <option value="top-left">Trên trái</option>
        </select>
      </div>
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">
          Độ mờ / Opacity ({Math.round(config.watermarkOpacity * 100)}%)
        </label>
        <input
          type="range"
          disabled={!config.watermarkEnabled}
          min={0.15}
          max={1}
          step={0.05}
          value={config.watermarkOpacity}
          onChange={(e) => onChange({ ...config, watermarkOpacity: Number(e.target.value) })}
          className="w-full accent-indigo-600 mt-1.5 disabled:opacity-50"
        />
      </div>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1 border-t border-slate-200/70">
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">Outro dòng 1</label>
        <input
          type="text"
          value={config.outroLine1}
          onChange={(e) => onChange({ ...config, outroLine1: e.target.value })}
          placeholder="Thanks for watching!"
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
        />
      </div>
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">Outro dòng 2</label>
        <input
          type="text"
          value={config.outroLine2}
          onChange={(e) => onChange({ ...config, outroLine2: e.target.value })}
          placeholder="See you next time"
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
        />
      </div>
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">
          Thời lượng Outro ({config.outroSeconds}s)
        </label>
        <input
          type="range"
          min={0}
          max={6}
          step={0.5}
          value={config.outroSeconds}
          onChange={(e) => onChange({ ...config, outroSeconds: Number(e.target.value) })}
          className="w-full accent-indigo-600 mt-1.5"
        />
      </div>
    </div>
  </div>
);

export const EducationalStudioTab: React.FC<EducationalStudioTabProps> = ({
  onSendAudioCuesToStudio,
}) => {
  const [subTab, setSubTab] = useState<'merge' | 'karaoke' | 'align'>('merge');

  // ── Shared Watermark & Outro (Tùy chọn) across all Edu Studio 1.19 tabs ────
  const [watermarkOutro, setWatermarkOutro] = useState<EduWatermarkOutroConfig>({
    watermarkEnabled: true,
    watermarkText: 'YOUR CHANNEL',
    watermarkCorner: 'bottom-right',
    watermarkOpacity: 0.65,
    outroSeconds: 3,
    outroLine1: 'Thanks for watching!',
    outroLine2: 'See you next time',
  });

  // ── Shared Output Folder Config ────────────────────────────────────────────
  const [outputFolders, setOutputFolders] = useState<string[]>([]);
  const [selectedSavePath, setSelectedSavePath] = useState<string>('');
  const [localDirHandle, setLocalDirHandle] = useState<any>(null);
  const [localDirName, setLocalDirName] = useState<string | null>(null);
  const [folderStatusMsg, setFolderStatusMsg] = useState<string | null>(null);

  const supportsLocalFolderPicker =
    typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function';

  const refreshOutputFolders = useCallback(async () => {
    try {
      const foldersRes = await fetch('/api/output/folders').catch(() => null);
      if (foldersRes && foldersRes.ok) {
        const fData = (await foldersRes.json()) as { folders?: string[] };
        if (Array.isArray(fData.folders)) {
          setOutputFolders(fData.folders);
        }
      }
    } catch {
      // ignore offline
    }
  }, []);

  useEffect(() => {
    void refreshOutputFolders();
  }, [refreshOutputFolders]);

  const handlePickLocalOutputFolder = async () => {
    if (!supportsLocalFolderPicker) return;
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      setLocalDirHandle(handle);
      setLocalDirName(handle?.name || 'Thư mục máy tính');
      setFolderStatusMsg(
        `Đã chọn thư mục lưu bổ sung trên máy: "${handle?.name}". Khi render xong file sẽ tự động lưu thêm vào thư mục này.`,
      );
    } catch {
      // cancelled
    }
  };

  const saveServerFileToLocalDir = useCallback(
    async (relativePath: string, fileName: string) => {
      if (!localDirHandle) return false;
      try {
        const resp = await fetch(`/api/output/download?path=${encodeURIComponent(relativePath)}`);
        if (!resp.ok) return false;
        const blob = await resp.blob();
        const fileHandle = await localDirHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch {
        return false;
      }
    },
    [localDirHandle],
  );

  const renderOutputFolderControl = () => (
    <div className="p-3 rounded-xl bg-emerald-50/60 border border-emerald-200/80 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-[11px] font-bold text-emerald-950 inline-flex items-center gap-1.5">
          <FolderPlus className="w-3.5 h-3.5 text-emerald-700" />
          <span>Thư mục Output lưu file</span>
        </label>
        {supportsLocalFolderPicker && (
          <button
            type="button"
            onClick={() => void handlePickLocalOutputFolder()}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 bg-white border border-emerald-300 rounded-md hover:bg-emerald-50"
          >
            <FolderOpen className="w-3 h-3" />
            <span>
              {localDirName ? `Thư mục máy: ${localDirName}` : 'Chọn thêm thư mục trên máy...'}
            </span>
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <select
          aria-label="Chọn thư mục Output có sẵn"
          value={outputFolders.includes(selectedSavePath) ? selectedSavePath : '__custom__'}
          onChange={(e) => {
            if (e.target.value !== '__custom__') {
              setSelectedSavePath(e.target.value);
            }
          }}
          className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-mono"
        >
          <option value="">Thư mục gốc (output/)</option>
          {outputFolders.map((folder) => (
            <option key={folder} value={folder}>
              output/{folder}
            </option>
          ))}
          {!outputFolders.includes(selectedSavePath) && selectedSavePath !== '' && (
            <option value="__custom__">Thư mục mới: output/{selectedSavePath}</option>
          )}
        </select>
        <input
          type="text"
          value={selectedSavePath}
          onChange={(e) => setSelectedSavePath(e.target.value)}
          placeholder="Hoặc nhập tên thư mục con (để trống = output/)"
          className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-mono"
        />
      </div>
    </div>
  );

  // ── Sub-tab 1: Merge Video + Audio (Single & Batch Pairing) + Watermark/Outro ──
  const [mergeMode, setMergeMode] = useState<'single' | 'batch'>('single');
  const [mergeVideoFile, setMergeVideoFile] = useState<File | null>(null);
  const [mergeAudioFile, setMergeAudioFile] = useState<File | null>(null);
  const [batchVideos, setBatchVideos] = useState<File[]>([]);
  const [batchAudios, setBatchAudios] = useState<File[]>([]);
  const [mergeVideoUrl, setMergeVideoUrl] = useState<string | null>(null);
  const [mergeAudioUrl, setMergeAudioUrl] = useState<string | null>(null);
  const mergePreviewVideoRef = useRef<HTMLVideoElement>(null);
  const mergePreviewAudioRef = useRef<HTMLAudioElement>(null);
  const [durationMode, setDurationMode] = useState<'loop-video' | 'shortest'>('shortest');
  const [mergeOutputName, setMergeOutputName] = useState('');
  const [isMerging, setIsMerging] = useState(false);
  const [mergeProgress, setMergeProgress] = useState(0);
  const [mergeStatus, setMergeStatus] = useState<string>('');
  const [mergeError, setMergeError] = useState<string | null>(null);
  const mergeAbortRef = useRef<AbortController | null>(null);
  const activeMergeJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!mergeVideoFile) {
      setMergeVideoUrl(null);
      return;
    }
    const url = URL.createObjectURL(mergeVideoFile);
    setMergeVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [mergeVideoFile]);

  useEffect(() => {
    if (!mergeAudioFile) {
      setMergeAudioUrl(null);
      return;
    }
    const url = URL.createObjectURL(mergeAudioFile);
    setMergeAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [mergeAudioFile]);

  const batchMatchedPairs = useMemo(() => {
    const audioMap = new Map<string, File>();
    for (const a of batchAudios) {
      const stem = a.name.replace(/\.[^.]+$/, '').toLowerCase();
      if (!audioMap.has(stem)) audioMap.set(stem, a);
    }
    const matched: Array<{ video: File; audio: File; stem: string }> = [];
    const missing: string[] = [];
    for (const v of batchVideos) {
      const stem = v.name.replace(/\.[^.]+$/, '').toLowerCase();
      const match = audioMap.get(stem);
      if (match) {
        matched.push({ video: v, audio: match, stem: v.name.replace(/\.[^.]+$/, '') });
      } else {
        missing.push(v.name);
      }
    }
    return { matched, missing };
  }, [batchVideos, batchAudios]);

  const handleCancelMerge = () => {
    mergeAbortRef.current?.abort();
    if (activeMergeJobIdRef.current) {
      void fetch(`/api/studio/job/${activeMergeJobIdRef.current}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  };

  const runSingleMergeJob = async (
    video: File,
    audio: File,
    outStem: string,
    controller: AbortController,
    progressPrefix = '',
  ) => {
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

    setMergeProgress(5);
    setMergeStatus(`${progressPrefix}Đang tải Video (${video.name})...`);
    await uploadStudioFileChunked(jobId, 'video', video, controller.signal);

    setMergeProgress(18);
    setMergeStatus(`${progressPrefix}Đang tải Audio (${audio.name})...`);
    await uploadStudioFileChunked(jobId, 'audio', audio, controller.signal);

    const outroText = [watermarkOutro.outroLine1.trim(), watermarkOutro.outroLine2.trim()]
      .filter(Boolean)
      .join('\n');

    setMergeProgress(25);
    setMergeStatus(`${progressPrefix}FFmpeg đang ghép Video + Audio + Watermark/Outro...`);

    const pollTimer = window.setInterval(async () => {
      try {
        const stRes = await fetch(`/api/studio/job/${jobId}/status`, { signal: controller.signal });
        if (!stRes.ok) return;
        const stData = (await stRes.json()) as { progress?: number; stageLabel?: string };
        if (typeof stData.progress === 'number' && stData.progress > 0) {
          setMergeProgress(Math.min(99, Math.max(25, stData.progress)));
        }
        if (stData.stageLabel) {
          setMergeStatus(`${progressPrefix}${stData.stageLabel}`);
        }
      } catch {
        // ignore poll glitch
      }
    }, 450);

    try {
      const finishRes = await fetch(`/api/studio/job/${jobId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          durationMode,
          watermarkEnabled: watermarkOutro.watermarkEnabled,
          watermarkText: watermarkOutro.watermarkText,
          watermarkCorner: watermarkOutro.watermarkCorner,
          watermarkOpacity: watermarkOutro.watermarkOpacity,
          outroText,
          outroDuration: watermarkOutro.outroSeconds,
          outputName: outStem,
          savePath: selectedSavePath.trim(),
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
      setMergeProgress(100);
      let copiedLocal = false;
      if (data.relativePath && data.fileName && localDirHandle) {
        copiedLocal = await saveServerFileToLocalDir(data.relativePath, data.fileName);
      }
      return { ...data, copiedLocal };
    } finally {
      window.clearInterval(pollTimer);
    }
  };

  const handleRunMerge = async () => {
    if (isMerging) return;
    if (mergeMode === 'single' && (!mergeVideoFile || !mergeAudioFile)) return;
    if (mergeMode === 'batch' && batchMatchedPairs.matched.length === 0) return;

    setMergeError(null);
    setMergeProgress(2);
    setIsMerging(true);
    const controller = new AbortController();
    mergeAbortRef.current = controller;

    try {
      if (mergeMode === 'single' && mergeVideoFile && mergeAudioFile) {
        const resolvedName =
          mergeOutputName.trim() || mergeVideoFile.name.replace(/\.[^.]+$/, '') || 'video_output';
        const data = await runSingleMergeJob(mergeVideoFile, mergeAudioFile, resolvedName, controller);
        setMergeStatus(
          `Hoàn tất! Đã lưu ${data.fileName} (${data.savedPath})${data.copiedLocal ? ` · Đã lưu thêm vào "${localDirName}"` : ''}`,
        );
        emitOutputUpdated({ relativePath: data.relativePath, sourceTab: 'Edu Merge' });
      } else {
        const pairs = batchMatchedPairs.matched;
        let lastRel: string | undefined;
        for (let i = 0; i < pairs.length; i++) {
          if (controller.signal.aborted) break;
          const p = pairs[i];
          const res = await runSingleMergeJob(
            p.video,
            p.audio,
            p.stem,
            controller,
            `[${i + 1}/${pairs.length}] `,
          );
          if (res.relativePath) lastRel = res.relativePath;
        }
        emitOutputUpdated({ relativePath: lastRel, sourceTab: 'Edu Merge' });
        setMergeStatus(
          `Hoàn tất Batch! Đã ghép ${pairs.length} cặp video+audio vào thư mục Output${localDirHandle ? ` và "${localDirName}"` : ''}.`,
        );
      }
      await refreshOutputFolders();
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

  // ── Sub-tab 2: Add Karaoke Sub (.ass) + Mix Audio/SFX/Voice + Watermark/Outro ──
  const [kmVideoFile, setKmVideoFile] = useState<File | null>(null);
  const [kmVideoUrl, setKmVideoUrl] = useState<string | null>(null);
  const [kmPreviewTimeSec, setKmPreviewTimeSec] = useState(0);
  const [kmMusicFile, setKmMusicFile] = useState<File | null>(null);
  const [kmSfxFile, setKmSfxFile] = useState<File | null>(null);
  const [kmMusicPreset, setKmMusicPreset] = useState<'lofi-calm' | 'soft-study' | 'none'>('lofi-calm');
  const [kmSfxPreset, setKmSfxPreset] = useState<'soft-rain' | 'cafe-room' | 'none'>('soft-rain');
  const [kmVoiceFile, setKmVoiceFile] = useState<File | null>(null);
  const [kmVoiceUrl, setKmVoiceUrl] = useState<string | null>(null);
  const [kmSrtInput, setKmSrtInput] = useState(
    `1\n00:00:00,200 --> 00:00:03,400\nWelcome to Educational Audio Video Studio.\n\n2\n00:00:03,600 --> 00:00:07,000\nLet us practice speaking naturally every day.`,
  );
  const [kmAssContent, setKmAssContent] = useState('');
  const [kmStyleId, setKmStyleId] = useState<string>(KARAOKE_EFFECT_PRESETS[0].id);
  const [kmSubPosition, setKmSubPosition] = useState<EduKaraokePosition>('Dưới');
  const [kmSubSize, setKmSubSize] = useState<EduKaraokeSize>('Vừa');
  const [kmHighlightColor, setKmHighlightColor] = useState(KARAOKE_EFFECT_PRESETS[0].activeColor);
  const [kmEffect, setKmEffect] = useState('Fade cinematic');
  const [kmMuteOriginal, setKmMuteOriginal] = useState(false);
  const [kmRemoveDialogue, setKmRemoveDialogue] = useState(false);
  const [kmVoicePriority, setKmVoicePriority] = useState(true);
  const [kmOriginalVol, setKmOriginalVol] = useState(0.45);
  const [kmMusicVol, setKmMusicVol] = useState(0.2);
  const [kmSfxVol, setKmSfxVol] = useState(0.1);
  const [kmVoiceVol, setKmVoiceVol] = useState(1.0);
  const [kmVoiceStart, setKmVoiceStart] = useState(0);
  const [kmOutputName, setKmOutputName] = useState('');
  const [isRenderingKm, setIsRenderingKm] = useState(false);
  const [kmProgress, setKmProgress] = useState(0);
  const [kmStatus, setKmStatus] = useState('');
  const [kmError, setKmError] = useState<string | null>(null);
  const kmVideoRef = useRef<HTMLVideoElement>(null);
  const kmVoiceRef = useRef<HTMLAudioElement>(null);
  const kmAbortRef = useRef<AbortController | null>(null);
  const activeKmJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!kmVideoFile) {
      setKmVideoUrl(null);
      return;
    }
    const url = URL.createObjectURL(kmVideoFile);
    setKmVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [kmVideoFile]);

  useEffect(() => {
    if (!kmVoiceFile) {
      setKmVoiceUrl(null);
      return;
    }
    const url = URL.createObjectURL(kmVoiceFile);
    setKmVoiceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [kmVoiceFile]);

  const kmEffectSpec = useMemo(
    () => KARAOKE_EFFECT_PRESETS.find((e) => e.id === kmStyleId) ?? KARAOKE_EFFECT_PRESETS[0],
    [kmStyleId],
  );

  const kmParsedPreviewCues = useMemo(() => parseTranscriptAuto(kmSrtInput), [kmSrtInput]);
  const kmActiveCue = useMemo(
    () =>
      kmParsedPreviewCues.find((c) => kmPreviewTimeSec >= c.start && kmPreviewTimeSec <= c.end) ??
      kmParsedPreviewCues[0] ??
      null,
    [kmParsedPreviewCues, kmPreviewTimeSec],
  );

  const handleGenerateAss = () => {
    const ass = buildEduKaraokeAss(kmSrtInput, {
      effectId: kmStyleId,
      activeColorOverride: kmHighlightColor,
      position: kmSubPosition,
      size: kmSubSize,
    });
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
    setKmProgress(3);
    setKmStatus('Đang tạo job Karaoke & Audio Mix...');
    const controller = new AbortController();
    kmAbortRef.current = controller;
    let pollTimer: number | null = null;

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

      setKmProgress(8);
      setKmStatus(`Đang tải Video nền (${kmVideoFile.name})...`);
      await uploadStudioFileChunked(jobId, 'video', kmVideoFile, controller.signal);

      if (kmMusicFile) {
        setKmProgress(14);
        setKmStatus(`Đang tải Nhạc nền (${kmMusicFile.name})...`);
        await uploadStudioFileChunked(jobId, 'music', kmMusicFile, controller.signal);
      }
      if (kmSfxFile) {
        setKmProgress(18);
        setKmStatus(`Đang tải Ambient SFX (${kmSfxFile.name})...`);
        await uploadStudioFileChunked(jobId, 'sfx', kmSfxFile, controller.signal);
      }
      if (kmVoiceFile) {
        setKmProgress(22);
        setKmStatus(`Đang tải Voiceover (${kmVoiceFile.name})...`);
        await uploadStudioFileChunked(jobId, 'voice', kmVoiceFile, controller.signal);
      }

      const finalAss =
        kmAssContent.trim() ||
        (kmSrtInput.trim()
          ? buildEduKaraokeAss(kmSrtInput, {
              effectId: kmStyleId,
              activeColorOverride: kmHighlightColor,
              position: kmSubPosition,
              size: kmSubSize,
            })
          : '');

      const resolvedKmName =
        kmOutputName.trim() || kmVideoFile.name.replace(/\.[^.]+$/, '') || 'karaoke_output';
      const outroText = [watermarkOutro.outroLine1.trim(), watermarkOutro.outroLine2.trim()]
        .filter(Boolean)
        .join('\n');

      setKmProgress(25);
      setKmStatus('FFmpeg đang hòa âm Ducking, đốt Karaoke (.ass) & Watermark/Outro...');
      pollTimer = window.setInterval(async () => {
        try {
          const stRes = await fetch(`/api/studio/job/${jobId}/status`, { signal: controller.signal });
          if (!stRes.ok) return;
          const stData = (await stRes.json()) as { progress?: number; stageLabel?: string };
          if (typeof stData.progress === 'number' && stData.progress > 0) {
            setKmProgress(Math.min(99, Math.max(25, stData.progress)));
          }
          if (stData.stageLabel) {
            setKmStatus(stData.stageLabel);
          }
        } catch {
          // ignore poll glitch
        }
      }, 450);

      const mixRes = await fetch(`/api/studio/job/${jobId}/karaoke-mix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          assContent: finalAss,
          videoEffect: kmEffect,
          outroSeconds: watermarkOutro.outroSeconds,
          outroText,
          watermarkEnabled: watermarkOutro.watermarkEnabled,
          watermarkText: watermarkOutro.watermarkText,
          watermarkCorner: watermarkOutro.watermarkCorner,
          watermarkOpacity: watermarkOutro.watermarkOpacity,
          muteOriginal: kmMuteOriginal,
          removeDialogue: kmRemoveDialogue,
          originalVolume: kmOriginalVol,
          musicVolume: kmMusicVol,
          sfxVolume: kmSfxVol,
          voiceVolume: kmVoiceVol,
          voiceStart: kmVoiceStart,
          voicePriority: kmVoicePriority,
          musicPreset: kmMusicFile ? 'none' : kmMusicPreset,
          sfxPreset: kmSfxFile ? 'none' : kmSfxPreset,
          outputName: resolvedKmName,
          savePath: selectedSavePath.trim(),
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
      setKmProgress(100);
      let extraLocalMsg = '';
      if (data.relativePath && data.fileName && localDirHandle) {
        const copied = await saveServerFileToLocalDir(data.relativePath, data.fileName);
        if (copied) {
          extraLocalMsg = ` · Đã lưu thêm vào "${localDirName}"`;
        }
      }
      setKmStatus(`Hoàn tất! Đã lưu ${data.fileName} (${data.savedPath})${extraLocalMsg}`);
      emitOutputUpdated({ relativePath: data.relativePath, sourceTab: 'Edu Karaoke' });
      await refreshOutputFolders();
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        setKmStatus('Đã hủy tác vụ Karaoke & Mix.');
      } else {
        setKmError(err instanceof Error ? err.message : 'Lỗi FFmpeg Karaoke & Mix.');
        setKmStatus('');
      }
    } finally {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      activeKmJobIdRef.current = null;
      kmAbortRef.current = null;
      setIsRenderingKm(false);
    }
  };

  // ── Sub-tab 3: Reading Along Studio (Book + Pointer Hand + Whisper + MP4 Export) ──
  const [readingTitle, setReadingTitle] = useState('A Simple Morning Routine');
  const [readingTopic, setReadingTopic] = useState('Daily life · A1');
  const [readingPaletteId, setReadingPaletteId] =
    useState<ReadingBookPalette['id']>('Sunny Yellow');
  const [readingIllustration, setReadingIllustration] =
    useState<ReadingIllustrationStyle>('2.5D');
  const [readingText, setReadingText] = useState(
    `Tom wakes up early every morning.\nHe opens the window and makes his bed.\nThen he drinks a glass of water and eats breakfast.\nHe checks the time, takes his bag, and leaves home.\nA good morning helps him start the day with energy.`,
  );
  const [alignFile, setAlignFile] = useState<File | null>(null);
  const [alignAudioUrl, setAlignAudioUrl] = useState<string | null>(null);
  const [alignAudioDur, setAlignAudioDur] = useState<number>(14);
  const [alignLang, setAlignLang] = useState('auto');
  const [alignModel, setAlignModel] = useState('Xenova/whisper-small');
  const [readingTtsRate, setReadingTtsRate] = useState(1.0);
  const [ttsVoices, setTtsVoices] = useState<TtsProviderItem[]>([]);
  const [readingProvider, setReadingProvider] = useState<string>('auto');
  const [hasReadingGeminiKey, setHasReadingGeminiKey] = useState(false);
  const [hasReadingElevenLabsKey, setHasReadingElevenLabsKey] = useState(false);
  const [readingVoice, setReadingVoice] = useState('en-US-JennyNeural');
  const [isGeneratingReadingTts, setIsGeneratingReadingTts] = useState(false);
  const [readingTtsProgress, setReadingTtsProgress] = useState(0);
  const [readingTtsStageLabel, setReadingTtsStageLabel] = useState('');
  const [isAligning, setIsAligning] = useState(false);
  const [alignError, setAlignError] = useState<string | null>(null);
  const [readingAspect, setReadingAspect] = useState<ExportAspectRatioId>('9:16');
  const [readingResolution, setReadingResolution] = useState<ExportResolutionId>('720p');
  const [readingQuality, setReadingQuality] = useState<ExportQualityId>('high');
  const [readingFps, setReadingFps] = useState<ExportFpsOption>(30);
  const [readingUrl, setReadingUrl] = useState('');
  const [readingUrlSubLinks, setReadingUrlSubLinks] = useState<Array<{ title: string; url: string }>>([]);
  const [readingAiTopic, setReadingAiTopic] = useState('Morning habits for better focus');
  const [readingAiLevel, setReadingAiLevel] = useState<'A1' | 'A2' | 'B1' | 'B2' | 'C1'>('B1');
  const [readingAiLength, setReadingAiLength] = useState<number>(110);
  const [isScrapingOrGeneratingReading, setIsScrapingOrGeneratingReading] = useState(false);
  const [readingAiProgress, setReadingAiProgress] = useState(0);
  const [readingAiStageLabel, setReadingAiStageLabel] = useState('');
  const [alignCurrentSec, setAlignCurrentSec] = useState(0);
  const [isPlayingReadingPreview, setIsPlayingReadingPreview] = useState(false);
  const [isExportingReadingMp4, setIsExportingReadingMp4] = useState(false);
  const [readingExportProgress, setReadingExportProgress] = useState(0);
  const [readingExportStatus, setReadingExportStatus] = useState('');
  const readingAbortRef = useRef<AbortController | null>(null);

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
  const readingCanvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    void fetchTtsVoicesCatalog()
      .then((res) => {
        setTtsVoices(res.providers);
        setHasReadingGeminiKey(res.hasGeminiKey);
        setHasReadingElevenLabsKey(res.hasElevenLabsKey);
      })
      .catch(() => undefined);
  }, []);

  const allReadingVoices = useMemo(() => {
    if (readingProvider === 'auto') {
      return ttsVoices
        .filter(
          (p) =>
            (p.id !== 'gemini' || hasReadingGeminiKey) &&
            (p.id !== 'elevenlabs' || hasReadingElevenLabsKey),
        )
        .flatMap((p) => p.voices);
    }
    return ttsVoices.find((p) => p.id === readingProvider)?.voices ?? [];
  }, [ttsVoices, readingProvider, hasReadingGeminiKey, hasReadingElevenLabsKey]);

  useEffect(() => {
    if (allReadingVoices.length > 0 && !allReadingVoices.some((v) => v.id === readingVoice)) {
      setReadingVoice(allReadingVoices[0].id);
    }
  }, [allReadingVoices, readingVoice]);

  useEffect(() => {
    return () => {
      if (alignAudioUrl) URL.revokeObjectURL(alignAudioUrl);
    };
  }, [alignAudioUrl]);

  const effectiveReadingWords = useMemo(() => {
    if (alignResult && alignResult.words.length > 0) return alignResult.words;
    return buildEstimatedReadingWords(readingText, alignAudioDur);
  }, [alignResult, readingText, alignAudioDur]);

  const effectiveReadingDuration = useMemo(() => {
    const lastWordEnd =
      effectiveReadingWords.length > 0
        ? effectiveReadingWords[effectiveReadingWords.length - 1].end
        : 10;
    return Math.max(4, alignResult?.durationSec || alignAudioDur || lastWordEnd + 0.5);
  }, [effectiveReadingWords, alignResult, alignAudioDur]);

  const resolvedReadingDims = useMemo(
    () =>
      resolveMp4EncodingParams({
        ...DEFAULT_MP4_EXPORT_SETTINGS,
        aspectRatio: readingAspect,
        resolution: readingResolution,
        quality: readingQuality,
        fps: readingFps,
      }),
    [readingAspect, readingResolution, readingQuality, readingFps],
  );

  const previewCanvasDims = useMemo(() => {
    switch (readingAspect) {
      case '16:9':
        return { w: 960, h: 540, cls: 'aspect-video max-w-full' };
      case '1:1':
        return { w: 720, h: 720, cls: 'aspect-square max-h-[340px]' };
      case '4:5':
        return { w: 640, h: 800, cls: 'aspect-[4/5] max-h-[340px]' };
      default:
        return { w: 540, h: 960, cls: 'aspect-[9/16] max-h-[340px]' };
    }
  }, [readingAspect]);

  // Draw live Book + Pointer Hand + Watermark/Outro Canvas Preview
  useEffect(() => {
    const canvas = readingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderReadingAlongFrame(ctx, {
      width: canvas.width,
      height: canvas.height,
      title: readingTitle,
      topicBadge: readingTopic,
      text: readingText,
      words: effectiveReadingWords,
      currentTime: alignCurrentSec,
      totalDuration: effectiveReadingDuration,
      paletteId: readingPaletteId,
      illustrationStyle: readingIllustration,
      watermarkOutro,
    });
  }, [
    readingTitle,
    readingTopic,
    readingText,
    effectiveReadingWords,
    alignCurrentSec,
    effectiveReadingDuration,
    readingPaletteId,
    readingIllustration,
    watermarkOutro,
    previewCanvasDims.w,
    previewCanvasDims.h,
  ]);

  // Playback timer when previewing without audio or syncing with audio
  useEffect(() => {
    if (!isPlayingReadingPreview) return;
    let rafId = 0;
    let lastTs = performance.now();
    const tick = (now: number) => {
      if (alignAudioRef.current && alignAudioUrl && !alignAudioRef.current.paused) {
        setAlignCurrentSec(alignAudioRef.current.currentTime);
      } else {
        const dt = (now - lastTs) / 1000;
        lastTs = now;
        setAlignCurrentSec((prev) => {
          const next = prev + dt;
          if (next >= effectiveReadingDuration) {
            setIsPlayingReadingPreview(false);
            return 0;
          }
          return next;
        });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlayingReadingPreview, alignAudioUrl, effectiveReadingDuration]);

  const handleGenerateReadingTts = async () => {
    if (isGeneratingReadingTts || !readingText.trim()) return;
    setAlignError(null);
    setIsGeneratingReadingTts(true);
    setReadingTtsProgress(4);
    setReadingTtsStageLabel('Đang khởi tạo tổng hợp giọng đọc...');
    try {
      const voiceObj = allReadingVoices.find((v) => v.id === readingVoice);
      const res = await synthesizeAudioAndSyncCues({
        rawScript: readingText,
        title: readingTitle,
        provider: readingProvider,
        voice: readingVoice,
        lang: voiceObj?.lang || 'en-US',
        rate: readingTtsRate,
        alignWithWhisper: true,
        whisperModel: alignModel,
        onProgress: (pct, label) => {
          setReadingTtsProgress(pct);
          setReadingTtsStageLabel(label);
        },
      });
      setAlignFile(res.audioFile);
      setAlignAudioDur(Math.max(4, res.durationSec));
      setAlignAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(res.audioFile);
      });
      const flatWords = res.cues.flatMap((c) => c.words);
      setAlignResult({
        language: res.detectedLanguage,
        modelUsed: alignModel,
        backendUsed: res.providerUsed,
        durationSec: res.durationSec,
        text: readingText,
        words: flatWords,
        cues: res.cues,
        srt: res.srt,
      });
      setAlignCurrentSec(0);
    } catch (err) {
      setAlignError(err instanceof Error ? err.message : 'Lỗi tạo Audio TTS cho bài đọc.');
    } finally {
      setIsGeneratingReadingTts(false);
    }
  };

  const handleRunWordAlign = async () => {
    if (!alignFile || isAligning) return;
    setAlignError(null);
    setIsAligning(true);
    setReadingTtsProgress(5);
    setReadingTtsStageLabel('Đang tải model Whisper & căn chỉnh từng từ...');
    try {
      const extMatch = alignFile.name.match(/(\.[a-z0-9]+)$/i);
      const ext = extMatch ? extMatch[1].toLowerCase() : '.mp3';
      const buf = new Uint8Array(await alignFile.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      const audioBase64 = btoa(bin);
      const data = await alignAudioWithProgressJob(
        {
          audioBase64,
          ext,
          lang: alignLang,
          model: alignModel,
        },
        (pct, label) => {
          setReadingTtsProgress(pct);
          setReadingTtsStageLabel(label);
        },
      );
      if (data.text?.trim()) {
        setReadingText(data.text.trim());
      }
      if (alignAudioRef.current && Number.isFinite(alignAudioRef.current.duration)) {
        setAlignAudioDur(alignAudioRef.current.duration);
      }
      const cuesArr = Array.isArray(data.cues) ? data.cues : [];
      const dur =
        cuesArr.length > 0
          ? cuesArr[cuesArr.length - 1].end
          : alignAudioRef.current && Number.isFinite(alignAudioRef.current.duration)
            ? alignAudioRef.current.duration
            : alignAudioDur;
      setAlignResult({
        language: data.language,
        modelUsed: data.modelUsed || alignModel,
        backendUsed: data.backendUsed || 'faster-whisper',
        durationSec: Number(dur || 0),
        text: data.text || '',
        words: Array.isArray(data.words) ? data.words : [],
        cues: cuesArr,
        srt: data.srt || '',
      });
    } catch (err) {
      setAlignError(err instanceof Error ? err.message : 'Lỗi chạy Whisper Local.');
    } finally {
      setIsAligning(false);
    }
  };

  const handleExportReadingAlongMp4 = async () => {
    if (isExportingReadingMp4) return;
    setAlignError(null);
    setIsExportingReadingMp4(true);
    setReadingExportProgress(0);
    setReadingExportStatus('Đang dựng video Reading Along + Watermark/Outro...');
    const controller = new AbortController();
    readingAbortRef.current = controller;

    try {
      const baseStem =
        (alignFile?.name.replace(/\.[^.]+$/, '') || readingTitle || 'reading_along')
          .replace(/[^a-zA-Z0-9-_]+/g, '_')
          .slice(0, 48) || 'reading_along';

      const dummyProject: LessonProject = {
        id: 'reading-along-export',
        title: readingTitle,
        subtitle: readingTopic,
        theme: 'pastel-sunrise',
        duration: effectiveReadingDuration + (watermarkOutro.outroSeconds > 0 ? watermarkOutro.outroSeconds : 0),
        fps: 30,
        cues: [],
        elements: [],
      };

      const totalWithOutro = dummyProject.duration;

      const saved = await exportProjectToServerDisk(
        dummyProject,
        alignFile,
        ({ progress, stageLabel }) => {
          setReadingExportProgress(progress);
          setReadingExportStatus(stageLabel);
        },
        {
          aspectRatio: readingAspect,
          resolution: readingResolution,
          quality: readingQuality,
          fps: readingFps,
        },
        baseStem,
        selectedSavePath.trim() || undefined,
        {
          signal: controller.signal,
          directoryHandle: localDirHandle || undefined,
          sourceTab: 'Reading Along',
          customRenderFrame: (ctx, time, width, height) => {
            renderReadingAlongFrame(ctx, {
              width,
              height,
              title: readingTitle,
              topicBadge: readingTopic,
              text: readingText,
              words: effectiveReadingWords,
              currentTime: time,
              totalDuration: totalWithOutro,
              paletteId: readingPaletteId,
              illustrationStyle: readingIllustration,
              watermarkOutro,
            });
          },
        },
      );

      setReadingExportStatus(`Hoàn tất! Đã lưu ${saved.fileName} (${saved.savedPath}).`);
      emitOutputUpdated({ relativePath: saved.relativePath, sourceTab: 'Reading Along' });
      await refreshOutputFolders();
    } catch (err) {
      if (err instanceof ExportAbortedError || controller.signal.aborted) {
        setReadingExportStatus('Đã hủy xuất Reading Along MP4.');
      } else {
        setAlignError(err instanceof Error ? err.message : 'Lỗi xuất Reading Along MP4.');
        setReadingExportStatus('');
      }
    } finally {
      readingAbortRef.current = null;
      setIsExportingReadingMp4(false);
    }
  };

  const handleScrapeReadingUrl = async (targetUrl?: string, adaptWithAi = true) => {
    const cleanUrl = (targetUrl || readingUrl).trim();
    if (!cleanUrl || isScrapingOrGeneratingReading) return;
    if (targetUrl) setReadingUrl(targetUrl);
    setAlignError(null);
    setIsScrapingOrGeneratingReading(true);
    setReadingAiProgress(12);
    setReadingAiStageLabel('Đang tải và bóc tách nội dung sạch từ trang web...');

    try {
      const scrapeRes = await fetch('/api/scraper/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
      });
      const scraped = await parseApiJson<{
        title?: string;
        text?: string;
        subLinks?: Array<{ title: string; url: string }>;
        error?: string;
      }>(scrapeRes, 'Không đọc được nội dung từ trang web');
      if (!scrapeRes.ok || !scraped.text?.trim()) {
        throw new Error(scraped.error || 'Không trích xuất được nội dung bài đọc từ URL này.');
      }
      setReadingUrlSubLinks(Array.isArray(scraped.subLinks) ? scraped.subLinks.slice(0, 8) : []);
      setReadingAiProgress(55);

      if (adaptWithAi && hasReadingGeminiKey) {
        setReadingAiStageLabel(`AI đang biên tập lại theo trình độ ${readingAiLevel}...`);
        const aiRes = await fetch('/api/ai/generate-reading', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'adapt-url',
            level: readingAiLevel,
            wordCount: readingAiLength,
            sourceTitle: scraped.title || '',
            sourceText: scraped.text,
          }),
        });
        const aiData = await parseApiJson<{
          title?: string;
          topicBadge?: string;
          text?: string;
          error?: string;
        }>(aiRes, 'AI chuyển thể bài đọc thất bại');
        if (aiRes.ok && aiData.text?.trim()) {
          setReadingAiProgress(100);
          setReadingTitle(aiData.title || scraped.title || readingTitle);
          setReadingTopic(aiData.topicBadge || `CEFR ${readingAiLevel} · WEB`);
          setReadingText(aiData.text.trim());
          setAlignResult(null);
          setReadingAiStageLabel(`Đã lấy bài từ web & chuyển thể trình độ ${readingAiLevel}!`);
          return;
        }
      }

      const rawLines = scraped.text
        .split(/(?<=[.!?])\s+|\r?\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 12)
        .slice(0, 12);
      setReadingAiProgress(100);
      if (scraped.title?.trim()) setReadingTitle(scraped.title.trim().slice(0, 80));
      setReadingTopic(`WEB ARTICLE · ${readingAiLevel}`);
      setReadingText((rawLines.length > 0 ? rawLines : [scraped.text.slice(0, 700)]).join('\n'));
      setAlignResult(null);
      setReadingAiStageLabel(
        hasReadingGeminiKey
          ? 'Đã lấy nội dung trang web vào bài đọc!'
          : 'Đã bóc tách văn bản sạch từ trang web (nếu muốn AI biên tập lại theo trình độ A1–C1, hãy thêm GEMINI_API_KEY vào Settings > Secrets).',
      );
    } catch (err) {
      setAlignError(err instanceof Error ? err.message : 'Lỗi đọc nội dung từ trang web.');
      setReadingAiStageLabel('');
    } finally {
      setIsScrapingOrGeneratingReading(false);
    }
  };

  const handleAiGenerateReadingPassage = async () => {
    if (isScrapingOrGeneratingReading || !readingAiTopic.trim()) return;
    setAlignError(null);
    setIsScrapingOrGeneratingReading(true);
    setReadingAiProgress(18);
    setReadingAiStageLabel(`AI đang viết bài đọc trình độ ${readingAiLevel}...`);
    try {
      const res = await fetch('/api/ai/generate-reading', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'generate',
          topic: readingAiTopic.trim(),
          level: readingAiLevel,
          wordCount: readingAiLength,
        }),
      });
      const data = await parseApiJson<{
        title?: string;
        topicBadge?: string;
        text?: string;
        error?: string;
      }>(res, 'AI tạo bài đọc thất bại');
      if (!res.ok || !data.text?.trim()) {
        throw new Error(data.error || 'AI không tạo được bài đọc.');
      }
      setReadingAiProgress(100);
      setReadingTitle(data.title || readingAiTopic.trim());
      setReadingTopic(data.topicBadge || `CEFR ${readingAiLevel}`);
      setReadingText(data.text.trim());
      setAlignResult(null);
      setReadingAiStageLabel(`AI đã tạo xong bài đọc trình độ ${readingAiLevel}!`);
    } catch (err) {
      setAlignError(err instanceof Error ? err.message : 'Lỗi AI tạo bài đọc.');
      setReadingAiStageLabel('');
    } finally {
      setIsScrapingOrGeneratingReading(false);
    }
  };

  const wmPosClass =
    watermarkOutro.watermarkCorner === 'top-left'
      ? 'top-2.5 left-2.5'
      : watermarkOutro.watermarkCorner === 'top-right'
        ? 'top-2.5 right-2.5'
        : watermarkOutro.watermarkCorner === 'bottom-left'
          ? 'bottom-10 left-2.5'
          : 'bottom-10 right-2.5';

  return (
    <div className="max-w-[1400px] w-full mx-auto p-4 lg:p-6 space-y-5">
      {/* Header Banner */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-slate-900">
            Educational Audio Video Studio 1.19 — FFmpeg Server &amp; Reading Along
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Đầy đủ 3 module nguyên bản 1.19: Merge Video+Audio (đơn &amp; batch), Add Karaoke Sub (6 style ASS) + Audio Mix, Reading Along Book+Pointer — file xuất hiển thị ngay ở Thư mục Output chung bên dưới.
          </p>
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

      {/* Full-width Studio Workspace */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
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
              <span>1. Merge Video + Audio</span>
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
              <span>2. Add Karaoke Sub &amp; Mix</span>
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
              <BookOpen className="w-3.5 h-3.5" />
              <span>3. Reading Along Studio</span>
            </button>
          </div>

          <div className="p-5 space-y-4">
            {/* ── SUB-TAB 1: MERGE VIDEO + AUDIO (Single + Batch) ───────────── */}
            {subTab === 'merge' && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                  <div className="inline-flex p-1 bg-slate-100 rounded-lg border border-slate-200">
                    <button
                      type="button"
                      onClick={() => setMergeMode('single')}
                      className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                        mergeMode === 'single'
                          ? 'bg-white text-indigo-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Một Video + Một Audio
                    </button>
                    <button
                      type="button"
                      onClick={() => setMergeMode('batch')}
                      className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                        mergeMode === 'batch'
                          ? 'bg-white text-indigo-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Batch – Ghép hàng loạt theo tên file
                    </button>
                  </div>
                  <select
                    value={durationMode}
                    onChange={(e) => setDurationMode(e.target.value as 'loop-video' | 'shortest')}
                    className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="shortest">Cắt theo file ngắn hơn (Shortest - Chuẩn 1.19)</option>
                    <option value="loop-video">Tự lặp Video nền khớp hết Audio</option>
                  </select>
                </div>

                {mergeMode === 'single' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                      <Film className="w-5 h-5 text-indigo-600 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-800 truncate">
                          {mergeVideoFile ? mergeVideoFile.name : 'Chọn Video nền (.mp4, .mov)'}
                        </div>
                        <div className="text-[11px] text-slate-500">Tên file xuất tự lấy theo tên video gốc</div>
                      </div>
                      <input
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          setMergeVideoFile(f);
                          if (f) setMergeOutputName(f.name.replace(/\.[^.]+$/, ''));
                        }}
                      />
                    </label>

                    <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                      <FileAudio className="w-5 h-5 text-emerald-600 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-800 truncate">
                          {mergeAudioFile ? mergeAudioFile.name : 'Chọn Audio ngoài (.mp3, .wav)'}
                        </div>
                        <div className="text-[11px] text-slate-500">Thay thế audio gốc trong video</div>
                      </div>
                      <input
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        onChange={(e) => setMergeAudioFile(e.target.files?.[0] ?? null)}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                        <Film className="w-5 h-5 text-indigo-600 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-800">
                            {batchVideos.length > 0 ? `Đã chọn ${batchVideos.length} Video` : 'Chọn nhiều Video (Batch)'}
                          </div>
                          <div className="text-[11px] text-slate-500">Ghép tự động với Audio cùng tên</div>
                        </div>
                        <input
                          type="file"
                          multiple
                          accept="video/*"
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            setBatchVideos(files);
                            if (files[0]) setMergeVideoFile(files[0]);
                          }}
                        />
                      </label>
                      <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                        <FileAudio className="w-5 h-5 text-emerald-600 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-800">
                            {batchAudios.length > 0 ? `Đã chọn ${batchAudios.length} Audio` : 'Chọn nhiều Audio (Batch)'}
                          </div>
                          <div className="text-[11px] text-slate-500">VD: lesson01.mp4 ↔ lesson01.mp3</div>
                        </div>
                        <input
                          type="file"
                          multiple
                          accept="audio/*"
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            setBatchAudios(files);
                            if (files[0]) setMergeAudioFile(files[0]);
                          }}
                        />
                      </label>
                    </div>
                    {(batchVideos.length > 0 || batchAudios.length > 0) && (
                      <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] space-y-1">
                        <div className="font-semibold text-emerald-700">
                          Khớp tự động: {batchMatchedPairs.matched.length} cặp Video + Audio
                        </div>
                        {batchMatchedPairs.missing.length > 0 && (
                          <div className="text-amber-700">
                            Thiếu Audio cùng tên: {batchMatchedPairs.missing.slice(0, 6).join(', ')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Always-visible Live Preview for Merge + Watermark/Outro */}
                <div className="p-3.5 rounded-xl bg-slate-900 text-white space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span className="font-semibold text-indigo-300 inline-flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5" />
                      <span>Live Preview (Merge Video + Watermark &amp; Outro)</span>
                    </span>
                    <div className="flex items-center gap-2">
                      {mergeVideoUrl && mergeAudioUrl && (
                        <button
                          type="button"
                          onClick={() => {
                            const v = mergePreviewVideoRef.current;
                            const a = mergePreviewAudioRef.current;
                            if (!v || !a) return;
                            if (v.paused || a.paused) {
                              v.currentTime = 0;
                              a.currentTime = 0;
                              void v.play().catch(() => undefined);
                              void a.play().catch(() => undefined);
                            } else {
                              v.pause();
                              a.pause();
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-semibold"
                        >
                          <Play className="w-2.5 h-2.5 fill-current" />
                          <span>Phát khớp Video &amp; Audio</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="relative rounded-lg overflow-hidden bg-slate-950 min-h-[175px] flex items-center justify-center border border-slate-800">
                    {mergeVideoUrl ? (
                      <video
                        ref={mergePreviewVideoRef}
                        controls
                        loop={durationMode === 'loop-video'}
                        muted={Boolean(mergeAudioUrl)}
                        src={mergeVideoUrl}
                        className="w-full max-h-60 mx-auto object-contain"
                      />
                    ) : (
                      <div className="p-6 text-center space-y-1">
                        <Film className="w-7 h-7 text-slate-600 mx-auto" />
                        <p className="text-xs font-medium text-slate-300">
                          Khung Live Preview Watermark &amp; Outro
                        </p>
                        <p className="text-[11px] text-slate-500">
                          Chọn Video &amp; Audio ở trên để xem phát khớp và ảnh xem trước nhanh 3 mốc
                        </p>
                      </div>
                    )}

                    {watermarkOutro.watermarkEnabled && watermarkOutro.watermarkText.trim() && (
                      <div
                        style={{ opacity: watermarkOutro.watermarkOpacity }}
                        className={`pointer-events-none absolute px-2.5 py-1 rounded bg-black/55 text-white text-xs font-semibold ${wmPosClass}`}
                      >
                        {watermarkOutro.watermarkText}
                      </div>
                    )}
                  </div>

                  {mergeAudioUrl && (
                    <audio
                      ref={mergePreviewAudioRef}
                      controls
                      src={mergeAudioUrl}
                      className="w-full h-8"
                    />
                  )}

                  <VideoSnapshotStrip
                    videoUrl={mergeVideoUrl}
                    watermarkOutro={watermarkOutro}
                    onSeek={(t) => {
                      if (mergePreviewVideoRef.current) {
                        mergePreviewVideoRef.current.currentTime = t;
                      }
                    }}
                  />
                </div>

                {mergeMode === 'single' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Tên file đầu ra (mặc định lấy tên video gốc)
                    </label>
                    <input
                      type="text"
                      value={mergeOutputName}
                      onChange={(e) => setMergeOutputName(e.target.value)}
                      placeholder={
                        mergeVideoFile
                          ? mergeVideoFile.name.replace(/\.[^.]+$/, '')
                          : 'Tự lấy theo tên video gốc'
                      }
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg font-mono"
                    />
                  </div>
                )}

                {renderOutputFolderControl()}

                <WatermarkOutroSection
                  config={watermarkOutro}
                  onChange={setWatermarkOutro}
                  title="Watermark & Outro (Tùy chọn · Ghép Video)"
                />

                {mergeError && (
                  <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                    {mergeError}
                  </p>
                )}
                {mergeStatus && (
                  <div className="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 font-medium">
                      <span>{mergeStatus}</span>
                      {(isMerging || mergeProgress > 0) && (
                        <span className="font-mono font-bold tabular-nums">{mergeProgress}%</span>
                      )}
                    </div>
                    {isMerging && (
                      <div className="w-full h-1.5 bg-indigo-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 transition-all duration-300"
                          style={{ width: `${Math.max(4, Math.min(100, mergeProgress))}%` }}
                        />
                      </div>
                    )}
                  </div>
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
                      disabled={
                        mergeMode === 'single'
                          ? !mergeVideoFile || !mergeAudioFile
                          : batchMatchedPairs.matched.length === 0
                      }
                      onClick={() => void handleRunMerge()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>
                        {mergeMode === 'batch'
                          ? `Ghép Batch (${batchMatchedPairs.matched.length} cặp)`
                          : 'Bắt đầu Ghép Video + Audio (FFmpeg)'}
                      </span>
                    </button>
                  )}
                </div>
              </>
            )}

            {/* ── SUB-TAB 2: ADD KARAOKE SUB (.ASS) & MIX AUDIO ─────────────── */}
            {subTab === 'karaoke' && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    {
                      label: 'Video nền *',
                      file: kmVideoFile,
                      set: (f: File | null) => {
                        setKmVideoFile(f);
                        if (f) setKmOutputName(f.name.replace(/\.[^.]+$/, ''));
                      },
                      accept: 'video/*',
                    },
                    { label: 'Voiceover / TTS', file: kmVoiceFile, set: setKmVoiceFile, accept: 'audio/*' },
                    { label: 'Nhạc nền BGM', file: kmMusicFile, set: setKmMusicFile, accept: 'audio/*' },
                    { label: 'Ambient SFX', file: kmSfxFile, set: setKmSfxFile, accept: 'audio/*' },
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

                {/* Default built-in BGM & Ambient SFX presets */}
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-800">
                      Âm thanh nền mặc định (tự dùng khi chưa tải file BGM / Ambient SFX)
                    </span>
                    <div className="flex items-center gap-2">
                      {kmMusicFile && (
                        <button
                          type="button"
                          onClick={() => setKmMusicFile(null)}
                          className="text-[10px] font-semibold text-rose-600 hover:underline"
                        >
                          Bỏ file BGM
                        </button>
                      )}
                      {kmSfxFile && (
                        <button
                          type="button"
                          onClick={() => setKmSfxFile(null)}
                          className="text-[10px] font-semibold text-rose-600 hover:underline"
                        >
                          Bỏ file SFX
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-semibold text-slate-600">
                        Nhạc nền BGM mặc định {kmMusicFile ? '(Đang dùng file tải lên)' : ''}
                      </label>
                      <select
                        disabled={Boolean(kmMusicFile)}
                        value={kmMusicPreset}
                        onChange={(e) =>
                          setKmMusicPreset(e.target.value as 'lofi-calm' | 'soft-study' | 'none')
                        }
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg disabled:opacity-50"
                      >
                        <option value="lofi-calm">Lo-fi Chill Mặc định (Warm Pad)</option>
                        <option value="soft-study">Soft Study Pad (Nhẹ nhàng)</option>
                        <option value="none">Không dùng BGM mặc định</option>
                      </select>
                      {!kmMusicFile && kmMusicPreset !== 'none' && (
                        <audio
                          controls
                          src={`/api/studio/default-audio?preset=${kmMusicPreset}`}
                          className="w-full h-7"
                        />
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-semibold text-slate-600">
                        Ambient SFX mặc định {kmSfxFile ? '(Đang dùng file tải lên)' : ''}
                      </label>
                      <select
                        disabled={Boolean(kmSfxFile)}
                        value={kmSfxPreset}
                        onChange={(e) =>
                          setKmSfxPreset(e.target.value as 'soft-rain' | 'cafe-room' | 'none')
                        }
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg disabled:opacity-50"
                      >
                        <option value="soft-rain">Mưa nhẹ (Soft Rain)</option>
                        <option value="cafe-room">Không gian quán cà phê (Cafe Room)</option>
                        <option value="none">Không dùng SFX mặc định</option>
                      </select>
                      {!kmSfxFile && kmSfxPreset !== 'none' && (
                        <audio
                          controls
                          src={`/api/studio/default-audio?preset=${kmSfxPreset}`}
                          className="w-full h-7"
                        />
                      )}
                    </div>
                  </div>
                </div>

                {/* Always-visible Live Karaoke Effect + Video FX + Watermark/Outro Preview */}
                <div className="p-3 rounded-xl bg-slate-900 text-white space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-indigo-300 font-semibold">
                    <span className="inline-flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5" />
                      <span>
                        Live Effect Preview ({kmEffectSpec.id.split('–')[0].trim()} · {kmEffect})
                      </span>
                    </span>
                    <div className="flex items-center gap-2">
                      {kmVideoUrl && kmVoiceUrl && (
                        <button
                          type="button"
                          onClick={() => {
                            const v = kmVideoRef.current;
                            const a = kmVoiceRef.current;
                            if (!v || !a) return;
                            if (v.paused || a.paused) {
                              v.currentTime = 0;
                              a.currentTime = 0;
                              void v.play().catch(() => undefined);
                              void a.play().catch(() => undefined);
                            } else {
                              v.pause();
                              a.pause();
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px]"
                        >
                          <Play className="w-2.5 h-2.5 fill-current" />
                          <span>Phát khớp Video &amp; Voice</span>
                        </button>
                      )}
                      <span className="font-mono text-slate-400">{kmPreviewTimeSec.toFixed(1)}s</span>
                    </div>
                  </div>

                  <div className="relative rounded-lg overflow-hidden bg-slate-950 min-h-[185px] flex items-center justify-center border border-slate-800">
                    {kmVideoUrl ? (
                      <video
                        ref={kmVideoRef}
                        controls
                        src={kmVideoUrl}
                        style={{ filter: getPreviewVideoCssFilter(kmEffect) }}
                        onTimeUpdate={(e) => setKmPreviewTimeSec(e.currentTarget.currentTime)}
                        className="w-full max-h-60 mx-auto object-contain"
                      />
                    ) : (
                      <div className="p-6 text-center space-y-1">
                        <Music className="w-7 h-7 text-slate-600 mx-auto" />
                        <p className="text-xs font-medium text-slate-300">
                          Live Preview Karaoke Sub (.ASS) + Watermark/Outro
                        </p>
                        <p className="text-[11px] text-slate-500">
                          Đang hiển thị style <strong>{kmEffectSpec.id}</strong> ({kmSubPosition} · cỡ {kmSubSize}). Chọn Video nền để xem trực tiếp trên video!
                        </p>
                      </div>
                    )}

                    {/* Live Subtitle Style Preview */}
                    {kmActiveCue && (
                      <div
                        className={`pointer-events-none absolute inset-x-4 flex justify-center ${
                          kmSubPosition === 'Trên'
                            ? 'top-5'
                            : kmSubPosition === 'Giữa'
                              ? 'top-1/2 -translate-y-1/2'
                              : 'bottom-10'
                        }`}
                      >
                        <div
                          className={`px-3 py-1.5 rounded-lg text-center font-bold max-w-[90%] ${
                            kmEffectSpec.box ? 'bg-slate-900/80 border border-slate-700' : 'bg-black/45'
                          } ${
                            kmSubSize === 'Nhỏ'
                              ? 'text-xs'
                              : kmSubSize === 'Lớn'
                                ? 'text-base'
                                : 'text-sm'
                          }`}
                          style={{
                            textShadow: `0 1px 4px ${kmEffectSpec.outlineColor}`,
                          }}
                        >
                          {(() => {
                            const words = kmActiveCue.text.split(/\s+/).filter(Boolean);
                            const span = Math.max(0.4, kmActiveCue.end - kmActiveCue.start);
                            const pct = Math.max(
                              0,
                              Math.min(1, (kmPreviewTimeSec - kmActiveCue.start) / span),
                            );
                            const activeWordIdx = Math.min(
                              words.length - 1,
                              Math.floor(pct * words.length),
                            );
                            const isTypewriter = kmEffectSpec.mode === 'typewriter';
                            return words.map((w, wi) => {
                              if (isTypewriter && wi > activeWordIdx && kmVideoUrl) return null;
                              const isHighlighted = wi <= activeWordIdx;
                              return (
                                <span
                                  key={`${w}-${wi}`}
                                  style={{
                                    color: isHighlighted
                                      ? kmHighlightColor
                                      : kmEffectSpec.inactiveColor,
                                  }}
                                  className="mx-0.5 inline-block"
                                >
                                  {w}
                                </span>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    )}

                    {watermarkOutro.watermarkEnabled && watermarkOutro.watermarkText.trim() && (
                      <div
                        style={{ opacity: watermarkOutro.watermarkOpacity }}
                        className={`pointer-events-none absolute px-2.5 py-1 rounded bg-black/55 text-white text-xs font-semibold ${wmPosClass}`}
                      >
                        {watermarkOutro.watermarkText}
                      </div>
                    )}
                  </div>

                  {kmVoiceUrl && (
                    <audio ref={kmVoiceRef} controls src={kmVoiceUrl} className="w-full h-8" />
                  )}

                  <VideoSnapshotStrip
                    videoUrl={kmVideoUrl}
                    videoFilterCss={getPreviewVideoCssFilter(kmEffect)}
                    watermarkOutro={watermarkOutro}
                    subtitleSampleText={kmActiveCue?.text}
                    highlightColor={kmHighlightColor}
                    subtitlePosition={kmSubPosition}
                    onSeek={(t) => {
                      if (kmVideoRef.current) {
                        kmVideoRef.current.currentTime = t;
                        setKmPreviewTimeSec(t);
                      }
                    }}
                  />
                </div>

                {/* Karaoke Effect Controls matching 1.19 */}
                <div className="p-3.5 rounded-xl bg-indigo-50/40 border border-indigo-200/70 space-y-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Hiệu ứng Karaoke (6 kiểu chuẩn 1.19)
                      </label>
                      <select
                        value={kmStyleId}
                        onChange={(e) => {
                          const nextId = e.target.value;
                          setKmStyleId(nextId);
                          const spec = KARAOKE_EFFECT_PRESETS.find((p) => p.id === nextId);
                          if (spec) setKmHighlightColor(spec.activeColor);
                        }}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        {KARAOKE_EFFECT_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.id}
                          </option>
                        ))}
                      </select>
                      <p className="text-[10px] text-slate-500 mt-1">{kmEffectSpec.description}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Vị trí
                        </label>
                        <select
                          value={kmSubPosition}
                          onChange={(e) => setKmSubPosition(e.target.value as EduKaraokePosition)}
                          className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="Dưới">Dưới</option>
                          <option value="Giữa">Giữa</option>
                          <option value="Trên">Trên</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Cỡ chữ
                        </label>
                        <select
                          value={kmSubSize}
                          onChange={(e) => setKmSubSize(e.target.value as EduKaraokeSize)}
                          className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="Nhỏ">Nhỏ</option>
                          <option value="Vừa">Vừa</option>
                          <option value="Lớn">Lớn</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                {/* SRT / ASS Text */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-slate-700">
                      Nội dung SRT / Câu thoại để đốt Karaoke .ASS
                    </label>
                    <div className="flex items-center gap-2">
                      <label className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer">
                        <Upload className="w-3 h-3" />
                        <span>Nạp file .SRT/.VTT/.ASS</span>
                        <input
                          type="file"
                          accept=".srt,.vtt,.ass,.ssa,.lrc,.txt"
                          className="hidden"
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            const txt = await f.text();
                            if (/\.ass$/i.test(f.name) || txt.includes('[V4+ Styles]')) {
                              setKmAssContent(txt);
                            } else {
                              setKmSrtInput(txt);
                            }
                          }}
                        />
                      </label>
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
                        Sinh mã .ASS →
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    <textarea
                      rows={4}
                      value={kmSrtInput}
                      onChange={(e) => setKmSrtInput(e.target.value)}
                      placeholder="Dán .SRT hoặc từng dòng câu..."
                      className="w-full p-2.5 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg"
                    />
                    <textarea
                      rows={4}
                      value={kmAssContent}
                      onChange={(e) => setKmAssContent(e.target.value)}
                      placeholder="Mã Karaoke .ASS tự động sinh (hoặc dán file .ass có sẵn)..."
                      className="w-full p-2.5 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg"
                    />
                  </div>
                </div>

                {/* Video FX + Audio Mix */}
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
                        Tên file xuất (mặc định tên video gốc)
                      </label>
                      <input
                        type="text"
                        value={kmOutputName}
                        onChange={(e) => setKmOutputName(e.target.value)}
                        placeholder={
                          kmVideoFile
                            ? kmVideoFile.name.replace(/\.[^.]+$/, '')
                            : 'Tự lấy theo tên video gốc'
                        }
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
                      <span>Ưu tiên Voiceover (Ducking)</span>
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
                      <span>Khử giọng trung tâm</span>
                    </label>
                  </div>
                </div>

                {renderOutputFolderControl()}

                <WatermarkOutroSection
                  config={watermarkOutro}
                  onChange={setWatermarkOutro}
                  title="Watermark & Outro (Tùy chọn · Karaoke & Mix)"
                />

                {kmError && (
                  <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                    {kmError}
                  </p>
                )}
                {kmStatus && (
                  <div className="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 font-medium">
                      <span>{kmStatus}</span>
                      {(isRenderingKm || kmProgress > 0) && (
                        <span className="font-mono font-bold tabular-nums">{kmProgress}%</span>
                      )}
                    </div>
                    {isRenderingKm && (
                      <div className="w-full h-1.5 bg-indigo-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 transition-all duration-300"
                          style={{ width: `${Math.max(4, Math.min(100, kmProgress))}%` }}
                        />
                      </div>
                    )}
                  </div>
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
                      <span>Add Karaoke + Export MP4</span>
                    </button>
                  )}
                </div>
              </>
            )}

            {/* ── SUB-TAB 3: READING ALONG STUDIO (Book + Pointer + Export MP4) ── */}
            {subTab === 'align' && (
              <>
                {/* Webpage URL Scraper + AI CEFR Generator */}
                <div className="p-3.5 rounded-xl bg-gradient-to-br from-indigo-50/80 via-white to-sky-50/70 border border-indigo-200/80 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-bold text-indigo-950 inline-flex items-center gap-1.5">
                      <Globe className="w-4 h-4 text-indigo-600" />
                      <span>Lấy bài từ Trang Web hoặc Nhờ AI tạo bài theo cấp độ (A1–C1)</span>
                    </div>
                    <span className="text-[11px] font-medium text-slate-500">
                      {hasReadingGeminiKey
                        ? 'Gemini AI đã sẵn sàng trên server'
                        : 'Thêm GEMINI_API_KEY vào Settings > Secrets để bật AI tạo/chuyển thể bài'}
                    </span>
                  </div>

                  {/* URL Input */}
                  <div className="flex flex-col sm:flex-row gap-2">
                    <div className="relative flex-1">
                      <Link2 className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="url"
                        value={readingUrl}
                        onChange={(e) => setReadingUrl(e.target.value)}
                        placeholder="Dán link bài báo/truyện tiếng Anh (vd: https://...) để lấy vào bài đọc"
                        className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                    <button
                      type="button"
                      disabled={isScrapingOrGeneratingReading || !readingUrl.trim()}
                      onClick={() => void handleScrapeReadingUrl(undefined, true)}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 shrink-0"
                    >
                      {isScrapingOrGeneratingReading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Globe className="w-3.5 h-3.5" />
                      )}
                      <span>Lấy nội dung Web</span>
                    </button>
                  </div>

                  {readingUrlSubLinks.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] font-semibold text-slate-500">Bài liên quan:</span>
                      {readingUrlSubLinks.map((lnk) => (
                        <button
                          key={lnk.url}
                          type="button"
                          onClick={() => void handleScrapeReadingUrl(lnk.url, true)}
                          className="px-2 py-0.5 text-[10px] font-medium text-indigo-700 bg-white border border-indigo-200 rounded-md hover:bg-indigo-50 truncate max-w-[200px]"
                          title={lnk.title}
                        >
                          {lnk.title}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* AI Generate Topic + Level + Length */}
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 pt-2 border-t border-indigo-100">
                    <input
                      type="text"
                      value={readingAiTopic}
                      onChange={(e) => setReadingAiTopic(e.target.value)}
                      placeholder="Chủ đề để AI tự viết bài đọc (vd: A rainy day in London, Space travel...)"
                      className="sm:col-span-5 px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                    />
                    <select
                      aria-label="Trình độ CEFR"
                      value={readingAiLevel}
                      onChange={(e) =>
                        setReadingAiLevel(e.target.value as 'A1' | 'A2' | 'B1' | 'B2' | 'C1')
                      }
                      className="sm:col-span-2 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-semibold"
                    >
                      <option value="A1">A1 · Cơ bản</option>
                      <option value="A2">A2 · Sơ cấp</option>
                      <option value="B1">B1 · Trung cấp</option>
                      <option value="B2">B2 · Khá</option>
                      <option value="C1">C1 · Nâng cao</option>
                    </select>
                    <select
                      aria-label="Độ dài bài đọc"
                      value={readingAiLength}
                      onChange={(e) => setReadingAiLength(Number(e.target.value))}
                      className="sm:col-span-2 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                    >
                      <option value={65}>Ngắn (~65 từ)</option>
                      <option value={110}>Vừa (~110 từ)</option>
                      <option value={175}>Dài (~175 từ)</option>
                    </select>
                    <button
                      type="button"
                      disabled={isScrapingOrGeneratingReading || !readingAiTopic.trim()}
                      onClick={() => void handleAiGenerateReadingPassage()}
                      className="sm:col-span-3 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-violet-600 rounded-lg hover:bg-violet-700 disabled:opacity-50"
                    >
                      {isScrapingOrGeneratingReading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      <span>AI Tự tạo bài đọc</span>
                    </button>
                  </div>

                  {(isScrapingOrGeneratingReading || readingAiStageLabel) && (
                    <div className="p-2 rounded-lg bg-white border border-indigo-200 space-y-1">
                      <div className="flex items-center justify-between text-[11px] font-medium text-indigo-900">
                        <span className="truncate">{readingAiStageLabel}</span>
                        <span className="font-mono font-bold tabular-nums">{readingAiProgress}%</span>
                      </div>
                      {isScrapingOrGeneratingReading && (
                        <div className="w-full h-1.5 bg-indigo-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-600 transition-all duration-300"
                            style={{ width: `${Math.max(8, Math.min(100, readingAiProgress))}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
                  {/* Left Controls */}
                  <div className="md:col-span-7 space-y-3">
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Màu sách (Book Palette)
                        </label>
                        <select
                          value={readingPaletteId}
                          onChange={(e) =>
                            setReadingPaletteId(e.target.value as ReadingBookPalette['id'])
                          }
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          {READING_BOOK_PALETTES.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.id}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Phong cách minh họa
                        </label>
                        <select
                          value={readingIllustration}
                          onChange={(e) =>
                            setReadingIllustration(e.target.value as ReadingIllustrationStyle)
                          }
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="Flat 2D">Flat 2D - Phẳng</option>
                          <option value="2.5D">2.5D - Minh họa nổi khối</option>
                          <option value="3D Cartoon">3D Cartoon - Giả lập 3D</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Tiêu đề trang sách
                        </label>
                        <input
                          type="text"
                          value={readingTitle}
                          onChange={(e) => setReadingTitle(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Chủ đề / Trình độ
                        </label>
                        <input
                          type="text"
                          value={readingTopic}
                          onChange={(e) => setReadingTopic(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-[11px] font-semibold text-slate-700">
                          Nội dung bài đọc
                        </label>
                        <label className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 cursor-pointer">
                          Nhập TXT / SRT...
                          <input
                            type="file"
                            accept=".txt,.md,.srt,.vtt"
                            className="hidden"
                            onChange={async (e) => {
                              const f = e.target.files?.[0];
                              if (f) setReadingText(await f.text());
                            }}
                          />
                        </label>
                      </div>
                      <textarea
                        rows={4}
                        value={readingText}
                        onChange={(e) => setReadingText(e.target.value)}
                        className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg leading-relaxed"
                      />
                    </div>

                    {/* TTS / Audio + Whisper Word-Level */}
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-bold text-slate-800">
                          Audio giọng đọc (Xuất TTS hoặc Nạp file có sẵn)
                        </span>
                        <label className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-white border border-indigo-200 rounded-md hover:bg-indigo-50 cursor-pointer">
                          <Upload className="w-3 h-3" />
                          <span>{alignFile ? alignFile.name : 'Chọn Audio/Video'}</span>
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

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <select
                          value={readingProvider}
                          onChange={(e) => setReadingProvider(e.target.value)}
                          className="px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="auto">Tự động (Edge TTS miễn phí)</option>
                          <option value="edge">Edge TTS (Miễn phí)</option>
                          <option value="elevenlabs">
                            ElevenLabs AI Voice ({hasReadingElevenLabsKey ? 'Đã kết nối Secrets' : 'Cần ELEVENLABS_API_KEY'})
                          </option>
                          <option value="google">Google Translate TTS (Miễn phí)</option>
                          <option value="polly">Amazon Polly (Miễn phí)</option>
                          <option value="gemini">
                            Gemini Flash TTS ({hasReadingGeminiKey ? 'Đã kết nối Secrets' : 'Cần GEMINI_API_KEY'})
                          </option>
                        </select>
                        <select
                          value={readingVoice}
                          onChange={(e) => setReadingVoice(e.target.value)}
                          className="sm:col-span-2 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          {allReadingVoices.length === 0 ? (
                            <option value="en-US-JennyNeural">Edge TTS — Jenny (English US)</option>
                          ) : (
                            allReadingVoices.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.label}
                              </option>
                            ))
                          )}
                        </select>
                      </div>

                      {((readingProvider === 'elevenlabs' && !hasReadingElevenLabsKey) ||
                        (readingProvider === 'gemini' && !hasReadingGeminiKey)) && (
                        <div className="px-2.5 py-1.5 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-900">
                          Nhà cung cấp này cần cấu hình biến môi trường{' '}
                          <code className="font-mono font-semibold">
                            {readingProvider === 'elevenlabs' ? 'ELEVENLABS_API_KEY' : 'GEMINI_API_KEY'}
                          </code>{' '}
                          trong <strong>Environment Secrets / .env</strong> ở server rồi khởi động lại server (không nhập key trên trình duyệt để bảo mật).
                        </div>
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={readingTtsRate}
                          onChange={(e) => setReadingTtsRate(Number(e.target.value))}
                          className="px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value={0.75}>0.75x</option>
                          <option value={0.9}>0.9x</option>
                          <option value={1.0}>1.0x</option>
                          <option value={1.15}>1.15x</option>
                          <option value={1.3}>1.3x</option>
                        </select>
                        <button
                          type="button"
                          disabled={isGeneratingReadingTts || !readingText.trim()}
                          onClick={() => void handleGenerateReadingTts()}
                          className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {isGeneratingReadingTts ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Volume2 className="w-3 h-3" />
                          )}
                          <span>
                            {isGeneratingReadingTts
                              ? `Đang tạo Audio... ${readingTtsProgress}%`
                              : 'Tạo Audio TTS & Đồng bộ từ'}
                          </span>
                        </button>
                      </div>

                      {(isGeneratingReadingTts || isAligning) && (
                        <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-200 space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-medium text-emerald-900">
                            <span className="truncate">{readingTtsStageLabel || 'Đang xử lý...'}</span>
                            <span className="font-mono font-bold tabular-nums">{readingTtsProgress}%</span>
                          </div>
                          <div className="w-full h-1.5 bg-emerald-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-600 transition-all duration-300"
                              style={{ width: `${Math.max(4, Math.min(100, readingTtsProgress))}%` }}
                            />
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-2 gap-2">
                        <select
                          value={alignModel}
                          onChange={(e) => setAlignModel(e.target.value)}
                          className="px-2 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg font-mono"
                        >
                          <option value="Xenova/whisper-small">whisper-small</option>
                          <option value="Xenova/whisper-base">whisper-base</option>
                          <option value="Xenova/whisper-tiny">whisper-tiny</option>
                          <option value="large-v3-turbo">large-v3-turbo</option>
                        </select>
                        <select
                          value={alignLang}
                          onChange={(e) => setAlignLang(e.target.value)}
                          className="px-2 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="auto">Tự động ngôn ngữ</option>
                          <option value="en">English</option>
                          <option value="vi">Tiếng Việt</option>
                          <option value="ja">日本語</option>
                        </select>
                      </div>

                      {alignFile && (
                        <button
                          type="button"
                          disabled={isAligning}
                          onClick={() => void handleRunWordAlign()}
                          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-50"
                        >
                          {isAligning ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Wand2 className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {isAligning
                              ? `Đang căn chỉnh từng từ... ${readingTtsProgress}%`
                              : 'Chạy Whisper Word Alignment (khớp bàn tay)'}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Right Live Book + Pointer Preview */}
                  <div className="md:col-span-5 bg-slate-900 rounded-xl p-3 text-white space-y-2.5">
                    <div className="flex items-center justify-between text-[11px]">
                      <span className="font-bold text-indigo-300">BOOK + POINTER PREVIEW</span>
                      <button
                        type="button"
                        onClick={() => {
                          if (isPlayingReadingPreview) {
                            setIsPlayingReadingPreview(false);
                            alignAudioRef.current?.pause();
                          } else {
                            setIsPlayingReadingPreview(true);
                            if (alignAudioRef.current && alignAudioUrl) {
                              alignAudioRef.current.currentTime = alignCurrentSec;
                              void alignAudioRef.current.play().catch(() => undefined);
                            }
                          }
                        }}
                        className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-semibold"
                      >
                        {isPlayingReadingPreview ? (
                          <>
                            <Pause className="w-2.5 h-2.5" />
                            <span>Tạm dừng</span>
                          </>
                        ) : (
                          <>
                            <Play className="w-2.5 h-2.5 fill-current" />
                            <span>Phát thử trang sách</span>
                          </>
                        )}
                      </button>
                    </div>

                    <div className={`${previewCanvasDims.cls} mx-auto rounded-lg overflow-hidden bg-slate-950 border border-slate-800`}>
                      <canvas
                        ref={readingCanvasRef}
                        width={previewCanvasDims.w}
                        height={previewCanvasDims.h}
                        className="w-full h-full object-contain"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        min={0}
                        max={effectiveReadingDuration}
                        step={0.05}
                        value={alignCurrentSec}
                        onChange={(e) => {
                          const t = Number(e.target.value);
                          setAlignCurrentSec(t);
                          if (alignAudioRef.current && alignAudioUrl) {
                            alignAudioRef.current.currentTime = t;
                          }
                        }}
                        className="flex-1 accent-indigo-400 h-1"
                      />
                      <span className="text-[10px] font-mono text-slate-300 tabular-nums">
                        {alignCurrentSec.toFixed(1)}s / {effectiveReadingDuration.toFixed(1)}s
                      </span>
                    </div>

                    {alignAudioUrl && (
                      <audio
                        ref={alignAudioRef}
                        controls
                        src={alignAudioUrl}
                        onLoadedMetadata={(e) => {
                          if (Number.isFinite(e.currentTarget.duration)) {
                            setAlignAudioDur(e.currentTarget.duration);
                          }
                        }}
                        onTimeUpdate={(e) => setAlignCurrentSec(e.currentTarget.currentTime)}
                        className="w-full h-8"
                      />
                    )}
                  </div>
                </div>

                {/* Video Frame Aspect Ratio + Resolution + Quality + FPS */}
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-800">
                      Cấu hình khung hình &amp; chất lượng Video Reading Along
                    </span>
                    <span className="text-[11px] font-mono text-slate-600 tabular-nums">
                      {resolvedReadingDims.width}×{resolvedReadingDims.height} · {resolvedReadingDims.fps}fps
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Khung hình (Tỷ lệ)
                      </label>
                      <select
                        value={readingAspect}
                        onChange={(e) => setReadingAspect(e.target.value as ExportAspectRatioId)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        {ASPECT_RATIO_OPTIONS.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Độ phân giải
                      </label>
                      <select
                        value={readingResolution}
                        onChange={(e) => setReadingResolution(e.target.value as ExportResolutionId)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="540p">540p (Nhanh)</option>
                        <option value="720p">720p (HD Chuẩn)</option>
                        <option value="1080p">1080p (Full HD)</option>
                        <option value="1440p">1440p (2K Siêu nét)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Chất lượng nén
                      </label>
                      <select
                        value={readingQuality}
                        onChange={(e) => setReadingQuality(e.target.value as ExportQualityId)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="standard">Tiêu chuẩn</option>
                        <option value="high">Cao (Nét chữ rõ)</option>
                        <option value="ultra">Ultra (Rất nét)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Khung hình/giây (FPS)
                      </label>
                      <select
                        value={readingFps}
                        onChange={(e) => setReadingFps(Number(e.target.value) as ExportFpsOption)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value={24}>24 fps</option>
                        <option value={30}>30 fps</option>
                        <option value={60}>60 fps (Mượt)</option>
                      </select>
                    </div>
                  </div>
                </div>

                {renderOutputFolderControl()}

                <WatermarkOutroSection
                  config={watermarkOutro}
                  onChange={setWatermarkOutro}
                  title="Watermark & Outro (Tùy chọn · Reading Along MP4)"
                />

                {alignError && (
                  <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                    {alignError}
                  </p>
                )}

                {readingExportStatus && (
                  <div className="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-800 space-y-1.5">
                    <div className="flex items-center justify-between font-medium">
                      <span>{readingExportStatus}</span>
                      {isExportingReadingMp4 && (
                        <span className="font-mono">{Math.round(readingExportProgress * 100)}%</span>
                      )}
                    </div>
                    {isExportingReadingMp4 && (
                      <div className="w-full h-1.5 bg-indigo-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 transition-all"
                          style={{ width: `${Math.round(readingExportProgress * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {isExportingReadingMp4 ? (
                    <button
                      type="button"
                      onClick={() => readingAbortRef.current?.abort()}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-rose-600 rounded-lg hover:bg-rose-700"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span>Hủy xuất MP4</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!readingText.trim()}
                      onClick={() => void handleExportReadingAlongMp4()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>Xuất Reading Along MP4</span>
                    </button>
                  )}

                  {alignResult && (
                    <>
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
                        className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Tải .SRT</span>
                      </button>
                      {onSendAudioCuesToStudio && (
                        <button
                          type="button"
                          onClick={() =>
                            onSendAudioCuesToStudio(
                              alignFile,
                              alignResult.cues,
                              readingTitle || alignFile?.name.replace(/\.[^.]+$/, '') || 'Aligned Lesson',
                            )
                          }
                          className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Nạp sang Studio 9:16</span>
                        </button>
                      )}
                    </>
                  )}
                </div>

                {alignResult && alignResult.words.length > 0 && (
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                    <div className="text-xs font-bold text-emerald-800 inline-flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span>
                        {alignResult.backendUsed} ({alignResult.modelUsed})
                        {alignResult.language ? ` · ${alignResult.language}` : ''} ·{' '}
                        {alignResult.words.length} từ đã căn chỉnh (bấm vào từ để nhảy bàn tay)
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 bg-white rounded-lg border border-slate-200">
                      {alignResult.words.map((w, idx) => {
                        const active = alignCurrentSec >= w.start && alignCurrentSec <= w.end;
                        return (
                          <button
                            key={`${w.start}-${idx}`}
                            type="button"
                            onClick={() => {
                              setAlignCurrentSec(w.start);
                              if (alignAudioRef.current && alignAudioUrl) {
                                alignAudioRef.current.currentTime = w.start;
                                void alignAudioRef.current.play().catch(() => undefined);
                              }
                            }}
                            title={`${w.start.toFixed(2)}s - ${w.end.toFixed(2)}s`}
                            className={`px-2 py-0.5 text-xs rounded-md transition-colors ${
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
      </div>
  );
};
