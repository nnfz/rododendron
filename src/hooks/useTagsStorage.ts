import { useEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { Tag } from '../types';
import { loadGlobalTags, TAGS_STORAGE_KEY } from '../utils/tagStorage';
import { browserStore } from '../utils/rulePresets';

export function useTagsStorage(
  tags: Tag[],
  setTags: Dispatch<SetStateAction<Tag[]>>
) {
  const skipSave = useRef(true);

  useEffect(() => {
    skipSave.current = true;
    setTags(loadGlobalTags());
  }, [setTags]);

  useEffect(() => {
    if (skipSave.current) {
      skipSave.current = false;
      return;
    }
    browserStore().setItem(TAGS_STORAGE_KEY, JSON.stringify(tags));
  }, [tags]);
}
