import {
  cuesToBlockTranscript,
  cuesToSrt,
  refineCuesWithWhisperWords,
  stripTimestampsFromScript,
} from './transcriptParser';
import { TranscriptCue, WordTiming } from './types';

export interface TtsVoiceItem {
  id: string;
  label: string;
  lang: string;
}

export interface TtsProviderItem {
  id: string;
  name: string;
  voices: TtsVoiceItem[];
}

export interface TtsSynthesizeResponse {
  ok?: boolean;
  providerUsed?: string;
  mimeType?: string;
  audioBase64?: string;
  durationSec?: number;
  segmentDurations?: number[];
  spokenDurations?: number[];
  pauseDurations?: number[];
  cues?: TranscriptCue[];
  srt?: string;
  vtt?: string;
  error?: string;
}

export interface WhisperAlignResponse {
  ok?: boolean;
  words?: WordTiming[];
  segments?: Array<{ start: number; end: number; text: string }>;
  text?: string;
  language?: string;
  modelUsed?: string;
  backendUsed?: string;
  srt?: string;
  cues?: TranscriptCue[];
  error?: string;
}

export interface SynthesizeAndSyncResult {
  audioFile: File;
  audioBase64: string;
  cues: TranscriptCue[];
  srt: string;
  blockTranscript: string;
  providerUsed: string;
  detectedLanguage?: string;
  durationSec: number;
  whisperAligned: boolean;
}

function base64ToMp3File(base64: string, fileName: string, mimeType = 'audio/mpeg'): File {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], fileName, { type: mimeType });
}

export async function fetchTtsVoicesCatalog(): Promise<{
  providers: TtsProviderItem[];
  hasGeminiKey: boolean;
  hasElevenLabsKey: boolean;
}> {
  const res = await fetch('/api/tts/voices');
  const data = (await res.json().catch(() => ({}))) as {
    providers?: TtsProviderItem[];
    hasGeminiKey?: boolean;
    hasElevenLabsKey?: boolean;
  };
  return {
    providers: Array.isArray(data.providers) ? data.providers : [],
    hasGeminiKey: Boolean(data.hasGeminiKey),
    hasElevenLabsKey: Boolean(data.hasElevenLabsKey),
  };
}

export async function synthesizeAudioWithProgressJob(
  payload: Record<string, unknown>,
  onProgress?: (progress: number, stageLabel: string) => void,
): Promise<TtsSynthesizeResponse> {
  onProgress?.(4, 'Đang khởi tạo tác vụ đọc TTS...');
  const startRes = await fetch('/api/tts/synthesize/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const startRaw = await startRes.text();
  const trimmedStart = startRaw.trim();

  // Graceful fallback to synchronous endpoint if /start returned 404 or HTML page
  if (startRes.status === 404 || trimmedStart.startsWith('<')) {
    onProgress?.(35, 'Đang tổng hợp giọng đọc TTS...');
    const directRes = await fetch('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const directRaw = await directRes.text();
    let directJson: TtsSynthesizeResponse = {};
    try {
      directJson = JSON.parse(directRaw) as TtsSynthesizeResponse;
    } catch {
      throw new Error(
        directRes.ok
          ? 'Server trả về dữ liệu TTS không hợp lệ (không phải JSON).'
          : `Lỗi tổng hợp TTS (HTTP ${directRes.status}).`,
      );
    }
    if (!directRes.ok || !directJson.audioBase64) {
      throw new Error(directJson.error || `Lỗi tổng hợp TTS (HTTP ${directRes.status}).`);
    }
    onProgress?.(100, 'Tổng hợp Audio hoàn tất!');
    return directJson;
  }

  let startJson: { jobId?: string; error?: string } = {};
  try {
    startJson = JSON.parse(trimmedStart) as { jobId?: string; error?: string };
  } catch {
    throw new Error(
      startRes.ok
        ? 'Server trả về dữ liệu TTS không hợp lệ.'
        : `Lỗi tạo tác vụ TTS (HTTP ${startRes.status}).`,
    );
  }
  if (!startRes.ok || !startJson.jobId) {
    throw new Error(startJson.error || `Lỗi tạo tác vụ TTS (HTTP ${startRes.status}).`);
  }

  const jobId = startJson.jobId;
  const startedAt = Date.now();
  let consecutivePollFailures = 0;

  while (Date.now() - startedAt < 10 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 380));
    let pollRes: Response;
    try {
      pollRes = await fetch(`/api/tts/synthesize/${encodeURIComponent(jobId)}`);
    } catch (netErr) {
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= 4) {
        throw netErr instanceof Error ? netErr : new Error('Mất kết nối tới server TTS.');
      }
      continue;
    }

    const pollRaw = await pollRes.text();
    const trimmedPoll = pollRaw.trim();
    if (!trimmedPoll || trimmedPoll.startsWith('<')) {
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= 4) {
        throw new Error(`Mất kết nối theo dõi tiến trình TTS (HTTP ${pollRes.status}).`);
      }
      continue;
    }

    let pollData: {
      status?: 'queued' | 'running' | 'done' | 'error';
      progress?: number;
      stageLabel?: string;
      result?: TtsSynthesizeResponse;
      error?: string;
    } = {};
    try {
      pollData = JSON.parse(trimmedPoll);
    } catch {
      consecutivePollFailures += 1;
      if (consecutivePollFailures >= 4) {
        throw new Error('Server trả về dữ liệu tiến trình TTS không hợp lệ.');
      }
      continue;
    }

    if (!pollRes.ok) {
      throw new Error(pollData.error || `Mất kết nối theo dõi tiến trình TTS (HTTP ${pollRes.status}).`);
    }
    consecutivePollFailures = 0;

    if (typeof pollData.progress === 'number' || pollData.stageLabel) {
      onProgress?.(
        Math.max(5, Math.min(99, Number(pollData.progress ?? 10))),
        pollData.stageLabel || 'Đang tổng hợp giọng đọc...',
      );
    }
    if (pollData.status === 'done' && pollData.result) {
      onProgress?.(100, 'Tổng hợp Audio hoàn tất!');
      return pollData.result;
    }
    if (pollData.status === 'error') {
      throw new Error(pollData.error || 'Lỗi tổng hợp Audio TTS.');
    }
  }
  throw new Error('Hết thời gian chờ tổng hợp Audio TTS.');
}

export async function alignAudioWithProgressJob(
  payload: { audioBase64: string; ext?: string; lang?: string; model?: string },
  onProgress?: (progress: number, stageLabel: string) => void,
): Promise<WhisperAlignResponse> {
  onProgress?.(5, 'Đang gửi audio sang Whisper...');
  const startRes = await fetch('/api/subtitles/align/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const startData = (await startRes.json().catch(() => ({}))) as {
    jobId?: string;
    error?: string;
  };
  if (!startRes.ok || !startData.jobId) {
    throw new Error(startData.error || `Không khởi tạo được Whisper Align (HTTP ${startRes.status}).`);
  }

  const jobId = startData.jobId;
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10 * 60 * 1000) {
    await new Promise((r) => setTimeout(r, 600));
    const pollRes = await fetch(`/api/subtitles/align/${encodeURIComponent(jobId)}`);
    const pollData = (await pollRes.json().catch(() => ({}))) as {
      status?: 'queued' | 'running' | 'done' | 'error';
      progress?: number;
      stageLabel?: string;
      result?: WhisperAlignResponse;
      error?: string;
    };
    if (!pollRes.ok) {
      throw new Error(pollData.error || 'Lỗi theo dõi tiến trình Whisper Align.');
    }
    if (typeof pollData.progress === 'number' || pollData.stageLabel) {
      onProgress?.(
        Math.max(8, Math.min(99, Number(pollData.progress ?? 15))),
        pollData.stageLabel || 'Đang căn từng từ bằng Whisper...',
      );
    }
    if (pollData.status === 'done' && pollData.result) {
      onProgress?.(100, 'Căn từng từ Whisper hoàn tất!');
      return pollData.result;
    }
    if (pollData.status === 'error') {
      throw new Error(pollData.error || 'Lỗi căn chỉnh Whisper.');
    }
  }
  throw new Error('Hết thời gian chờ Whisper Align.');
}

export async function synthesizeAudioAndSyncCues(params: {
  rawScript: string;
  title?: string;
  provider?: string;
  voice?: string;
  lang?: string;
  rate?: number;
  alignWithWhisper?: boolean;
  whisperModel?: string;
  onProgress?: (progress: number, stageLabel: string) => void;
}): Promise<SynthesizeAndSyncResult> {
  const cleanText = stripTimestampsFromScript(params.rawScript).trim();
  if (!cleanText) {
    throw new Error('Hãy nhập nội dung văn bản (mỗi dòng 1 câu) để xuất Audio.');
  }

  const useWhisperAlign = params.alignWithWhisper !== false;
  const data = await synthesizeAudioWithProgressJob(
    {
      provider: params.provider || 'auto',
      voice: params.voice || 'en-US-JennyNeural',
      lang: params.lang || 'en-US',
      rate: params.rate ?? 1.0,
      text: cleanText,
    },
    (pct, label) => {
      const scaled = useWhisperAlign ? Math.round(pct * 0.72) : pct;
      params.onProgress?.(Math.max(3, scaled), label);
    },
  );

  if (!data.audioBase64) {
    throw new Error(data.error || 'Không thể sinh Audio TTS từ server.');
  }

  let finalCues: TranscriptCue[] = Array.isArray(data.cues) ? data.cues : [];
  let providerUsed = data.providerUsed || params.provider || 'edge';
  let detectedLanguage: string | undefined;
  let whisperAligned = false;

  if (useWhisperAlign && finalCues.length > 0) {
    try {
      params.onProgress?.(74, 'Đang căn từng từ với Whisper Local...');
      const alignData = await alignAudioWithProgressJob(
        {
          audioBase64: data.audioBase64,
          ext: '.mp3',
          lang: 'auto',
          model: params.whisperModel || 'Xenova/whisper-small',
        },
        (pct, label) => {
          const scaled = Math.min(98, Math.round(74 + pct * 0.24));
          params.onProgress?.(scaled, label);
        },
      );
      if (Array.isArray(alignData.words) && alignData.words.length > 0) {
        finalCues = refineCuesWithWhisperWords(finalCues, alignData.words);
        detectedLanguage = alignData.language;
        providerUsed = `${providerUsed} + ${alignData.backendUsed || 'whisper'}`;
        whisperAligned = true;
      }
    } catch {
      // Keep exact per-line MP3 durations measured by FFmpeg
    }
  }

  params.onProgress?.(100, 'Hoàn tất đồng bộ Audio & Sub!');
  const srt = finalCues.length > 0 ? cuesToSrt(finalCues) : data.srt || '';
  const blockTranscript = finalCues.length > 0 ? cuesToBlockTranscript(finalCues) : '';
  const safeStem =
    (params.title || 'kineticsub_audio')
      .trim()
      .replace(/[^a-zA-Z0-9-_]+/g, '_')
      .slice(0, 36) || 'kineticsub_audio';
  const audioFile = base64ToMp3File(
    data.audioBase64,
    `${safeStem}.mp3`,
    data.mimeType || 'audio/mpeg',
  );

  return {
    audioFile,
    audioBase64: data.audioBase64,
    cues: finalCues,
    srt,
    blockTranscript,
    providerUsed,
    detectedLanguage,
    durationSec: Number(data.durationSec || 0),
    whisperAligned,
  };
}
