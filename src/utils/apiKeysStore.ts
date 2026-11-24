import { useEffect, useState } from 'react';

export interface ClientApiKeys {
  elevenlabsApiKey: string;
  geminiApiKey: string;
}

const STORAGE_ELEVENLABS_KEY = 'kineticsub_elevenlabs_api_key_v1';
const STORAGE_GEMINI_KEY = 'kineticsub_gemini_api_key_v1';
const KEYS_EVENT = 'kineticsub:api-keys-changed';

export function loadClientApiKeys(): ClientApiKeys {
  if (typeof window === 'undefined' || !window.localStorage) {
    return { elevenlabsApiKey: '', geminiApiKey: '' };
  }
  try {
    return {
      elevenlabsApiKey: (window.localStorage.getItem(STORAGE_ELEVENLABS_KEY) || '').trim(),
      geminiApiKey: (window.localStorage.getItem(STORAGE_GEMINI_KEY) || '').trim(),
    };
  } catch {
    return { elevenlabsApiKey: '', geminiApiKey: '' };
  }
}

export function saveClientApiKeys(partial: Partial<ClientApiKeys>): ClientApiKeys {
  const current = loadClientApiKeys();
  const next: ClientApiKeys = {
    elevenlabsApiKey:
      partial.elevenlabsApiKey !== undefined
        ? partial.elevenlabsApiKey.trim()
        : current.elevenlabsApiKey,
    geminiApiKey:
      partial.geminiApiKey !== undefined
        ? partial.geminiApiKey.trim()
        : current.geminiApiKey,
  };

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      if (next.elevenlabsApiKey) {
        window.localStorage.setItem(STORAGE_ELEVENLABS_KEY, next.elevenlabsApiKey);
      } else {
        window.localStorage.removeItem(STORAGE_ELEVENLABS_KEY);
      }
      if (next.geminiApiKey) {
        window.localStorage.setItem(STORAGE_GEMINI_KEY, next.geminiApiKey);
      } else {
        window.localStorage.removeItem(STORAGE_GEMINI_KEY);
      }
      window.dispatchEvent(new CustomEvent(KEYS_EVENT, { detail: next }));
    } catch {
      // Ignore storage quota errors
    }
  }
  return next;
}

export function buildApiKeyHeaders(extra?: Record<string, string>): Record<string, string> {
  const keys = loadClientApiKeys();
  const headers: Record<string, string> = { ...(extra ?? {}) };
  if (keys.elevenlabsApiKey) {
    headers['x-elevenlabs-api-key'] = keys.elevenlabsApiKey;
  }
  if (keys.geminiApiKey) {
    headers['x-gemini-api-key'] = keys.geminiApiKey;
  }
  return headers;
}

export function useClientApiKeys() {
  const [keys, setKeys] = useState<ClientApiKeys>(() => loadClientApiKeys());

  useEffect(() => {
    const sync = () => setKeys(loadClientApiKeys());
    window.addEventListener(KEYS_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(KEYS_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  return {
    keys,
    saveKeys: saveClientApiKeys,
  };
}
