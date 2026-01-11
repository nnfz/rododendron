import { memo, useEffect, useState, useCallback, useMemo, useRef, type Dispatch, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import { LuPlus, LuTrash2, LuSearch, LuMonitor, LuGlobe, LuHash, LuX, LuChevronDown } from 'react-icons/lu';

import { useI18n } from '../i18n';
import type { Rule, Tag } from '../types';
import { isTauri } from '../utils/isTauri';
import CustomSelect from './CustomSelect';

const TAG_COLOR_PRESETS = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#eab308',
  '#22c55e',
  '#10b981',
  '#14b8a6',
  '#06b6d4',
  '#0ea5e9',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#d946ef',
  '#ec4899',
  '#64748b',
  '#94a3b8',
  '#111827',
] as const;

const TAG_FILTER_COLLAPSED_COUNT = 8;
const RULE_GROUPS_COLLAPSED_KEY = 'rules-collapsed-groups-v1';

function normalizeHexColor(input: string): string | null {
  const s = input.trim();
  const v = s.startsWith('#') ? s : `#${s}`;
  if (!/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(v)) return null;
  return v.toLowerCase();
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const n = normalizeHexColor(hex);
  if (!n || n.length < 7) return null;
  const r = parseInt(n.slice(1, 3), 16);
  const g = parseInt(n.slice(3, 5), 16);
  const b = parseInt(n.slice(5, 7), 16);
  return { r, g, b };
}

function rgbToHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.min(255, Math.max(0, Math.round(v)));
  const to2 = (v: number) => clamp(v).toString(16).padStart(2, '0');
  return `#${to2(r)}${to2(g)}${to2(b)}`;
}

function parseTagColor(input: string): { hex: string; alpha: number } | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;

  if (s.startsWith('#')) {
    const n = normalizeHexColor(s);
    if (!n) return null;
    if (n.length === 9) {
      const a = parseInt(n.slice(7, 9), 16);
      return { hex: n.slice(0, 7), alpha: Math.min(1, Math.max(0, a / 255)) };
    }
    return { hex: n.slice(0, 7), alpha: 1 };
  }

  const rgba = s.match(/^rgba\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]*\.?[0-9]+)\s*\)$/);
  if (rgba) {
    const r = Number(rgba[1]);
    const g = Number(rgba[2]);
    const b = Number(rgba[3]);
    const a = Number(rgba[4]);
    if ([r, g, b, a].some(v => Number.isNaN(v))) return null;
    return { hex: rgbToHex(r, g, b), alpha: Math.min(1, Math.max(0, a)) };
  }

  const rgb = s.match(/^rgb\(\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*,\s*([0-9]{1,3})\s*\)$/);
  if (rgb) {
    const r = Number(rgb[1]);
    const g = Number(rgb[2]);
    const b = Number(rgb[3]);
    if ([r, g, b].some(v => Number.isNaN(v))) return null;
    return { hex: rgbToHex(r, g, b), alpha: 1 };
  }

  return null;
}

function cssFromHexAlpha(hex: string, alpha: number): string {
  const rgb = hexToRgb(hex);
  const a = Math.min(1, Math.max(0, alpha));
  if (!rgb) return hex;
  if (a >= 0.999) return hex;
  const rounded = Math.round(a * 1000) / 1000;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${rounded})`;
}

function normalizeRuleFromClipboard(raw: unknown, fallbackId: number): Rule | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;

  const app = typeof r.app === 'string' ? r.app : '';
  const rule = typeof r.rule === 'string' ? r.rule : '';
  const active = typeof r.active === 'boolean' ? r.active : true;
  const ruleType = r.ruleType;

  const allowedTypes: Rule['ruleType'][] = ['process', 'domain', 'domain_keyword', 'ip'];
  const normalizedType: Rule['ruleType'] =
    typeof ruleType === 'string' && (allowedTypes as string[]).includes(ruleType)
      ? (ruleType as Rule['ruleType'])
      : 'process';

  if (!app.trim() || !rule.trim()) return null;

  const id = typeof r.id === 'number' && Number.isFinite(r.id) ? r.id : fallbackId;

  return {
    id,
    app,
    rule,
    active,
    ruleType: normalizedType,
  };
}

function ColorPicker({
  value,
  onChange,
  ariaLabel,
}: {
  value: string;
  onChange: (next: string) => void;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const parsed = useMemo(() => parseTagColor(value), [value]);
  const baseHex = parsed?.hex ?? '#3b82f6';
  const currentAlpha = parsed?.alpha ?? 1;

  const [draftHex, setDraftHex] = useState(baseHex);
  const [draftAlpha, setDraftAlpha] = useState(currentAlpha);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (open) return;
    setDraftHex(baseHex);
    setDraftAlpha(currentAlpha);
  }, [baseHex, currentAlpha, open]);

  useEffect(() => {
    if (!open) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) {
      const gap = 10;
      const width = 232;
      const left = Math.min(Math.max(8, rect.right - width), window.innerWidth - width - 8);
      const top = Math.min(rect.bottom + gap, window.innerHeight - 8);
      setPos({ top, left });
    }
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('.color-picker-root')) return;
      if (target.closest('.color-popover')) return;
      setOpen(false);
    };

    const onResizeOrScroll = () => {
      const r = anchorRef.current?.getBoundingClientRect();
      if (!r) return;
      const gap = 10;
      const width = 232;
      const left = Math.min(Math.max(8, r.right - width), window.innerWidth - width - 8);
      const top = Math.min(r.bottom + gap, window.innerHeight - 8);
      setPos({ top, left });
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onResizeOrScroll);
    window.addEventListener('scroll', onResizeOrScroll, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onResizeOrScroll);
      window.removeEventListener('scroll', onResizeOrScroll, true);
    };
  }, [open]);

  const applyHex = useCallback(() => {
    const normalized = normalizeHexColor(draftHex);
    if (!normalized) return;

    if (normalized.length === 9) {
      const parsedInline = parseTagColor(normalized);
      if (!parsedInline) return;
      setDraftHex(parsedInline.hex);
      setDraftAlpha(parsedInline.alpha);
      onChange(cssFromHexAlpha(parsedInline.hex, parsedInline.alpha));
      return;
    }

    onChange(cssFromHexAlpha(normalized.slice(0, 7), draftAlpha));
  }, [draftAlpha, draftHex, onChange]);

  return (
    <div className="color-picker-root">
      <button
        type="button"
        className="color-swatch-btn"
        style={{ background: cssFromHexAlpha(baseHex, currentAlpha) }}
        aria-label={ariaLabel}
        ref={anchorRef}
        onClick={() => setOpen(v => !v)}
      />

      {open
        ? createPortal(
            <div
              className="color-popover"
              role="dialog"
              aria-label={ariaLabel}
              style={{ top: pos.top, left: pos.left }}
            >
              <div className="color-grid">
                {TAG_COLOR_PRESETS.map(c => (
                  <button
                    key={c}
                    type="button"
                    className={`color-swatch ${c.toLowerCase() === baseHex.toLowerCase() ? 'active' : ''}`}
                    style={{ background: c }}
                    onClick={() => {
                      setDraftHex(c);
                      onChange(cssFromHexAlpha(c, draftAlpha));
                    }}
                  />
                ))}
              </div>

              <div className="color-alpha-row">
                <span className="color-alpha-label">Opacity</span>
                <div
                  className="color-alpha-track"
                  style={{ ['--alpha-pct' as any]: `${Math.round(draftAlpha * 100)}%` }}
                >
                  <input
                    type="range"
                    className="color-alpha-slider"
                    min={0}
                    max={100}
                    value={Math.round(draftAlpha * 100)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onPointerDown={(e) => e.stopPropagation()}
                    onInput={(e) => {
                      const next = Math.min(1, Math.max(0, Number((e.target as HTMLInputElement).value) / 100));
                      setDraftAlpha(next);
                      const normalized = normalizeHexColor(draftHex)?.slice(0, 7) ?? baseHex;
                      onChange(cssFromHexAlpha(normalized, next));
                    }}
                    onChange={(e) => {
                      const next = Math.min(1, Math.max(0, Number(e.target.value) / 100));
                      setDraftAlpha(next);
                      const normalized = normalizeHexColor(draftHex)?.slice(0, 7) ?? baseHex;
                      onChange(cssFromHexAlpha(normalized, next));
                    }}
                  />
                </div>
                <span className="color-alpha-value">{Math.round(draftAlpha * 100)}%</span>
              </div>

              <div className="color-hex-row">
                <input
                  type="text"
                  className="input color-hex-input"
                  value={draftHex}
                  onChange={e => setDraftHex(e.target.value)}
                  onBlur={applyHex}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      applyHex();
                      setOpen(false);
                    }
                  }}
                  spellCheck={false}
                  inputMode="text"
                />
                <label className="color-native-wrap">
                  <input
                    type="color"
                    value={baseHex}
                    onChange={e => {
                      const next = normalizeHexColor(e.target.value)?.slice(0, 7) ?? e.target.value;
                      setDraftHex(next);
                      onChange(cssFromHexAlpha(next, draftAlpha));
                    }}
                    aria-label={ariaLabel}
                  />
                  <span className="btn btn-ghost-dark">More</span>
                </label>
              </div>
            </div>,
            document.body
          )
        : null}
    </div>
  );
}

interface RulesPageProps {
  rules: Rule[];
  setRules: Dispatch<SetStateAction<Rule[]>>;
  tags: Tag[];
  setTags: Dispatch<SetStateAction<Tag[]>>;
  vpnEnabled: boolean;
  restartVPN: (rulesOverride?: Rule[]) => Promise<void>;
  activeConfigFilename: string | null;
  autoRestartOnRuleApply: boolean;
}

type RuleType = 'process' | 'domain' | 'domain_keyword';

interface ProcessInfo {
  name: string;
  pid: number;
  path?: string | null;
  icon?: string | null;
}

const RULE_TYPE_ICONS = {
  process: LuMonitor,
  domain: LuGlobe,
  domain_keyword: LuHash,
} as const;

const RULE_TYPE_LABELS = {
  process: 'Process',
  domain: 'Domain',
  domain_keyword: 'Keyword',
} as const;

function RulesPage({ rules, setRules, tags, setTags, vpnEnabled, restartVPN, autoRestartOnRuleApply }: RulesPageProps) {
  const { t } = useI18n();
  const [osPlatform, setOsPlatform] = useState<'windows' | 'macos' | 'linux' | 'unknown'>('unknown');
  const [newRuleApp, setNewRuleApp] = useState('');
  const [newRuleType, setNewRuleType] = useState<RuleType>('process');
  const [newRuleAction, setNewRuleAction] = useState<'Via VPN' | 'Direct'>('Via VPN');

  const [newRuleInputError, setNewRuleInputError] = useState(false);
  const [newRuleInputShake, setNewRuleInputShake] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedTagId, setSelectedTagId] = useState<number | null>(null);
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [collapsedRuleGroups, setCollapsedRuleGroups] = useState<Record<string, boolean>>({});
  const [showTagsManager, setShowTagsManager] = useState(false);
  const [ruleTagsPopover, setRuleTagsPopover] = useState<null | { ruleId: number; top: number; left: number }>(null);
  const ruleTagsAnchorRef = useRef<HTMLElement | null>(null);
  const ruleTagsPopoverRef = useRef<HTMLDivElement | null>(null);

  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#3b82f6');
  const [showProcessScanner, setShowProcessScanner] = useState(false);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [isLoadingProcesses, setIsLoadingProcesses] = useState(false);
  const [processSearchQuery, setProcessSearchQuery] = useState('');

  const tagsById = useMemo(() => {
    const m = new Map<number, Tag>();
    for (const tag of tags) m.set(tag.id, tag);
    return m;
  }, [tags]);

  const tagsForFilterBar = useMemo(() => {
    if (tagsExpanded) return tags;
    const base = tags.slice(0, TAG_FILTER_COLLAPSED_COUNT);
    if (selectedTagId === null) return base;
    if (base.some(tg => tg.id === selectedTagId)) return base;
    const selected = tagsById.get(selectedTagId);
    return selected ? [...base, selected] : base;
  }, [tags, tagsExpanded, selectedTagId, tagsById]);

  useEffect(() => {
    if (!isTauri()) return;
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes('windows')) setOsPlatform('windows');
    else if (ua.includes('mac os') || ua.includes('macos')) setOsPlatform('macos');
    else if (ua.includes('linux')) setOsPlatform('linux');
    else setOsPlatform('unknown');
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(RULE_GROUPS_COLLAPSED_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== 'object') return;
      setCollapsedRuleGroups(parsed as Record<string, boolean>);
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(RULE_GROUPS_COLLAPSED_KEY, JSON.stringify(collapsedRuleGroups));
    } catch {
      // ignore
    }
  }, [collapsedRuleGroups]);

  const copyRulesToClipboard = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(
          rules.map(({ tags: _tags, ...rest }) => rest)
        )
      );
    } catch (e) {
      console.error('Failed to copy rules to clipboard:', e);
    }
  }, [rules]);

  const pasteRulesFromClipboard = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) return;

      const parsed = JSON.parse(text) as unknown;
      const candidate =
        Array.isArray(parsed)
          ? parsed
          : parsed && typeof parsed === 'object' && Array.isArray((parsed as any).rules)
            ? (parsed as any).rules
            : null;

      if (!candidate) return;

      const base = Date.now();
      const normalized: Rule[] = [];
      for (let i = 0; i < candidate.length; i++) {
        const r = normalizeRuleFromClipboard(candidate[i], base + i);
        if (r) normalized.push(r);
      }

      if (normalized.length === 0) return;

      const usedIds = new Set<number>();
      const deduped: Rule[] = [];
      for (let i = 0; i < normalized.length; i++) {
        let next = normalized[i];
        while (usedIds.has(next.id)) next = { ...next, id: base + normalized.length + i };
        usedIds.add(next.id);
        deduped.push(next);
      }

      setRuleTagsPopover(null);
      ruleTagsAnchorRef.current = null;
      setRules(deduped);
    } catch (e) {
      console.error('Failed to paste rules from clipboard:', e);
    }
  }, [setRules]);

  const loadProcesses = useCallback(async () => {
    if (!isTauri()) return;
    setIsLoadingProcesses(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const procs = await invoke<ProcessInfo[]>('get_running_processes');
      setProcesses(procs);
    } catch (e) {
      console.error('Failed to load processes:', e);
    } finally {
      setIsLoadingProcesses(false);
    }
  }, []);

  const openProcessScanner = useCallback(() => {
    setShowProcessScanner(true);
    loadProcesses();
  }, [loadProcesses]);

  const selectProcess = useCallback((processName: string) => {
    setNewRuleApp(processName);
    setShowProcessScanner(false);
    setProcessSearchQuery('');
  }, []);

  const toggleRule = useCallback(async (id: number) => {
    const nextRules = rules.map(r => r.id === id ? { ...r, active: !r.active } : r);
    setRules(nextRules);
    if (vpnEnabled && autoRestartOnRuleApply) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await restartVPN(nextRules);
    }
  }, [rules, setRules, vpnEnabled, restartVPN, autoRestartOnRuleApply]);

  const isValidProcessTarget = useCallback((raw: string): boolean => {
    const s = raw.trim();
    if (!s) return false;
    const lower = s.toLowerCase();

    if (lower.includes('://') || s.includes('/') || s.includes('\\')) return false;
    if (/[<>:"|?*]/.test(s)) return false;
    if (lower.endsWith('.com')) return false;

    if (osPlatform === 'windows') {
      if (s.includes('@')) return false;
      const allowedExtensions = ['.exe', '.bat', '.cmd', '.scr'];
      if (!allowedExtensions.some(ext => lower.endsWith(ext))) return false;
      return true;
    }

    if (s.includes('@')) return false;
    return true;
  }, [osPlatform]);

  const triggerNewRuleInputError = useCallback(() => {
    setNewRuleInputError(true);
    setNewRuleInputShake(true);
    setTimeout(() => setNewRuleInputShake(false), 400);
  }, []);

  const deleteRule = useCallback(async (id: number) => {
    const nextRules = rules.filter(r => r.id !== id);
    setRules(nextRules);
    if (vpnEnabled && autoRestartOnRuleApply) {
      await restartVPN(nextRules);
    }
  }, [rules, setRules, vpnEnabled, restartVPN, autoRestartOnRuleApply]);

  const addRule = useCallback(async () => {
    const normalizeTarget = (raw: string) => {
      const t = raw.trim();
      if (!t) return '';
      if (newRuleType === 'domain' || newRuleType === 'domain_keyword') {
        return t.toLowerCase();
      }
      return t;
    };

    const targets = newRuleApp
      .split(',')
      .map(normalizeTarget)
      .filter(Boolean);

    if (targets.length === 0) return;

    if (newRuleType === 'process') {
      const hasInvalid = targets.some(t => !isValidProcessTarget(t));
      if (hasInvalid) {
        triggerNewRuleInputError();
        return;
      }
    }

    const existingKeys = new Set(rules.map(r => `${r.ruleType}:${r.app.toLowerCase()}:${r.rule}`));
    const seenInInput = new Set<string>();

    const baseId = Date.now();
    const newRules: Rule[] = [];
    
    for (const target of targets) {
      const key = `${newRuleType}:${target.toLowerCase()}:${newRuleAction}`;
      if (existingKeys.has(key) || seenInInput.has(key)) continue;
      seenInInput.add(key);
      newRules.push({
        id: baseId + newRules.length,
        app: target,
        rule: newRuleAction,
        active: true,
        ruleType: newRuleType,
      });
    }

    if (newRules.length === 0) {
      setNewRuleInputError(false);
      return;
    }

    const nextRules = [...rules, ...newRules];
    setRules(nextRules);
    setNewRuleApp('');
    setNewRuleInputError(false);

    if (vpnEnabled && autoRestartOnRuleApply) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await restartVPN(nextRules);
    }
  }, [newRuleApp, newRuleAction, newRuleType, rules, setRules, vpnEnabled, restartVPN, autoRestartOnRuleApply, isValidProcessTarget, triggerNewRuleInputError]);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      addRule();
    }
  }, [addRule]);

  const createTag = useCallback(() => {
    const name = newTagName.trim();
    if (!name) return;
    const color = newTagColor || '#3b82f6';

    const tag: Tag = {
      id: Date.now(),
      name,
      color,
    };
    setTags(prev => [...prev, tag]);
    setNewTagName('');
  }, [newTagColor, newTagName, setTags]);

  const updateTag = useCallback((id: number, patch: Partial<Pick<Tag, 'name' | 'color'>>) => {
    setTags(prev => prev.map(tg => (tg.id === id ? { ...tg, ...patch } : tg)));
  }, [setTags]);

  const deleteTag = useCallback((id: number) => {
    setTags(prev => prev.filter(tg => tg.id !== id));
    setRules(prev => prev.map(r => ({
      ...r,
      tags: (r.tags || []).filter(tid => tid !== id),
    })));
    setSelectedTagId(prev => (prev === id ? null : prev));
  }, [setRules, setTags]);

  const toggleRuleTag = useCallback(async (ruleId: number, tagId: number) => {
    const nextRules = rules.map(r => {
      if (r.id !== ruleId) return r;
      const current = r.tags || [];
      const next = current.includes(tagId) ? current.filter(x => x !== tagId) : [...current, tagId];
      return { ...r, tags: next };
    });
    setRules(nextRules);
    if (vpnEnabled && autoRestartOnRuleApply) {
      await restartVPN(nextRules);
    }
  }, [rules, setRules, vpnEnabled, restartVPN, autoRestartOnRuleApply]);

  const formatTagName = useCallback((name: string) => {
    const max = 8;
    if (name.length <= max) return name;
    return `${name.slice(0, max)}...`;
  }, []);

  const openRuleTagsPopover = useCallback((ruleId: number, anchorEl: HTMLElement) => {
    ruleTagsAnchorRef.current = anchorEl;
    const rect = anchorEl.getBoundingClientRect();
    const gap = 10;
    const popW = ruleTagsPopoverRef.current?.offsetWidth ?? 300;
    const popH = ruleTagsPopoverRef.current?.offsetHeight ?? 320;

    const left = Math.min(Math.max(8, rect.left), window.innerWidth - popW - 8);
    const belowTop = rect.bottom + gap;
    const aboveTop = rect.top - gap - popH;
    const maxTop = Math.max(8, window.innerHeight - popH - 8);

    const clamp = (v: number) => Math.min(Math.max(8, v), maxTop);
    const topBelow = clamp(belowTop);
    const topAbove = clamp(aboveTop);
    const belowFits = belowTop + popH <= window.innerHeight - 8;
    const aboveFits = aboveTop >= 8;

    let top = topBelow;
    if (!belowFits && aboveFits) {
      top = topAbove;
    } else if (!belowFits && !aboveFits) {
      const shiftBelow = Math.abs(topBelow - belowTop);
      const shiftAbove = Math.abs(topAbove - aboveTop);
      top = shiftAbove < shiftBelow ? topAbove : topBelow;
    }
    setRuleTagsPopover(prev => (prev ? { ...prev, top, left } : { ruleId, top, left }));
  }, []);

  const filteredRules = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return rules.filter(rule => {
      if (q && !rule.app.toLowerCase().includes(q)) return false;
      if (selectedTagId !== null) {
        const tids = rule.tags || [];
        if (!tids.includes(selectedTagId)) return false;
      }
      return true;
    });
  }, [rules, searchQuery, selectedTagId]);

  const ruleGroups = useMemo(() => {
    type Group = { key: string; title: string; color: string | null; rules: Rule[] };
    const map = new Map<string, Group>();

    for (const r of filteredRules) {
      const tagId = (r.tags && r.tags.length > 0) ? r.tags[0] : null;
      if (tagId === null) {
        const key = 'untagged';
        const existing = map.get(key);
        if (existing) existing.rules.push(r);
        else map.set(key, { key, title: t.rules.noTags, color: null, rules: [r] });
        continue;
      }

      const tag = tagsById.get(tagId);
      const key = `tag:${tagId}`;
      const title = tag?.name ?? `Tag ${tagId}`;
      const color = tag?.color ?? '#64748b';
      const existing = map.get(key);
      if (existing) existing.rules.push(r);
      else map.set(key, { key, title, color, rules: [r] });
    }

    const list = Array.from(map.values());
    for (const g of list) g.rules.sort((a, b) => a.app.localeCompare(b.app));

    const untaggedIdx = list.findIndex(g => g.key === 'untagged');
    const untagged = untaggedIdx >= 0 ? list.splice(untaggedIdx, 1)[0] : null;
    list.sort((a, b) => a.title.localeCompare(b.title));
    if (untagged) list.push(untagged);
    return list;
  }, [filteredRules, tagsById, t.rules.noTags]);

  const filteredProcesses = useMemo(() =>
    processes.filter(proc => proc.name.toLowerCase().includes(processSearchQuery.toLowerCase())),
    [processes, processSearchQuery]
  );

  const getRuleTypeLabel = useCallback((type: string) => {
    return RULE_TYPE_LABELS[type as keyof typeof RULE_TYPE_LABELS] || type;
  }, []);

  const getRuleTypeLabelPlaceholder = useCallback((type: string) => {
    switch (type) {
      case 'process': return osPlatform === 'windows' ? 'chrome.exe' : 'Google Chrome';
      case 'domain': return 'youtube.com';
      case 'domain_keyword': return 'youtube';
      default: return type;
    }
  }, [osPlatform]);

  const getRuleTypeIcon = useCallback((type: string) => {
    const Icon = RULE_TYPE_ICONS[type as keyof typeof RULE_TYPE_ICONS] || LuMonitor;
    return <Icon size={14} />;
  }, []);

  const getAppNameTranslation = useCallback((appName: string) => {
    switch (appName) {
      case 'process': return t.rules.process;
      case 'domain': return t.rules.domain;
      case 'domain_keyword': return t.rules.domainkey;
      default: return appName;
    }
  }, [t.rules]);

  const ruleActionOptions = useMemo(() => [
    { value: 'Via VPN', label: t.rules.viaVpn },
    { value: 'Direct', label: t.rules.direct },
  ], [t.rules.viaVpn, t.rules.direct]);

  return (
    <div className="page-content">
      <div className="page-header">
        <h2 className="page-title">{t.rules.title}</h2>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className="btn btn-ghost-dark" onClick={copyRulesToClipboard}>
            {t.rules.copy}
          </button>
          <button type="button" className="btn btn-ghost-dark" onClick={pasteRulesFromClipboard}>
            {t.rules.paste}
          </button>
        </div>
      </div>

      <div className="container-narrow">
        <div className="panel">
          <div className="add-rule-form">
            <div className="add-rule-type-selector">
              <button
                onClick={() => setNewRuleType('process')}
                className={`type-btn ${newRuleType === 'process' ? 'active' : ''}`}
              >
                <LuMonitor size={16} />
                {t.rules.process}
              </button>
              <button
                onClick={() => setNewRuleType('domain')}
                className={`type-btn ${newRuleType === 'domain' ? 'active' : ''}`}
              >
                <LuGlobe size={16} />
                {t.rules.domain}
              </button>
              <button
                onClick={() => setNewRuleType('domain_keyword')}
                className={`type-btn ${newRuleType === 'domain_keyword' ? 'active' : ''}`}
              >
                <LuHash size={16} />
                {t.rules.domainkey}
              </button>
            </div>

            <div className="add-rule-row">
              <div className="add-rule-input">
                <input
                  type="text"
                  placeholder={`${getRuleTypeLabelPlaceholder(newRuleType).toLowerCase()}`}
                  value={newRuleApp}
                  onChange={e => {
                    setNewRuleApp(e.target.value);
                    setNewRuleInputError(false);
                  }}
                  onKeyPress={handleKeyPress}
                  className={`input ${newRuleInputError ? 'input-error' : ''} ${newRuleInputShake ? 'input-shake' : ''}`}
                  style={{ width: '100%' }}
                />
              </div>
              <CustomSelect
                value={newRuleAction}
                onChange={(val) => setNewRuleAction(val as 'Via VPN' | 'Direct')}
                options={ruleActionOptions}
                className="add-rule-select"
                style={{ width: '10rem' }}
              />
              {newRuleType === 'process' && isTauri() && (
                <button onClick={openProcessScanner} className="btn btn-ghost-dark">
                  <LuSearch size={18} />
                  {t.rules.scan}
                </button>
              )}
              <button onClick={addRule} className="btn btn-primary-dark">
                <LuPlus size={18} />
                {t.rules.addRule}
              </button>
            </div>
          </div>
        </div>

        {rules.length > 0 && (
          <div className="panel">
            <div className="panel-row disabled rules-search-row">
              <div className="rules-searchbox">
                <LuSearch size={18} />
                <input
                  type="text"
                  placeholder={t.rules.searchRules}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="rules-search-input"
                />
              </div>
            </div>

            <div className="panel-row disabled rules-tags-row" style={{ gap: '0.75rem', alignItems: 'flex-start' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1, minWidth: 0 }}>
                <span className="setting-label">{t.rules.tags}</span>
                <div className="tag-filter-bar">
                  <button
                    type="button"
                    className={`tag-filter-chip ${selectedTagId === null ? 'active' : ''}`}
                    onClick={() => setSelectedTagId(null)}
                  >
                    {t.rules.allTags}
                  </button>
                  {tagsForFilterBar.map(tag => (
                    <button
                      key={tag.id}
                      type="button"
                      className={`tag-filter-chip ${selectedTagId === tag.id ? 'active' : ''}`}
                      style={{ background: tag.color }}
                      onClick={() => setSelectedTagId(tag.id)}
                      title={tag.name}
                    >
                      {formatTagName(tag.name)}
                    </button>
                  ))}
                  {tags.length > TAG_FILTER_COLLAPSED_COUNT && (
                    <button
                      type="button"
                      className={`tag-collapse-btn ${tagsExpanded ? 'expanded' : ''}`}
                      onClick={() => setTagsExpanded(v => !v)}
                      aria-label={tagsExpanded ? 'Collapse tags' : 'Expand tags'}
                      title={tagsExpanded ? 'Collapse tags' : 'Expand tags'}
                    >
                      <LuChevronDown size={14} />
                    </button>
                  )}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '0.5rem' }}>
                <button type="button" className="btn btn-ghost-dark" onClick={() => setShowTagsManager(true)}>
                  {t.rules.manageTags}
                </button>
              </div>
            </div>
          </div>
        )}

        {filteredRules.length > 0 ? (
          <div className="panel">
            <div className="header-grid grid-12">
              <div className="col-span-1">{t.rules.type}</div>
              <div className="col-span-4">{t.rules.target}</div>
              <div className="col-span-2">{t.rules.tags}</div>
              <div className="col-span-2">{t.rules.action}</div>
              <div className="col-span-2">{t.rules.status}</div>
              <div className="col-span-1 text-right">{t.rules.actions}</div>
            </div>

            {ruleGroups.map(group => {
              const collapsed = !!collapsedRuleGroups[group.key];
              const toggleGroup = () => setCollapsedRuleGroups(prev => ({ ...prev, [group.key]: !prev[group.key] }));
              return (
                <div key={group.key} className="rules-group">
                  <div className="rules-group-header-row">
                    <button
                      type="button"
                      className={`rules-group-toggle ${collapsed ? 'collapsed' : ''}`}
                      onClick={toggleGroup}
                      aria-label={collapsed ? 'Expand group' : 'Collapse group'}
                      title={collapsed ? 'Expand group' : 'Collapse group'}
                    >
                      <LuChevronDown size={16} className="rules-group-chevron" />
                    </button>

                    <div
                      className="rules-group-title"
                      title={group.title}
                      onClick={toggleGroup}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          toggleGroup();
                        }
                      }}
                    >
                      {group.color ? <span className="rules-group-dot" style={{ background: group.color }} /> : null}
                      <span className="rules-group-name">{group.title}</span>
                      <span className="rules-group-count">{group.rules.length}</span>
                    </div>
                  </div>

                  {collapsed
                    ? null
                    : group.rules.map(rule => (
                        <div key={rule.id} className="row grid-12">
                          <div className="col-span-1">
                            <span className="rule-type-badge">
                              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                {getRuleTypeIcon(rule.ruleType)}
                                {getRuleTypeLabel(getAppNameTranslation(rule.ruleType))}
                              </div>
                            </span>
                          </div>
                          <div className="col-span-4">
                            <span className="rule-app">{rule.app}</span>
                          </div>
                          <div className="col-span-2">
                            <button
                              type="button"
                              className="rule-tags-cell"
                              onClick={(e) => openRuleTagsPopover(rule.id, e.currentTarget)}
                            >
                              <div className="rule-tags-wrap">
                                {(rule.tags || []).map(tid => {
                                  const tag = tagsById.get(tid);
                                  if (!tag) return null;
                                  return (
                                    <span key={tid} className="tag-chip" style={{ background: tag.color }} title={tag.name}>
                                      {formatTagName(tag.name)}
                                    </span>
                                  );
                                })}
                                {(rule.tags || []).length === 0 ? (
                                  <span className="tag-chip tag-chip-empty">{t.rules.noTags}</span>
                                ) : null}
                              </div>
                            </button>
                          </div>
                          <div className="col-span-2">
                            <span className={`tag ${rule.rule === 'Via VPN' ? 'tag-proxy-active' : 'tag-proxy-inactive'}`}>
                              {rule.rule === 'Via VPN' ? t.rules.viaVpn : t.rules.direct}
                            </span>
                          </div>
                          <div className="col-span-2">
                            <button
                              onClick={() => toggleRule(rule.id)}
                              className={`btn-pill ${rule.active ? 'active' : 'inactive'}`}
                            >
                              {rule.active ? t.rules.active : t.rules.inactive}
                            </button>
                          </div>
                          <div className="col-span-1 text-right">
                            <button onClick={() => deleteRule(rule.id)} className="btn btn-icon">
                              <LuTrash2 size={18} />
                            </button>
                          </div>
                        </div>
                      ))}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="panel">
            <div className="panel-row disabled" style={{ justifyContent: 'center', padding: '3rem' }}>
              <span className="setting-label">
                {searchQuery ? 'No rules found' : t.rules.noRules}
              </span>
            </div>
          </div>
        )}
      </div>

      {showProcessScanner && (
        <div className="modal-backdrop" onClick={() => setShowProcessScanner(false)}>
          <div className="modal process-scanner-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{t.rules.runningProcesses}</h3>
              <button onClick={() => setShowProcessScanner(false)} className="btn btn-icon">
                <LuX size={18} />
              </button>
            </div>
            <div className="process-search">
              <input
                type="text"
                placeholder={t.rules.searchProcesses}
                value={processSearchQuery}
                onChange={e => setProcessSearchQuery(e.target.value)}
                className="input"
                style={{ width: '100%' }}
                autoFocus
              />
            </div>
            <div className="process-list">
              {isLoadingProcesses ? (
                <div className="process-loading">
                  <LuMonitor size={24} className="spin" />
                  {t.rules.loadingProcesses}
                </div>
              ) : filteredProcesses.length > 0 ? (
                filteredProcesses.map(proc => (
                  <div
                    key={proc.pid}
                    className="process-item"
                    onClick={() => selectProcess(proc.name)}
                  >
                    <div className="process-icon">
                      {proc.icon ? (
                        <img
                          src={`data:image/png;base64,${proc.icon}`}
                          alt={proc.name}
                          draggable={false}
                        />
                      ) : (
                        <LuMonitor size={18} />
                      )}
                    </div>
                    <div className="process-info">
                      <div className="process-name">{proc.name}</div>
                      {proc.path ? <div className="process-path">{proc.path}</div> : null}
                    </div>
                    <div className="process-pid">PID: {proc.pid}</div>
                  </div>
                ))
              ) : (
                <div className="process-empty">{t.rules.noProcessesFound}</div>
              )}
            </div>
          </div>
        </div>
      )}

      {showTagsManager && (
        <div className="modal-backdrop" onClick={() => setShowTagsManager(false)}>
          <div className="modal tags-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{t.rules.manageTags}</h3>
              <button onClick={() => setShowTagsManager(false)} className="btn btn-icon">
                <LuX size={18} />
              </button>
            </div>

            <div className="modal-body">
              <div className="tags-manager-create">
                <input
                  type="text"
                  className="input"
                  value={newTagName}
                  placeholder={t.rules.tagName}
                  onChange={e => setNewTagName(e.target.value)}
                  style={{ flex: 1 }}
                />
                <ColorPicker
                  value={newTagColor}
                  onChange={setNewTagColor}
                  ariaLabel={t.rules.tagColor}
                />
                <button type="button" className="btn btn-primary-dark" onClick={createTag}>
                  {t.rules.newTag}
                </button>
              </div>

              <div className="tags-manager-list">
                {tags.map(tag => (
                  <div key={tag.id} className="tags-manager-row">
                    <span className="tag-chip" style={{ background: tag.color }} title={tag.name}>{formatTagName(tag.name)}</span>
                    <input
                      type="text"
                      className="input"
                      value={tag.name}
                      onChange={e => updateTag(tag.id, { name: e.target.value })}
                      style={{ flex: 1 }}
                    />
                    <ColorPicker
                      value={tag.color}
                      onChange={(c) => updateTag(tag.id, { color: c })}
                      ariaLabel={t.rules.tagColor}
                    />
                    <button type="button" className="btn btn-icon" onClick={() => deleteTag(tag.id)}>
                      <LuTrash2 size={18} />
                    </button>
                  </div>
                ))}
                {tags.length === 0 ? (
                  <div className="tags-empty">{t.rules.noTagsYet}</div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      )}

      {ruleTagsPopover
        ? (() => {
            const rule = rules.find(r => r.id === ruleTagsPopover.ruleId) || null;
            return createPortal(
              <div
                className="rule-tags-popover"
                role="dialog"
                aria-label={t.rules.editRuleTags}
                style={{ top: ruleTagsPopover.top, left: ruleTagsPopover.left }}
                ref={ruleTagsPopoverRef}
              >
                <div className="rule-tags-popover-body">
                  <div className="rule-tags-popover-list">
                    {tags.map(tag => {
                      const isOn = !!(rule?.tags || []).includes(tag.id);
                      return (
                        <label key={tag.id} className="rule-tag-toggle">
                          <input
                            type="checkbox"
                            checked={isOn}
                            onChange={() => void toggleRuleTag(ruleTagsPopover.ruleId, tag.id)}
                          />
                          <span className="ui-checkbox" aria-hidden="true" />
                          <span className="tag-chip" style={{ background: tag.color }} title={tag.name}>{formatTagName(tag.name)}</span>
                        </label>
                      );
                    })}
                    {tags.length === 0 ? (
                      <div className="tags-empty">{t.rules.noTagsYet}</div>
                    ) : null}
                  </div>
                </div>
              </div>,
              document.body
            );
          })()
        : null}
    </div>
  );
}

export default memo(RulesPage);