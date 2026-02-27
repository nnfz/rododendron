import { useState, useEffect, useCallback, useRef } from 'react';
import type { Settings } from '../types';

const STORAGE_KEY = 'vpn-settings';
const SETTINGS_EVENT = 'vpn-settings-updated';

const DEFAULT_SETTINGS: Settings = {
  autostart: false,
  startminimized: false,
  autoConnect: false,
  autoCheckUpdates: true,
  autoRestartOnRuleApply: true,
  closeBehavior: 'tray',
  killSwitch: false,
  logLevel: 'info',
  mtu: '1500',
  enableTun: true,
  snowfall: false,
};

const loadSettings = (): Settings => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      return { ...DEFAULT_SETTINGS, ...parsed };
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }
  return { ...DEFAULT_SETTINGS };
};

export function useSettingsStorage(): [
  Settings,
  (updater: Settings | ((prev: Settings) => Settings)) => void,
] {
  const [settings, setSettingsState] = useState<Settings>(loadSettings);
  const instanceIdRef = useRef(Math.random().toString(36).slice(2));

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY || !e.newValue) return;
      try {
        const parsed = JSON.parse(e.newValue);
        setSettingsState({ ...DEFAULT_SETTINGS, ...parsed });
      } catch (err) {
        console.error('Failed to load settings:', err);
      }
    };

    const handleSettingsEvent = (e: Event) => {
      const custom = e as CustomEvent<{ settings: Settings; source: string }>;
      if (!custom.detail?.settings) return;
      if (custom.detail.source === instanceIdRef.current) return;
      setSettingsState(custom.detail.settings);
    };

    window.addEventListener('storage', handleStorage);
    window.addEventListener(SETTINGS_EVENT, handleSettingsEvent);

    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(SETTINGS_EVENT, handleSettingsEvent);
    };
  }, []);

  const setSettings = useCallback(
    (updater: Settings | ((prev: Settings) => Settings)) => {
      setSettingsState((prev) => {
        const nextRaw = typeof updater === 'function' ? updater(prev) : updater;
        const next = { ...DEFAULT_SETTINGS, ...nextRaw };

        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        } catch (e) {
          console.error('Failed to save settings:', e);
        }

        window.dispatchEvent(
          new CustomEvent(SETTINGS_EVENT, {
            detail: { settings: next, source: instanceIdRef.current },
          }),
        );

        return next;
      });
    },
    [],
  );

  return [settings, setSettings];
}