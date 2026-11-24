import React, { useEffect, useRef, useState } from 'react';
import { Download, FolderOpen, Image as ImageIcon, Pause, Play, RotateCcw, Shuffle, Square, Trash2 } from 'lucide-react';
import {
  ensureProjectAssetsLoaded,
  hitTestElements,
  renderProjectFrame,
  STAGE_HEIGHT,
  STAGE_WIDTH,
} from '../engine/canvasRenderer';
import { LAYOUT_COMPOSITIONS } from '../engine/illustrationLayouts';
import {
  FPS_OPTIONS,
  Mp4ExportSettings,
  QUALITY_OPTIONS,
  RESOLUTION_OPTIONS,
  resolveMp4EncodingParams,
} from '../engine/mp4Config';
import {
  BackgroundFitMode,
  BackgroundImageConfig,
  CANVAS_THEMES,
  CanvasThemeId,
  LayoutCompositionId,
  LessonProject,
} from '../engine/types';
import { resizeImageFileToStageDataUrl } from '../utils/imageResize';

interface StagePreviewProps {
  project: LessonProject;
  currentTime: number;
  isPlaying: boolean;
  isExportingVideo: boolean;
  exportProgress: number;
  exportStageLabel?: string;
  lastExportSummary?: {
    fileName: string;
    savedPath?: string;
    outputCount: number;
    outputDir?: string;
  } | null;
  selectedElementId: string | null;
  mp4Settings: Mp4ExportSettings;
  onChangeMp4Settings: (next: Mp4ExportSettings) => void;
  onChangeComposition: (compositionId: LayoutCompositionId) => void;
  onRandomizeComposition: () => void;
  onTogglePlay: () => void;
  onRestart: () => void;
  onSeek: (time: number) => void;
  onChangeTheme: (theme: CanvasThemeId) => void;
  onChangeBackgroundImage: (bg?: BackgroundImageConfig) => void;
  onSelectElement: (id: string | null) => void;
  onMoveElement: (id: string, x: number, y: number) => void;
  onExportVideo: () => void;
  onCancelExportVideo?: () => void;
  onOpenOutputFolder?: () => void;
}

export const StagePreview: React.FC<StagePreviewProps> = ({
  project,
  currentTime,
  isPlaying,
  isExportingVideo,
  exportProgress,
  exportStageLabel,
  lastExportSummary,
  selectedElementId,
  mp4Settings,
  onChangeMp4Settings,
  onChangeComposition,
  onRandomizeComposition,
  onTogglePlay,
  onRestart,
  onSeek,
  onChangeTheme,
  onChangeBackgroundImage,
  onSelectElement,
  onMoveElement,
  onExportVideo,
  onCancelExportVideo,
  onOpenOutputFolder,
}) => {
  const resolved = resolveMp4EncodingParams(mp4Settings);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);
  const [assetVersion, setAssetVersion] = useState(0);
  const [isProcessingBg, setIsProcessingBg] = useState(false);
  const dragStateRef = useRef<{
    id: string;
    offsetX: number;
    offsetY: number;
  } | null>(null);

  useEffect(() => {
    let active = true;
    if (project.backgroundImage?.dataUrl) {
      void ensureProjectAssetsLoaded(project).then(() => {
        if (active) setAssetVersion((v) => v + 1);
      });
    }
    return () => {
      active = false;
    };
  }, [project]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderProjectFrame(
      ctx,
      project,
      currentTime,
      isPlaying || isExportingVideo ? null : selectedElementId,
    );
  }, [project, currentTime, selectedElementId, isPlaying, isExportingVideo, assetVersion]);

  const handleUploadBgImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setIsProcessingBg(true);
    try {
      const config = await resizeImageFileToStageDataUrl(file, {
        fit: project.backgroundImage?.fit ?? 'cover',
        scrimOpacity: project.backgroundImage?.scrimOpacity ?? 0.22,
      });
      onChangeBackgroundImage(config);
    } catch {
      // Ignore invalid image decode error silently
    } finally {
      setIsProcessingBg(false);
    }
  };

  const toCanvasCoords = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((e.clientX - rect.left) / rect.width) * STAGE_WIDTH,
      y: ((e.clientY - rect.top) / rect.height) * STAGE_HEIGHT,
    };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (isPlaying || isExportingVideo) return;
    const { x, y } = toCanvasCoords(e);
    const hit = hitTestElements(project.elements, x, y, currentTime);
    if (hit) {
      onSelectElement(hit.id);
      dragStateRef.current = {
        id: hit.id,
        offsetX: hit.layout.x - x,
        offsetY: hit.layout.y - y,
      };
      e.currentTarget.setPointerCapture(e.pointerId);
    } else {
      onSelectElement(null);
    }
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    if (!drag) return;
    const { x, y } = toCanvasCoords(e);
    const clampedX = Math.max(120, Math.min(STAGE_WIDTH - 120, Math.round(x + drag.offsetX)));
    const clampedY = Math.max(120, Math.min(STAGE_HEIGHT - 120, Math.round(y + drag.offsetY)));
    onMoveElement(drag.id, clampedX, clampedY);
  };

  const handlePointerUp = () => {
    dragStateRef.current = null;
  };

  const fmtTime = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const secs = (sec % 60).toFixed(2).padStart(5, '0');
    return `${String(mins).padStart(2, '0')}:${secs}`;
  };

  return (
    <section className="flex flex-col items-center bg-white border border-slate-200 rounded-xl p-4 h-fit sticky top-4">
      <div className="w-full flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-slate-100">
        <div className="flex items-center gap-2 text-xs text-slate-500 whitespace-nowrap">
          <span className="font-medium text-slate-800">Xem trước Video 9:16</span>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">{resolved.width}×{resolved.height}</span>
        </div>

        <div className="flex items-center gap-1.5 flex-wrap">
          {Object.values(CANVAS_THEMES).map((theme) => (
            <button
              key={theme.id}
              type="button"
              onClick={() => onChangeTheme(theme.id)}
              title={theme.name}
              aria-label={`Chọn nền ${theme.name}`}
              className={`w-5 h-5 rounded-md border transition-transform ${
                project.theme === theme.id
                  ? 'border-indigo-600 ring-2 ring-indigo-200 scale-110'
                  : 'border-slate-300 hover:scale-105'
              }`}
              style={{
                background: `linear-gradient(180deg, ${theme.bgTop} 0%, ${theme.bgBottom} 100%)`,
              }}
            />
          ))}
        </div>
      </div>

      {/* Unified Composition & Randomize Bar */}
      <div className="w-full pt-2.5 flex items-center gap-2">
        <select
          aria-label="Kiểu phối minh họa & hiệu ứng"
          disabled={isExportingVideo}
          value={project.compositionId ?? 'story-scenes'}
          onChange={(e) => onChangeComposition(e.target.value as LayoutCompositionId)}
          className="flex-1 min-w-0 px-2.5 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
        >
          {LAYOUT_COMPOSITIONS.map((comp) => (
            <option key={comp.id} value={comp.id}>
              {comp.name}
            </option>
          ))}
        </select>

        <button
          type="button"
          disabled={isExportingVideo}
          onClick={onRandomizeComposition}
          aria-label="Phối ngẫu nhiên đúng ngữ cảnh"
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
        >
          <Shuffle className="w-3.5 h-3.5" />
          <span>Phối ngẫu nhiên</span>
        </button>
      </div>

      {/* Background Image Upload (Auto-Resize 9:16) */}
      <div className="w-full pt-2 flex flex-wrap items-center justify-between gap-2">
        <input
          ref={bgInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => void handleUploadBgImage(e)}
        />
        <button
          type="button"
          disabled={isExportingVideo || isProcessingBg}
          onClick={() => bgInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 disabled:opacity-50"
        >
          <ImageIcon className="w-3.5 h-3.5 text-indigo-600" />
          <span>
            {isProcessingBg
              ? 'Đang resize 9:16...'
              : project.backgroundImage
                ? `Ảnh nền: ${project.backgroundImage.fileName || 'Đã nạp'}`
                : 'Upload ảnh nền (Tự resize 9:16)'}
          </span>
        </button>

        {project.backgroundImage && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                onChangeBackgroundImage({
                  ...project.backgroundImage!,
                  fit: (project.backgroundImage!.fit === 'contain' ? 'cover' : 'contain') as BackgroundFitMode,
                })
              }
              className="px-2 py-1 text-[10px] font-semibold bg-white border border-slate-200 rounded text-slate-700 hover:bg-slate-50"
              title="Đổi chế độ phủ khung 9:16"
            >
              {project.backgroundImage.fit === 'contain' ? 'Vừa khung' : 'Phủ đầy'}
            </button>
            <input
              type="range"
              aria-label="Độ tối lớp phủ ảnh nền"
              min={0}
              max={0.7}
              step={0.05}
              value={project.backgroundImage.scrimOpacity ?? 0.22}
              onChange={(e) =>
                onChangeBackgroundImage({
                  ...project.backgroundImage!,
                  scrimOpacity: Number(e.target.value),
                })
              }
              title="Làm dịu ảnh nền để chữ nổi rõ hơn"
              className="w-16 accent-indigo-600 h-1"
            />
            <button
              type="button"
              onClick={() => onChangeBackgroundImage(undefined)}
              aria-label="Xóa ảnh nền"
              className="p-1 text-slate-400 hover:text-red-600 rounded"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
      </div>

      {/* 9:16 Preview Canvas */}
      <div className="my-3 flex items-center justify-center w-full">
        <div className="relative h-[515px] aspect-[9/16] rounded-[28px] overflow-hidden border border-slate-200 shadow-sm bg-slate-100">
          <canvas
            ref={canvasRef}
            data-testid="kinetic-stage-canvas"
            width={STAGE_WIDTH}
            height={STAGE_HEIGHT}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            className="w-full h-full block cursor-grab active:cursor-grabbing touch-none"
          />
          {isExportingVideo && (
            <div className="absolute inset-0 bg-slate-900/75 backdrop-blur-[2px] flex flex-col items-center justify-center text-white p-5 text-center">
              <p className="text-sm font-semibold mb-2">
                {exportStageLabel || 'Đang render Video MP4...'}
              </p>
              <div className="w-48 h-2 bg-white/25 rounded-full overflow-hidden mb-1.5">
                <div
                  className="h-full bg-indigo-400 transition-all duration-150"
                  style={{ width: `${Math.round(exportProgress * 100)}%` }}
                />
              </div>
              <span className="text-xs tabular-nums text-white/85 mb-4">
                {Math.round(exportProgress * 100)}%
              </span>
              {onCancelExportVideo && (
                <button
                  type="button"
                  onClick={onCancelExportVideo}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 rounded-lg shadow-sm transition-colors"
                >
                  <Square className="w-3 h-3 fill-current" />
                  <span>Hủy render</span>
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Transport & Scrubber */}
      <div className="w-full pt-3 border-t border-slate-100 space-y-2.5">
        <div className="flex items-center gap-3">
          <input
            type="range"
            aria-label="Thanh tua thời gian"
            min={0}
            max={project.duration}
            step={0.02}
            value={currentTime}
            onChange={(e) => onSeek(Number(e.target.value))}
            className="flex-1 accent-indigo-600 h-1.5 bg-slate-200 rounded-lg cursor-pointer"
          />
          <span className="text-xs font-mono text-slate-600 tabular-nums shrink-0">
            {fmtTime(currentTime)} / {fmtTime(project.duration)}
          </span>
        </div>

        <div className="grid grid-cols-3 gap-1.5">
          <select
            aria-label="Độ phân giải xuất MP4"
            disabled={isExportingVideo}
            value={mp4Settings.resolution}
            onChange={(e) =>
              onChangeMp4Settings({
                ...mp4Settings,
                resolution: e.target.value as Mp4ExportSettings['resolution'],
              })
            }
            className="w-full px-2 py-1.5 text-[11px] font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            {RESOLUTION_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.id} ({opt.width}×{opt.height})
              </option>
            ))}
          </select>

          <select
            aria-label="Chất lượng xuất MP4"
            disabled={isExportingVideo}
            value={mp4Settings.quality}
            onChange={(e) =>
              onChangeMp4Settings({
                ...mp4Settings,
                quality: e.target.value as Mp4ExportSettings['quality'],
              })
            }
            className="w-full px-2 py-1.5 text-[11px] font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            {QUALITY_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>

          <select
            aria-label="Tốc độ khung hình FPS xuất MP4"
            disabled={isExportingVideo}
            value={mp4Settings.fps}
            onChange={(e) =>
              onChangeMp4Settings({
                ...mp4Settings,
                fps: Number(e.target.value) as Mp4ExportSettings['fps'],
              })
            }
            className="w-full px-2 py-1.5 text-[11px] font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50"
          >
            {FPS_OPTIONS.map((fpsVal) => (
              <option key={fpsVal} value={fpsVal}>
                {fpsVal} fps
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onTogglePlay}
              disabled={isExportingVideo}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              {isPlaying ? (
                <>
                  <Pause className="w-3.5 h-3.5" />
                  <span>Tạm dừng</span>
                </>
              ) : (
                <>
                  <Play className="w-3.5 h-3.5" />
                  <span>Phát thử</span>
                </>
              )}
            </button>
            <button
              type="button"
              onClick={onRestart}
              disabled={isExportingVideo}
              aria-label="Phát lại từ đầu"
              className="p-2 text-slate-600 hover:text-slate-900 border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
            </button>
          </div>

          {isExportingVideo && onCancelExportVideo ? (
            <button
              type="button"
              onClick={onCancelExportVideo}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-700 transition-colors whitespace-nowrap"
            >
              <Square className="w-3.5 h-3.5 fill-current" />
              <span>Hủy render</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={isExportingVideo}
              onClick={onExportVideo}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-50 transition-colors whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{isExportingVideo ? 'Đang render MP4...' : 'Render & Tải MP4'}</span>
            </button>
          )}
        </div>

        {lastExportSummary && !isExportingVideo && (
          <div className="px-3 py-2 rounded-lg bg-emerald-50 border border-emerald-200 flex items-center justify-between gap-2 text-[11px] text-emerald-900">
            <div className="min-w-0">
              <div className="font-semibold truncate">
                ✓ Đã xuất {lastExportSummary.fileName} ({lastExportSummary.outputCount} file trong Output)
              </div>
              {(lastExportSummary.savedPath || lastExportSummary.outputDir) && (
                <div className="text-[10px] text-emerald-700 font-mono truncate">
                  Lưu tại: {lastExportSummary.savedPath || lastExportSummary.outputDir}
                </div>
              )}
            </div>
            {onOpenOutputFolder && (
              <button
                type="button"
                onClick={onOpenOutputFolder}
                className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-semibold bg-white border border-emerald-300 text-emerald-800 rounded-md hover:bg-emerald-100 shrink-0"
              >
                <FolderOpen className="w-3 h-3" />
                <span>Mở thư mục Output</span>
              </button>
            )}
          </div>
        )}
      </div>
    </section>
  );
};
