import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Database,
  Eye,
  Plus,
  RotateCcw,
  Save,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { renderIllustrationVariantThumbnail } from '../engine/canvasRenderer';
import {
  buildVectorComponentAiPrompt,
  deleteComponentVariant,
  getCustomComponentByVariant,
  getDeletedBuiltInsSnapshot,
  normalizeCustomComponent,
  parseVectorComponentAiJson,
  restoreBuiltInComponent,
  sanitizeVariantSlug,
  subscribeCustomComponents,
  upsertCustomComponent,
} from '../engine/customComponentStore';
import {
  CustomComponentDefinition,
  VectorCategory,
  VectorPrimitive,
} from '../engine/customComponentTypes';
import { IllustrationSceneIcon } from '../engine/types';
import {
  ALL_SCENE_ICONS,
  getEffectiveVectorCatalog,
  VECTOR_COMPONENT_CATALOG,
} from '../engine/vectorComponentDb';

interface ComponentDatabaseModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const CATEGORY_LABELS: Record<VectorCategory, string> = {
  life: 'Đời sống',
  grammar: 'Ngữ pháp',
  vocab: 'Từ vựng',
  pronunciation: 'Phát âm',
  dialogue: 'Hội thoại',
};

const DEFAULT_STARTER_PRIMITIVES: VectorPrimitive[] = [
  {
    shape: 'rect',
    x: -330,
    y: -140,
    w: 660,
    h: 280,
    radius: 30,
    fill: '#FFFFFF',
    stroke: '#E2E8F0',
    lineWidth: 2,
    shadow: true,
  },
  { shape: 'pill', x: -115, y: -118, w: 230, h: 40, fill: '#EEF2FF' },
  {
    shape: 'text',
    x: 0,
    y: -98,
    text: 'CUSTOM SCENE',
    fill: '#4338CA',
    fontSize: 20,
    fontWeight: 800,
    align: 'center',
  },
  { shape: 'circle', x: -145, y: 20, r: 58, fill: '#DBEAFE', stroke: '#3B82F6', lineWidth: 3 },
  { shape: 'icon', icon: 'sparkles', x: -145, y: 20 },
  { shape: 'arrow', x: -60, y: 20, x2: 15, y2: 20, stroke: '#16A34A', lineWidth: 6 },
  {
    shape: 'rect',
    x: 35,
    y: -48,
    w: 255,
    h: 140,
    radius: 22,
    fill: '#ECFDF5',
    stroke: '#86EFAC',
    lineWidth: 2,
  },
  {
    shape: 'text',
    x: 162,
    y: 8,
    text: 'Key Expression',
    fill: '#15803D',
    fontSize: 24,
    fontWeight: 800,
    align: 'center',
  },
  {
    shape: 'text',
    x: 162,
    y: 48,
    text: 'Context Match',
    fill: '#475569',
    fontSize: 18,
    fontWeight: 600,
    align: 'center',
  },
];

const ComponentMiniCanvas: React.FC<{
  variant: string;
  primitives?: VectorPrimitive[];
  width?: number;
  height?: number;
  className?: string;
}> = ({ variant, primitives, width = 240, height = 128, className = '' }) => {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderIllustrationVariantThumbnail(ctx, variant, width, height, 0.75, primitives);
  }, [variant, primitives, width, height]);

  return (
    <canvas
      ref={ref}
      width={width}
      height={height}
      className={`block bg-slate-50 rounded-lg border border-slate-200 ${className}`}
    />
  );
};

export const ComponentDatabaseModal: React.FC<ComponentDatabaseModalProps> = ({
  isOpen,
  onClose,
}) => {
  const [version, setVersion] = useState(0);
  const [activeTab, setActiveTab] = useState<'browse' | 'ai-prompt'>('browse');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<VectorCategory | 'all'>('all');
  const [showDeleted, setShowDeleted] = useState(false);

  // Selected / Editor state
  const [isCreatingNew, setIsCreatingNew] = useState(false);
  const [editVariant, setEditVariant] = useState('cafe-water');
  const [editLabel, setEditLabel] = useState('');
  const [editCategory, setEditCategory] = useState<VectorCategory>('life');
  const [editDescription, setEditDescription] = useState('');
  const [editKeywords, setEditKeywords] = useState('');
  const [editIcon, setEditIcon] = useState<IllustrationSceneIcon>('sparkles');
  const [editPrimitivesJson, setEditPrimitivesJson] = useState('[]');
  const [editorStatus, setEditorStatus] = useState<string | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);

  // AI Web Prompt Builder tab state
  const [aiConcept, setAiConcept] = useState('Đặt đồ ăn tại nhà hàng chay hoặc hỏi thành phần món');
  const [aiCategory, setAiCategory] = useState<VectorCategory>('life');
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [pastedAiJson, setPastedAiJson] = useState('');
  const [aiParseError, setAiParseError] = useState<string | null>(null);
  const [aiImportSuccess, setAiImportSuccess] = useState<string | null>(null);

  useEffect(() => {
    return subscribeCustomComponents(() => setVersion((v) => v + 1));
  }, []);

  const catalog = useMemo(() => {
    void version;
    return getEffectiveVectorCatalog();
  }, [version]);

  const deletedBuiltIns = useMemo(() => {
    void version;
    return getDeletedBuiltInsSnapshot();
  }, [version]);

  const filteredItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return catalog.filter((item) => {
      if (categoryFilter !== 'all' && item.category !== categoryFilter) return false;
      if (!q) return true;
      return (
        item.variant.toLowerCase().includes(q) ||
        item.label.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        item.keywordsText.toLowerCase().includes(q)
      );
    });
  }, [catalog, categoryFilter, searchQuery]);

  const hiddenBuiltInItems = useMemo(
    () => VECTOR_COMPONENT_CATALOG.filter((b) => deletedBuiltIns.includes(b.variant)),
    [deletedBuiltIns],
  );

  const loadVariantIntoEditor = (variant: string) => {
    setIsCreatingNew(false);
    setEditorError(null);
    setEditorStatus(null);
    const custom = getCustomComponentByVariant(variant);
    const builtIn = VECTOR_COMPONENT_CATALOG.find((b) => b.variant === variant);
    const catalogEntry = catalog.find((c) => c.variant === variant);

    setEditVariant(variant);
    setEditLabel(custom?.label ?? catalogEntry?.label ?? builtIn?.label ?? variant);
    setEditCategory(custom?.category ?? catalogEntry?.category ?? builtIn?.category ?? 'life');
    setEditDescription(
      custom?.description ?? catalogEntry?.description ?? builtIn?.description ?? '',
    );
    setEditKeywords(
      custom?.keywords.join(', ') ??
        (builtIn ? builtIn.keywords.source.replace(/\\b|\(|\)/g, '').replace(/\|/g, ', ') : ''),
    );
    setEditIcon(custom?.defaultIcon ?? builtIn?.defaultIcon ?? 'sparkles');
    setEditPrimitivesJson(
      custom && custom.primitives.length > 0
        ? JSON.stringify(custom.primitives, null, 2)
        : '[]',
    );
  };

  useEffect(() => {
    if (isOpen && !isCreatingNew) {
      loadVariantIntoEditor(editVariant);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  const parsedEditorPrimitives = useMemo((): {
    primitives: VectorPrimitive[];
    error: string | null;
  } => {
    try {
      const raw = JSON.parse(editPrimitivesJson);
      if (!Array.isArray(raw)) {
        return { primitives: [], error: 'Primitives phải là mảng JSON [] các shape.' };
      }
      const norm = normalizeCustomComponent({
        variant: editVariant || 'preview',
        label: editLabel || 'Preview',
        primitives: raw,
      });
      return { primitives: norm?.primitives ?? [], error: null };
    } catch {
      return { primitives: [], error: 'Cú pháp JSON của mảng primitives chưa hợp lệ.' };
    }
  }, [editPrimitivesJson, editVariant, editLabel]);

  const aiGeneratedPrompt = useMemo(
    () =>
      buildVectorComponentAiPrompt(aiConcept || 'Thẻ minh họa giao tiếp tiếng Anh', {
        category: aiCategory,
        availableIcons: ALL_SCENE_ICONS,
      }),
    [aiConcept, aiCategory],
  );

  const parsedAiComponents = useMemo(() => {
    if (!pastedAiJson.trim()) return [];
    try {
      return parseVectorComponentAiJson(pastedAiJson);
    } catch {
      return [];
    }
  }, [pastedAiJson]);

  if (!isOpen) return null;

  const isSelectedBuiltIn = VECTOR_COMPONENT_CATALOG.some((b) => b.variant === editVariant);
  const hasCustomOverride = Boolean(getCustomComponentByVariant(editVariant));

  const handleStartNewComponent = () => {
    setIsCreatingNew(true);
    setEditorError(null);
    setEditorStatus(null);
    setEditVariant(`custom-scene-${Date.now().toString(36).slice(-4)}`);
    setEditLabel('Cảnh minh họa mới');
    setEditCategory('life');
    setEditDescription('Minh họa thẻ học tiếng Anh 2D pastel');
    setEditKeywords('example, phrase, conversation, practice');
    setEditIcon('sparkles');
    setEditPrimitivesJson(JSON.stringify(DEFAULT_STARTER_PRIMITIVES, null, 2));
  };

  const handleSaveEditor = async () => {
    setEditorError(null);
    setEditorStatus(null);
    if (parsedEditorPrimitives.error) {
      setEditorError(parsedEditorPrimitives.error);
      return;
    }

    const slug = sanitizeVariantSlug(editVariant);
    if (!slug) {
      setEditorError('Mã variant không hợp lệ.');
      return;
    }

    const keywords = editKeywords
      .split(/[,;\n]/)
      .map((s) => s.trim())
      .filter(Boolean);

    // If editing built-in metadata without primitives JSON, seed starter primitives ONLY if user explicitly added primitives;
    // otherwise save metadata + existing custom primitives or starter
    const def: CustomComponentDefinition = {
      variant: isSelectedBuiltIn && !isCreatingNew ? editVariant : slug,
      label: editLabel.trim() || slug,
      category: editCategory,
      description: editDescription.trim() || editLabel.trim() || slug,
      keywords,
      defaultIcon: editIcon,
      primitives: parsedEditorPrimitives.primitives,
      isBuiltInOverride: isSelectedBuiltIn && !isCreatingNew,
    };

    try {
      const saved = await upsertCustomComponent(def);
      setIsCreatingNew(false);
      setEditVariant(saved.variant);
      setEditorStatus(
        `Đã lưu "${saved.variant}" vào Kho Component! Các video và prompt mới sẽ tự nhận diện component này.`,
      );
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : 'Không thể lưu component.');
    }
  };

  const handleDeleteCurrent = async () => {
    if (isCreatingNew) return;
    await deleteComponentVariant(editVariant, isSelectedBuiltIn);
    setEditorStatus(
      isSelectedBuiltIn
        ? `Đã ẩn component mặc định "${editVariant}" (có thể khôi phục bất kỳ lúc nào).`
        : `Đã xóa vĩnh viễn component "${editVariant}".`,
    );
    const remaining = getEffectiveVectorCatalog();
    if (remaining.length > 0) {
      loadVariantIntoEditor(remaining[0].variant);
    }
  };

  const handleRestoreBuiltIn = async (variant: string) => {
    await restoreBuiltInComponent(variant);
    setEditorStatus(`Đã khôi phục nguyên bản "${variant}".`);
    loadVariantIntoEditor(variant);
  };

  const handleCopyAiPrompt = async () => {
    try {
      await navigator.clipboard.writeText(aiGeneratedPrompt);
      setCopiedPrompt(true);
      setTimeout(() => setCopiedPrompt(false), 2000);
    } catch {
      setCopiedPrompt(false);
    }
  };

  const handleImportAiComponents = async () => {
    setAiParseError(null);
    setAiImportSuccess(null);
    try {
      const parsed = parseVectorComponentAiJson(pastedAiJson);
      if (parsed.length === 0) {
        setAiParseError(
          'Không tìm thấy component hợp lệ có mảng "primitives". Hãy copy nguyên JSON từ AI Web.',
        );
        return;
      }
      for (const comp of parsed) {
        await upsertCustomComponent(comp);
      }
      setAiImportSuccess(
        `Đã thêm ${parsed.length} component (${parsed.map((c) => c.variant).join(', ')}) vào Kho! Tạo video mới hoặc bấm Random theo ngữ cảnh sẽ tự dùng ngay.`,
      );
      setEditVariant(parsed[0].variant);
      loadVariantIntoEditor(parsed[0].variant);
      setPastedAiJson('');
    } catch {
      setAiParseError('JSON từ AI Web chưa đúng cấu trúc. Hãy kiểm tra lại dấu ngoặc và phẩy.');
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="component-db-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/55 backdrop-blur-[2px] p-4"
    >
      <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-6xl h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-3.5 border-b border-slate-200 flex flex-wrap items-center justify-between gap-4 bg-slate-50/70">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
              <Database className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h2 id="component-db-title" className="text-base font-bold text-slate-900 truncate">
                Kho Component Minh Họa Vector (@168 &amp; Custom AI)
              </h2>
              <p className="text-xs text-slate-500 truncate tabular-nums">
                Đang kích hoạt: {catalog.length} component · Tùy chỉnh/AI:{' '}
                {catalog.filter((c) => c.isCustom || c.isOverride).length} · Tự động đồng bộ vào Video &amp; Prompt mới
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg border border-slate-200">
              <button
                type="button"
                onClick={() => setActiveTab('browse')}
                className={`px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  activeTab === 'browse'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                Xem · Sửa · Xóa ({catalog.length})
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('ai-prompt')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md transition-colors whitespace-nowrap ${
                  activeTab === 'ai-prompt'
                    ? 'bg-indigo-600 text-white shadow-xs'
                    : 'text-indigo-700 hover:bg-indigo-50'
                }`}
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>Tạo Prompt cho AI Web vẽ Component</span>
              </button>
            </div>

            <button
              type="button"
              onClick={onClose}
              aria-label="Đóng Kho Component"
              className="p-2 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Body */}
        {activeTab === 'browse' ? (
          <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 overflow-hidden">
            {/* Left Catalog Grid */}
            <div className="lg:col-span-7 flex flex-col min-h-0 border-b lg:border-b-0 lg:border-r border-slate-200">
              <div className="p-3.5 bg-slate-50/60 border-b border-slate-200 flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[180px]">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="Tìm tên, variant, keyword..."
                    className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <select
                  aria-label="Lọc nhóm component"
                  value={categoryFilter}
                  onChange={(e) => setCategoryFilter(e.target.value as VectorCategory | 'all')}
                  className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="all">Tất cả nhóm</option>
                  {(Object.keys(CATEGORY_LABELS) as VectorCategory[]).map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_LABELS[cat]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={handleStartNewComponent}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 whitespace-nowrap"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Thêm mới</span>
                </button>
              </div>

              {hiddenBuiltInItems.length > 0 && (
                <div className="px-3.5 py-2 bg-amber-50/70 border-b border-amber-200 flex items-center justify-between gap-2 text-xs">
                  <label className="inline-flex items-center gap-2 text-amber-900 font-medium cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showDeleted}
                      onChange={(e) => setShowDeleted(e.target.checked)}
                      className="rounded border-amber-300 text-amber-600"
                    />
                    <span>Hiện {hiddenBuiltInItems.length} component mặc định đã ẩn</span>
                  </label>
                </div>
              )}

              <div className="flex-1 overflow-y-auto p-3.5 grid grid-cols-1 sm:grid-cols-2 gap-3 content-start">
                {filteredItems.map((item) => {
                  const customDef = getCustomComponentByVariant(item.variant);
                  const active = !isCreatingNew && editVariant === item.variant;
                  return (
                    <button
                      key={item.variant}
                      type="button"
                      onClick={() => loadVariantIntoEditor(item.variant)}
                      className={`text-left p-2.5 rounded-xl border transition-all flex flex-col gap-2 ${
                        active
                          ? 'bg-indigo-50/70 border-indigo-400 ring-2 ring-indigo-100'
                          : 'bg-white border-slate-200 hover:border-slate-300'
                      }`}
                    >
                      <ComponentMiniCanvas
                        variant={item.variant}
                        primitives={customDef?.primitives}
                        width={260}
                        height={120}
                        className="w-full h-auto"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center justify-between gap-1.5">
                          <span className="text-xs font-bold text-slate-900 truncate">
                            {item.label}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 text-[10px] font-semibold rounded shrink-0 ${
                              item.isCustom
                                ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                : item.isOverride
                                  ? 'bg-amber-50 text-amber-700 border border-amber-200'
                                  : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {item.isCustom ? 'Tùy chỉnh' : item.isOverride ? 'Đã sửa' : CATEGORY_LABELS[item.category]}
                          </span>
                        </div>
                        <div className="text-[11px] font-mono text-indigo-600 truncate mt-0.5">
                          {item.variant}
                        </div>
                      </div>
                    </button>
                  );
                })}

                {showDeleted &&
                  hiddenBuiltInItems.map((b) => (
                    <div
                      key={`hidden-${b.variant}`}
                      className="p-2.5 rounded-xl border border-dashed border-amber-300 bg-amber-50/40 flex flex-col justify-between gap-2"
                    >
                      <div>
                        <div className="text-xs font-bold text-slate-700">{b.label}</div>
                        <div className="text-[11px] font-mono text-slate-500">{b.variant} (đã ẩn)</div>
                      </div>
                      <button
                        type="button"
                        onClick={() => void handleRestoreBuiltIn(b.variant)}
                        className="inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-semibold text-amber-800 bg-white border border-amber-300 rounded-lg hover:bg-amber-100"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Khôi phục</span>
                      </button>
                    </div>
                  ))}
              </div>
            </div>

            {/* Right Inspector / Editor */}
            <div className="lg:col-span-5 flex flex-col min-h-0 overflow-y-auto p-4 bg-slate-50/40 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-bold text-slate-900">
                  {isCreatingNew
                    ? 'Tạo Component Vector Mới'
                    : `Chi tiết & Chỉnh sửa: ${editVariant}`}
                </h3>
                {!isCreatingNew && isSelectedBuiltIn && hasCustomOverride && (
                  <button
                    type="button"
                    onClick={() => void handleRestoreBuiltIn(editVariant)}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-md hover:bg-amber-100"
                  >
                    <RotateCcw className="w-3 h-3" />
                    <span>Khôi phục gốc</span>
                  </button>
                )}
              </div>

              <ComponentMiniCanvas
                variant={editVariant}
                primitives={
                  parsedEditorPrimitives.primitives.length > 0
                    ? parsedEditorPrimitives.primitives
                    : undefined
                }
                width={460}
                height={200}
                className="w-full h-auto bg-white"
              />

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Mã variant (slug)
                  </label>
                  <input
                    type="text"
                    disabled={!isCreatingNew && isSelectedBuiltIn}
                    value={editVariant}
                    onChange={(e) => setEditVariant(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs font-mono bg-white border border-slate-200 rounded-lg disabled:bg-slate-100 disabled:text-slate-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Nhóm ngữ cảnh
                  </label>
                  <select
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value as VectorCategory)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                  >
                    {(Object.keys(CATEGORY_LABELS) as VectorCategory[]).map((cat) => (
                      <option key={cat} value={cat}>
                        {CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Tên hiển thị
                  </label>
                  <input
                    type="text"
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Icon mặc định
                  </label>
                  <select
                    value={editIcon}
                    onChange={(e) => setEditIcon(e.target.value as IllustrationSceneIcon)}
                    className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                  >
                    {ALL_SCENE_ICONS.map((icon) => (
                      <option key={icon} value={icon}>
                        {icon}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Mô tả (để AI hiểu khi tạo kịch bản video mới)
                </label>
                <input
                  type="text"
                  value={editDescription}
                  onChange={(e) => setEditDescription(e.target.value)}
                  className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                  Từ khóa tự động khớp lời thoại (cách nhau dấu phẩy)
                </label>
                <input
                  type="text"
                  value={editKeywords}
                  onChange={(e) => setEditKeywords(e.target.value)}
                  placeholder="interview, resume, job, phỏng vấn"
                  className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-[11px] font-semibold text-slate-700">
                    Định nghĩa hình vẽ Vector (<code>primitives[]</code>)
                  </label>
                  <button
                    type="button"
                    onClick={() =>
                      setEditPrimitivesJson(JSON.stringify(DEFAULT_STARTER_PRIMITIVES, null, 2))
                    }
                    className="text-[11px] font-medium text-indigo-600 hover:text-indigo-700"
                  >
                    Nạp khung vẽ mẫu
                  </button>
                </div>
                <textarea
                  rows={6}
                  value={editPrimitivesJson}
                  onChange={(e) => setEditPrimitivesJson(e.target.value)}
                  className="w-full p-2.5 text-[11px] font-mono bg-white border border-slate-200 rounded-lg leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <p className="text-[10px] text-slate-500 mt-1">
                  Để <code>[]</code> nếu là component mặc định muốn giữ hình gốc của hệ thống và chỉ sửa từ khóa/tên.
                </p>
              </div>

              {(editorError || parsedEditorPrimitives.error) && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2">
                  {editorError || parsedEditorPrimitives.error}
                </p>
              )}

              {editorStatus && (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2">
                  {editorStatus}
                </p>
              )}

              <div className="flex items-center justify-between gap-2 pt-2 border-t border-slate-200">
                {!isCreatingNew ? (
                  <button
                    type="button"
                    onClick={() => void handleDeleteCurrent()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-semibold text-red-600 bg-white border border-red-200 rounded-lg hover:bg-red-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>{isSelectedBuiltIn ? 'Ẩn khỏi Kho' : 'Xóa vĩnh viễn'}</span>
                  </button>
                ) : (
                  <span />
                )}

                <button
                  type="button"
                  onClick={() => void handleSaveEditor()}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>Lưu vào Database</span>
                </button>
              </div>
            </div>
          </div>
        ) : (
          /* AI Web Prompt Builder Tab */
          <div className="flex-1 min-h-0 overflow-y-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-5 bg-slate-50/40">
            <div className="lg:col-span-6 space-y-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Bước 1: Tạo Prompt cho AI Web tự vẽ Component mới
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Nhập ý tưởng cảnh bạn muốn → sao chép Prompt gửi ChatGPT/Gemini/Claude Web → nhận lại JSON chuẩn tọa độ Canvas của KineticSub.
                </p>
              </div>

              <div className="grid grid-cols-3 gap-2.5">
                <div className="col-span-2">
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Ý tưởng / Cảnh cần AI vẽ
                  </label>
                  <input
                    type="text"
                    value={aiConcept}
                    onChange={(e) => setAiConcept(e.target.value)}
                    placeholder="VD: Gửi bưu kiện ở bưu điện, Phỏng vấn online qua Zoom..."
                    className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                    Nhóm gợi ý
                  </label>
                  <select
                    value={aiCategory}
                    onChange={(e) => setAiCategory(e.target.value as VectorCategory)}
                    className="w-full px-2.5 py-2 text-xs bg-white border border-slate-200 rounded-lg"
                  >
                    {(Object.keys(CATEGORY_LABELS) as VectorCategory[]).map((cat) => (
                      <option key={cat} value={cat}>
                        {CATEGORY_LABELS[cat]}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <textarea
                aria-label="Prompt AI Web vẽ Vector Component"
                readOnly
                rows={15}
                value={aiGeneratedPrompt}
                className="w-full p-3 text-[11px] font-mono bg-white border border-slate-200 rounded-xl leading-relaxed text-slate-800"
              />

              <button
                type="button"
                onClick={() => void handleCopyAiPrompt()}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
              >
                {copiedPrompt ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                <span>{copiedPrompt ? 'Đã sao chép Prompt!' : 'Sao chép Prompt gửi AI Web'}</span>
              </button>
            </div>

            <div className="lg:col-span-6 space-y-3">
              <div>
                <h3 className="text-sm font-bold text-slate-900">
                  Bước 2: Dán JSON từ AI Web &amp; Xem trước Live
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Hỗ trợ cả 1 object hoặc mảng nhiều component cùng lúc. Sau khi thêm, các video mới &amp; AI Prompt Video sẽ tự động có thêm các component này.
                </p>
              </div>

              <textarea
                aria-label="Dán JSON component từ AI Web"
                rows={9}
                value={pastedAiJson}
                onChange={(e) => {
                  setPastedAiJson(e.target.value);
                  setAiParseError(null);
                  setAiImportSuccess(null);
                }}
                placeholder='Dán kết quả JSON từ ChatGPT / Gemini Web vào đây...'
                className="w-full p-3 text-[11px] font-mono bg-white border border-slate-200 rounded-xl leading-relaxed focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />

              {parsedAiComponents.length > 0 && (
                <div className="p-3 bg-white border border-indigo-200 rounded-xl space-y-2">
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-indigo-700">
                    <Eye className="w-3.5 h-3.5" />
                    <span>Xem trước ngay ({parsedAiComponents.length} component nhận diện được):</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {parsedAiComponents.map((comp) => (
                      <div key={comp.variant} className="space-y-1">
                        <ComponentMiniCanvas
                          variant={comp.variant}
                          primitives={comp.primitives}
                          width={320}
                          height={150}
                          className="w-full h-auto"
                        />
                        <div className="text-xs font-bold text-slate-800">{comp.label}</div>
                        <div className="text-[10px] font-mono text-slate-500">
                          {comp.variant} · {comp.primitives.length} hình · keywords: {comp.keywords.slice(0, 4).join(', ')}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {aiParseError && (
                <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg p-2.5">
                  {aiParseError}
                </p>
              )}

              {aiImportSuccess && (
                <p className="text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 font-medium">
                  {aiImportSuccess}
                </p>
              )}

              <button
                type="button"
                disabled={!pastedAiJson.trim()}
                onClick={() => void handleImportAiComponents()}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
              >
                <Plus className="w-4 h-4" />
                <span>Lưu vào Kho Component &amp; Áp dụng cho Video mới</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
