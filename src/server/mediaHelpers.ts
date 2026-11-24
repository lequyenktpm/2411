import { spawn, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface WhisperWordChunk {
  text: string;
  start: number;
  end: number;
}

export interface WhisperTranscribeResult {
  text: string;
  segments: Array<{ start: number; end: number; text: string }>;
  words: WhisperWordChunk[];
  modelUsed?: string;
  backendUsed?: string;
}

const whisperPipelines = new Map<string, Promise<any>>();
let cachedFasterWhisperAvailable: boolean | null = null;

export async function isFasterWhisperPythonAvailable(): Promise<boolean> {
  if (cachedFasterWhisperAvailable !== null) return cachedFasterWhisperAvailable;
  const check = async (pyCmd: string): Promise<boolean> =>
    new Promise((resolve) => {
      const proc = spawn(pyCmd, ['-c', 'import faster_whisper'], { shell: false });
      proc.on('error', () => resolve(false));
      proc.on('close', (code) => resolve(code === 0));
    });
  cachedFasterWhisperAvailable = (await check('python3')) || (await check('python'));
  return cachedFasterWhisperAvailable;
}

async function runFasterWhisperPython(
  wavPath: string,
  modelName: string,
  sourceLang?: string,
  wordLevel?: boolean,
): Promise<WhisperTranscribeResult | null> {
  if (!(await isFasterWhisperPythonAvailable())) return null;
  const whisperLang = mapLanguageToIsoCode(sourceLang || 'auto');
  const script = `
import json, sys
from faster_whisper import WhisperModel
wav_path, model_name, lang, word_ts = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
model = WhisperModel(model_name, device="auto", compute_type="int8")
kwargs = {"word_timestamps": word_ts, "vad_filter": True}
if lang:
    kwargs["language"] = lang
segs_gen, info = model.transcribe(wav_path, **kwargs)
segs = []
words = []
texts = []
for s in segs_gen:
    txt = (s.text or "").strip()
    if txt:
        segs.append({"start": round(float(s.start), 3), "end": round(float(s.end), 3), "text": txt})
        texts.append(txt)
    if word_ts and getattr(s, "words", None):
        for w in s.words:
            wt = (w.word or "").strip()
            if wt:
                words.append({"text": wt, "start": round(float(w.start), 3), "end": round(float(w.end), 3)})
print(json.dumps({"text": " ".join(texts), "segments": segs, "words": words}, ensure_ascii=False))
`;

  const runPy = (pyCmd: string) =>
    new Promise<string>((resolve, reject) => {
      const proc = spawn(
        pyCmd,
        ['-c', script, wavPath, modelName, whisperLang || '', wordLevel ? '1' : '0'],
        { shell: false },
      );
      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (c: Buffer) => {
        stdout += c.toString('utf8');
      });
      proc.stderr?.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      proc.on('error', reject);
      proc.on('close', (code) => {
        if (code === 0) resolve(stdout);
        else reject(new Error(stderr.slice(-500) || `python exit ${code}`));
      });
    });

  try {
    const out = await runPy('python3').catch(() => runPy('python'));
    const parsed = JSON.parse(out.trim()) as WhisperTranscribeResult;
    return {
      text: parsed.text || '',
      segments: Array.isArray(parsed.segments) ? parsed.segments : [],
      words: Array.isArray(parsed.words) ? parsed.words : [],
      modelUsed: modelName,
      backendUsed: 'faster-whisper',
    };
  } catch {
    return null;
  }
}

export function parseWavToFloat32Mono16k(wavBuffer: Buffer): Float32Array {
  if (wavBuffer.length < 44 || wavBuffer.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('File WAV không hợp lệ để chạy Whisper Local.');
  }
  let offset = 12;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= wavBuffer.length) {
    const chunkId = wavBuffer.toString('ascii', offset, offset + 4);
    const chunkSize = wavBuffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkSize, wavBuffer.length - dataOffset);
      break;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  if (dataOffset < 0 || dataSize <= 0) {
    throw new Error('Không tìm thấy dữ liệu PCM trong file WAV.');
  }

  const sampleCount = Math.floor(dataSize / 2);
  const floatData = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    floatData[i] = wavBuffer.readInt16LE(dataOffset + i * 2) / 32768.0;
  }
  return floatData;
}

function mapLanguageToIsoCode(lang: string): string | undefined {
  const low = (lang || '').trim().toLowerCase();
  if (!low || low === 'auto') return undefined;
  if (low.startsWith('en')) return 'en';
  if (low.startsWith('vi') || low.includes('tiếng việt')) return 'vi';
  if (low.startsWith('ja') || low.includes('japan')) return 'ja';
  if (low.startsWith('zh') || low.includes('chin')) return 'zh';
  if (low.startsWith('ko') || low.includes('kor')) return 'ko';
  if (low.startsWith('fr')) return 'fr';
  if (low.startsWith('es') || low.includes('span')) return 'es';
  return undefined;
}

function mapLanguageToWhisper(lang: string): string | undefined {
  const low = (lang || '').trim().toLowerCase();
  if (!low || low === 'auto') return undefined;
  if (low.startsWith('en')) return 'english';
  if (low.startsWith('vi') || low.includes('tiếng việt')) return 'vietnamese';
  if (low.startsWith('ja') || low.includes('japan')) return 'japanese';
  if (low.startsWith('zh') || low.includes('chin')) return 'chinese';
  if (low.startsWith('ko') || low.includes('kor')) return 'korean';
  if (low.startsWith('fr')) return 'french';
  if (low.startsWith('es') || low.includes('span')) return 'spanish';
  return undefined;
}

async function getWhisperPipeline(modelId: string) {
  let pending = whisperPipelines.get(modelId);
  if (!pending) {
    pending = (async () => {
      const { pipeline } = await import('@huggingface/transformers');
      return pipeline('automatic-speech-recognition', modelId, {
        dtype: 'q8',
      });
    })();
    whisperPipelines.set(modelId, pending);
  }
  try {
    return await pending;
  } catch (err) {
    whisperPipelines.delete(modelId);
    throw err;
  }
}

function resolveOnnxModelCandidates(requestedModel: string): string[] {
  const clean = (requestedModel || '').trim();
  const mapped =
    clean === 'large-v3-turbo' || clean === 'whisper-large-v3-turbo'
      ? 'onnx-community/whisper-large-v3-turbo'
      : clean === 'small'
        ? 'Xenova/whisper-small'
        : clean === 'base'
          ? 'Xenova/whisper-base'
          : clean === 'tiny'
            ? 'Xenova/whisper-tiny'
            : clean || 'onnx-community/whisper-large-v3-turbo';

  const candidates = [mapped];
  if (mapped !== 'Xenova/whisper-small') candidates.push('Xenova/whisper-small');
  if (mapped !== 'Xenova/whisper-tiny') candidates.push('Xenova/whisper-tiny');
  return candidates;
}

export async function runLocalWhisperOnWav(
  wavPath: string,
  options?: {
    sourceLang?: string;
    modelId?: string;
    wordLevel?: boolean;
    preferFasterWhisper?: boolean;
  },
): Promise<WhisperTranscribeResult> {
  const requestedModel =
    options?.modelId?.trim() ||
    process.env.WHISPER_MODEL?.trim() ||
    'large-v3-turbo';

  // 1. Try native faster-whisper Python library if installed on the machine
  if (options?.preferFasterWhisper !== false) {
    const fwModel = requestedModel
      .replace(/^onnx-community\/whisper-/i, '')
      .replace(/^Xenova\/whisper-/i, '');
    const fwRes = await runFasterWhisperPython(
      wavPath,
      fwModel || 'large-v3-turbo',
      options?.sourceLang,
      options?.wordLevel,
    );
    if (fwRes && (fwRes.segments.length > 0 || fwRes.text)) {
      return fwRes;
    }
  }

  // 2. Built-in zero-dependency ONNX Whisper via @huggingface/transformers (works everywhere)
  const wavBuf = await fs.promises.readFile(wavPath);
  const audioFloat = parseWavToFloat32Mono16k(wavBuf);
  if (audioFloat.length < 160) {
    return { text: '', segments: [], words: [], modelUsed: requestedModel, backendUsed: 'whisper-onnx' };
  }

  const candidates = resolveOnnxModelCandidates(requestedModel);
  let transcriber: any = null;
  let modelUsed = candidates[0];
  let lastLoadErr: unknown = null;

  for (const candidate of candidates) {
    try {
      transcriber = await getWhisperPipeline(candidate);
      modelUsed = candidate;
      break;
    } catch (err) {
      lastLoadErr = err;
    }
  }
  if (!transcriber) {
    throw lastLoadErr instanceof Error ? lastLoadErr : new Error('Không thể tải mô hình Whisper local.');
  }

  const whisperLang = mapLanguageToWhisper(options?.sourceLang || 'auto');
  const result = await transcriber(audioFloat, {
    chunk_length_s: 30,
    stride_length_s: 5,
    return_timestamps: options?.wordLevel ? 'word' : true,
    ...(whisperLang ? { language: whisperLang, task: 'transcribe' } : {}),
  });

  const chunks: Array<{ text?: string; timestamp?: [number | null, number | null] }> = Array.isArray(
    result?.chunks,
  )
    ? result.chunks
    : [];

  const totalDur = Number((audioFloat.length / 16000).toFixed(3));
  const rawWords: WhisperWordChunk[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const txt = String(chunk?.text || '').trim();
    if (!txt) continue;
    const ts = Array.isArray(chunk?.timestamp) ? chunk.timestamp : [0, totalDur];
    const start = Math.max(0, Number(ts[0] ?? (i === 0 ? 0 : rawWords[rawWords.length - 1]?.end ?? 0)));
    const rawEnd = ts[1] !== null && ts[1] !== undefined ? Number(ts[1]) : Math.min(totalDur, start + 0.65);
    const end = Math.max(start + 0.08, Math.min(totalDur, rawEnd));
    rawWords.push({
      text: txt,
      start: Number(start.toFixed(3)),
      end: Number(end.toFixed(3)),
    });
  }

  // Group word chunks into subtitle-length segments (~8-12 words or punctuation boundary)
  const segments: Array<{ start: number; end: number; text: string }> = [];
  if (options?.wordLevel) {
    let curWords: WhisperWordChunk[] = [];
    for (let i = 0; i < rawWords.length; i++) {
      const w = rawWords[i];
      curWords.push(w);
      const isSentenceEnd = /[.!?。！？]$/.test(w.text);
      const nextGap = i + 1 < rawWords.length ? rawWords[i + 1].start - w.end : 1;
      if (isSentenceEnd || curWords.length >= 9 || nextGap >= 0.65 || i === rawWords.length - 1) {
        segments.push({
          start: curWords[0].start,
          end: curWords[curWords.length - 1].end,
          text: curWords.map((x) => x.text).join(' ').replace(/\s+([,.!?;:])/g, '$1').trim(),
        });
        curWords = [];
      }
    }
  } else {
    for (const c of rawWords) {
      segments.push({ start: c.start, end: c.end, text: c.text });
    }
  }

  if (segments.length === 0 && typeof result?.text === 'string' && result.text.trim()) {
    segments.push({ start: 0, end: Math.max(1.5, totalDur), text: result.text.trim() });
  }

  return {
    text: String(result?.text || segments.map((s) => s.text).join(' ')).trim(),
    segments,
    words: rawWords,
    modelUsed,
    backendUsed: 'faster-whisper-built-in (ONNX)',
  };
}

export const ELEVENLABS_DEFAULT_VOICES = [
  { id: '21m00Tcm4TlvDq8ikWAM', label: 'Rachel (US Female · Tự nhiên rõ)', lang: 'en-US' },
  { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah / Bella (Soft Narration)', lang: 'en-US' },
  { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam (US Male · Thuyết minh)', lang: 'en-US' },
  { id: 'ErXwobaYiN019PkySvjV', label: 'Antoni (Warm Male)', lang: 'en-US' },
  { id: 'TxGEqnHWrfWFTfGW9XjX', label: 'Josh (Young Energetic Male)', lang: 'en-US' },
  { id: 'N2lVS1w4EtoT3dr4eOWO', label: 'Callum (Storyteller)', lang: 'en-US' },
];

export async function synthesizeElevenLabsTtsBuffer(
  text: string,
  voiceId: string,
  apiKey: string,
): Promise<Buffer> {
  const safeVoiceId = /^[A-Za-z0-9]{10,40}$/.test(voiceId)
    ? voiceId
    : ELEVENLABS_DEFAULT_VOICES[0].id;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(safeVoiceId)}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: 'eleven_multilingual_v2',
        voice_settings: {
          stability: 0.52,
          similarity_boost: 0.78,
        },
      }),
    },
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs HTTP ${res.status}: ${errText.slice(0, 180)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export function resolveSafeOutputDir(rawSubPath?: string): { baseDir: string; targetDir: string } {
  const baseDir = path.resolve(process.env.BATCH_OUTPUT_DIR || 'output');
  const trimmed = (rawSubPath || '').trim().replace(/^[/\\]+/, '');
  const candidate = trimmed ? path.resolve(baseDir, trimmed) : baseDir;
  const targetDir =
    candidate === baseDir || candidate.startsWith(baseDir + path.sep) ? candidate : baseDir;
  return { baseDir, targetDir };
}

export function resolveSafeOutputFile(relPath: string): { baseDir: string; filePath: string } | null {
  const baseDir = path.resolve(process.env.BATCH_OUTPUT_DIR || 'output');
  const clean = (relPath || '').replace(/^[/\\]+/, '');
  if (!clean) return null;
  const candidate = path.resolve(baseDir, clean);
  if (!candidate.startsWith(baseDir + path.sep)) return null;
  return { baseDir, filePath: candidate };
}

export function sanitizeOutputStem(raw: string, fallback = 'video_output'): string {
  return (
    raw
      .replace(/[\x00-\x1f\\/:*?"<>|]/g, '_')
      .trim()
      .replace(/[.\s]+$/, '')
      .slice(0, 120) || fallback
  );
}

export async function probeMediaMeta(filePath: string): Promise<{
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  isStereo: boolean;
}> {
  let duration = 0;
  let width = 1080;
  let height = 1920;
  let fps = 30;
  let hasAudio = false;
  let isStereo = false;

  try {
    const proc = spawn('ffprobe', [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      filePath,
    ]);
    let out = '';
    await new Promise<void>((resolve) => {
      proc.stdout?.on('data', (c: Buffer) => {
        out += c.toString('utf8');
      });
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
    });
    const parsed = JSON.parse(out || '{}') as {
      format?: { duration?: string };
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        r_frame_rate?: string;
        channels?: number;
      }>;
    };
    const fd = Number.parseFloat(String(parsed.format?.duration || '0'));
    if (Number.isFinite(fd) && fd > 0.05) duration = fd;
    for (const s of parsed.streams || []) {
      if (s.codec_type === 'video') {
        if (s.width && s.height) {
          width = s.width;
          height = s.height;
        }
        const rateStr = s.avg_frame_rate && s.avg_frame_rate !== '0/0' ? s.avg_frame_rate : s.r_frame_rate;
        if (rateStr && rateStr.includes('/')) {
          const [num, den] = rateStr.split('/').map(Number);
          if (num > 0 && den > 0) {
            const calc = num / den;
            if (calc >= 10 && calc <= 120) fps = Math.round(calc);
          }
        }
      } else if (s.codec_type === 'audio') {
        hasAudio = true;
        if ((s.channels ?? 0) >= 2) isStereo = true;
      }
    }
  } catch {
    // fallback values preserved
  }

  return { duration: Math.max(0.5, duration || 3), width, height, fps, hasAudio, isStereo };
}

export function spawnTrackedFfmpeg(
  args: string[],
  cwd: string,
  registerProc?: (proc: ChildProcess) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', args, { cwd, shell: false });
    registerProc?.(proc);
    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-8000);
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`FFmpeg lỗi (${code}): ${stderr.slice(-500)}`));
    });
  });
}
