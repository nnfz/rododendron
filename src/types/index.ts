export interface Rule {
  id: number;
  app: string;
  rule: string;
  active: boolean;
  ruleType: 'process' | 'domain' | 'domain_keyword' | 'ip';
  tags?: number[];
}

export interface Tag {
  id: number;
  name: string;
  color: string;
}

export type LogLevel = 'INFO' | 'WARNING' | 'ERROR' | 'DEBUG';

export interface Log {
  id: number;
  time: string;
  level: LogLevel;
  message: string;
}

export interface Settings {
  autostart: boolean;
  startminimized: boolean;
  autoConnect: boolean;
  autoCheckUpdates: boolean;
  autoRestartOnRuleApply: boolean;
  closeBehavior: 'tray' | 'exit';
  killSwitch: boolean;
  snowfall: boolean;
}

export type TabType = 'home' | 'rules' | 'settings';

// Mihomo types
export interface ProxyConfig {
  name: string;
  server: string;
  port: number;
  proxy_type: string;
}

export interface ParsedConfig {
  proxies: ProxyConfig[];
  proxy_name: string | null;
  server_address: string | null;
  mode: string;
  log_level: string;
  mixed_port: number;
  rules: ParsedRule[];
}

export interface ParsedRule {
  rule_type: 'process' | 'domain' | 'domain_keyword' | 'ip' | 'other';
  target: string;
  action: string; // PROXY or DIRECT
  raw: string;
}

export interface VpnStatus {
  running: boolean;
  server: string | null;
  proxy_name: string | null;
  mode: string;
  port: number;
}

export interface Config {
  id: string;
  name: string;
  filename: string;
  content?: string;
}