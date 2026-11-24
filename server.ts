import 'dotenv/config';
import crypto from 'node:crypto';
import { ChildProcess, spawn } from 'node:child_process';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { load as loadHtml } from 'cheerio';
import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } from 'msedge-tts';
import { buildFfmpegArgs } from './src/engine/ffmpegArgs.ts';
import { detectReelMode, splitMultipleExercisesFromText } from './src/engine/englishReelsEngine.ts';
import { formatTimeToken, interpolateWordTimings } from './src/engine/transcriptParser.ts';
import {
  ELEVENLABS_DEFAULT_VOICES,
  probeMediaMeta,
  resolveSafeOutputDir,
  resolveSafeOutputFile,
  runLocalWhisperOnWav,
  sanitizeOutputStem,
  spawnTrackedFfmpeg,
  synthesizeElevenLabsTtsBuffer,
} from './src/server/mediaHelpers.ts';

interface RenderJob {
  id: string;
  dir: string;
  fps: number;
  crf: number;
  framesPath: string;
  audioPath: string | null;
  createdAt: number;
  chunkCount: number;
}

interface StudioJob {
  id: string;
  dir: string;
  createdAt: number;
  files: Record<string, string>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_AUDIO_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.webm', '.flac', '.opus']);
const ALLOWED_MEDIA_EXTS = new Set(['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.webm', '.mp4', '.mov', '.mkv', '.avi', '.m4v', '.mpeg', '.mpg']);
const JOB_TTL_MS = 60 * 60 * 1000;
const COMPONENTS_DATA_DIR = path.resolve('data');
const COMPONENTS_DATA_FILE = path.join(COMPONENTS_DATA_DIR, 'custom-components.json');
const RENDER_TMP_ROOT = path.resolve('.render-tmp');
const STUDIO_TMP_ROOT = path.resolve('.studio-tmp');

const jobs = new Map<string, RenderJob>();
const activeJobProcs = new Map<string, ChildProcess>();
const studioJobs = new Map<string, StudioJob>();
const activeStudioProcs = new Map<string, ChildProcess>();

function getJobDir(jobId: string): string {
  return path.join(RENDER_TMP_ROOT, `ks-render-${jobId}`);
}

function getStudioJobDir(jobId: string): string {
  return path.join(STUDIO_TMP_ROOT, `ks-studio-${jobId}`);
}

async function saveJobMeta(job: RenderJob): Promise<void> {
  const metaPath = path.join(job.dir, 'meta.json');
  await fs.promises.writeFile(metaPath, JSON.stringify(job), 'utf8');
}

async function loadJob(jobId: string): Promise<RenderJob | null> {
  if (!UUID_RE.test(jobId)) return null;
  const cached = jobs.get(jobId);
  if (cached) return cached;

  const dir = getJobDir(jobId);
  const metaPath = path.join(dir, 'meta.json');
  try {
    const raw = await fs.promises.readFile(metaPath, 'utf8');
    const parsed = JSON.parse(raw) as RenderJob;
    if (parsed && parsed.id === jobId && parsed.dir === dir) {
      jobs.set(jobId, parsed);
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

async function cleanupJob(jobId: string): Promise<void> {
  if (!UUID_RE.test(jobId)) return;
  const proc = activeJobProcs.get(jobId);
  if (proc && !proc.killed) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  activeJobProcs.delete(jobId);
  const job = jobs.get(jobId);
  jobs.delete(jobId);
  const dir = job?.dir ?? getJobDir(jobId);
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

async function loadStudioJob(jobId: string): Promise<StudioJob | null> {
  if (!UUID_RE.test(jobId)) return null;
  const cached = studioJobs.get(jobId);
  if (cached) return cached;
  const dir = getStudioJobDir(jobId);
  try {
    const raw = await fs.promises.readFile(path.join(dir, 'meta.json'), 'utf8');
    const parsed = JSON.parse(raw) as StudioJob;
    if (parsed && parsed.id === jobId && parsed.dir === dir) {
      studioJobs.set(jobId, parsed);
      return parsed;
    }
  } catch {
    return null;
  }
  return null;
}

async function cleanupStudioJob(jobId: string): Promise<void> {
  if (!UUID_RE.test(jobId)) return;
  const proc = activeStudioProcs.get(jobId);
  if (proc && !proc.killed) {
    try {
      proc.kill('SIGTERM');
    } catch {
      // ignore
    }
  }
  activeStudioProcs.delete(jobId);
  const job = studioJobs.get(jobId);
  studioJobs.delete(jobId);
  const dir = job?.dir ?? getStudioJobDir(jobId);
  await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) {
      void cleanupJob(id);
    }
  }
}, 60_000).unref();

function sanitizeAudioExt(rawExt: string | undefined): string {
  if (!rawExt) return '.mp3';
  const normalized = rawExt.trim().toLowerCase();
  const withDot = normalized.startsWith('.') ? normalized : `.${normalized}`;
  return ALLOWED_AUDIO_EXTS.has(withDot) ? withDot : '.mp3';
}

function sanitizeMediaExt(rawExt: string | undefined): string {
  if (!rawExt) return '.mp4';
  const normalized = rawExt.trim().toLowerCase();
  const withDot = normalized.startsWith('.') ? normalized : `.${normalized}`;
  return ALLOWED_MEDIA_EXTS.has(withDot) ? withDot : '.mp4';
}

function runProcess(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { shell: false });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdout = (stdout + chunk.toString('utf8')).slice(-12000);
    });
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-12000);
    });
    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-500)}`));
    });
  });
}

async function getAudioDurationSec(filePath: string): Promise<number> {
  try {
    const { stdout } = await runProcess('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      filePath,
    ]);
    const val = Number.parseFloat(stdout.trim());
    if (Number.isFinite(val) && val > 0.05) return Number(val.toFixed(3));
  } catch {
    // Fallback parsing via ffmpeg stderr
  }
  try {
    const proc = spawn('ffmpeg', ['-i', filePath], { shell: false });
    let stderr = '';
    await new Promise<void>((resolve) => {
      proc.stderr.on('data', (c: Buffer) => {
        stderr += c.toString('utf8');
      });
      proc.on('close', () => resolve());
      proc.on('error', () => resolve());
    });
    const m = stderr.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
    if (m) {
      return Number((Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])).toFixed(3));
    }
  } catch {
    // ignore
  }
  return 2.5;
}

function isPrivateOrBlockedIp(ip: string): boolean {
  const cleaned = ip.replace(/^::ffff:/i, '');
  const version = net.isIP(cleaned);
  if (version === 4) {
    const parts = cleaned.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const low = cleaned.toLowerCase();
    if (low === '::' || low === '::1') return true;
    if (low.startsWith('fe80:') || low.startsWith('fc') || low.startsWith('fd')) return true;
    if (low.startsWith('ff')) return true;
    return false;
  }
  return true;
}

async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('URL không hợp lệ.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Chỉ hỗ trợ giao thức http:// hoặc https://.');
  }
  const host = parsed.hostname.toLowerCase();
  if (
    !host ||
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  ) {
    throw new Error('Không cho phép truy cập địa chỉ nội bộ.');
  }
  if (net.isIP(host)) {
    if (isPrivateOrBlockedIp(host)) {
      throw new Error('Địa chỉ IP nội bộ / riêng tư bị từ chối.');
    }
    return parsed;
  }
  const records = await dns.lookup(host, { all: true }).catch(() => []);
  if (!records || records.length === 0) {
    throw new Error(`Không phân giải được tên miền: ${host}`);
  }
  for (const rec of records) {
    if (isPrivateOrBlockedIp(rec.address)) {
      throw new Error('Tên miền trỏ tới địa chỉ mạng nội bộ không hợp lệ.');
    }
  }
  return parsed;
}

async function fetchPublicUrlSafe(rawUrl: string, maxRedirects = 3): Promise<{ finalUrl: string; html: string }> {
  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const validated = await assertPublicHttpUrl(currentUrl);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(validated.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; EnglishReelsBot/1.0)',
          Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
        },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`Redirect (${res.status}) thiếu Location.`);
        currentUrl = new URL(loc, validated).toString();
        continue;
      }
      if (!res.ok) {
        throw new Error(`Không tải được trang (HTTP ${res.status}).`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 3 * 1024 * 1024) {
        return { finalUrl: validated.toString(), html: buf.subarray(0, 3 * 1024 * 1024).toString('utf8') };
      }
      return { finalUrl: validated.toString(), html: buf.toString('utf8') };
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Quá nhiều chuyển hướng URL.');
}

function splitTextForTtsChunks(text: string, maxChars = 175): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const sentences = clean.split(/(?<=[.!?。！？])\s+/);
  const chunks: string[] = [];
  let buf = '';
  for (const s of sentences) {
    if (!buf) {
      if (s.length <= maxChars) {
        buf = s;
      } else {
        for (let i = 0; i < s.length; i += maxChars) {
          chunks.push(s.slice(i, i + maxChars).trim());
        }
      }
    } else if (buf.length + 1 + s.length <= maxChars) {
      buf = `${buf} ${s}`;
    } else {
      chunks.push(buf);
      buf = s.length <= maxChars ? s : '';
      if (!buf) {
        for (let i = 0; i < s.length; i += maxChars) {
          chunks.push(s.slice(i, i + maxChars).trim());
        }
      }
    }
  }
  if (buf) chunks.push(buf);
  return chunks.filter(Boolean);
}

function sanitizeTtsSegmentText(raw: string): string {
  return String(raw || '')
    .replace(/\u200B|\uFEFF/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, ', ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s*&\s*/g, ' and ')
    .replace(/&/g, ' and ')
    .replace(/[<>]/g, ' ')
    .replace(/[`*_~#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeXmlForSsml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function pickEdgeVoiceForLang(lang: string, requestedVoice: string): string {
  if (requestedVoice && requestedVoice.includes('Neural')) {
    return requestedVoice;
  }
  const low = (lang || 'en').trim().toLowerCase();
  if (low.startsWith('vi')) return 'vi-VN-HoaiMyNeural';
  if (low.startsWith('ja')) return 'ja-JP-NanamiNeural';
  if (low.startsWith('zh')) return 'zh-CN-XiaoxiaoNeural';
  if (low.startsWith('ko')) return 'ko-KR-SunHiNeural';
  if (low.startsWith('fr')) return 'fr-FR-DeniseNeural';
  if (low.startsWith('es')) return 'es-ES-ElviraNeural';
  if (low.includes('en-gb') || low === 'uk') return 'en-GB-SoniaNeural';
  if (low.includes('en-au')) return 'en-AU-NatashaNeural';
  return 'en-US-JennyNeural';
}

async function synthesizeEdgeTtsSingleChunk(text: string, voice: string, rate = 1.0): Promise<Buffer> {
  const safeXmlText = escapeXmlForSsml(sanitizeTtsSegmentText(text));
  if (!safeXmlText) {
    throw new Error('Edge TTS: Nội dung sau khi làm sạch bị rỗng.');
  }
  const tts = new MsEdgeTTS({ connectionTimeoutMs: 9000, synthesisTimeoutMs: 20000 });
  try {
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const prosody = new ProsodyOptions();
    const pct = Math.round((Math.max(0.6, Math.min(1.6, rate)) - 1) * 100);
    prosody.rate = `${pct >= 0 ? '+' : ''}${pct}%`;
    const { audioStream } = tts.toStream(safeXmlText, prosody);
    const buf = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      audioStream.on('data', (d: Buffer) => chunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d)));
      audioStream.on('end', () => resolve(Buffer.concat(chunks)));
      audioStream.on('error', (err) => reject(err));
    });
    if (buf.length < 128) {
      throw new Error('Edge TTS không trả về dữ liệu âm thanh.');
    }
    return buf;
  } finally {
    try {
      tts.close();
    } catch {
      // ignore
    }
  }
}

async function synthesizeEdgeTtsBuffer(
  text: string,
  voice: string,
  rate = 1.0,
  tmpDir?: string,
  prefix = 'edge',
): Promise<Buffer> {
  const cleaned = sanitizeTtsSegmentText(text);
  const chunks = splitTextForTtsChunks(cleaned, 290);
  if (chunks.length === 0) {
    throw new Error('Nội dung TTS rỗng.');
  }
  if (chunks.length === 1 || !tmpDir) {
    return synthesizeEdgeTtsSingleChunk(chunks.join(' '), voice, rate);
  }
  const partFiles: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const partBuf = await synthesizeEdgeTtsSingleChunk(chunks[i], voice, rate);
    const partPath = path.join(tmpDir, `${prefix}_e_${i}.mp3`);
    await fs.promises.writeFile(partPath, partBuf);
    partFiles.push(partPath);
  }
  const concatTxt = path.join(tmpDir, `${prefix}_e_concat.txt`);
  await fs.promises.writeFile(
    concatTxt,
    partFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  );
  const merged = path.join(tmpDir, `${prefix}_e_merged.mp3`);
  await runProcess('ffmpeg', [
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatTxt,
    '-c:a',
    'libmp3lame',
    '-ar',
    '24000',
    '-ac',
    '1',
    '-b:a',
    '64k',
    merged,
  ]);
  return fs.promises.readFile(merged);
}

async function synthesizeGoogleTranslateTtsChunked(
  text: string,
  lang: string,
  tmpDir: string,
  prefix: string,
  rate = 1.0,
): Promise<Buffer> {
  const cleaned = sanitizeTtsSegmentText(text);
  const rawBase = (lang || 'en').split('-')[0].toLowerCase();
  const normalizedLang = rawBase === 'zh' ? 'zh-CN' : rawBase || 'en';
  const pieces = splitTextForTtsChunks(cleaned, 160);
  if (pieces.length === 0) {
    throw new Error('Google TTS: Nội dung rỗng.');
  }
  const partFiles: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const q = encodeURIComponent(pieces[i]);
    const speedParam = rate < 0.85 ? '&ttsspeed=0.7' : '';
    const clients = ['tw-ob', 'gtx'];
    let chunkBuf: Buffer | null = null;
    let lastStatus = 0;
    for (const client of clients) {
      const url = `https://translate.googleapis.com/translate_tts?ie=UTF-8&q=${q}&tl=${encodeURIComponent(normalizedLang)}&client=${client}${speedParam}`;
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36',
          Referer: 'https://translate.google.com/',
        },
        signal: AbortSignal.timeout(10000),
      });
      lastStatus = res.status;
      const ctype = (res.headers.get('content-type') || '').toLowerCase();
      if (res.ok && !ctype.includes('text/html')) {
        const candidate = Buffer.from(await res.arrayBuffer());
        if (candidate.length >= 160) {
          chunkBuf = candidate;
          break;
        }
      }
    }
    if (!chunkBuf) {
      throw new Error(`Google TTS HTTP ${lastStatus || 'error'}`);
    }
    const partPath = path.join(tmpDir, `${prefix}_g_${i}.mp3`);
    await fs.promises.writeFile(partPath, chunkBuf);
    partFiles.push(partPath);
  }
  if (partFiles.length === 1) {
    return fs.promises.readFile(partFiles[0]);
  }
  const concatTxt = path.join(tmpDir, `${prefix}_g_concat.txt`);
  await fs.promises.writeFile(
    concatTxt,
    partFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  );
  const mergedPath = path.join(tmpDir, `${prefix}_g_merged.mp3`);
  await runProcess('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatTxt, '-c:a', 'libmp3lame', '-ar', '24000', '-ac', '1', '-b:a', '64k', mergedPath]);
  return fs.promises.readFile(mergedPath);
}

async function synthesizeStreamElementsTts(text: string, voice: string, tmpDir: string, prefix: string): Promise<Buffer> {
  const cleaned = sanitizeTtsSegmentText(text);
  const pieces = splitTextForTtsChunks(cleaned, 200);
  if (pieces.length === 0) {
    throw new Error('StreamElements TTS: Nội dung rỗng.');
  }
  const partFiles: string[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const url = `https://api.streamelements.com/kappa/v2/speech?voice=${encodeURIComponent(voice || 'Brian')}&text=${encodeURIComponent(pieces[i])}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!res.ok || ctype.includes('text/html')) {
      throw new Error(`StreamElements TTS HTTP ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 160) {
      throw new Error('StreamElements TTS trả về buffer rỗng.');
    }
    const p = path.join(tmpDir, `${prefix}_se_${i}.mp3`);
    await fs.promises.writeFile(p, buf);
    partFiles.push(p);
  }
  if (partFiles.length === 1) {
    return fs.promises.readFile(partFiles[0]);
  }
  const concatTxt = path.join(tmpDir, `${prefix}_se_concat.txt`);
  await fs.promises.writeFile(
    concatTxt,
    partFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  );
  const merged = path.join(tmpDir, `${prefix}_se_merged.mp3`);
  await runProcess('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', concatTxt, '-c:a', 'libmp3lame', '-ar', '24000', '-ac', '1', '-b:a', '64k', merged]);
  return fs.promises.readFile(merged);
}

async function synthesizeGeminiTtsMp3(
  text: string,
  voiceName: string,
  apiKey: string,
  tmpDir: string,
  prefix: string,
): Promise<Buffer> {
  const { GoogleGenAI } = await import('@google/genai');
  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
  });
  const res = await ai.models.generateContent({
    model: 'gemini-3.8-flash-lite-tts',
    contents: text,
    config: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: voiceName || 'Kore' },
        },
      },
    },
  });
  const base64 = res.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
  if (!base64) {
    throw new Error('Gemini TTS không trả về dữ liệu âm thanh.');
  }
  const wavPath = path.join(tmpDir, `${prefix}_gem.wav`);
  const mp3Path = path.join(tmpDir, `${prefix}_gem.mp3`);
  await fs.promises.writeFile(wavPath, Buffer.from(base64, 'base64'));
  await runProcess('ffmpeg', ['-y', '-i', wavPath, '-c:a', 'libmp3lame', '-ar', '24000', '-ac', '1', '-b:a', '64k', mp3Path]);
  return fs.promises.readFile(mp3Path);
}

function cuesToSrt(cues: Array<{ start: number; end: number; text: string }>): string {
  return cues
    .map((c, idx) => {
      const s = formatTimeToken(c.start).replace('.', ',');
      const e = formatTimeToken(c.end).replace('.', ',');
      return `${idx + 1}\n${s} --> ${e}\n${c.text}\n`;
    })
    .join('\n');
}

function cuesToVtt(cues: Array<{ start: number; end: number; text: string }>): string {
  const body = cues
    .map((c) => `${formatTimeToken(c.start)} --> ${formatTimeToken(c.end)}\n${c.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

async function startServer(): Promise<void> {
  const app = express();
  const port = Number(process.env.PORT) || 3000;

  app.get('/api/health', (_req, res) => {
    const { baseDir } = resolveSafeOutputDir();
    res.json({
      ok: true,
      encoder: 'ffmpeg-h264-aac',
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasElevenLabsKey: Boolean(process.env.ELEVENLABS_API_KEY),
      hasWhisperLocal: true,
      outputDir: baseDir,
    });
  });

  // ── Direct Output Folder Save / List / Preview / Open API ─────────────────
  app.post(
    '/api/output/save',
    express.raw({ type: () => true, limit: '250mb' }),
    async (req, res) => {
      try {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: 'File MP4 rỗng.' });
          return;
        }
        const rawName =
          typeof req.headers['x-file-name'] === 'string'
            ? decodeURIComponent(req.headers['x-file-name'])
            : 'kineticsub-video';
        const stem = sanitizeOutputStem(rawName.replace(/\.mp4$/i, ''), 'kineticsub-video');
        const fileName = `${stem}.mp4`;
        const savePath =
          typeof req.headers['x-save-path'] === 'string'
            ? decodeURIComponent(req.headers['x-save-path'])
            : '';
        const { baseDir, targetDir } = resolveSafeOutputDir(savePath);
        await fs.promises.mkdir(targetDir, { recursive: true });
        const diskPath = path.join(targetDir, fileName);
        if (req.query.append === '1') {
          await fs.promises.appendFile(diskPath, body);
        } else {
          await fs.promises.writeFile(diskPath, body);
        }
        const stat = await fs.promises.stat(diskPath);
        const relPath = path.relative(baseDir, diskPath).replace(/\\/g, '/');
        res.json({
          ok: true,
          fileName,
          relativePath: relPath,
          savedPath: diskPath,
          bytes: stat.size,
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Lỗi lưu file vào output.' });
      }
    },
  );

  app.get('/api/output/files', async (req, res) => {
    try {
      const subPath = typeof req.query.path === 'string' ? req.query.path : '';
      const { baseDir, targetDir } = resolveSafeOutputDir(subPath);
      await fs.promises.mkdir(targetDir, { recursive: true });
      const items: Array<{
        name: string;
        relativePath: string;
        savedPath: string;
        bytes: number;
        updatedAt: number;
      }> = [];

      const scan = async (dir: string, depth: number) => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory() && depth < 2) {
            await scan(full, depth + 1);
          } else if (entry.isFile() && /\.(mp4|webm|srt|vtt|mp3)$/i.test(entry.name)) {
            const st = await fs.promises.stat(full).catch(() => null);
            if (st) {
              items.push({
                name: entry.name,
                relativePath: path.relative(baseDir, full).replace(/\\/g, '/'),
                savedPath: full,
                bytes: st.size,
                updatedAt: st.mtimeMs,
              });
            }
          }
        }
      };

      await scan(targetDir, 0);
      items.sort((a, b) => b.updatedAt - a.updatedAt);
      res.json({ ok: true, outputDir: targetDir, baseDir, files: items });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Không đọc được thư mục output.' });
    }
  });

  app.get('/api/output/download', async (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const resolved = resolveSafeOutputFile(rel);
    if (!resolved) {
      res.status(400).json({ error: 'Đường dẫn file không hợp lệ.' });
      return;
    }
    const stat = await fs.promises.stat(resolved.filePath).catch(() => null);
    if (!stat || !stat.isFile()) {
      res.status(404).json({ error: 'Không tìm thấy file trong thư mục output.' });
      return;
    }
    const isInline = req.query.inline === '1';
    const fileName = path.basename(resolved.filePath);
    if (!isInline) {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`);
    }
    res.sendFile(resolved.filePath);
  });

  app.delete('/api/output/file', async (req, res) => {
    const rel = typeof req.query.path === 'string' ? req.query.path : '';
    const resolved = resolveSafeOutputFile(rel);
    if (!resolved) {
      res.status(400).json({ error: 'Đường dẫn file không hợp lệ.' });
      return;
    }
    await fs.promises.unlink(resolved.filePath).catch(() => undefined);
    res.json({ ok: true });
  });

  app.post('/api/output/open', express.json({ limit: '64kb' }), async (req, res) => {
    const subPath = typeof req.body?.path === 'string' ? req.body.path : '';
    const { targetDir } = resolveSafeOutputDir(subPath);
    await fs.promises.mkdir(targetDir, { recursive: true });
    const entries = await fs.promises.readdir(targetDir).catch(() => []);
    let desktopOpened = false;
    try {
      const hasDisplay = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.platform === 'darwin' || process.platform === 'win32');
      if (hasDisplay) {
        const cmd =
          process.platform === 'win32'
            ? 'explorer'
            : process.platform === 'darwin'
              ? 'open'
              : 'xdg-open';
        const p = spawn(cmd, [targetDir], { detached: true, stdio: 'ignore' });
        p.on('error', () => undefined);
        p.unref();
        desktopOpened = true;
      }
    } catch {
      desktopOpened = false;
    }
    res.json({
      ok: true,
      outputDir: targetDir,
      filesCount: entries.filter((n) => !n.startsWith('.')).length,
      desktopOpened,
    });
  });

  // ── Custom Vector Component Database Persistence ────────────────────────────
  app.get('/api/components', async (_req, res) => {
    try {
      const raw = await fs.promises.readFile(COMPONENTS_DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      res.json({
        ok: true,
        components: Array.isArray(parsed?.components) ? parsed.components : [],
        deletedBuiltIns: Array.isArray(parsed?.deletedBuiltIns)
          ? parsed.deletedBuiltIns
          : Array.isArray(parsed?.deletedVariants)
            ? parsed.deletedVariants
            : [],
      });
    } catch {
      res.json({ ok: true, components: [], deletedBuiltIns: [] });
    }
  });

  app.put('/api/components', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const resolvedTarget = path.resolve(COMPONENTS_DATA_FILE);
      if (!resolvedTarget.startsWith(COMPONENTS_DATA_DIR + path.sep)) {
        res.status(400).json({ error: 'Invalid storage path.' });
        return;
      }
      const components = Array.isArray(req.body?.components) ? req.body.components : [];
      const deletedBuiltIns = Array.isArray(req.body?.deletedBuiltIns)
        ? req.body.deletedBuiltIns
        : Array.isArray(req.body?.deletedVariants)
          ? req.body.deletedVariants
          : [];
      await fs.promises.mkdir(COMPONENTS_DATA_DIR, { recursive: true });
      await fs.promises.writeFile(
        resolvedTarget,
        JSON.stringify({ version: 1, components, deletedBuiltIns }, null, 2),
        'utf8',
      );
      res.json({ ok: true, count: components.length });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Lỗi lưu kho component.' });
    }
  });

  // ── URL Content Scraper (English Reels Studio Port) ─────────────────────────
  app.post('/api/scraper/extract', express.json({ limit: '256kb' }), async (req, res) => {
    try {
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
      if (!rawUrl) {
        res.status(400).json({ error: 'Vui lòng nhập URL bài học tiếng Anh.' });
        return;
      }

      const { finalUrl, html } = await fetchPublicUrlSafe(rawUrl);
      const $ = loadHtml(html);

      const pageTitle =
        $('meta[property="og:title"]').attr('content')?.trim() ||
        $('h1').first().text().trim() ||
        $('title').first().text().trim() ||
        'Bài học tiếng Anh';

      // Collect candidate sub-lesson links before stripping navs in main container
      const base = new URL(finalUrl);
      const linkMap = new Map<string, string>();
      $('main a[href], article a[href], .content a[href], #content a[href], body a[href]').each((_i, el) => {
        const href = $(el).attr('href')?.trim();
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (!href || text.length < 6 || text.length > 110) return;
        if (/^(#|javascript:|mailto:|tel:)/i.test(href)) return;
        try {
          const abs = new URL(href, base);
          if (abs.origin !== base.origin || abs.pathname === base.pathname) return;
          if (/\/(login|signup|register|contact|about|privacy|terms|tag|author|search)\b/i.test(abs.pathname)) return;
          if (!linkMap.has(abs.toString())) {
            linkMap.set(abs.toString(), text);
          }
        } catch {
          // ignore malformed href
        }
      });

      // Strip navigation, ads, comments, scripts, boilerplate
      $(
        'script, style, noscript, iframe, svg, nav, header, footer, aside, form, button, .nav, .navbar, .menu, .sidebar, .ads, .advertisement, .cookie-banner, .breadcrumb, .share-buttons, .comments, #comments',
      ).remove();

      const mainRoot = $('article').first().length
        ? $('article').first()
        : $('main').first().length
          ? $('main').first()
          : $('#content').first().length
            ? $('#content').first()
            : $('body');

      const blocks: string[] = [];
      mainRoot.find('h1, h2, h3, h4, p, li, blockquote').each((_i, el) => {
        const txt = $(el).text().replace(/\s+/g, ' ').trim();
        if (txt.length >= 4 && !/^(cookie|privacy|subscribe|advertisement|menu)$/i.test(txt)) {
          const tag = el.tagName.toLowerCase();
          blocks.push(tag.startsWith('h') ? `## ${txt}` : txt);
        }
      });

      const rawText = (blocks.length > 0 ? blocks.join('\n') : mainRoot.text().replace(/\s+\n/g, '\n'))
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, 18000);

      const links = Array.from(linkMap.entries())
        .slice(0, 24)
        .map(([url, title]) => ({ url, title }));
      const exercises = splitMultipleExercisesFromText(rawText);
      const isDirectoryPage = links.length >= 6 && rawText.length < 1800;

      res.json({
        ok: true,
        url: finalUrl,
        title: pageTitle,
        isDirectoryPage,
        links,
        rawText,
        detectedMode: detectReelMode(rawText),
        exercises,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Không thể đọc nội dung từ URL.';
      const status = /nội bộ|không hợp lệ|giao thức|từ chối/i.test(msg) ? 400 : 500;
      res.status(status).json({ error: msg });
    }
  });

  // ── Free & Key-based Multi-Provider TTS Catalog & Synthesizer ───────────────
  app.get('/api/tts/voices', async (_req, res) => {
    const elevenLabsKey = process.env.ELEVENLABS_API_KEY || '';
    let elevenLabsVoices = ELEVENLABS_DEFAULT_VOICES;
    if (elevenLabsKey) {
      try {
        const elRes = await fetch('https://api.elevenlabs.io/v1/voices', {
          headers: { 'xi-api-key': elevenLabsKey },
          signal: AbortSignal.timeout(4500),
        });
        if (elRes.ok) {
          const elJson = (await elRes.json()) as {
            voices?: Array<{ voice_id?: string; name?: string; labels?: Record<string, string> }>;
          };
          if (Array.isArray(elJson.voices) && elJson.voices.length > 0) {
            elevenLabsVoices = elJson.voices.slice(0, 20).map((v) => ({
              id: String(v.voice_id || ''),
              label: `${v.name || 'Voice'}${v.labels?.accent ? ` (${v.labels.accent})` : ''}`,
              lang: 'multi',
            }));
          }
        }
      } catch {
        // Keep curated defaults on network timeout
      }
    }

    res.json({
      ok: true,
      hasGeminiKey: Boolean(process.env.GEMINI_API_KEY),
      hasElevenLabsKey: Boolean(elevenLabsKey),
      hasWhisperLocal: true,
      providers: [
        {
          id: 'edge',
          name: 'Microsoft Edge Neural TTS (Miễn phí · Chất lượng cao)',
          voices: [
            { id: 'en-US-JennyNeural', label: 'Jenny (US Female · Tự nhiên)', lang: 'en-US' },
            { id: 'en-US-GuyNeural', label: 'Guy (US Male · Rõ ràng)', lang: 'en-US' },
            { id: 'en-US-AriaNeural', label: 'Aria (US Female · Biểu cảm)', lang: 'en-US' },
            { id: 'en-GB-SoniaNeural', label: 'Sonia (UK Female · Chuẩn Anh)', lang: 'en-GB' },
            { id: 'en-AU-NatashaNeural', label: 'Natasha (AU Female)', lang: 'en-AU' },
            { id: 'vi-VN-HoaiMyNeural', label: 'Hoài My (Tiếng Việt Nữ)', lang: 'vi-VN' },
            { id: 'vi-VN-NamMinhNeural', label: 'Nam Minh (Tiếng Việt Nam)', lang: 'vi-VN' },
            { id: 'ja-JP-NanamiNeural', label: 'Nanami (日本語 Nữ)', lang: 'ja-JP' },
            { id: 'zh-CN-XiaoxiaoNeural', label: 'Xiaoxiao (中文 Nữ)', lang: 'zh-CN' },
            { id: 'ko-KR-SunHiNeural', label: 'SunHi (한국어 Nữ)', lang: 'ko-KR' },
            { id: 'fr-FR-DeniseNeural', label: 'Denise (Français Nữ)', lang: 'fr-FR' },
            { id: 'es-ES-ElviraNeural', label: 'Elvira (Español Nữ)', lang: 'es-ES' },
          ],
        },
        {
          id: 'elevenlabs',
          name: elevenLabsKey
            ? 'ElevenLabs AI Voice (Đã kết nối ELEVENLABS_API_KEY)'
            : 'ElevenLabs AI Voice (Cần ELEVENLABS_API_KEY trong Secrets / .env)',
          voices: elevenLabsVoices,
        },
        {
          id: 'google',
          name: 'Google Translate TTS (Miễn phí · Đa ngôn ngữ)',
          voices: [
            { id: 'en', label: 'English (Google)', lang: 'en' },
            { id: 'vi', label: 'Tiếng Việt (Google)', lang: 'vi' },
            { id: 'ja', label: '日本語 (Google)', lang: 'ja' },
            { id: 'zh-CN', label: '中文 (Google)', lang: 'zh-CN' },
            { id: 'ko', label: '한국어 (Google)', lang: 'ko' },
            { id: 'fr', label: 'Français (Google)', lang: 'fr' },
            { id: 'es', label: 'Español (Google)', lang: 'es' },
          ],
        },
        {
          id: 'streamelements',
          name: 'StreamElements Polly Voices (Miễn phí)',
          voices: [
            { id: 'Joanna', label: 'Joanna (US Female)', lang: 'en-US' },
            { id: 'Matthew', label: 'Matthew (US Male)', lang: 'en-US' },
            { id: 'Amy', label: 'Amy (UK Female)', lang: 'en-GB' },
            { id: 'Brian', label: 'Brian (UK Male)', lang: 'en-GB' },
            { id: 'Mizuki', label: 'Mizuki (日本語)', lang: 'ja-JP' },
            { id: 'Takumi', label: 'Takumi (日本語)', lang: 'ja-JP' },
          ],
        },
        {
          id: 'gemini',
          name: process.env.GEMINI_API_KEY
            ? 'Gemini 3.8 Flash Lite TTS (Đã kết nối GEMINI_API_KEY)'
            : 'Gemini 3.8 Flash Lite TTS (Cần GEMINI_API_KEY trong Secrets / .env)',
          voices: [
            { id: 'Kore', label: 'Kore (Tự nhiên · Rõ nét)', lang: 'multi' },
            { id: 'Puck', label: 'Puck (Năng động)', lang: 'multi' },
            { id: 'Aoede', label: 'Aoede (Nhẹ nhàng)', lang: 'multi' },
            { id: 'Charon', label: 'Charon (Trầm ấm)', lang: 'multi' },
          ],
        },
      ],
    });
  });

  app.post('/api/tts/synthesize', express.json({ limit: '1mb' }), async (req, res) => {
    const tmpDir = path.join(os.tmpdir(), `ks-tts-${crypto.randomUUID()}`);
    await fs.promises.mkdir(tmpDir, { recursive: true });
    try {
      const providerReq = typeof req.body?.provider === 'string' ? req.body.provider : 'auto';
      const voice = typeof req.body?.voice === 'string' ? req.body.voice : 'en-US-JennyNeural';
      const lang = typeof req.body?.lang === 'string' ? req.body.lang : 'en';
      const rate = Number(req.body?.rate ?? 1.0);
      const rawSegments = Array.isArray(req.body?.segments)
        ? req.body.segments
        : typeof req.body?.text === 'string' && req.body.text.trim()
          ? req.body.text
              .split(/\r?\n+/)
              .map((t: string, i: number) => ({ id: `seg-${i + 1}`, text: t.trim() }))
              .filter((s: { text: string }) => s.text.length > 0)
          : [];

      if (rawSegments.length === 0) {
        res.status(400).json({ error: 'Vui lòng nhập nội dung văn bản để tạo giọng đọc.' });
        return;
      }

      const geminiKey = process.env.GEMINI_API_KEY || '';
      const elevenLabsKey = process.env.ELEVENLABS_API_KEY || '';
      if (providerReq === 'elevenlabs' && !elevenLabsKey) {
        res.status(400).json({
          error: 'Chưa cấu hình ELEVENLABS_API_KEY trên server (vào Settings > Secrets hoặc file .env để thêm key).',
        });
        return;
      }
      if (providerReq === 'gemini' && !geminiKey) {
        res.status(400).json({
          error: 'Chưa cấu hình GEMINI_API_KEY trên server (vào Settings > Secrets hoặc file .env để thêm key).',
        });
        return;
      }

      const segFiles: string[] = [];
      const segDurations: number[] = [];
      const spokenDurations: number[] = [];
      const pauseDurations: number[] = [];
      const cues: Array<{
        id: string;
        start: number;
        end: number;
        text: string;
        words: ReturnType<typeof interpolateWordTimings>;
      }> = [];
      let providerUsed = providerReq;
      let cursor = 0;

      for (let i = 0; i < rawSegments.length; i++) {
        const segText = sanitizeTtsSegmentText(String(rawSegments[i]?.text || ''));
        const pauseAfterSec = Math.max(0, Math.min(12, Number(rawSegments[i]?.pauseAfterSec || 0)));
        if (!segText) continue;

        let buf: Buffer | null = null;
        const attemptOrder = Array.from(
          new Set(
            providerReq === 'auto'
              ? ['edge', 'google', 'streamelements', ...(elevenLabsKey ? ['elevenlabs'] : []), ...(geminiKey ? ['gemini'] : [])]
              : [providerReq, 'edge', 'google', 'streamelements'],
          ),
        );

        const attemptErrors: string[] = [];
        for (const p of attemptOrder) {
          try {
            if (p === 'elevenlabs') {
              if (!elevenLabsKey) continue;
              buf = await synthesizeElevenLabsTtsBuffer(segText, voice, elevenLabsKey);
              providerUsed = 'elevenlabs';
              break;
            } else if (p === 'edge') {
              const edgeVoice = pickEdgeVoiceForLang(lang, voice);
              buf = await synthesizeEdgeTtsBuffer(segText, edgeVoice, rate, tmpDir, `s${i}`);
              providerUsed = 'edge';
              break;
            } else if (p === 'google') {
              buf = await synthesizeGoogleTranslateTtsChunked(segText, lang || voice, tmpDir, `s${i}`, rate);
              providerUsed = 'google';
              break;
            } else if (p === 'streamelements') {
              const seVoice = ['Joanna', 'Matthew', 'Amy', 'Brian', 'Mizuki', 'Takumi'].includes(voice)
                ? voice
                : 'Joanna';
              buf = await synthesizeStreamElementsTts(segText, seVoice, tmpDir, `s${i}`);
              providerUsed = 'streamelements';
              break;
            } else if (p === 'gemini' && geminiKey) {
              buf = await synthesizeGeminiTtsMp3(segText, voice, geminiKey, tmpDir, `s${i}`);
              providerUsed = 'gemini';
              break;
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            attemptErrors.push(`${p}: ${msg}`);
          }
        }

        if (!buf || buf.length === 0) {
          throw new Error(
            attemptErrors.length > 0
              ? `Không thể tạo giọng đọc (${attemptErrors.join(' | ')})`
              : 'Không thể tạo giọng đọc từ các API TTS.',
          );
        }

        const rawPath = path.join(tmpDir, `seg_raw_${i}.mp3`);
        const normPath = path.join(tmpDir, `seg_norm_${i}.mp3`);
        await fs.promises.writeFile(rawPath, buf);
        await runProcess('ffmpeg', [
          '-y',
          '-i',
          rawPath,
          '-c:a',
          'libmp3lame',
          '-ar',
          '24000',
          '-ac',
          '1',
          '-b:a',
          '64k',
          normPath,
        ]);

        const spokenDur = await getAudioDurationSec(normPath);
        segFiles.push(normPath);

        let actualPauseDur = 0;
        if (pauseAfterSec > 0.15) {
          const pausePath = path.join(tmpDir, `seg_pause_${i}.mp3`);
          await runProcess('ffmpeg', [
            '-y',
            '-f',
            'lavfi',
            '-i',
            'anullsrc=r=24000:cl=mono',
            '-t',
            String(Number(pauseAfterSec.toFixed(2))),
            '-c:a',
            'libmp3lame',
            '-ar',
            '24000',
            '-ac',
            '1',
            '-b:a',
            '64k',
            pausePath,
          ]);
          actualPauseDur = await getAudioDurationSec(pausePath);
          segFiles.push(pausePath);
        }

        const totalSegDur = Number((spokenDur + actualPauseDur).toFixed(3));
        segDurations.push(totalSegDur);
        spokenDurations.push(spokenDur);
        pauseDurations.push(actualPauseDur);

        const start = Number(cursor.toFixed(3));
        const spokenEnd = Number((cursor + spokenDur).toFixed(3));
        cues.push({
          id: String(rawSegments[i]?.id || `tts-cue-${i + 1}`),
          start,
          end: spokenEnd,
          text: segText,
          words: interpolateWordTimings(segText, start, spokenEnd),
        });
        cursor = Number((cursor + totalSegDur).toFixed(3));
      }

      if (segFiles.length === 0) {
        throw new Error('Các đoạn văn bản sau khi lọc ký tự đặc biệt đều bị rỗng.');
      }

      const finalAudioPath = path.join(tmpDir, 'combined.mp3');
      if (segFiles.length === 1) {
        await fs.promises.copyFile(segFiles[0], finalAudioPath);
      } else {
        const listPath = path.join(tmpDir, 'concat.txt');
        await fs.promises.writeFile(
          listPath,
          segFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'),
          'utf8',
        );
        await runProcess('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', finalAudioPath]);
      }

      const finalBuf = await fs.promises.readFile(finalAudioPath);
      const totalDur = Number(cursor.toFixed(3));

      res.json({
        ok: true,
        providerUsed,
        mimeType: 'audio/mpeg',
        audioBase64: finalBuf.toString('base64'),
        durationSec: totalDur,
        segmentDurations: segDurations,
        spokenDurations,
        pauseDurations,
        cues,
        srt: cuesToSrt(cues),
        vtt: cuesToVtt(cues),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Lỗi tạo Audio TTS.' });
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // ── Multi-Language Subtitle Extractor (Whisper Local + Gemini Fallback) ──
  app.post(
    '/api/subtitles/transcribe',
    express.raw({ type: () => true, limit: '50mb' }),
    async (req, res) => {
      const tmpDir = path.join(os.tmpdir(), `ks-sub-${crypto.randomUUID()}`);
      await fs.promises.mkdir(tmpDir, { recursive: true });
      try {
        const body = req.body;
        if (!Buffer.isBuffer(body) || body.length === 0) {
          res.status(400).json({ error: 'Vui lòng tải lên file video hoặc audio.' });
          return;
        }

        const ext = sanitizeMediaExt(
          typeof req.headers['x-file-ext'] === 'string' ? req.headers['x-file-ext'] : '.mp4',
        );
        const sourceLang =
          typeof req.headers['x-source-lang'] === 'string' ? req.headers['x-source-lang'].trim() : 'auto';
        const translateLang =
          typeof req.headers['x-translate-lang'] === 'string' ? req.headers['x-translate-lang'].trim() : 'none';
        const engineReq =
          typeof req.headers['x-engine'] === 'string' ? req.headers['x-engine'].trim().toLowerCase() : 'faster-whisper';
        const whisperModel =
          typeof req.headers['x-whisper-model'] === 'string' && req.headers['x-whisper-model'].trim()
            ? req.headers['x-whisper-model'].trim()
            : 'large-v3-turbo';

        const inputPath = path.join(tmpDir, `input${ext}`);
        const wavPath = path.join(tmpDir, 'extracted_16k.wav');
        const mp3Path = path.join(tmpDir, 'extracted.mp3');
        await fs.promises.writeFile(inputPath, body);

        await runProcess('ffmpeg', [
          '-y',
          '-i',
          inputPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          wavPath,
        ]);
        await runProcess('ffmpeg', [
          '-y',
          '-i',
          wavPath,
          '-c:a',
          'libmp3lame',
          '-b:a',
          '48k',
          mp3Path,
        ]);

        const mp3Buf = await fs.promises.readFile(mp3Path);
        const totalDur = await getAudioDurationSec(wavPath);
        const apiKey = process.env.GEMINI_API_KEY || '';

        let rawSegs: Array<{ start: number; end: number; text: string; translation?: string }> = [];
        let detectedLang = sourceLang;
        let engineUsed = 'faster-whisper (Built-in)';
        let whisperWords: Array<{ word: string; start: number; end: number }> = [];

        const tryGeminiTranscribe = async () => {
          if (!apiKey) {
            throw new Error('Chưa cấu hình GEMINI_API_KEY trong Settings > Secrets hoặc .env.');
          }
          const langHint =
            sourceLang && sourceLang !== 'auto'
              ? `The spoken language is ${sourceLang}.`
              : 'Auto-detect the spoken language accurately (English, Vietnamese, Japanese, Chinese, Korean, French, Spanish, etc.).';
          const translateHint =
            translateLang && translateLang !== 'none'
              ? `Also provide a natural translation into ${translateLang} in the "translation" field of each segment.`
              : 'Leave "translation" empty.';
          const prompt = [
            'Transcribe the audio into timestamped subtitle segments suitable for short-form 9:16 videos (1–2 short clauses per segment).',
            langHint,
            translateHint,
            'Return ONLY valid JSON with shape: { "language": "detected code", "segments": [{ "start": 0.0, "end": 2.5, "text": "...", "translation": "..." }] }.',
            `Audio total duration is approximately ${totalDur.toFixed(2)} seconds. Ensure start < end and timestamps never exceed ${totalDur.toFixed(2)}.`,
          ].join(' ');

          const { GoogleGenAI } = await import('@google/genai');
          const ai = new GoogleGenAI({
            apiKey,
            httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
          });
          // Use supported Gemini audio-capable models without triggering broken v1 404s
          const modelCandidates = ['gemini-4-hydrogen', 'gemini-3.1-flash-lite'];
          let aiRes: any = null;
          let lastErr: unknown = null;
          for (const modelName of modelCandidates) {
            try {
              aiRes = await ai.models.generateContent({
                model: modelName,
                contents: [
                  { inlineData: { mimeType: 'audio/mp3', data: mp3Buf.toString('base64') } },
                  { text: prompt },
                ],
                config: { responseMimeType: 'application/json' },
              });
              engineUsed = `gemini (${modelName})`;
              break;
            } catch (err) {
              lastErr = err;
            }
          }
          if (!aiRes) throw lastErr instanceof Error ? lastErr : new Error('Gemini API không phản hồi.');
          const rawJsonText = (aiRes.text || '').trim();
          let parsed: { language?: string; segments?: Array<{ start?: number; end?: number; text?: string; translation?: string }> } = {};
          try {
            parsed = JSON.parse(rawJsonText);
          } catch {
            const m = rawJsonText.match(/\{[\s\S]*\}/);
            if (m) parsed = JSON.parse(m[0]);
          }
          detectedLang = parsed.language || sourceLang;
          rawSegs = (Array.isArray(parsed.segments) ? parsed.segments : []).map((s) => ({
            start: Number(s.start ?? 0),
            end: Number(s.end ?? 0),
            text: String(s.text || '').trim(),
            translation: String(s.translation || '').trim(),
          }));
        };

        if (engineReq === 'gemini') {
          try {
            await tryGeminiTranscribe();
          } catch (gemErr) {
            // Auto-rescue with Built-in Local Whisper if Gemini fails (404 / no key)
            const wRes = await runLocalWhisperOnWav(wavPath, {
              sourceLang,
              modelId: whisperModel,
              wordLevel: true,
              preferFasterWhisper: true,
            });
            rawSegs = wRes.segments;
            whisperWords = wRes.words.map((w) => ({ word: w.text, start: w.start, end: w.end }));
            engineUsed = `${wRes.backendUsed || 'faster-whisper (Built-in)'} · ${wRes.modelUsed || whisperModel}`;
            if (rawSegs.length === 0) throw gemErr;
          }
        } else {
          // Default 'faster-whisper' or 'auto' or 'whisper-local': Run Local Whisper (0 API key required)
          const wRes = await runLocalWhisperOnWav(wavPath, {
            sourceLang,
            modelId: whisperModel,
            wordLevel: true,
            preferFasterWhisper: engineReq !== 'whisper-onnx',
          });
          rawSegs = wRes.segments;
          whisperWords = wRes.words.map((w) => ({ word: w.text, start: w.start, end: w.end }));
          engineUsed = `${wRes.backendUsed || 'faster-whisper (Built-in)'} · ${wRes.modelUsed || whisperModel}`;

          // Optional bilingual translation using Gemini if requested & key present
          if (rawSegs.length > 0 && translateLang && translateLang !== 'none' && apiKey) {
            try {
              const { GoogleGenAI } = await import('@google/genai');
              const ai = new GoogleGenAI({
                apiKey,
                httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
              });
              const trRes = await ai.models.generateContent({
                model: 'gemini-3.1-flash-lite',
                contents: `Translate each line into ${translateLang}. Return JSON { "translations": string[] } matching exact array length (${rawSegs.length}):\n${JSON.stringify(rawSegs.map((s) => s.text))}`,
                config: { responseMimeType: 'application/json' },
              });
              const trParsed = JSON.parse(trRes.text || '{}') as { translations?: string[] };
              if (Array.isArray(trParsed.translations)) {
                rawSegs = rawSegs.map((s, idx) => ({
                  ...s,
                  translation: String(trParsed.translations?.[idx] || '').trim(),
                }));
              }
            } catch {
              // Keep original language cleanly if translation fails
            }
          }
        }

        if (rawSegs.length === 0) {
          throw new Error('Không nhận diện được lời thoại trong file này (có thể file không có giọng nói).');
        }

        const cues = rawSegs
          .map((s, idx) => {
            const st = Math.max(0, Number(s.start ?? 0));
            const en = Math.max(st + 0.3, Number(s.end ?? st + 2.0));
            const mainText = String(s.text || '').trim();
            const trans = String(s.translation || '').trim();
            const fullText = trans && translateLang !== 'none' ? `${mainText}\n${trans}` : mainText;
            const segWords = whisperWords.filter((w) => w.start >= st - 0.05 && w.end <= en + 0.08);
            return {
              id: `sub-cue-${idx + 1}`,
              start: Number(st.toFixed(3)),
              end: Number(en.toFixed(3)),
              text: fullText,
              words:
                segWords.length >= 2
                  ? segWords
                  : interpolateWordTimings(mainText || fullText, st, en),
            };
          })
          .filter((c) => c.text.length > 0);

        res.json({
          ok: true,
          engineUsed,
          language: detectedLang,
          durationSec: totalDur,
          cues,
          srt: cuesToSrt(cues),
          vtt: cuesToVtt(cues),
          audioBase64: mp3Buf.length <= 12 * 1024 * 1024 ? mp3Buf.toString('base64') : undefined,
          audioMimeType: 'audio/mpeg',
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Lỗi bóc tách phụ đề.' });
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  );

  // ── Whisper Local Word-Level Alignment (for Reading Along Studio 1.19) ───
  app.post(
    '/api/subtitles/align',
    express.raw({ type: () => true, limit: '50mb' }),
    async (req, res) => {
      const tmpDir = path.join(os.tmpdir(), `ks-align-${crypto.randomUUID()}`);
      await fs.promises.mkdir(tmpDir, { recursive: true });
      try {
        const isJson =
          typeof req.headers['content-type'] === 'string' &&
          req.headers['content-type'].includes('application/json');
        let audioBuf: Buffer | null = Buffer.isBuffer(req.body) ? req.body : null;
        let ext = '.mp3';
        let sourceLang = 'auto';
        let whisperModel = 'large-v3-turbo';

        if (isJson && audioBuf) {
          const parsed = JSON.parse(audioBuf.toString('utf8')) as {
            audioBase64?: string;
            ext?: string;
            lang?: string;
            model?: string;
          };
          audioBuf = parsed.audioBase64 ? Buffer.from(parsed.audioBase64, 'base64') : null;
          ext = sanitizeAudioExt(parsed.ext || '.mp3');
          sourceLang = parsed.lang?.trim() || 'auto';
          whisperModel = parsed.model?.trim() || 'large-v3-turbo';
        } else {
          ext = sanitizeAudioExt(
            typeof req.headers['x-file-ext'] === 'string' ? req.headers['x-file-ext'] : '.mp3',
          );
          sourceLang =
            typeof req.headers['x-source-lang'] === 'string' ? req.headers['x-source-lang'].trim() : 'auto';
          whisperModel =
            typeof req.headers['x-whisper-model'] === 'string' && req.headers['x-whisper-model'].trim()
              ? req.headers['x-whisper-model'].trim()
              : 'large-v3-turbo';
        }

        if (!audioBuf || audioBuf.length === 0) {
          res.status(400).json({ error: 'Thiếu file audio để căn chỉnh word-level.' });
          return;
        }

        const inPath = path.join(tmpDir, `audio${ext}`);
        const wavPath = path.join(tmpDir, 'align_16k.wav');
        await fs.promises.writeFile(inPath, audioBuf);
        await runProcess('ffmpeg', [
          '-y',
          '-i',
          inPath,
          '-vn',
          '-ac',
          '1',
          '-ar',
          '16000',
          '-c:a',
          'pcm_s16le',
          wavPath,
        ]);
        const durationSec = await getAudioDurationSec(wavPath);
        const aligned = await runLocalWhisperOnWav(wavPath, {
          sourceLang,
          modelId: whisperModel,
          wordLevel: true,
          preferFasterWhisper: true,
        });
        const cues = aligned.segments.map((seg, idx) => ({
          id: `align-cue-${idx + 1}`,
          start: seg.start,
          end: seg.end,
          text: seg.text,
          words: aligned.words.filter((w) => w.start >= seg.start - 0.06 && w.end <= seg.end + 0.08),
        }));
        res.json({
          ok: true,
          modelUsed: aligned.modelUsed || whisperModel,
          backendUsed: aligned.backendUsed || 'faster-whisper-built-in',
          durationSec,
          text: aligned.text,
          segments: aligned.segments,
          words: aligned.words,
          cues,
          srt: cuesToSrt(cues),
        });
      } catch (err) {
        res.status(500).json({ error: err instanceof Error ? err.message : 'Lỗi căn chỉnh Whisper Local.' });
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  );

  app.post('/api/ai/generate-scene', express.json({ limit: '2mb' }), async (req, res) => {
    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        res.status(400).json({ error: 'Chưa cấu hình GEMINI_API_KEY trong biến môi trường server.' });
        return;
      }
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
      if (!prompt.trim()) {
        res.status(400).json({ error: 'Thiếu prompt đầu vào.' });
        return;
      }
      const model =
        typeof req.body?.model === 'string' && req.body.model.trim()
          ? req.body.model.trim()
          : 'gemini-4-hydrogen';
      const { GoogleGenAI } = await import('@google/genai');
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });
      const isGemini4 = model.startsWith('gemini-4-');
      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          ...(isGemini4 ? {} : { temperature: 0.35 }),
        },
      });
      res.json({ ok: true, jsonText: response.text || '', text: response.text || '' });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Lỗi gọi Gemini API',
      });
    }
  });

  app.post('/api/render/start', express.json({ limit: '1mb' }), async (req, res) => {
    try {
      const requestedFps = Number(req.body?.fps ?? 30);
      const fps = Number.isFinite(requestedFps)
        ? Math.max(1, Math.min(60, Math.round(requestedFps)))
        : 30;
      const requestedCrf = Number(req.body?.crf ?? 22);
      const crf = Number.isFinite(requestedCrf)
        ? Math.max(16, Math.min(32, Math.round(requestedCrf)))
        : 22;
      const jobId = crypto.randomUUID();
      const dir = getJobDir(jobId);
      await fs.promises.mkdir(dir, { recursive: true });
      const framesPath = path.join(dir, 'frames.mjpeg');

      const job: RenderJob = {
        id: jobId,
        dir,
        fps,
        crf,
        framesPath,
        audioPath: null,
        createdAt: Date.now(),
        chunkCount: 0,
      };
      jobs.set(jobId, job);
      await saveJobMeta(job);

      res.json({ jobId, fps, crf });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create render job',
      });
    }
  });

  app.post(
    '/api/render/:jobId/audio',
    express.raw({ type: () => true, limit: '20mb' }),
    async (req, res) => {
      const job = await loadJob(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'Render job not found' });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'Empty audio payload' });
        return;
      }
      const extHeader =
        typeof req.headers['x-audio-ext'] === 'string' ? req.headers['x-audio-ext'] : '';
      const safeExt = sanitizeAudioExt(extHeader);
      const audioPath = path.join(job.dir, `audio${safeExt}`);
      const isAppend = req.query.append === '1';

      if (isAppend) {
        await fs.promises.appendFile(audioPath, body);
      } else {
        await fs.promises.writeFile(audioPath, body);
      }
      if (job.audioPath !== audioPath) {
        job.audioPath = audioPath;
      }
      job.createdAt = Date.now();
      await saveJobMeta(job);
      res.json({ ok: true, bytes: body.length });
    },
  );

  app.post(
    '/api/render/:jobId/frames',
    express.raw({ type: () => true, limit: '20mb' }),
    async (req, res) => {
      const job = await loadJob(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'Render job not found (job đã hết hạn hoặc bị hủy)' });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'Empty frames chunk' });
        return;
      }
      await fs.promises.appendFile(job.framesPath, body);
      job.chunkCount += 1;
      job.createdAt = Date.now();
      if (job.chunkCount % 10 === 0) {
        await saveJobMeta(job).catch(() => undefined);
      }
      res.json({ ok: true, chunkCount: job.chunkCount, bytes: body.length });
    },
  );

  app.post('/api/render/:jobId/finish', express.json({ limit: '256kb' }), async (req, res) => {
    const job = await loadJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Render job not found' });
      return;
    }

    try {
      const stat = await fs.promises.stat(job.framesPath).catch(() => null);
      if (!stat || stat.size === 0) {
        await cleanupJob(job.id);
        res.status(400).json({ error: 'No video frames uploaded' });
        return;
      }

      const outputPath = path.join(job.dir, 'output.mp4');
      const ffmpegArgs = buildFfmpegArgs({
        fps: job.fps,
        framesPath: job.framesPath,
        outputPath,
        audioPath: job.audioPath,
        crf: job.crf,
      });

      await new Promise<void>((resolve, reject) => {
        const proc = spawn('ffmpeg', ffmpegArgs, { shell: false });
        activeJobProcs.set(job.id, proc);
        let stderr = '';
        proc.stderr.on('data', (chunk: Buffer) => {
          stderr = (stderr + chunk.toString('utf8')).slice(-8000);
        });
        proc.on('error', (err) => {
          activeJobProcs.delete(job.id);
          reject(err);
        });
        proc.on('close', (code) => {
          activeJobProcs.delete(job.id);
          if (code === 0) {
            resolve();
          } else {
            reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-500)}`));
          }
        });
      });

      const outStat = await fs.promises.stat(outputPath);
      const rawName = typeof req.body?.fileName === 'string' ? req.body.fileName : 'kineticsub-video';
      const safeBaseName = sanitizeOutputStem(rawName, 'kineticsub-video');

      if (req.body?.saveToDisk === true) {
        const rawSavePath = typeof req.body?.savePath === 'string' ? req.body.savePath.trim() : '';
        const { baseDir, targetDir } = resolveSafeOutputDir(rawSavePath);
        await fs.promises.mkdir(targetDir, { recursive: true });
        const diskPath = path.join(targetDir, `${safeBaseName}.mp4`);
        await fs.promises.copyFile(outputPath, diskPath);
        await cleanupJob(job.id);
        res.json({
          ok: true,
          savedPath: diskPath,
          relativePath: path.relative(baseDir, diskPath).replace(/\\/g, '/'),
          bytes: outStat.size,
        });
        return;
      }

      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', String(outStat.size));
      const asciiFallback = safeBaseName.replace(/[^a-zA-Z0-9_-]/g, '_') || 'kineticsub-video';
      res.setHeader(
        'Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(safeBaseName)}.mp4; filename="${asciiFallback}.mp4"`,
      );

      const stream = fs.createReadStream(outputPath);
      const onDone = () => {
        void cleanupJob(job.id);
      };
      res.on('close', onDone);
      stream.on('error', () => {
        void cleanupJob(job.id);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream rendered MP4' });
        }
      });
      stream.pipe(res);
    } catch (err) {
      await cleanupJob(job.id);
      if (!res.headersSent) {
        res.status(500).json({
          error: err instanceof Error ? err.message : 'MP4 encoding failed',
        });
      }
    }
  });

  app.delete('/api/render/:jobId', async (req, res) => {
    await cleanupJob(req.params.jobId);
    res.json({ ok: true });
  });

  // ── Educational Video Studio 1.19 Server FFmpeg Merge & Karaoke-Mix Routes ─
  app.post('/api/studio/job/start', express.json({ limit: '64kb' }), async (_req, res) => {
    try {
      const jobId = crypto.randomUUID();
      const dir = getStudioJobDir(jobId);
      await fs.promises.mkdir(dir, { recursive: true });
      const job: StudioJob = { id: jobId, dir, createdAt: Date.now(), files: {} };
      studioJobs.set(jobId, job);
      await fs.promises.writeFile(path.join(dir, 'meta.json'), JSON.stringify(job), 'utf8');
      res.json({ ok: true, jobId });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Không tạo được Studio job.' });
    }
  });

  app.post(
    '/api/studio/job/:jobId/file',
    express.raw({ type: () => true, limit: '250mb' }),
    async (req, res) => {
      const job = await loadStudioJob(req.params.jobId);
      if (!job) {
        res.status(404).json({ error: 'Studio job không tồn tại hoặc đã bị hủy.' });
        return;
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        res.status(400).json({ error: 'File upload rỗng.' });
        return;
      }
      const role = sanitizeOutputStem(
        typeof req.headers['x-role'] === 'string' ? req.headers['x-role'] : 'media',
        'media',
      );
      const rawFileName =
        typeof req.headers['x-filename'] === 'string'
          ? decodeURIComponent(req.headers['x-filename'])
          : `${role}.bin`;
      const baseOnly = path.basename(rawFileName).replace(/[\x00-\x1f\\/:*?"<>|]/g, '_') || `${role}.bin`;
      const destPath = path.join(job.dir, `${role}_${baseOnly}`);
      if (req.query.append === '1') {
        await fs.promises.appendFile(destPath, body);
      } else {
        await fs.promises.writeFile(destPath, body);
      }
      job.files[role] = destPath;
      job.createdAt = Date.now();
      await fs.promises.writeFile(path.join(job.dir, 'meta.json'), JSON.stringify(job), 'utf8');
      res.json({ ok: true, role, bytes: body.length });
    },
  );

  app.post('/api/studio/job/:jobId/merge', express.json({ limit: '256kb' }), async (req, res) => {
    const job = await loadStudioJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Studio job không tồn tại hoặc đã bị hủy.' });
      return;
    }
    try {
      const videoPath = job.files.video;
      const audioPath = job.files.audio;
      if (!videoPath || !audioPath) {
        res.status(400).json({ error: 'Thiếu file video hoặc file audio để ghép.' });
        return;
      }
      const vMeta = await probeMediaMeta(videoPath);
      const aMeta = await probeMediaMeta(audioPath);
      const durationMode = req.body?.durationMode === 'loop-video' ? 'loop-video' : 'shortest';
      const shouldLoopVideo = durationMode === 'loop-video' && vMeta.duration > 0.2 && vMeta.duration < aMeta.duration;
      const duration = Math.max(
        0.5,
        durationMode === 'loop-video' ? aMeta.duration : Math.min(vMeta.duration, aMeta.duration),
      );

      const watermarkText = typeof req.body?.watermarkText === 'string' ? req.body.watermarkText.trim() : '';
      const watermarkCorner = typeof req.body?.watermarkCorner === 'string' ? req.body.watermarkCorner : 'bottom-right';
      const watermarkOpacity = Math.max(0.1, Math.min(1, Number(req.body?.watermarkOpacity ?? 0.65)));
      const outroText = typeof req.body?.outroText === 'string' ? req.body.outroText.trim() : '';
      const outroDuration = Math.max(0, Math.min(6, Number(req.body?.outroDuration ?? 0)));

      const assLines: string[] = [
        '[Script Info]',
        'ScriptType: v4.00+',
        `PlayResX: ${vMeta.width}`,
        `PlayResY: ${vMeta.height}`,
        'WrapStyle: 2',
        '',
        '[V4+ Styles]',
        'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
        `Style: Watermark,Noto Sans,${Math.max(20, Math.round(vMeta.height * 0.024))},&H00FFFFFF,&H00FFFFFF,&H800F172A,&H00000000,-1,0,0,0,100,100,0,0,1,2,1,3,36,36,28,1`,
        `Style: Outro,Noto Sans,${Math.max(26, Math.round(vMeta.height * 0.042))},&H00FFFFFF,&H00FFFFFF,&H400F172A,&H00000000,-1,0,0,0,100,100,0,0,1,3,1,5,40,40,40,1`,
        '',
        '[Events]',
        'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
      ];

      const toAssTime = (sec: number) => {
        const s = Math.max(0, sec);
        const cs = Math.round(s * 100);
        const hh = Math.floor(cs / 360000);
        const mm = Math.floor((cs % 360000) / 6000);
        const ss = Math.floor((cs % 6000) / 100);
        const cc = cs % 100;
        return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(cc).padStart(2, '0')}`;
      };
      const escAss = (s: string) => s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');

      if (watermarkText) {
        const anCode =
          watermarkCorner === 'top-left'
            ? 7
            : watermarkCorner === 'top-right'
              ? 9
              : watermarkCorner === 'bottom-left'
                ? 1
                : 3;
        const alphaHex = Math.round((1 - watermarkOpacity) * 255)
          .toString(16)
          .toUpperCase()
          .padStart(2, '0');
        assLines.push(
          `Dialogue: 1,0:00:00.00,${toAssTime(duration)},Watermark,,0,0,0,,{\\an${anCode}\\alpha&H${alphaHex}&}${escAss(watermarkText)}`,
        );
      }
      if (outroDuration > 0 && outroText) {
        const startOutro = Math.max(0, duration - outroDuration);
        const joined = outroText
          .split(/\r?\n/)
          .map((l: string) => escAss(l.trim()))
          .filter(Boolean)
          .slice(0, 2)
          .join('\\N');
        if (joined) {
          assLines.push(
            `Dialogue: 2,${toAssTime(startOutro)},${toAssTime(duration)},Outro,,0,0,0,,{\\an5\\fad(450,450)}${joined}`,
          );
        }
      }

      const assPath = path.join(job.dir, 'overlay.ass');
      await fs.promises.writeFile(assPath, '\uFEFF' + assLines.join('\n'), 'utf8');

      const vFilters: string[] = [];
      if (watermarkText || (outroDuration > 0 && outroText)) {
        vFilters.push(`subtitles=filename=${path.basename(assPath)}`);
      }
      if (outroDuration > 0) {
        const dOut = Math.max(0.25, Math.min(outroDuration, duration));
        const stOut = Math.max(0, duration - dOut);
        vFilters.push(`fade=t=out:st=${stOut.toFixed(3)}:d=${dOut.toFixed(3)}`);
      }

      const outLocal = path.join(job.dir, 'merged.mp4');
      const args: string[] = ['-y', '-hide_banner', '-loglevel', 'error'];
      if (shouldLoopVideo) args.push('-stream_loop', '-1');
      args.push('-i', videoPath, '-i', audioPath);
      if (vFilters.length > 0) {
        args.push('-filter_complex', `[0:v:0]${vFilters.join(',')}[v]`, '-map', '[v]', '-map', '1:a:0');
        args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p');
      } else {
        args.push('-map', '0:v:0', '-map', '1:a:0', '-c:v', shouldLoopVideo ? 'libx264' : 'copy');
        if (shouldLoopVideo) {
          args.push('-preset', 'medium', '-crf', '19', '-pix_fmt', 'yuv420p');
        }
      }
      args.push('-t', duration.toFixed(3), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outLocal);

      await spawnTrackedFfmpeg(args, job.dir, (p) => activeStudioProcs.set(job.id, p));
      activeStudioProcs.delete(job.id);

      const rawOutName = typeof req.body?.outputName === 'string' ? req.body.outputName : 'merged_video';
      const stem = sanitizeOutputStem(rawOutName.replace(/\.mp4$/i, ''), 'merged_video');
      const fileName = stem.endsWith('_merged') ? `${stem}.mp4` : `${stem}_merged.mp4`;
      const saveSubPath = typeof req.body?.savePath === 'string' ? req.body.savePath : 'edu-studio';
      const { baseDir, targetDir } = resolveSafeOutputDir(saveSubPath);
      await fs.promises.mkdir(targetDir, { recursive: true });
      const diskPath = path.join(targetDir, fileName);
      await fs.promises.copyFile(outLocal, diskPath);
      const stat = await fs.promises.stat(diskPath);
      await cleanupStudioJob(job.id);

      res.json({
        ok: true,
        fileName,
        relativePath: path.relative(baseDir, diskPath).replace(/\\/g, '/'),
        savedPath: diskPath,
        bytes: stat.size,
      });
    } catch (err) {
      await cleanupStudioJob(job.id);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Lỗi FFmpeg ghép Video + Audio.' });
    }
  });

  app.post('/api/studio/job/:jobId/karaoke-mix', express.json({ limit: '1mb' }), async (req, res) => {
    const job = await loadStudioJob(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: 'Studio job không tồn tại hoặc đã bị hủy.' });
      return;
    }
    try {
      const videoPath = job.files.video;
      if (!videoPath) {
        res.status(400).json({ error: 'Thiếu file Video nền.' });
        return;
      }
      const vMeta = await probeMediaMeta(videoPath);
      const duration = vMeta.duration;
      const assContent = typeof req.body?.assContent === 'string' ? req.body.assContent : '';
      const assPath = path.join(job.dir, 'karaoke.ass');
      if (assContent.trim()) {
        await fs.promises.writeFile(assPath, '\uFEFF' + assContent, 'utf8');
      }

      const effect = typeof req.body?.videoEffect === 'string' ? req.body.videoEffect : 'Fade cinematic';
      const outroSeconds = Math.max(0, Math.min(6, Number(req.body?.outroSeconds ?? 0)));
      const fadeOutStart = outroSeconds > 0 ? Math.max(0, duration - outroSeconds) : Math.max(0, duration - 0.35);
      const fadeOutDur = Math.max(0.25, duration - fadeOutStart);

      const vFilters: string[] = [];
      if (effect === 'Fade cinematic') {
        vFilters.push('fade=t=in:st=0:d=0.65', `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDur.toFixed(3)}`);
      } else if (effect === 'Soft vignette + fade') {
        vFilters.push('vignette=PI/5', 'eq=contrast=1.04:saturation=0.92', 'fade=t=in:st=0:d=0.7', `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDur.toFixed(3)}`);
      } else if (effect === 'Warm film + fade') {
        vFilters.push('eq=contrast=1.06:saturation=1.12:brightness=0.015', 'colorbalance=rs=0.035:gs=0.012:bs=-0.025', 'vignette=PI/6', 'fade=t=in:st=0:d=0.7', `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDur.toFixed(3)}`);
      } else if (effect === 'Cool tech + fade') {
        vFilters.push('eq=contrast=1.05:saturation=1.08', 'colorbalance=rs=-0.025:gs=0.005:bs=0.035', 'fade=t=in:st=0:d=0.7', `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDur.toFixed(3)}`);
      } else if (effect === 'Slow zoom + fade') {
        // Fixed Educational Studio 1.19 bug: preserve source probed FPS instead of dead regex + hardcoded 30
        const srcFps = Math.max(24, Math.min(60, vMeta.fps || 30));
        vFilters.push(
          `fps=${srcFps}`,
          `zoompan=z='min(zoom+0.00012,1.045)':d=1:s=${vMeta.width}x${vMeta.height}:fps=${srcFps}`,
          'fade=t=in:st=0:d=0.7',
          `fade=t=out:st=${fadeOutStart.toFixed(3)}:d=${fadeOutDur.toFixed(3)}`,
        );
      }
      if (assContent.trim()) {
        vFilters.push(`subtitles=filename=${path.basename(assPath)}`);
      }

      const cmd: string[] = ['-y', '-hide_banner', '-loglevel', 'error', '-i', videoPath];
      let nextIdx = 1;
      let musicIdx: number | null = null;
      let sfxIdx: number | null = null;
      let voiceIdx: number | null = null;

      if (job.files.music) {
        cmd.push('-stream_loop', '-1', '-i', job.files.music);
        musicIdx = nextIdx++;
      }
      if (job.files.sfx) {
        cmd.push('-stream_loop', '-1', '-i', job.files.sfx);
        sfxIdx = nextIdx++;
      }
      if (job.files.voice) {
        cmd.push('-i', job.files.voice);
        voiceIdx = nextIdx++;
      }

      const muteOriginal = Boolean(req.body?.muteOriginal);
      const removeDialogue = Boolean(req.body?.removeDialogue);
      const originalVol = Math.max(0, Math.min(2, Number(req.body?.originalVolume ?? 0.6)));
      const musicVol = Math.max(0, Math.min(2, Number(req.body?.musicVolume ?? 0.35)));
      const sfxVol = Math.max(0, Math.min(2, Number(req.body?.sfxVolume ?? 0.3)));
      const voiceVol = Math.max(0, Math.min(2, Number(req.body?.voiceVolume ?? 1.0)));
      const voiceStart = Math.max(0, Number(req.body?.voiceStart ?? 0));
      const voicePriority = req.body?.voicePriority !== false;

      const filters: string[] = [vFilters.length > 0 ? `[0:v:0]${vFilters.join(',')}[vout]` : '[0:v:0]null[vout]'];
      const bedLabels: string[] = [];

      if (!muteOriginal && vMeta.hasAudio) {
        if (removeDialogue && vMeta.isStereo) {
          filters.push(`[0:a:0]aformat=sample_rates=48000:channel_layouts=stereo,pan=stereo|c0=FL-FR|c1=FR-FL,volume=${originalVol.toFixed(3)}[orig]`);
        } else {
          filters.push(`[0:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume=${originalVol.toFixed(3)}[orig]`);
        }
        bedLabels.push('[orig]');
      }
      if (musicIdx !== null) {
        filters.push(
          `[${musicIdx}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume=${musicVol.toFixed(3)},atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.2,afade=t=out:st=${Math.max(0, duration - 1.5).toFixed(3)}:d=${Math.min(1.5, duration).toFixed(3)}[music]`,
        );
        bedLabels.push('[music]');
      }
      if (sfxIdx !== null) {
        filters.push(
          `[${sfxIdx}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume=${sfxVol.toFixed(3)},atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=1.8,afade=t=out:st=${Math.max(0, duration - 2.0).toFixed(3)}:d=${Math.min(2.0, duration).toFixed(3)}[sfx]`,
        );
        bedLabels.push('[sfx]');
      }
      if (voiceIdx !== null) {
        const delayMs = Math.max(0, Math.round(voiceStart * 1000));
        filters.push(
          `[${voiceIdx}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume=${voiceVol.toFixed(3)},adelay=${delayMs}:all=1,apad,atrim=0:${duration.toFixed(3)},asetpts=PTS-STARTPTS[voice]`,
        );
      }

      if (bedLabels.length > 0 && voiceIdx !== null) {
        if (bedLabels.length === 1) {
          filters.push(`${bedLabels[0]}anull[bed]`);
        } else {
          filters.push(
            `${bedLabels.join('')}amix=inputs=${bedLabels.length}:duration=longest:dropout_transition=0:normalize=0,alimiter=limit=0.95[bed]`,
          );
        }
      }

      const audioPresent = bedLabels.length > 0 || voiceIdx !== null;
      if (voiceIdx !== null) {
        if (bedLabels.length > 0) {
          if (voicePriority) {
            filters.push('[voice]asplit=2[voice_key][voice_mix]');
            filters.push('[bed][voice_key]sidechaincompress=threshold=0.025:ratio=10:attack=15:release=420:makeup=1[bedduck]');
            filters.push("[bedduck][voice_mix]amix=inputs=2:duration=longest:dropout_transition=0:weights='0.55 1.0':normalize=0,alimiter=limit=0.95[aout]");
          } else {
            filters.push("[bed][voice]amix=inputs=2:duration=longest:dropout_transition=0:weights='0.8 1.0':normalize=0,alimiter=limit=0.95[aout]");
          }
        } else {
          filters.push('[voice]alimiter=limit=0.95[aout]');
        }
      } else if (bedLabels.length > 0) {
        if (bedLabels.length === 1) {
          filters.push(`${bedLabels[0]}alimiter=limit=0.95[aout]`);
        } else {
          filters.push(
            `${bedLabels.join('')}amix=inputs=${bedLabels.length}:duration=longest:dropout_transition=2,alimiter=limit=0.95[aout]`,
          );
        }
      }

      const outLocal = path.join(job.dir, 'karaoke_out.mp4');
      cmd.push('-filter_complex', filters.join(';'), '-map', '[vout]');
      if (audioPresent) cmd.push('-map', '[aout]');
      cmd.push('-t', duration.toFixed(3), '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p');
      if (audioPresent) cmd.push('-c:a', 'aac', '-b:a', '192k');
      else cmd.push('-an');
      cmd.push('-movflags', '+faststart', outLocal);

      await spawnTrackedFfmpeg(cmd, job.dir, (p) => activeStudioProcs.set(job.id, p));
      activeStudioProcs.delete(job.id);

      const rawOutName = typeof req.body?.outputName === 'string' ? req.body.outputName : 'karaoke_mix';
      const stem = sanitizeOutputStem(rawOutName.replace(/\.mp4$/i, ''), 'karaoke_mix');
      const fileName = `${stem}_karaoke.mp4`;
      const saveSubPath = typeof req.body?.savePath === 'string' ? req.body.savePath : 'edu-studio';
      const { baseDir, targetDir } = resolveSafeOutputDir(saveSubPath);
      await fs.promises.mkdir(targetDir, { recursive: true });
      const diskPath = path.join(targetDir, fileName);
      await fs.promises.copyFile(outLocal, diskPath);
      const stat = await fs.promises.stat(diskPath);
      await cleanupStudioJob(job.id);

      res.json({
        ok: true,
        fileName,
        relativePath: path.relative(baseDir, diskPath).replace(/\\/g, '/'),
        savedPath: diskPath,
        bytes: stat.size,
      });
    } catch (err) {
      await cleanupStudioJob(job.id);
      res.status(500).json({ error: err instanceof Error ? err.message : 'Lỗi FFmpeg render Karaoke & Mix.' });
    }
  });

  app.delete('/api/studio/job/:jobId', async (req, res) => {
    await cleanupStudioJob(req.params.jobId);
    res.json({ ok: true });
  });

  if (process.env.NODE_ENV === 'production') {
    const distDir = path.resolve('dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    const { createServer } = await import('vite');
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`KineticSub Studio server listening on http://0.0.0.0:${port}`);
  });
}

void startServer();
