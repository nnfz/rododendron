import type { ParsedRule, Rule } from '../types';
import { selectSubscriptionRules, subscriptionRuleKey } from './subscriptionRules';

export const PRESETS_STORAGE_KEY = 'vpn-rule-presets';
export const ACTIVE_PRESET_STORAGE_KEY = 'vpn-active-rule-preset';
export const LEGACY_RULES_KEY = 'vpn-rules';
export const DEFAULT_PRESET_ID = 'default';

export interface RulePreset {
  id: string;
  name: string;
  rules: Rule[];
}

export interface StoredPresets {
  presets: RulePreset[];
  activeId: string;
}

export interface ProfileRuleHint {
  id: string;
  name: string;
  /** null for a local profile. An array is the subscription metadata list. */
  userRuleLines: string[] | null;
  /** Rules already parsed from a local profile file. Ignored for subscriptions. */
  parsedRules?: ParsedRule[];
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys(): string[];
}

export interface RuleTemplate {
  id: string;
  rules: Array<{ app: string; rule: 'Via VPN' | 'Direct'; ruleType: Rule['ruleType'] }>;
}

export const RULE_TEMPLATES: RuleTemplate[] = [
  {
    id: 'browsers',
    rules: ['chrome.exe', 'msedge.exe', 'firefox.exe', 'opera.exe', 'brave.exe'].map(app => ({
      app,
      rule: 'Via VPN' as const,
      ruleType: 'process' as const,
    })),
  },
  {
    id: 'messengers',
    rules: ['Telegram.exe', 'Discord.exe'].map(app => ({
      app,
      rule: 'Via VPN' as const,
      ruleType: 'process' as const,
    })),
  },
  {
    id: 'launchers',
    rules: ['steam.exe', 'steamwebhelper.exe', 'EpicGamesLauncher.exe'].map(app => ({
      app,
      rule: 'Direct' as const,
      ruleType: 'process' as const,
    })),
  },
];

const RULE_TYPES = new Set<Rule['ruleType']>(['process', 'domain', 'domain_keyword', 'ip']);

export function memoryStore(initial: Record<string, string> = {}): KeyValueStore {
  const data = { ...initial };
  return {
    getItem: key => (Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null),
    setItem: (key, value) => {
      data[key] = value;
    },
    removeItem: key => {
      delete data[key];
    },
    keys: () => Object.keys(data),
  };
}

export function browserStore(): KeyValueStore {
  return {
    getItem: key => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
    removeItem: key => localStorage.removeItem(key),
    keys: () => {
      const keys: string[] = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key) keys.push(key);
      }
      return keys;
    },
  };
}

export function normalizeStoredRule(raw: unknown, fallbackId: number): Rule | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const app = typeof record.app === 'string' ? record.app.trim() : '';
  const rule = typeof record.rule === 'string' ? record.rule.trim() : '';
  if (!app || !rule) return null;
  const ruleType = typeof record.ruleType === 'string' && RULE_TYPES.has(record.ruleType as Rule['ruleType'])
    ? record.ruleType as Rule['ruleType']
    : 'process';
  const id = typeof record.id === 'number' && Number.isFinite(record.id) ? record.id : fallbackId;
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is number => typeof tag === 'number' && Number.isFinite(tag))
    : [];
  return {
    id,
    app,
    rule,
    active: typeof record.active === 'boolean' ? record.active : true,
    ruleType,
    tags: tags.length > 0 ? tags : undefined,
  };
}

export function normalizeRuleList(value: unknown): Rule[] {
  if (!Array.isArray(value)) return [];
  const used = new Set<number>();
  const rules: Rule[] = [];
  value.forEach((item, index) => {
    const rule = normalizeStoredRule(item, index + 1);
    if (!rule) return;
    let id = rule.id;
    while (used.has(id)) id += value.length + rules.length + 1;
    used.add(id);
    rules.push(id === rule.id ? rule : { ...rule, id });
  });
  return rules;
}

export function readStoredRules(raw: string | null): Rule[] {
  if (!raw) return [];
  try {
    return normalizeRuleList(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

export function cloneRules(rules: Rule[], idBase: number): Rule[] {
  return rules.map((rule, index) => ({
    ...rule,
    id: idBase + index,
    tags: rule.tags ? [...rule.tags] : undefined,
  }));
}

export function rulesFromTemplate(template: RuleTemplate, idBase = Date.now()): Rule[] {
  return template.rules.map((rule, index) => ({
    id: idBase + index,
    app: rule.app,
    rule: rule.rule,
    active: true,
    ruleType: rule.ruleType,
  }));
}

export function nextPresetName(presets: RulePreset[], base: string): string {
  const names = new Set(presets.map(preset => preset.name.trim().toLowerCase()));
  const trimmed = base.trim() || 'Preset';
  if (!names.has(trimmed.toLowerCase())) return trimmed;
  let index = 2;
  while (names.has(`${trimmed} ${index}`.toLowerCase())) index += 1;
  return `${trimmed} ${index}`;
}

export interface PresetFile {
  name: string;
  rules: Rule[];
}

export function presetFileName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/[. ]+$/g, '')
    .trim();
  const base = cleaned || 'preset';
  return base.toLowerCase().endsWith('.json') ? base : `${base}.json`;
}

export function presetNameFromPath(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? '';
  return base.replace(/\.json$/i, '').trim();
}

export function serializePresetFile(name: string, rules: Rule[]): string {
  return JSON.stringify({
    name,
    rules: rules.map(rule => ({
      id: rule.id,
      app: rule.app,
      rule: rule.rule,
      active: rule.active,
      ruleType: rule.ruleType,
      ...(rule.tags?.length ? { tags: rule.tags } : {}),
    })),
  }, null, 2);
}

export function parsePresetFile(text: string, fallbackName: string): PresetFile | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  const fallback = fallbackName.trim() || 'Preset';
  if (Array.isArray(parsed)) {
    const rules = normalizeRuleList(parsed);
    return rules.length > 0 ? { name: fallback, rules } : null;
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as Record<string, unknown>).rules)) return null;
  const record = parsed as Record<string, unknown>;
  const rules = normalizeRuleList(record.rules);
  if (Array.isArray(record.rules) && record.rules.length > 0 && rules.length === 0) return null;
  const name = typeof record.name === 'string' && record.name.trim() ? record.name.trim() : fallback;
  return { name, rules };
}

export function parseStoredPresets(rawPresets: string | null, rawActiveId: string | null): StoredPresets | null {
  if (!rawPresets) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawPresets) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const presets: RulePreset[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    const name = typeof record.name === 'string' ? record.name.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    presets.push({ id, name: name || id, rules: normalizeRuleList(record.rules) });
  }
  if (presets.length === 0) return null;
  const activeId = rawActiveId && presets.some(preset => preset.id === rawActiveId)
    ? rawActiveId
    : presets[0].id;
  return { presets, activeId };
}

export function mergeSavedAndParsedRules(savedRules: Rule[], parsedRules: ParsedRule[], baseId = Date.now()): Rule[] {
  const savedByKey = new Map<string, Rule>();
  for (const rule of savedRules) savedByKey.set(subscriptionRuleKey(rule), rule);
  const configRules: Rule[] = [];
  parsedRules.forEach((parsed, index) => {
    const target = parsed.target?.trim();
    if (!target) return;
    const ruleType: Rule['ruleType'] = parsed.rule_type === 'process'
      || parsed.rule_type === 'domain'
      || parsed.rule_type === 'domain_keyword'
      || parsed.rule_type === 'ip'
      ? parsed.rule_type
      : 'domain';
    const nextRule: Rule = {
      id: baseId + index,
      app: target,
      rule: parsed.action === 'PROXY' ? 'Via VPN' : 'Direct',
      active: true,
      ruleType,
    };
    const saved = savedByKey.get(subscriptionRuleKey(nextRule));
    configRules.push(saved ? { ...nextRule, id: saved.id, active: saved.active, tags: saved.tags } : nextRule);
  });
  const configKeys = new Set(configRules.map(subscriptionRuleKey));
  const missingSavedInactive = savedRules.filter(rule => !rule.active && !configKeys.has(subscriptionRuleKey(rule)));
  return [...configRules, ...missingSavedInactive];
}

function resolveHint(hint: ProfileRuleHint, store: KeyValueStore): Rule[] {
  const saved = readStoredRules(store.getItem(`${LEGACY_RULES_KEY}:${hint.id}`));
  if (hint.userRuleLines != null) return selectSubscriptionRules(hint.userRuleLines, saved);
  if (hint.parsedRules && hint.parsedRules.length > 0) return mergeSavedAndParsedRules(saved, hint.parsedRules);
  return saved;
}

function presetLabel(value: unknown, fallback: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof fallback === 'string' && fallback.trim()) return fallback.trim();
  return 'Main';
}

function uniqueName(name: unknown, used: Set<string>, fallback: unknown): string {
  const base = presetLabel(name, fallback);
  if (!used.has(base.toLowerCase())) {
    used.add(base.toLowerCase());
    return base;
  }
  let index = 2;
  while (used.has(`${base} ${index}`.toLowerCase())) index += 1;
  const next = `${base} ${index}`;
  used.add(next.toLowerCase());
  return next;
}

function legacyPresetName(configId: string, fallback: string): string {
  const stem = configId.replace(/^config-/, '').replace(/\.(yaml|yml)$/i, '').trim();
  return stem || fallback;
}

export function buildPresetsFromLegacy(
  store: KeyValueStore,
  hints: ProfileRuleHint[],
  activeConfigId: string | null,
  defaultName: string,
): StoredPresets {
  const fallbackName = presetLabel(defaultName, 'Main');
  const hintedIds = new Set<string>();
  const buckets: Array<{ id: string; name: string; rules: Rule[]; fromActive: boolean }> = [];
  for (const hint of hints) {
    if (!hint?.id || hintedIds.has(hint.id)) continue;
    hintedIds.add(hint.id);
    buckets.push({
      id: `legacy:${hint.id}`,
      name: presetLabel(hint.name, legacyPresetName(hint.id, fallbackName)),
      rules: resolveHint(hint, store),
      fromActive: hint.id === activeConfigId,
    });
  }

  for (const key of store.keys()) {
    if (!key.startsWith(`${LEGACY_RULES_KEY}:`)) continue;
    const configId = key.slice(LEGACY_RULES_KEY.length + 1);
    if (!configId || hintedIds.has(configId)) continue;
    const rules = readStoredRules(store.getItem(key));
    if (rules.length === 0) continue;
    buckets.push({
      id: `legacy:${configId}`,
      name: legacyPresetName(configId, fallbackName),
      rules,
      fromActive: configId === activeConfigId,
    });
  }

  const nonEmpty = buckets.filter(bucket => bucket.rules.length > 0);
  const activeHasRules = nonEmpty.some(bucket => bucket.fromActive);
  if (nonEmpty.length === 0) {
    const bare = readStoredRules(store.getItem(LEGACY_RULES_KEY));
    return {
      presets: [{ id: DEFAULT_PRESET_ID, name: fallbackName, rules: bare }],
      activeId: DEFAULT_PRESET_ID,
    };
  }
  if (nonEmpty.length === 1 && activeHasRules) {
    return {
      presets: [{ id: DEFAULT_PRESET_ID, name: fallbackName, rules: nonEmpty[0].rules }],
      activeId: DEFAULT_PRESET_ID,
    };
  }

  const used = new Set<string>();
  const presets: RulePreset[] = [];
  if (!activeHasRules) {
    presets.push({ id: DEFAULT_PRESET_ID, name: uniqueName(fallbackName, used, fallbackName), rules: [] });
  }
  const ordered = [...nonEmpty].sort((left, right) => Number(right.fromActive) - Number(left.fromActive));
  for (const bucket of ordered) {
    presets.push({
      id: bucket.fromActive ? DEFAULT_PRESET_ID : bucket.id,
      name: uniqueName(bucket.fromActive ? fallbackName : bucket.name, used, fallbackName),
      rules: bucket.rules,
    });
  }
  return { presets, activeId: presets[0].id };
}

function legacyRuleKeys(keys: string[]): string[] {
  return keys.filter(key => key === LEGACY_RULES_KEY || key.startsWith(`${LEGACY_RULES_KEY}:`));
}

export function loadOrMigratePresets(
  store: KeyValueStore,
  hints: ProfileRuleHint[],
  activeConfigId: string | null,
  defaultName: string,
): StoredPresets {
  const existing = parseStoredPresets(
    store.getItem(PRESETS_STORAGE_KEY),
    store.getItem(ACTIVE_PRESET_STORAGE_KEY),
  );
  if (existing) return existing;
  const migrated = buildPresetsFromLegacy(store, hints, activeConfigId, defaultName);
  store.setItem(PRESETS_STORAGE_KEY, JSON.stringify(migrated.presets));
  store.setItem(ACTIVE_PRESET_STORAGE_KEY, migrated.activeId);
  for (const key of legacyRuleKeys(store.keys())) store.removeItem(key);
  return migrated;
}

export function withActiveRules(state: StoredPresets, rules: Rule[]): StoredPresets {
  return {
    ...state,
    presets: state.presets.map(preset => (
      preset.id === state.activeId ? { ...preset, rules } : preset
    )),
  };
}

export function withSelectedPreset(state: StoredPresets, id: string): StoredPresets {
  if (!state.presets.some(preset => preset.id === id)) return state;
  return { ...state, activeId: id };
}

export function withCreatedPreset(
  state: StoredPresets,
  name: string,
  rules: Rule[],
  id: string,
  idBase = Date.now(),
): StoredPresets {
  const trimmed = name.trim();
  return {
    presets: [...state.presets, { id, name: trimmed || id, rules: cloneRules(rules, idBase) }],
    activeId: id,
  };
}

export function withRenamedPreset(state: StoredPresets, id: string, name: string): StoredPresets {
  const trimmed = name.trim();
  if (!trimmed) return state;
  return {
    ...state,
    presets: state.presets.map(preset => (preset.id === id ? { ...preset, name: trimmed } : preset)),
  };
}

export function withoutPreset(state: StoredPresets, id: string): StoredPresets {
  if (state.presets.length < 2) return state;
  const index = state.presets.findIndex(preset => preset.id === id);
  if (index < 0) return state;
  const presets = state.presets.filter(preset => preset.id !== id);
  const activeId = state.activeId === id ? presets[Math.max(0, index - 1)].id : state.activeId;
  return { presets, activeId };
}
