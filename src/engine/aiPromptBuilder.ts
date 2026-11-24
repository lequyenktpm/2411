import { LAYOUT_COMPOSITIONS } from './illustrationLayouts';
import { formatTimeToken } from './transcriptParser';
import {
  CanvasThemeId,
  CustomComponentPresetConfig,
  LayoutCompositionId,
  TranscriptCue,
} from './types';
import { getCatalogSummaryForPrompt } from './vectorComponentDb';

export type PromptVideoStyle = 'tiktok-cards' | '3d-shapes' | 'word-reveal-dark';

export function buildSceneGenerationPrompt(
  cues: TranscriptCue[],
  options?: {
    title?: string;
    style?: PromptVideoStyle;
    compositionId?: LayoutCompositionId | 'ai-decide';
    theme?: CanvasThemeId;
    customConfig?: CustomComponentPresetConfig;
  },
): string {
  const style = options?.style ?? 'tiktok-cards';
  const is3D = style === '3d-shapes';
  const isWordReveal = style === 'word-reveal-dark';
  const aiDecideComposition = options?.compositionId === 'ai-decide';

  const totalStart = cues.length > 0 ? formatTimeToken(cues[0].start) : '00:00:00.000';
  const totalEnd =
    cues.length > 0 ? formatTimeToken(cues[cues.length - 1].end + 0.4) : '00:00:30.000';

  const compMeta =
    !aiDecideComposition && options?.compositionId
      ? LAYOUT_COMPOSITIONS.find((c) => c.id === options.compositionId)
      : undefined;

  const { variantsListText, sceneIconsListText } = getCatalogSummaryForPrompt();

  // ── Style guide block ──────────────────────────────────────────────────────
  let styleGuide: string;

  if (options?.compositionId === 'custom' && options?.customConfig) {
    const cc = options.customConfig;
    styleGuide = `CHẾ ĐỘ TỰ SÁNG TẠO & TÙY BIẾN COMPONENT TỪ KHO:
- Người dùng đã chọn component chủ đạo từ Kho Component: \`variant: "${cc.variant}"\`${cc.sceneIcon ? `, \`sceneIcon: "${cc.sceneIcon}"\`` : ''}.
- Tham số tùy biến yêu cầu áp dụng vào các thẻ minh họa trọng tâm:
  + Tiêu đề (\`title\`): "${cc.title || options?.title || 'Key Rule'}"
  + Phụ đề (\`subtitle\`): "${cc.subtitle || 'Điền ghi chú ngắn sát câu thoại'}"
  + Nhãn (\`labels\`): ${JSON.stringify(cc.labels && cc.labels.length > 0 ? cc.labels : ['Step 1', 'Step 2', 'Step 3'])}
  + Từ nhấn (\`highlightWord\`): "${cc.highlightWord || ''}"
  + Màu nhấn (\`accentColor\`): "${cc.accentColor || '#4F46E5'}"
- Hãy giữ đúng \`variant: "${cc.variant}"\` hoặc biến tấu sáng tạo thêm bằng \`customPrimitives\` dựa theo phong cách này, đồng bộ với từng câu thoại.`;
  } else if (isWordReveal || options?.compositionId === 'word-reveal') {
    styleGuide = `PHONG CÁCH WORD-REVEAL (@xun52000 — Kinetic Typography tập trung chữ lớn):
- Đặt "theme": "${options?.theme ?? 'studio-slate'}" (hoặc "pastel-sunrise" / "soft-lavender" / "mint-breeze" / "warm-paper").
- Mỗi câu thoại → 1 "sentence_card" to, căn giữa (y ≈ 780), làm nổi từ khóa bằng "emphasisWord" + "emphasisColor": "#FACC15" (nền tối) hoặc "#4F46E5" (nền sáng).
- "subtext": nghĩa / phonetic nhỏ hơn phía dưới. Dùng enterAnimation "fade-scale" hoặc "pop-up" ngắn ≤ 0.3s.
- Có thể thêm "word_stack" (y ≈ 650) cho các bài đối chiếu nhiều dạng hoặc "staircase_3d" (y ≈ 780, fill="#FACC15") khi liệt kê 3 cấp độ.
- Vùng karaoke (y ≥ 1450) vẫn để app tự render — KHÔNG đặt phần tử tại đây.`;
  } else if (is3D || options?.compositionId === '3d-shapes') {
    styleGuide = `PHONG CÁCH 3D NỔI + KARAOKE ĐẬM:
- Đặt "theme": "${options?.theme ?? 'studio-slate'}" (hoặc các nền sáng/tối tùy chọn, chữ karaoke vàng #FACC15 khi nền tối).
- Ưu tiên dùng "card_3d", "pill_3d", "cube_3d", "staircase_3d" làm điểm nhấn chính ở Vùng C & Vùng D.`;
  } else if (aiDecideComposition) {
    // AI tự quyết định phong cách phối tối ưu dựa trên nội dung
    const compositionList = LAYOUT_COMPOSITIONS.filter((c) => c.id !== 'custom').map(
      (c) => `  - "${c.id}" → ${c.name}: ${c.description} (theme: ${c.recommendedTheme}, signature: ${c.signatureVariant})`,
    ).join('\n');

    styleGuide = `PHONG CÁCH TIKTOK GIẢNG DẠY (@englishpracticing168) — CHẾ ĐỘ AI TỰ CHỌN PHỐI TỐI ƯU (KHÔNG RANDOM):

**NHIỆM VỤ BỔ SUNG**: Đọc toàn bộ transcript, nhận diện mô típ bài (đối chiếu 2–3 từ gần nghĩa, nâng cấp câu, đồng hồ/giờ, hội thoại đời sống, checklist đúng/sai, word-reveal chữ lớn, khối 3D nổi, sân bay, nhà hàng, mua sắm, phát âm...), rồi chọn ĐÚNG 1 id dưới đây:
${compositionList}

Quy tắc chọn (ưu tiên từ trên xuống):
- Bài đối chiếu 2–3 từ gần nghĩa (Look/See/Watch, Say/Tell/Talk, Hear/Listen...) → "phrase-icon-split"
- Có giờ / clock / o'clock → "clock-spotlight"
- Nâng cấp câu boring → natural / don't say → "dialogue-upgrade"
- Các bước 1-2-3 / ladder → "flow-steps"
- Sắc thái polite/rude → "gauge-tone"
- Checklist đúng/sai → "checklist-cards"
- Mốc thời gian / deadline / thì → "timeline-track"
- 3 khái niệm / giới từ / trọng âm → "spatial-contrast"
- Từ khóa/câu ngắn mạnh phong cách @xun52000 → "word-reveal"
- Bài giảng 3 cấp độ dùng khối nổi 3D → "3d-shapes"
- Cảnh đời sống (quán, công sở, bạn bè, sân bay, nhà hàng, mua sắm, bác sĩ, thời tiết...) → "story-scenes"

Cách "tạo phong cách mới" AN TOÀN (không được linh tinh):
- KHÔNG invent type, variant, hay toạ độ ngoài 5 vùng.
- Được phép ghép linh hoạt kho 50+ vector & Bootstrap 5 / Modern CSS variants, 42 \`sceneIcon\`, schema \`"dynamic_scene"\`, hoặc tự vẽ component mới qua \`"customPrimitives"\` để minh họa khớp từng câu nói.
- 1 bài = 1 signature illustration chủ đạo hoặc mỗi câu 1 cảnh đúng ngữ cảnh. Không chồng 2 sơ đồ khác nhau trong cùng 1 mốc giờ.

Sau khi chọn:
1. \`"compositionId": "<id đã chọn>"\`
2. \`"compositionReason": "<1 câu, nêu đúng mô típ transcript>"\`
3. Theme = theme khuyến nghị của kiểu phối.
4. Điền data sát chữ trong bài (dùng \`sceneIcon\` phù hợp trong kho 42 icon).`;
  } else {
    styleGuide = `PHONG CÁCH TIKTOK GIẢNG DẠY (@englishpracticing168)${compMeta ? ` — KIỂU PHỐI: ${compMeta.name}` : ''}:
- Đặt "theme": "${options?.theme ?? compMeta?.recommendedTheme ?? 'pastel-sunrise'}" (hoặc "soft-lavender" / "mint-breeze" / "warm-paper").
- Kết hợp thanh đối chiếu trên cùng ("comparison_strip"), nhãn ngữ cảnh ("topic_pill"), hình minh họa/sơ đồ sát ngữ cảnh (${compMeta ? `ưu tiên "${compMeta.signatureVariant}"` : 'đa dạng từ kho 50+ vector & Bootstrap 5 / Modern CSS hoặc dynamic_scene'}), thẻ câu nổi bật ("sentence_card"), bậc thang 3D ("staircase_3d"), và thanh sắc thái ("tone_meter").`;
  }

  const transcriptLines = cues
    .map(
      (cue, idx) =>
        `[Cue ${idx + 1} | ${formatTimeToken(cue.start)} -> ${formatTimeToken(cue.end)}] ${cue.text}`,
    )
    .join('\n');

  const extraOutputFields = aiDecideComposition
    ? `  "compositionId": "story-scenes",\n  "compositionReason": "...",\n  `
    : '  ';

  const resolvedTemplateTheme =
    options?.theme ??
    (isWordReveal || is3D ? 'studio-slate' : compMeta?.recommendedTheme ?? 'pastel-sunrise');

  return `# VAI TRÒ
Bạn là Đạo diễn Motion Graphics tự động cho video dọc 9:16 (1080×1920).
Người dùng **KHÔNG tự thiết kế**. JSON do bạn sinh ra là **xương sống điều khiển toàn bộ chữ, hình minh họa, khối 3D và hiệu ứng ẩn/hiện** đồng bộ 100% với Audio + Transcript dưới đây.

# NHIỆM VỤ
Phân tích toàn bộ ${cues.length} câu thoại từ \`${totalStart}\` đến \`${totalEnd}\` và trả về **DUY NHẤT 1 KHỐI JSON HỢP LỆ** (không giải thích ngoài JSON) để app tự động dựng thành video hoàn chỉnh.

# ${styleGuide}
Tiêu đề bài học: "${options?.title || 'Language Lesson'}"

# HỆ THỐNG 5 VÙNG BỐ CỤC CHỐNG CHỒNG ĐÈ (BẮT BUỘC)
Khung hình rộng 1080 × cao 1920. Mọi phần tử chỉ được đặt đúng vùng Y tương ứng:
- **Vùng A (y = 185)** — \`comparison_strip\`: Thanh 2–4 mục chính xuyên suốt bài (tự sáng viền theo \`activateAt\`).
- **Vùng B (y = 335)** — \`topic_pill\`: Nhãn tiêu đề phần hiện tại (VD: \`"Picture this"\`, \`"1. Casual"\`, \`"Pro Tip"\`, \`"Quiz"\`).
- **Vùng C (y = 620)** — \`illustration\` / \`dynamic_scene\` / \`staircase_3d\` / \`word_stack\` / \`cube_3d\`: Hình minh họa hoặc sơ đồ trung tâm.
- **Vùng D (y = 970)** — \`sentence_card\` / \`card_3d\`: Câu ví dụ hoặc từ khóa cần nhấn mạnh (tách câu mục tiêu ra thẻ to rõ).
- **Vùng E (y = 1215)** — \`tone_meter\`: Thanh trượt sắc thái/mức độ (khi có sự so sánh trái-phải).
- **VÙNG CẤM (y = 1450..1850)**: Chừa trống hoàn toàn — app tự render phụ đề karaoke highlight từng từ tại đây.

# TỪ ĐIỂN ELEMENT ĐƯỢC HỖ TRỢ TRONG \`elements[]\`
1. \`comparison_strip\`:
   \`{ "type": "comparison_strip", "start": "HH:MM:SS.mmm", "end": "HH:MM:SS.mmm", "y": 185, "items": [{ "label": "...", "sublabel": "...", "activateAt": "HH:MM:SS.mmm", "accentColor": "#2563EB" }] }\`
2. \`topic_pill\`:
   \`{ "type": "topic_pill", "start": "...", "end": "...", "y": 335, "text": "...", "bgColor": "#DDD6FE", "textColor": "#4338CA" }\`
3. \`illustration\` (CHỌN \`variant\` SÁT NGHĨA VỚI CÂU THOẠI TẠI MỐC ĐÓ, không chọn bừa):
   Kho 50+ vector, Bootstrap 5 & Modern CSS chuẩn @englishpracticing168:
${variantsListText}
   + \`"dynamic-scene"\`: Bố cục tự ghép bất kỳ chủ đề nào từ 42 icon + bảng so sánh / công thức / thẻ 3 cột.
   Kho 42 \`sceneIcon\` cho \`phrase-icon-split\` và \`dynamic-scene\`:
   ${sceneIconsListText}
   Ví dụ: \`{ "type": "illustration", "variant": "css-sticky-note", "start": "...", "end": "...", "y": 635, "title": "QUICK RULE", "subtitle": "Could I + V?", "labels": ["Polite", "Natural"] }\`
   Hoặc \`dynamic_scene\` tự ghép cho chủ đề mới:
   \`{ "type": "dynamic_scene", "start": "...", "end": "...", "y": 635, "dynamicScene": { "layout": "split-compare"|"hero-icon-formula"|"triple-card-grid", "badgeText": "UPGRADE", "connector": "arrow"|"vs", "headline": "...", "motifs": [{ "icon": "airplane", "label": "Boarding pass", "sublabel": "Gate B4", "accent": "#2563EB", "status": "check" }] } }\`
4. \`sentence_card\`:
   \`{ "type": "sentence_card", "start": "...", "end": "...", "y": 985, "text": "Could I have some water, please?", "subtext": "Ghi chú ngắn hoặc nghĩa (tùy chọn)", "badge": "check", "emphasisWord": "Could I", "emphasisColor": "#16A34A", "stampText": "" }\`
   (\`badge\`: \`"check"\` | \`"cross"\` | \`"question"\` | \`"none"\`; \`stampText\` dùng cho thẻ sai/cần tránh như \`"RUDE"\`)
5. \`word_stack\`: Xếp chồng 2–4 dòng đối chiếu:
   \`{ "type": "word_stack", "start": "...", "end": "...", "y": 680, "rows": [{ "prefix": "Can ", "suffix": "I...", "suffixColor": "#2563EB", "appearAt": "00:00:11.960", "phonetic": "Casual" }] }\`
6. \`staircase_3d\`: Bậc thang 3 cấp 3D:
   \`{ "type": "staircase_3d", "start": "...", "end": "...", "y": 780, "fill": "#F59E0B", "step_labels": ["Can", "Could", "May"] }\`
7. \`tone_meter\`: Thanh trượt sắc thái:
   \`{ "type": "tone_meter", "start": "...", "end": "...", "y": 1245, "title": "TONE", "leftLabel": "rude", "rightLabel": "polite", "valueStart": 0.5, "valueEnd": 0.14 }\`
8. \`card_3d\` / \`pill_3d\` / \`cube_3d\`: Khối 3D nổi có chữ (\`text\`, \`fill\`, \`textColor\`, \`depth\`).

# CÁCH TỰ TÙY BIẾN & THIẾT KẾ COMPONENT MỚI (BOOTSTRAP 5 / MODERN CSS + \`customPrimitives\`)
Bạn có **2 cách tùy biến component** thay vì xuất thẻ lặp lại nhàm chán:
1. **Tùy biến tham số trực tiếp trên mọi \`illustration\` (\`bs-*\`, \`css-*\`, vector)**:
   Truyền \`title\`, \`subtitle\`, \`labels\` (mảng 2–4 nhãn), \`formula\`, \`value\` (0..1), \`highlightWord\`, \`sceneIcon\` (từ kho 42 icon) ngay trên element \`illustration\` để đổi nội dung bên trong Bootstrap card / Sticky Note / Magnifying Glass / Badge Cluster / Modal Quiz.
2. **Tự thiết kế component UI mới hoàn toàn qua \`customPrimitives[]\`**:
   Đặt trên element: \`{ "type": "illustration", "variant": "custom-ui", "start": "...", "end": "...", "y": 635, "customPrimitives": [...] }\`.
   - Hệ tọa độ tương đối quanh tâm \`(0, 0)\`, vùng an toàn: \`x: -380..380\`, \`y: -145..145\`.
   - 9 hình cơ bản được engine vẽ sắc nét lên Canvas:
     + \`{ "shape": "rect", "x": -340, "y": -130, "w": 680, "h": 260, "radius": 24, "fill": "#FFFFFF", "stroke": "#E2E8F0", "lineWidth": 2, "shadow": true }\`
     + \`{ "shape": "pill", "x": -120, "y": -108, "w": 240, "h": 42, "fill": "#EFF6FF", "stroke": "#93C5FD" }\`
     + \`{ "shape": "circle", "x": -220, "y": 15, "r": 46, "fill": "#FEF3C7", "stroke": "#F59E0B" }\`
     + \`{ "shape": "ellipse", "x": 0, "y": 95, "rx": 160, "ry": 20, "fill": "rgba(15,23,42,0.08)", "opacity": 0.8 }\`
     + \`{ "shape": "line", "x": -300, "y": -42, "x2": 300, "y2": -42, "stroke": "#E2E8F0", "lineWidth": 2 }\`
     + \`{ "shape": "arrow", "x": -60, "y": 25, "x2": 60, "y2": 25, "stroke": "#2563EB", "lineWidth": 5 }\`
     + \`{ "shape": "polygon", "points": [{"x":0,"y":-40},{"x":40,"y":20},{"x":-40,"y":20}], "fill": "#4F46E5" }\`
     + \`{ "shape": "icon", "icon": "sparkles", "x": -220, "y": 15 }\` (chọn \`icon\` trong kho 42 \`sceneIcon\`)
     + \`{ "shape": "text", "x": 40, "y": -4, "text": "PRO TIP", "fill": "#0F172A", "fontSize": 28, "fontWeight": 800, "align": "center" }\`
   - **Mẫu công thức Bootstrap 5 & Modern CSS chuẩn đẹp (tham khảo phối màu \`#2563EB\`, \`#4F46E5\`, \`#16A34A\`, \`#D97706\`, \`#E11D48\`)**:
     + *Left-Border Callout Card*: card trắng \`shadow: true\` + thanh nhấn dọc \`w: 12\` bên trái \`x: -334\` + badge \`pill\` + \`text\` tiêu đề đậm.
     + *Bootstrap Colored Header + Divider*: \`rect\` nền trắng + \`rect\` header màu phía trên + \`line\` ngăn cách + 2–3 \`pill\` bên dưới.
     + *Modern CSS Sticky Note*: nền vàng pastel \`#FEF3C7\` viền \`#F59E0B\` + đinh ghim \`circle\` đỏ \`#EF4444\` phía trên + chữ viết tay nổi bật.
     + *Glassmorphism / Bento 2x2*: các ô \`rect\` dùng \`fill: "rgba(255,255,255,0.86)"\` xếp lưới cân đối + \`icon\` mỗi ô.
     + *macOS Browser / Badge Cluster*: 3 chấm \`circle\` đỏ-vàng-xanh ở góc trên trái + cụm \`pill\` phân loại màu khác nhau.

# LUẬT CHỐNG ĐỤNG HÀNG (CHỌN COMPONENT ĐA DẠNG MỖI VIDEO)
1. **KHÔNG lặp nguyên mẫu**: Tuyệt đối KHÔNG dùng trùng một \`variant\` hoặc cùng \`dynamicScene.layout\` cho 2 cue liên tiếp nhau.
2. **Phối hợp ít nhất 3–4 họ thị giác trong cùng 1 video**:
   - Họ cảnh đời sống (\`cafe-water\`, \`hotel-desk\`, \`airport-travel\`, \`shopping-price\`, \`restaurant-order\`, \`doctor-health\`...)
   - Họ UI Bootstrap 5 & Modern CSS (\`css-sticky-note\`, \`bs-badge-cluster\`, \`css-magnifying-word\`, \`bs-modal-quiz\`, \`bs-card-header\`, \`bs-pricing-tier\`, \`css-bento-stats\`, \`css-toggle-switch\`, \`css-chat-thread\`...)
   - Họ sơ đồ / 3D / \`dynamic_scene\` (\`staircase_3d\`, \`word_stack\`, \`phrase-icon-split\`, \`split-compare\`, \`triple-card-grid\`)
   - Họ tự thiết kế \`customPrimitives\` (nên tạo ít nhất 1–2 element dùng \`customPrimitives\` may đo riêng cho từ khóa/ngữ cảnh bài học để video không giống khuôn đúc sẵn).

# QUY TẮC DÀN CẢNH TỰ ĐỘNG BẮT BUỘC
1. **Phủ kín 100% thời lượng**: Từ \`${totalStart}\` đến \`${totalEnd}\`, luôn có ít nhất 1–2 thành phần thị giác đang hiển thị phù hợp với nội dung đang nói (không để màn hình trống > 1.5s).
2. **Không bao giờ chồng đè**: Trong cùng 1 vùng (B, C, D, hoặc E), phần tử cũ phải có \`end <= start\` của phần tử tiếp theo trong cùng vùng đó.
3. **Bắt đúng câu ví dụ**: Bất kỳ câu mẫu/cụm từ trọng tâm nào trong transcript (đặc biệt các câu tiếng Anh/ngoại ngữ hoặc câu nằm trong ngoặc) phải xuất hiện trên \`sentence_card\` đúng lúc Audio đọc đến cue đó.
4. **Định dạng đầu ra**: Chỉ trả về 1 object JSON theo mẫu sau:

\`\`\`json
{
  "title": "${options?.title || 'Language Lesson'}",
  "theme": "${resolvedTemplateTheme}",
  ${extraOutputFields}"scenes": [
    {
      "id": "sc1",
      "elements": [
        { "type": "comparison_strip", "start": "${totalStart}", "end": "${totalEnd}", "y": 185, "items": [] }
      ]
    }
  ]
}
\`\`\`

# TRANSCRIPT CẦN CHUYỂN THÀNH VIDEO JSON
${transcriptLines}`;
}

