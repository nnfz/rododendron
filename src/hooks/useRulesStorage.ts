import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Rule } from '../types';

const STORAGE_KEY = 'vpn-rules';

export function useRulesStorage(
  rules: Rule[],
  setRules: Dispatch<SetStateAction<Rule[]>>
) {
  const isInitialized = useRef(false);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        setRules(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to load rules:', e);
      }
    }
    isInitialized.current = true;
  }, [setRules]);

  useEffect(() => {
    if (!isInitialized.current) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rules));
  }, [rules]);
}
