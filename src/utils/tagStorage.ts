import type { Tag } from '../types';
import { browserStore, type KeyValueStore } from './rulePresets';

export const TAGS_STORAGE_KEY = 'vpn-tags';
export const TAGS_MIGRATED_KEY = 'vpn-tags-migrated-v1';

function normalizeTag(raw: unknown): Tag | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== 'number' || !Number.isFinite(record.id)) return null;
  if (typeof record.name !== 'string' || !record.name.trim()) return null;
  const color = typeof record.color === 'string' && record.color.trim() ? record.color : '#3b82f6';
  return { id: record.id, name: record.name, color };
}

export function readTags(raw: string | null): Tag[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap(item => {
      const tag = normalizeTag(item);
      return tag ? [tag] : [];
    });
  } catch {
    return [];
  }
}

export function mergeTagLists(lists: Tag[][]): Tag[] {
  const byId = new Map<number, Tag>();
  for (const list of lists) {
    for (const tag of list) {
      if (!byId.has(tag.id)) byId.set(tag.id, tag);
    }
  }
  return [...byId.values()];
}

export function migrateTags(store: KeyValueStore): Tag[] {
  if (store.getItem(TAGS_MIGRATED_KEY) === '1') return readTags(store.getItem(TAGS_STORAGE_KEY));
  const lists: Tag[][] = [];
  for (const key of store.keys()) {
    if (key === TAGS_STORAGE_KEY || key.startsWith(`${TAGS_STORAGE_KEY}:`)) {
      lists.push(readTags(store.getItem(key)));
    }
  }
  const merged = mergeTagLists(lists);
  store.setItem(TAGS_STORAGE_KEY, JSON.stringify(merged));
  for (const key of store.keys()) {
    if (key.startsWith(`${TAGS_STORAGE_KEY}:`)) store.removeItem(key);
  }
  store.setItem(TAGS_MIGRATED_KEY, '1');
  return merged;
}

export function loadGlobalTags(): Tag[] {
  return migrateTags(browserStore());
}
