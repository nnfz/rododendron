import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Tag } from '../types';

const STORAGE_KEY = 'vpn-tags';

export function useTagsStorage(
  storageKeySuffix: string | null,
  tags: Tag[],
  setTags: Dispatch<SetStateAction<Tag[]>>
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
        setTags(JSON.parse(saved));
      } catch (e) {
        console.error('Failed to load tags:', e);
        setTags([]);
      }
    } else {
      setTags([]);
    }
    isInitialized.current = true;
  }, [key, setTags]);

  useEffect(() => {
    if (!isInitialized.current) return;
    localStorage.setItem(key, JSON.stringify(tags));
  }, [key, tags]);
}
