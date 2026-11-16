import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { memoryStore } from './rulePresets.ts';
import { migrateTags, TAGS_MIGRATED_KEY, TAGS_STORAGE_KEY } from './tagStorage.ts';

describe('migrateTags', () => {
  it('merges per-profile tags into one global list and keeps the first id', () => {
    const store = memoryStore({
      'vpn-tags:config-a.yaml': JSON.stringify([
        { id: 1, name: 'Games', color: '#22c55e' },
        { id: 2, name: 'Work', color: '#3b82f6' },
      ]),
      'vpn-tags:config-b.yaml': JSON.stringify([
        { id: 2, name: 'Other', color: '#ef4444' },
        { id: 3, name: 'Chat', color: '#eab308' },
      ]),
    });

    const tags = migrateTags(store);
    assert.deepEqual(tags.map(tag => [tag.id, tag.name]), [
      [1, 'Games'],
      [2, 'Work'],
      [3, 'Chat'],
    ]);
    assert.equal(store.getItem('vpn-tags:config-a.yaml'), null);
    assert.equal(store.getItem(TAGS_MIGRATED_KEY), '1');
    assert.deepEqual(migrateTags(store).map(tag => tag.id), [1, 2, 3]);
    assert.equal(store.getItem(TAGS_STORAGE_KEY)?.includes('Games'), true);
  });
});
