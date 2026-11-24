import { STAGE_HEIGHT, STAGE_WIDTH } from '../engine/canvasRenderer';
import { BackgroundFitMode, BackgroundImageConfig } from '../engine/types';

export async function resizeImageFileToStageDataUrl(
  file: File,
  options?: { fit?: BackgroundFitMode; scrimOpacity?: number },
): Promise<BackgroundImageConfig> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Không thể đọc file ảnh nền.'));
      el.src = objectUrl;
    });

    const fit: BackgroundFitMode = options?.fit ?? 'cover';
    const canvas = document.createElement('canvas');
    canvas.width = STAGE_WIDTH;
    canvas.height = STAGE_HEIGHT;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Không khởi tạo được Canvas để xử lý ảnh nền.');
    }

    const srcW = Math.max(1, img.naturalWidth || img.width);
    const srcH = Math.max(1, img.naturalHeight || img.height);
    const scale =
      fit === 'contain'
        ? Math.min(STAGE_WIDTH / srcW, STAGE_HEIGHT / srcH)
        : Math.max(STAGE_WIDTH / srcW, STAGE_HEIGHT / srcH);
    const dw = Math.round(srcW * scale);
    const dh = Math.round(srcH * scale);
    const dx = Math.round((STAGE_WIDTH - dw) / 2);
    const dy = Math.round((STAGE_HEIGHT - dh) / 2);

    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, STAGE_WIDTH, STAGE_HEIGHT);
    ctx.drawImage(img, dx, dy, dw, dh);

    const dataUrl = canvas.toDataURL('image/jpeg', 0.88);
    return {
      dataUrl,
      fileName: file.name,
      fit,
      scrimOpacity: options?.scrimOpacity ?? 0.22,
    };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}
