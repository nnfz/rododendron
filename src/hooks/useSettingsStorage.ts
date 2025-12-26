import { useState, useEffect, useCallback, useRef } from 'react';
import type { Settings } from '../types';

const STORAGE_KEY = 'vpn-settings';
const SETTINGS_EVENT = 'vpn-settings-updated';

// Default settings to ensure all required fields are present
const DEFAULT_SETTINGS: Settings = {
  autostart: false,
  startminimized: false,
  autoConnect: false,
  autoCheckUpdates: true,
  closeBehavior: 'tray',
  killSwitch: false,
  logLevel: 'info',
  mtu: '1500',
  enableTun: true,
  snowfall: true
};

// Helper function to load settings from localStorage
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

export function useSettingsStorage(): [Settings, (updater: Settings | ((prev: Settings) => Settings)) => void] {
  const [settings, setSettingsState] = useState<Settings>(loadSettings());
  const instanceIdRef = useRef<string>(Math.random().toString(36).slice(2));

  // Load settings from localStorage on mount
  useEffect(() => {
    const savedSettings = loadSettings();
    setSettingsState(savedSettings);
  }, []);

  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key !== STORAGE_KEY) return;
      if (!e.newValue) return;

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

  // Save settings to localStorage and update state
  const saveSettings = useCallback((newSettings: Settings) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(newSettings));
      return true;
    } catch (e) {
      console.error('Failed to save settings:', e);
      return false;
    }
  }, []);

  // Wrapper for setSettings to handle both direct and functional updates
  const setSettings = useCallback((updater: Settings | ((prev: Settings) => Settings)) => {
    setSettingsState(prev => {
      const nextSettingsRaw = typeof updater === 'function' ? updater(prev) : updater;
      const nextSettings = { ...DEFAULT_SETTINGS, ...nextSettingsRaw };
      saveSettings(nextSettings);

      window.dispatchEvent(
        new CustomEvent(SETTINGS_EVENT, {
          detail: { settings: nextSettings, source: instanceIdRef.current },
        })
      );

      return nextSettings;
    });
  }, [saveSettings]);

  return [settings, setSettings];
}
