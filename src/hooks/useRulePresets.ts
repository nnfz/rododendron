import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import type { Rule } from '../types';
import {
  ACTIVE_PRESET_STORAGE_KEY,
  browserStore,
  loadOrMigratePresets,
  parseStoredPresets,
  PRESETS_STORAGE_KEY,
  withActiveRules,
  withCreatedPreset,
  withRenamedPreset,
  withSelectedPreset,
  withoutPreset,
  type ProfileRuleHint,
  type StoredPresets,
} from '../utils/rulePresets';

export function useRulePresets(defaultName: string) {
  const [stored, setStored] = useState<StoredPresets | null>(null);
  const migratedRef = useRef(false);
  const idRef = useRef(0);

  useEffect(() => {
    const store = browserStore();
    const existing = parseStoredPresets(
      store.getItem(PRESETS_STORAGE_KEY),
      store.getItem(ACTIVE_PRESET_STORAGE_KEY),
    );
    if (!existing) return;
    migratedRef.current = true;
    setStored(existing);
  }, []);

  useEffect(() => {
    if (!stored || !migratedRef.current) return;
    const store = browserStore();
    store.setItem(PRESETS_STORAGE_KEY, JSON.stringify(stored.presets));
    store.setItem(ACTIVE_PRESET_STORAGE_KEY, stored.activeId);
  }, [stored]);

  const migrateIfNeeded = useCallback((hints: ProfileRuleHint[], activeConfigId: string | null) => {
    if (migratedRef.current) return;
    try {
      const next = loadOrMigratePresets(browserStore(), hints, activeConfigId, defaultName);
      migratedRef.current = true;
      setStored(next);
    } catch (error) {
      console.error('Failed to migrate rule presets:', error);
    }
  }, [defaultName]);

  const presets = stored?.presets ?? [];
  const activePresetId = stored?.activeId ?? '';
  const rules = stored?.presets.find(preset => preset.id === stored.activeId)?.rules ?? [];

  const setRules = useCallback<Dispatch<SetStateAction<Rule[]>>>((action) => {
    setStored(prev => {
      if (!prev) return prev;
      const current = prev.presets.find(preset => preset.id === prev.activeId)?.rules ?? [];
      const nextRules = typeof action === 'function' ? action(current) : action;
      return withActiveRules(prev, nextRules);
    });
  }, []);

  const selectPreset = useCallback((id: string) => {
    setStored(prev => (prev ? withSelectedPreset(prev, id) : prev));
  }, []);

  const createPreset = useCallback((name: string, nextRules: Rule[]) => {
    idRef.current += 1;
    const id = `preset-${Date.now()}-${idRef.current}`;
    const idBase = Date.now() + idRef.current * 1000;
    setStored(prev => (prev ? withCreatedPreset(prev, name, nextRules, id, idBase) : prev));
  }, []);

  const renamePreset = useCallback((id: string, name: string) => {
    setStored(prev => (prev ? withRenamedPreset(prev, id, name) : prev));
  }, []);

  const deletePreset = useCallback((id: string) => {
    setStored(prev => (prev ? withoutPreset(prev, id) : prev));
  }, []);

  return {
    presets,
    activePresetId,
    rules,
    ready: stored !== null,
    setRules,
    selectPreset,
    createPreset,
    renamePreset,
    deletePreset,
    migrateIfNeeded,
  };
}
