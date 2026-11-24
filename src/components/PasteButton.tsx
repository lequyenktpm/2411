import React, { useEffect, useRef, useState } from 'react';
import { Check, ClipboardPaste } from 'lucide-react';

interface PasteButtonProps {
  onPasteText: (text: string) => void;
  label?: string;
  title?: string;
  className?: string;
  disabled?: boolean;
  targetSelector?: string;
}

export const PasteButton: React.FC<PasteButtonProps> = ({
  onPasteText,
  label = 'Dán',
  title = 'Xóa nội dung cũ & tự dán từ bộ nhớ đệm (Clipboard)',
  className = '',
  disabled = false,
  targetSelector,
}) => {
  const [status, setStatus] = useState<'idle' | 'pasted' | 'empty' | 'denied'>('idle');
  const timerRef = useRef<number | null>(null);
  const cleanupPasteListenerRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
      cleanupPasteListenerRef.current?.();
    };
  }, []);

  const scheduleIdleReset = (ms: number) => {
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setStatus('idle'), ms);
  };

  const getTargetElement = (): HTMLInputElement | HTMLTextAreaElement | null => {
    if (!targetSelector) return null;
    return document.querySelector(targetSelector) as HTMLInputElement | HTMLTextAreaElement | null;
  };

  const applyClearAndPaste = (
    el: HTMLInputElement | HTMLTextAreaElement | null,
    text: string,
  ) => {
    // Explicitly clear existing content first, then apply fresh clipboard text
    onPasteText('');
    if (el) {
      el.value = '';
      el.value = text;
      el.scrollTop = 0;
      el.focus();
      try {
        el.setSelectionRange(0, 0);
      } catch {
        // Ignore on input types without selection range
      }
    }
    onPasteText(text);
    setStatus('pasted');
    scheduleIdleReset(1600);
  };

  const attachOneShotPasteListener = (el: HTMLInputElement | HTMLTextAreaElement | null) => {
    cleanupPasteListenerRef.current?.();
    if (!el) return;
    const onManualPaste = (ev: Event) => {
      const clipEvent = ev as ClipboardEvent;
      const clipText =
        clipEvent.clipboardData?.getData('text/plain') ??
        clipEvent.clipboardData?.getData('text');
      if (typeof clipText === 'string' && clipText.length > 0) {
        clipEvent.preventDefault();
        applyClearAndPaste(el, clipText);
      }
      cleanupPasteListenerRef.current?.();
    };
    el.addEventListener('paste', onManualPaste as EventListener, { once: true });
    cleanupPasteListenerRef.current = () => {
      el.removeEventListener('paste', onManualPaste as EventListener);
      cleanupPasteListenerRef.current = null;
    };
  };

  const readFromClipboardApi = async (): Promise<{ ok: boolean; text: string }> => {
    if (!navigator.clipboard) return { ok: false, text: '' };

    // Primary: standard readText() called immediately inside click gesture
    if (typeof navigator.clipboard.readText === 'function') {
      try {
        const txt = await navigator.clipboard.readText();
        return { ok: true, text: txt ?? '' };
      } catch {
        // Fall through to clipboard.read() if available
      }
    }

    // Secondary: navigator.clipboard.read() for ClipboardItem text/plain blobs
    if (typeof navigator.clipboard.read === 'function') {
      try {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes('text/plain')) {
            const blob = await item.getType('text/plain');
            const txt = await blob.text();
            return { ok: true, text: txt ?? '' };
          }
        }
        return { ok: true, text: '' };
      } catch {
        // Blocked by browser/iframe permissions
      }
    }

    return { ok: false, text: '' };
  };

  const handleClick = async () => {
    if (disabled) return;
    cleanupPasteListenerRef.current?.();

    const targetEl = getTargetElement();

    // 1. Read clipboard first while click user-activation is intact
    const clipRes = await readFromClipboardApi();
    if (clipRes.ok) {
      if (clipRes.text.length === 0) {
        setStatus('empty');
        scheduleIdleReset(1800);
        return;
      }
      applyClearAndPaste(targetEl, clipRes.text);
      return;
    }

    // 2. Fallback when direct Clipboard API is blocked (e.g. embedded iframe policy):
    // Clear existing content first, focus the box, try execCommand('paste'), otherwise wait for Ctrl+V
    onPasteText('');
    if (targetEl) {
      targetEl.value = '';
      targetEl.scrollTop = 0;
      targetEl.focus();
      try {
        const pastedViaExec = document.execCommand('paste');
        if (pastedViaExec && targetEl.value && targetEl.value.length > 0) {
          const val = targetEl.value;
          applyClearAndPaste(targetEl, val);
          return;
        }
      } catch {
        // Ignore execCommand refusal
      }
      attachOneShotPasteListener(targetEl);
    }

    setStatus('denied');
    scheduleIdleReset(2600);
  };

  const buttonTitle =
    status === 'denied'
      ? 'Trình duyệt/iframe đang chặn tự đọc bộ nhớ đệm — ô cũ đã được xóa trống, nhấn Ctrl+V để dán ngay (hoặc mở app ở tab mới để dán 1 chạm).'
      : title;

  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => void handleClick()}
      title={buttonTitle}
      className={`inline-flex items-center gap-1 px-2 py-1 text-[11px] font-semibold rounded-md border transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 ${
        status === 'pasted'
          ? 'bg-emerald-50 border-emerald-300 text-emerald-700'
          : status === 'empty'
            ? 'bg-slate-100 border-slate-300 text-slate-600'
            : status === 'denied'
              ? 'bg-amber-50 border-amber-300 text-amber-800'
              : 'bg-white border-slate-200 text-slate-700 hover:bg-indigo-50 hover:border-indigo-200 hover:text-indigo-700'
      } ${className}`}
    >
      {status === 'pasted' ? (
        <Check className="w-3 h-3" />
      ) : (
        <ClipboardPaste className="w-3 h-3" />
      )}
      <span>
        {status === 'pasted'
          ? 'Đã dán'
          : status === 'empty'
            ? 'Bộ nhớ trống'
            : status === 'denied'
              ? 'Đã xóa · Ctrl+V'
              : label}
      </span>
    </button>
  );
};
