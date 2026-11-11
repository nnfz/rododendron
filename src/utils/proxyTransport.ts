export interface ProxyTransportOptions {
  network: string;
  security?: string;
  pbk?: string;
  fp?: string;
  sni?: string;
  sid?: string;
  flow?: string;
  spx?: string;
  host?: string;
  path?: string;
  mode?: string;
  extra?: string;
  serviceName?: string;
  /** VLESS Encryption query value, for example `mlkem768x25519plus.native.0rtt.…`. */
  encryption?: string;
  /** Raw `support-x25519mlkem768` query value. Absent means do not emit the key. */
  mlkem?: string;
  sniKey?: 'servername' | 'sni';
}

/** Query parser that keeps `+` inside base64 public keys. URLSearchParams turns `+` into a space. */
export function readLinkParams(search: string): Record<string, string> {
  const params: Record<string, string> = {};
  const query = search.startsWith('?') ? search.slice(1) : search;
  if (!query) return params;

  const decode = (value: string) => {
    try {
      return decodeURIComponent(value.replace(/\+/g, '%2B'));
    } catch {
      return value;
    }
  };

  for (const part of query.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const rawKey = eq >= 0 ? part.slice(0, eq) : part;
    const rawValue = eq >= 0 ? part.slice(eq + 1) : '';
    params[decode(rawKey)] = decode(rawValue);
  }
  return params;
}

function mlkemEnabled(raw: string | undefined): boolean {
  if (raw == null || raw.trim() === '') return false;
  return ['1', 'true', 'yes'].includes(raw.trim().toLowerCase());
}

function yamlQuoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return yamlQuoted(value);
  if (value === null || value === undefined) return '""';
  return yamlQuoted(String(value));
}

function emitYamlNode(value: unknown, indent: number): string[] {
  const pad = ' '.repeat(indent);

  if (Array.isArray(value)) {
    if (value.length === 0) return [`${pad}[]`];
    const lines: string[] = [];
    for (const item of value) {
      if (item && typeof item === 'object') {
        const nested = emitYamlNode(item, indent + 2);
        if (nested.length === 0) continue;
        lines.push(`${pad}- ${nested[0].trimStart()}`);
        for (const line of nested.slice(1)) {
          lines.push(`${' '.repeat(indent + 2)}${line.trimStart()}`);
        }
      } else {
        lines.push(`${pad}- ${yamlScalar(item)}`);
      }
    }
    return lines;
  }

  if (value && typeof value === 'object') {
    const lines: string[] = [];
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child && typeof child === 'object') {
        lines.push(`${pad}${key}:`);
        lines.push(...emitYamlNode(child, indent + 2));
      } else {
        lines.push(`${pad}${key}: ${yamlScalar(child)}`);
      }
    }
    return lines;
  }

  return [`${pad}${yamlScalar(value)}`];
}

/** Share-link `encryption`, or a VLESS ML-KEM string that a panel put in `packetEncoding`. */
export function vlessEncryptionParam(params: Record<string, string>): string {
  const direct = (params.encryption || '').trim();
  if (direct && direct.toLowerCase() !== 'none') return direct;
  const packet = (params.packetEncoding || params['packet-encoding'] || '').trim();
  if (packet.toLowerCase().startsWith('mlkem768x25519plus')) return packet;
  return '';
}

function rangeText(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const from = record.from ?? record.From;
    const to = record.to ?? record.To;
    if (typeof from === 'number' && typeof to === 'number') {
      return from === to ? String(from) : `${from}-${to}`;
    }
  }
  return '';
}

function pick(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (record[key] != null && record[key] !== '') return record[key];
  }
  return undefined;
}

function isEnabled(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '1' || text === 'true' || text === 'yes';
  }
  return false;
}

function isDisabled(value: unknown): boolean {
  if (value === false || value === 0) return true;
  if (typeof value === 'string') {
    const text = value.trim().toLowerCase();
    return text === '0' || text === 'false' || text === 'no';
  }
  return false;
}

function positiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.trunc(value);
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
    const parsed = Number(value.trim());
    if (parsed > 0) return parsed;
  }
  return undefined;
}

const XHTTP_TEXT_FIELDS: Array<[string, string[]]> = [
  ['x-padding-bytes', ['xPaddingBytes', 'x-padding-bytes']],
  ['x-padding-key', ['xPaddingKey', 'x-padding-key']],
  ['x-padding-header', ['xPaddingHeader', 'x-padding-header']],
  ['x-padding-placement', ['xPaddingPlacement', 'x-padding-placement']],
  ['x-padding-method', ['xPaddingMethod', 'x-padding-method']],
  ['uplink-http-method', ['uplinkHTTPMethod', 'uplink-http-method']],
  ['session-placement', ['sessionPlacement', 'sessionIDPlacement', 'session-placement']],
  ['session-key', ['sessionKey', 'sessionIDKey', 'session-key']],
  ['session-table', ['sessionTable', 'sessionIDTable', 'session-table']],
  ['session-length', ['sessionLength', 'sessionIDLength', 'session-length']],
  ['seq-placement', ['seqPlacement', 'seq-placement']],
  ['seq-key', ['seqKey', 'seq-key']],
  ['uplink-data-placement', ['uplinkDataPlacement', 'uplink-data-placement']],
  ['uplink-data-key', ['uplinkDataKey', 'uplink-data-key']],
];

function reuseFromXmux(xmux: Record<string, unknown>): Record<string, unknown> {
  const reuse: Record<string, unknown> = {};
  const textFields: Array<[string, string[]]> = [
    ['max-concurrency', ['maxConcurrency', 'max-concurrency']],
    ['max-connections', ['maxConnections', 'max-connections']],
    ['c-max-reuse-times', ['cMaxReuseTimes', 'c-max-reuse-times']],
    ['h-max-request-times', ['hMaxRequestTimes', 'h-max-request-times']],
    ['h-max-reusable-secs', ['hMaxReusableSecs', 'h-max-reusable-secs']],
  ];
  for (const [dest, keys] of textFields) {
    const text = rangeText(pick(xmux, keys));
    if (!text || text === '0' || text === '0-0') continue;
    reuse[dest] = text;
  }
  const keepAlive = positiveInt(pick(xmux, ['hKeepAlivePeriod', 'h-keep-alive-period']));
  if (keepAlive !== undefined) reuse['h-keep-alive-period'] = keepAlive;
  return reuse;
}

/** Xray xhttp `extra` JSON → Mihomo xhttp-opts. Mihomo ignores a nested `extra` key. */
function xhttpExtraLines(raw: string | undefined): string[] {
  const text = raw?.trim();
  if (!text) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  const mapped: Record<string, unknown> = {};

  for (const [dest, keys] of XHTTP_TEXT_FIELDS) {
    const value = rangeText(pick(record, keys));
    if (value) mapped[dest] = value;
  }

  const chunk = rangeText(pick(record, ['uplinkChunkSize', 'uplink-chunk-size']));
  if (chunk && chunk !== '0' && chunk !== '0-0') mapped['uplink-chunk-size'] = chunk;

  const eachPost = rangeText(pick(record, ['scMaxEachPostBytes', 'sc-max-each-post-bytes']));
  if (eachPost && eachPost !== '1000000') mapped['sc-max-each-post-bytes'] = eachPost;

  const postInterval = rangeText(pick(record, ['scMinPostsIntervalMs', 'sc-min-posts-interval-ms']));
  if (postInterval && postInterval !== '30') mapped['sc-min-posts-interval-ms'] = postInterval;

  if (isEnabled(pick(record, ['xPaddingObfsMode', 'x-padding-obfs-mode']))) {
    mapped['x-padding-obfs-mode'] = true;
  }
  if (isEnabled(pick(record, ['noGRPCHeader', 'no-grpc-header']))) {
    mapped['no-grpc-header'] = true;
  }

  const headers = pick(record, ['headers']);
  if (headers && typeof headers === 'object' && !Array.isArray(headers)) {
    const headerMap: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
      if (typeof value === 'string' && value.trim()) headerMap[key] = value;
    }
    if (Object.keys(headerMap).length > 0) mapped.headers = headerMap;
  }

  if (!isDisabled(record.enableXmux)) {
    const xmux = record.xmux ?? record['reuse-settings'];
    if (xmux && typeof xmux === 'object' && !Array.isArray(xmux)) {
      const reuse = reuseFromXmux(xmux as Record<string, unknown>);
      if (Object.keys(reuse).length > 0) mapped['reuse-settings'] = reuse;
    }
  }

  if (Object.keys(mapped).length === 0) return [];
  return emitYamlNode(mapped, 6);
}

/** Transport and security lines for a Mihomo proxy. xhttp path/host stay on xhttp-opts, not inside extra. */
export function appendProxyTransport(lines: string[], opts: ProxyTransportOptions): void {
  const network = (opts.network || 'tcp').toLowerCase();
  const security = (opts.security || '').toLowerCase();
  const sniKey = opts.sniKey ?? 'servername';
  const encryption = (opts.encryption || '').trim();

  if (encryption && encryption.toLowerCase() !== 'none') {
    lines.push(`    encryption: ${yamlQuoted(encryption)}`);
  }

  if (network === 'tcp') {
    lines.push('    packet-encoding: xudp');
  }

  if (opts.sni) lines.push(`    ${sniKey}: ${yamlQuoted(opts.sni)}`);

  const fingerprint = opts.fp || (security === 'reality' ? 'chrome' : '');
  if (fingerprint) lines.push(`    client-fingerprint: ${fingerprint}`);

  // Vision on xhttp/ws rides the VLESS encryption conn. Without encryption,
  // Mihomo tries to splice the transport itself and the dial fails.
  const encryptionOn = encryption.length > 0 && encryption.toLowerCase() !== 'none';
  if (opts.flow && (network === 'tcp' || encryptionOn)) {
    lines.push(`    flow: ${opts.flow}`);
  }

  if (security === 'reality') {
    lines.push('    reality-opts:');
    if (opts.pbk) lines.push(`      public-key: ${yamlQuoted(opts.pbk)}`);
    if (opts.sid) lines.push(`      short-id: ${yamlQuoted(opts.sid)}`);
    if (opts.spx) lines.push(`      spider-x: ${yamlQuoted(opts.spx)}`);
    if (mlkemEnabled(opts.mlkem)) {
      lines.push('      support-x25519mlkem768: true');
    }
  }

  if (network === 'xhttp') {
    const extraLines = xhttpExtraLines(opts.extra);
    if (opts.mode || opts.host || opts.path || extraLines.length > 0) {
      lines.push('    xhttp-opts:');
      if (opts.mode) lines.push(`      mode: ${opts.mode}`);
      if (opts.host) lines.push(`      host: ${yamlQuoted(opts.host)}`);
      if (opts.path) lines.push(`      path: ${yamlQuoted(opts.path)}`);
      lines.push(...extraLines);
    }
    return;
  }

  if (network === 'ws') {
    if (opts.path || opts.host) {
      lines.push('    ws-opts:');
      if (opts.path) lines.push(`      path: ${yamlQuoted(opts.path)}`);
      if (opts.host) {
        lines.push('      headers:');
        lines.push(`        Host: ${yamlQuoted(opts.host)}`);
      }
    }
    return;
  }

  if (network === 'grpc' && opts.serviceName) {
    lines.push('    grpc-opts:');
    lines.push(`      grpc-service-name: ${yamlQuoted(opts.serviceName)}`);
  }
}
