export type ReadingCefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

export interface ReadingWebPromptOptions {
  mode: 'web-url' | 'topic';
  url?: string;
  sourceTitle?: string;
  sourceText?: string;
  topic?: string;
  level: ReadingCefrLevel;
  wordCount: number;
}

export interface ParsedReadingPassage {
  title: string;
  topicBadge: string;
  level?: string;
  text: string;
}

const LEVEL_GUIDANCE: Record<ReadingCefrLevel, string> = {
  A1: 'CEFR A1 Beginner: câu ngắn rõ ràng (6-10 từ/câu), từ vựng thông dụng hằng ngày, thì hiện tại đơn / quá khứ đơn dễ đọc.',
  A2: 'CEFR A2 Elementary: câu đơn giản mạch lạc (8-13 từ/câu), từ vựng giao tiếp đời sống, liên từ tự nhiên.',
  B1: 'CEFR B1 Intermediate: tiếng Anh tự nhiên mượt mà (10-16 từ/câu), phù hợp kể chuyện và luyện phát âm.',
  B2: 'CEFR B2 Upper-Intermediate: cấu trúc đa dạng, có cụm từ tự nhiên/collocations hay, nhịp đọc cuốn hút.',
  C1: 'CEFR C1 Advanced: văn phong sắc sảo, từ vựng học thuật/tinh tế nhưng vẫn dễ đọc thành tiếng.',
};

export function buildReadingWebAiPrompt(opts: ReadingWebPromptOptions): string {
  const level = opts.level || 'B1';
  const wordCount = Math.max(40, Math.min(260, Math.round(opts.wordCount || 110)));
  const cleanUrl = (opts.url || '').trim();
  const cleanSource = (opts.sourceText || '').trim().slice(0, 8500);
  const cleanTopic = (opts.topic || '').trim();

  const sourceBlock =
    opts.mode === 'web-url'
      ? cleanSource
        ? `NGUỒN BÀI VIẾT TỪ WEB${cleanUrl ? ` (${cleanUrl})` : ''}:
Tiêu đề gốc: ${opts.sourceTitle || 'Web Article'}
Nội dung đã trích xuất:
"""
${cleanSource}
"""
Hãy tóm tắt & biên tập lại thành bài đọc tiếng Anh hay nhất từ nội dung trên.`
        : `HÃY TRUY CẬP / ĐỌC NỘI DUNG TỪ ĐƯỜNG LINK SAU VÀ BIÊN TẬP THÀNH BÀI ĐỌC:
URL: ${cleanUrl || '(người dùng sẽ dán URL)'}
(Nếu bạn không truy cập trực tiếp được link, hãy dựa theo chủ đề trong URL "${cleanUrl}" hoặc nội dung liên quan để viết bài đọc chuẩn xác).`
      : `CHỦ ĐỀ BÀI ĐỌC: "${cleanTopic || 'Morning habits for better focus'}"`;

  return `# VAI TRÒ
Bạn là Chuyên gia thiết kế giáo trình luyện đọc tiếng Anh (Reading Along Karaoke Video).

# NHIỆM VỤ
${sourceBlock}

# YÊU CẦU TRÌNH ĐỘ & ĐỘ DÀI
- Trình độ: ${LEVEL_GUIDANCE[level]}
- Độ dài mục tiêu: khoảng **${wordCount} từ tiếng Anh**.
- Mỗi câu viết trên **1 dòng riêng** (ngăn cách bằng \\n), KHÔNG đánh số thứ tự, KHÔNG gắn timestamp, KHÔNG markdown (\`**\`, \`*\`), KHÔNG emoji, để app đọc TTS & chạy bàn tay chỉ chữ chính xác từng từ.

# ĐỊNH DẠNG ĐẦU RA BẮT BUỘC (CHỈ TRẢ VỀ 1 KHỐI JSON)
\`\`\`json
{
  "title": "Tiêu đề tiếng Anh ngắn gọn, thu hút",
  "topicBadge": "CEFR ${level} · READING",
  "level": "${level}",
  "text": "Sentence one goes here.\\nSentence two goes here.\\nSentence three continues the story."
}
\`\`\``;
}

export function parseReadingWebAiResponse(
  rawInput: string,
  fallbackLevel: ReadingCefrLevel = 'B1',
): ParsedReadingPassage | null {
  const raw = rawInput.trim();
  if (!raw) return null;

  // 1. Try stripping markdown fences and parsing JSON
  const cleanedJson = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as {
        title?: string;
        topicBadge?: string;
        level?: string;
        text?: string;
        content?: string;
        passage?: string;
      };
      const rawPassage = String(obj.text || obj.content || obj.passage || '').trim();
      if (rawPassage) {
        const cleanLines = rawPassage
          .replace(/\\n/g, '\n')
          .split(/\r?\n+/)
          .map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, '').trim())
          .filter(Boolean);
        return {
          title: String(obj.title || 'Reading Practice').trim().slice(0, 90),
          topicBadge: String(obj.topicBadge || `CEFR ${obj.level || fallbackLevel} · READING`)
            .trim()
            .slice(0, 48),
          level: obj.level ? String(obj.level) : fallbackLevel,
          text: cleanLines.join('\n'),
        };
      }
    } catch {
      // Fall through to plain-text mode
    }
  }

  // 2. Plain text fallback: split sentences / lines cleanly
  const plainLines = raw
    .replace(/^```[a-z]*\s*/gim, '')
    .replace(/```$/gm, '')
    .split(/\r?\n+/)
    .map((l) => l.replace(/^\s*[-*•]\s*/, '').trim())
    .filter((l) => l.length > 0);

  if (plainLines.length === 0) return null;

  // If first line looks like a short title (no terminal period and <= 60 chars) followed by more lines
  let title = '';
  let bodyLines = plainLines;
  if (
    plainLines.length >= 2 &&
    plainLines[0].length <= 64 &&
    !/[.!?]$/.test(plainLines[0])
  ) {
    title = plainLines[0].replace(/^#+\s*/, '').trim();
    bodyLines = plainLines.slice(1);
  }

  // If a single dense paragraph was pasted, split cleanly by sentence boundaries
  if (bodyLines.length === 1 && bodyLines[0].length > 90) {
    const splitSentences = bodyLines[0]
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (splitSentences.length > 1) bodyLines = splitSentences;
  }

  return {
    title: title || 'Custom Web Reading',
    topicBadge: `CEFR ${fallbackLevel} · WEB AI`,
    level: fallbackLevel,
    text: bodyLines.join('\n'),
  };
}
