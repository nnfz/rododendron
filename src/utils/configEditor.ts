import { isTauri } from './isTauri';

export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'select' | 'string-list';

export type ConfigFieldSection = 'general' | 'tun' | 'dns' | 'profile' | 'performance';

export interface ConfigFieldDef {
  path: string;
  section: ConfigFieldSection;
  type: ConfigFieldType;
  options?: string[];
}

export interface ConfigFieldState {
  path: string;
  section: ConfigFieldSection;
  type: ConfigFieldType;
  options?: string[];
  value: string | boolean | string[];
  custom?: boolean;
}

export interface ConfigEditorState {
  fields: ConfigFieldState[];
  customFields: ConfigFieldState[];
}

const RESERVED_TOP_LEVEL = new Set([
  'proxies',
  'proxy-groups',
  'rules',
  'tun',
  'dns',
  'profile',
]);

export const CONFIG_FIELD_DEFS: ConfigFieldDef[] = [
  { path: 'mode', section: 'general', type: 'select', options: ['rule', 'global', 'direct'] },
  { path: 'log-level', section: 'general', type: 'select', options: ['silent', 'error', 'warning', 'info', 'debug'] },
  { path: 'mixed-port', section: 'general', type: 'number' },
  { path: 'port', section: 'general', type: 'number' },
  { path: 'socks-port', section: 'general', type: 'number' },
  { path: 'redir-port', section: 'general', type: 'number' },
  { path: 'allow-lan', section: 'general', type: 'boolean' },
  { path: 'bind-address', section: 'general', type: 'string' },
  { path: 'ipv6', section: 'general', type: 'boolean' },
  { path: 'external-controller', section: 'general', type: 'string' },
  { path: 'secret', section: 'general', type: 'string' },
  { path: 'find-process-mode', section: 'general', type: 'select', options: ['strict', 'always', 'off'] },
  { path: 'geodata-mode', section: 'general', type: 'select', options: ['memconservative', 'standard'] },
  { path: 'tun.enable', section: 'tun', type: 'boolean' },
  { path: 'tun.mtu', section: 'tun', type: 'number' },
  { path: 'tun.stack', section: 'tun', type: 'select', options: ['gvisor', 'mixed', 'system'] },
  { path: 'tun.auto-route', section: 'tun', type: 'boolean' },
  { path: 'tun.auto-detect-interface', section: 'tun', type: 'boolean' },
  { path: 'tun.device', section: 'tun', type: 'string' },
  { path: 'tun.endpoint-independent-nat', section: 'tun', type: 'boolean' },
  { path: 'dns.enable', section: 'dns', type: 'boolean' },
  { path: 'dns.ipv6', section: 'dns', type: 'boolean' },
  { path: 'dns.enhanced-mode', section: 'dns', type: 'select', options: ['fake-ip', 'redir-host'] },
  { path: 'dns.fake-ip-range', section: 'dns', type: 'string' },
  { path: 'dns.fake-ip-filter', section: 'dns', type: 'string-list' },
  { path: 'dns.use-hosts', section: 'dns', type: 'boolean' },
  { path: 'dns.respect-rules', section: 'dns', type: 'boolean' },
  { path: 'profile.store-selected', section: 'profile', type: 'boolean' },
  { path: 'profile.store-fake-ip', section: 'profile', type: 'boolean' },
  { path: 'tcp-concurrent', section: 'performance', type: 'boolean' },
  { path: 'unified-delay', section: 'performance', type: 'boolean' },
  { path: 'keep-alive-interval', section: 'performance', type: 'number' },
];

const KNOWN_PATHS = new Set(CONFIG_FIELD_DEFS.map((d) => d.path));

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getByPath(root: Record<string, unknown>, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = root;
  for (const part of parts) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

export function setByPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    const next = current[part];
    if (!isRecord(next)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (value === undefined || value === null || value === '') {
    delete current[last];
    return;
  }
  current[last] = value as never;
}

async function parseYamlRoot(content: string): Promise<Record<string, unknown>> {
  if (!isTauri()) return {};
  const { invoke } = await import('@tauri-apps/api/core');
  const doc = await invoke<unknown>('parse_config_yaml', { content });
  return isRecord(doc) ? { ...doc } : {};
}

async function stringifyYamlRoot(root: Record<string, unknown>): Promise<string> {
  if (!isTauri()) return '';
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('stringify_config_yaml', { value: root });
}

function scalarToFieldValue(type: ConfigFieldType, raw: unknown): string | boolean | string[] {
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return raw;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    return false;
  }
  if (type === 'string-list') {
    if (Array.isArray(raw)) {
      return raw.map((item) => String(item)).filter((item) => item.trim().length > 0);
    }
    if (typeof raw === 'string' && raw.trim()) return [raw.trim()];
    return [];
  }
  if (raw === undefined || raw === null) return '';
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return String(raw);
}

function fieldValueToYaml(type: ConfigFieldType, value: string | boolean | string[]): unknown {
  if (type === 'boolean') return Boolean(value);
  if (type === 'string-list') {
    const list = Array.isArray(value) ? value : [];
    return list.map((item) => item.trim()).filter(Boolean);
  }
  if (type === 'number') {
    const raw = String(value).trim();
    if (!raw) return undefined;
    const num = Number(raw);
    return Number.isFinite(num) ? num : raw;
  }
  const raw = String(value).trim();
  return raw || undefined;
}

function inferCustomType(raw: unknown): ConfigFieldType {
  if (typeof raw === 'boolean') return 'boolean';
  if (typeof raw === 'number') return 'number';
  return 'string';
}

export async function parseConfigEditorState(content: string): Promise<ConfigEditorState> {
  const root = await parseYamlRoot(content);

  const fields: ConfigFieldState[] = CONFIG_FIELD_DEFS.map((def) => ({
    path: def.path,
    section: def.section,
    type: def.type,
    options: def.options,
    value: scalarToFieldValue(def.type, getByPath(root, def.path)),
  }));

  const customFields: ConfigFieldState[] = [];
  for (const [key, raw] of Object.entries(root)) {
    if (RESERVED_TOP_LEVEL.has(key)) continue;
    if (KNOWN_PATHS.has(key)) continue;
    if (Array.isArray(raw) || isRecord(raw)) continue;
    customFields.push({
      path: key,
      section: 'general',
      type: inferCustomType(raw),
      value: scalarToFieldValue(inferCustomType(raw), raw),
      custom: true,
    });
  }

  customFields.sort((a, b) => a.path.localeCompare(b.path));

  return { fields, customFields };
}

export async function buildConfigFromEditorState(
  content: string,
  state: ConfigEditorState,
): Promise<string> {
  const root = await parseYamlRoot(content);

  const allFields = [...state.fields, ...state.customFields];
  for (const field of allFields) {
    if (field.custom && !field.path.trim()) continue;
    const yamlValue = fieldValueToYaml(field.type, field.value);
    if (yamlValue === undefined) {
      if (field.path.includes('.')) {
        setByPath(root, field.path, undefined);
      } else {
        delete root[field.path];
      }
      continue;
    }
    setByPath(root, field.path, yamlValue);
  }

  return stringifyYamlRoot(root);
}

export function createEmptyCustomField(): ConfigFieldState {
  return {
    path: '',
    section: 'general',
    type: 'string',
    value: '',
    custom: true,
  };
}

export function formatFieldLabel(path: string): string {
  return path
    .split('.')
    .map((part) => part.replace(/-/g, ' '))
    .join(' · ');
}

export const CONFIG_SECTIONS: ConfigFieldSection[] = [
  'general',
  'tun',
  'dns',
  'profile',
  'performance',
];