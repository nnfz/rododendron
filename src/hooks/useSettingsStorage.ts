import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Settings } from '../types';

const STORAGE_KEY = 'vpn-settings';

export function useSettingsStorage(
  settings: Settings,
  setSettings: Dispatch<SetStateAction<Settings>>
) {
  const isInitialized = useRef(false);

  // Load on mount
  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        setSettings(prev => ({ ...prev, ...parsed }));
      } catch (e) {
        console.error('Failed to load settings:', e);
      }
    }
    isInitialized.current = true;
  }, [setSettings]);

  // Save on change
  useEffect(() => {
    if (!isInitialized.current) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);
}
