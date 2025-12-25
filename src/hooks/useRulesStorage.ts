import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Rule } from '../types';

const STORAGE_KEY = 'vpn-rules';

export function useRulesStorage(
  storageKeySuffix: string | null,
  rules: Rule[],
  setRules: Dispatch<SetStateAction<Rule[]>>
) {
  const isInitialized = useRef(false);
  const prevKeyRef = useRef<string | null>(null);

  const key = storageKeySuffix ? `${STORAGE_KEY}:${storageKeySuffix}` : STORAGE_KEY;

  useEffect(() => {
    if (prevKeyRef.current !== key) {
      isInitialized.current = false;
      prevKeyRef.current = key;
    }

    const saved = localStorage.getItem(key);
    if (saved) {
      try {
        setRules(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to load rules:', e);
        setRules([]);
      }
    } else {
      setRules([]);
    }
    isInitialized.current = true;
  }, [key, setRules]);

  useEffect(() => {
    if (!isInitialized.current) return;
    localStorage.setItem(key, JSON.stringify(rules));
  }, [key, rules]);
}
