import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LuChevronRight,
  LuDownload,
  LuFileText,
  LuHelpCircle,
  LuRefreshCw,
  LuUpload,
  LuTrash2,
  LuX,
  LuPencil,
  LuSave,
  LuPlus,
} from 'react-icons/lu';
import CustomSelect from './CustomSelect';
import { useI18n } from '../i18n';
import type { Language } from '../i18n/translations';
import type { Settings, Config, ParsedConfig } from '../types';
import type { CSSProperties, Dispatch, SetStateAction } from 'react';
import { isTauri } from '../utils/isTauri';

interface SettingsPageProps {
  setShowLogsModal: (show: boolean) => void;
  configs: Config[];
  setConfigs: Dispatch<SetStateAction<Config[]>>;
  activeConfigId: string;
  setActiveConfigId: Dispatch<SetStateAction<string>>;
  setActiveConfigContent: Dispatch<SetStateAction<string | null>>;
  setParsedConfig: Dispatch<SetStateAction<ParsedConfig | null>>;
  vpnEnabled: boolean;
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  availableUpdateVersion: string | null;
  setNeedsRestart: Dispatch<SetStateAction<boolean>>;
}

type UpdateCheckResult = {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  asset_name?: string | null;
  download_url?: string | null;
  release_notes?: string | null;
};

const MTU_MIN = 1280;
const MTU_MAX = 1500;
const MTU_DEFAULT = '1500';
const DELETE_CONFIRM_TIMEOUT = 3000;
const MIHOMO_CORE_VERSION = '1.19.20';

const EASTER_EGG_IMAGE_URLS: string[] = [
  'https://sun9-23.userapi.com/s/v1/ig2/UxlCqEp8iuDBw9X7APXtXfiz9XPl60eMlMB_Z-auRwfcfRiHLeLCCBmYfjgTZMiR7K9BJ8NluXWEMVZ0EsYm_F2P.jpg?quality=95&as=32x37,48x56,72x84,108x126,160x186,208x242&from=bu&cs=208x0',
  'https://sun9-17.userapi.com/s/v1/ig2/QWx-DlwGizCMUxXvnMggm9qBbr9S1E7KQVE3BJOzh1bLObLWTMGmmaZSSF038V_jthBcHpe30jS839PhjXwsH8wE.jpg?quality=95&as=32x15,48x23,72x35,108x52,160x77,240x115,360x173,418x201&from=bu&cs=418x0',
  'https://sun9-87.userapi.com/s/v1/ig2/gpHJB5fgO5e5QTFOZWEPwaHIw2ADvchMF04nokaH6BXLtumYocYQzWD6ZwtJukkyPkIkRRCBdLQCmX8UGngw_p57.jpg?quality=95&as=32x24,48x36,72x54,108x81,160x120,240x180,360x270,480x359,540x404,640x479,720x539,800x599&from=bu&cs=800x0',
  'https://sun9-19.userapi.com/s/v1/ig2/iG3zzJcnf5rvEczGebCw7DHKbbVs9npk3043DzGONUZwrg0NLOMhGYtowxnE-CZfU7ogsBsUVuHnP98Zr2hQ9mTH.jpg?quality=95&as=32x24,48x36,72x54,108x81,160x120,240x180,360x270,450x337&from=bu&cs=450x0',
  'https://sun9-79.userapi.com/s/v1/ig2/Uf0zlawdQDvRUd4-OmlD8gGTcjJ8SUuOH4bm_x2m9yaiMyAaYSeT_SCfdQs-PHxKY1hKqqOxZLqWnvzueo2iuTtZ.jpg?quality=95&as=32x32,48x48,72x72,108x108,160x160,240x240,300x300&from=bu&cs=300x0',
  'https://sun9-15.userapi.com/s/v1/ig2/QJ-d3NRMWhjIgbWkQ4BAMEweNhpfEsxSmvvJzltIZ_rdryR-5hIH4GYBHVmG7V7aTu4P1BGgzAVQduWf5ibgFKpI.jpg?quality=95&as=32x48,48x72,72x108,108x162,160x240,183x275&from=bu&cs=183x0',
];

const autostartPlugin = {
  async enable() {
    const { enable } = await import('@tauri-apps/plugin-autostart');
    await enable();
  },
  async disable() {
    const { disable } = await import('@tauri-apps/plugin-autostart');
    await disable();
  },
  async isEnabled(): Promise<boolean> {
    if (import.meta.env.DEV) return false;
    const { isEnabled } = await import('@tauri-apps/plugin-autostart');
    return isEnabled();
  },
};

// ─── Парсеры протокольных ссылок ─────────────────────────────────────────────

function parseVlessLink(text: string): { yaml: string; filename: string } {
  const url = new URL(text);
  if (url.protocol !== 'vless:') throw new Error('Not a vless:// link');
  if (!url.username) throw new Error('Missing UUID in vless:// link');

  const name = decodeURIComponent((url.hash || '').replace(/^#/, '')).trim() || 'VLESS';
  const server = url.hostname;
  const port = url.port ? Number(url.port) : 443;
  const network = (url.searchParams.get('type') || 'tcp').toLowerCase();
  const security = (url.searchParams.get('security') || '').toLowerCase();
  const pbk = url.searchParams.get('pbk') || '';
  const fp = url.searchParams.get('fp') || '';
  const sni = url.searchParams.get('sni') || '';
  const sid = url.searchParams.get('sid') || '';
  const flow = url.searchParams.get('flow') || '';
  const tlsEnabled = security === 'reality' || security === 'tls';
  
  const host = url.searchParams.get('host') || '';
  const path = url.searchParams.get('path') || '';
  const mode = url.searchParams.get('mode') || '';
  const serviceName = url.searchParams.get('serviceName') || '';

  const safeName = name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'VLESS';
  const filename = `${safeName}.yaml`;

  const proxyLines: string[] = [
    `  - name: "${name}"`,
    '    type: vless',
    `    server: ${server}`,
    `    port: ${port}`,
    `    uuid: ${url.username}`,
    '    udp: true',
    '    packet-encoding: xudp',
    `    network: ${network}`,
    `    tls: ${tlsEnabled}`,
  ];

  if (sni) proxyLines.push(`    servername: ${sni}`);
  if (fp) proxyLines.push(`    client-fingerprint: ${fp}`);
  if (flow) proxyLines.push(`    flow: ${flow}`);

  if (security === 'reality') {
    proxyLines.push('    reality-opts:');
    if (pbk) proxyLines.push(`      public-key: ${pbk}`);
    if (sid) proxyLines.push(`      short-id: ${sid}`);
  }

  if (network === 'xhttp') {
    proxyLines.push('    xhttp-opts:');
    if (mode) proxyLines.push(`      mode: ${mode}`);
    if (host || path) {
      proxyLines.push('      extra:');
      if (host) proxyLines.push(`        host: "${host}"`);
      if (path) proxyLines.push(`        path: "${path}"`);
    }
  } else if (network === 'ws') {
    proxyLines.push('    ws-opts:');
    if (path) proxyLines.push(`      path: "${path}"`);
    if (host) {
      proxyLines.push('      headers:');
      proxyLines.push(`        Host: "${host}"`);
    }
  } else if (network === 'grpc') {
    proxyLines.push('    grpc-opts:');
    if (serviceName) proxyLines.push(`      grpc-service-name: "${serviceName}"`);
  }

  const yaml = [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    '',
    'proxies:',
    ...proxyLines,
    '',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    `      - "${name}"`,
    '      - DIRECT',
    '',
    'rules:',
    '  - MATCH,PROXY',
    '',
  ].join('\n');

  return { yaml, filename };
}

function parseHysteria2Link(text: string): { yaml: string; filename: string } {
  const stripped = text.replace(/^(hysteria2|hy2):\/\//, '');
  const hashIdx = stripped.indexOf('#');
  const withoutHash = hashIdx >= 0 ? stripped.slice(0, hashIdx) : stripped;
  const name =
    hashIdx >= 0
      ? decodeURIComponent(stripped.slice(hashIdx + 1)).trim() || 'Hysteria2'
      : 'Hysteria2';

  const qIdx = withoutHash.indexOf('?');
  const beforeQuery = qIdx >= 0 ? withoutHash.slice(0, qIdx) : withoutHash;
  const queryString = qIdx >= 0 ? withoutHash.slice(qIdx + 1) : '';

  const lastAtIdx = beforeQuery.lastIndexOf('@');
  if (lastAtIdx === -1) throw new Error('Missing @ in hysteria2:// link');

  const password = decodeURIComponent(beforeQuery.slice(0, lastAtIdx));
  const hostPortRaw = beforeQuery.slice(lastAtIdx + 1).split('/')[0];

  if (!password) throw new Error('Missing password in hysteria2:// link');

  let server: string;
  let port: number;

  if (hostPortRaw.startsWith('[')) {
    const closeBracket = hostPortRaw.indexOf(']');
    server = hostPortRaw.slice(1, closeBracket);
    port = Number(hostPortRaw.slice(closeBracket + 2)) || 443;
  } else {
    const colonIdx = hostPortRaw.lastIndexOf(':');
    if (colonIdx > 0) {
      server = hostPortRaw.slice(0, colonIdx);
      port = Number(hostPortRaw.slice(colonIdx + 1)) || 443;
    } else {
      server = hostPortRaw;
      port = 443;
    }
  }

  if (!server) throw new Error('Missing server in hysteria2:// link');

  const params = new URLSearchParams(queryString);
  const sni = params.get('sni') || '';
  const insecure = params.get('insecure') === '1';
  const obfs = params.get('obfs') || '';
  const obfsPassword = params.get('obfs-password') || '';
  const upMbps = params.get('up') || '';
  const downMbps = params.get('down') || '';
  const alpn = params.get('alpn') || '';

  const safeName = name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'Hysteria2';
  const filename = `${safeName}.yaml`;

  const proxyLines: string[] = [
    `  - name: "${name}"`,
    '    type: hysteria2',
    `    server: ${server}`,
    `    port: ${port}`,
    `    password: "${password}"`,
  ];

  if (sni) proxyLines.push(`    sni: ${sni}`);
  if (insecure) proxyLines.push('    skip-cert-verify: true');
  if (alpn) {
    const alpnList = alpn.split(',').map((a) => a.trim()).filter(Boolean);
    proxyLines.push('    alpn:');
    alpnList.forEach((a) => proxyLines.push(`      - ${a}`));
  }
  if (obfs === 'salamander' && obfsPassword) {
    proxyLines.push('    obfs: salamander');
    proxyLines.push(`    obfs-password: "${obfsPassword}"`);
  }
  if (upMbps) proxyLines.push(`    up: "${upMbps} Mbps"`);
  if (downMbps) proxyLines.push(`    down: "${downMbps} Mbps"`);

  const yaml = [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    '',
    'proxies:',
    ...proxyLines,
    '',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    `      - "${name}"`,
    '      - DIRECT',
    '',
    'rules:',
    '  - MATCH,PROXY',
    '',
  ].join('\n');

  return { yaml, filename };
}

function parseShadowsocksLink(text: string): { yaml: string; filename: string } {
  const url = new URL(text);
  if (url.protocol !== 'ss:') throw new Error('Not a ss:// link');

  const name = decodeURIComponent((url.hash || '').replace(/^#/, '')).trim() || 'Shadowsocks';

  let method = '';
  let password = '';
  let server = url.hostname;
  let port = url.port ? Number(url.port) : 0;

  if (server && port) {
    const decoded = atob(url.username);
    const colonIdx = decoded.indexOf(':');
    if (colonIdx > 0) {
      method = decoded.slice(0, colonIdx);
      password = decoded.slice(colonIdx + 1);
    }
  } else {
    const path = text.replace(/^ss:\/\//, '').split('#')[0];
    const decoded = atob(path);
    const atIdx = decoded.lastIndexOf('@');
    if (atIdx > 0) {
      const userInfo = decoded.slice(0, atIdx);
      const hostPort = decoded.slice(atIdx + 1);
      const colonIdx = userInfo.indexOf(':');
      method = userInfo.slice(0, colonIdx);
      password = userInfo.slice(colonIdx + 1);
      const hpParts = hostPort.split(':');
      server = hpParts[0];
      port = Number(hpParts[1]) || 443;
    }
  }

  if (!server || !port || !method || !password) {
    throw new Error('Failed to parse ss:// link');
  }

  const safeName = name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'Shadowsocks';
  const filename = `${safeName}.yaml`;

  const yaml = [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    '',
    'proxies:',
    `  - name: "${name}"`,
    '    type: ss',
    `    server: ${server}`,
    `    port: ${port}`,
    `    cipher: ${method}`,
    `    password: "${password}"`,
    '    udp: true',
    '',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    `      - "${name}"`,
    '      - DIRECT',
    '',
    'rules:',
    '  - MATCH,PROXY',
    '',
  ].join('\n');

  return { yaml, filename };
}

function parseTrojanLink(text: string): { yaml: string; filename: string } {
  const url = new URL(text);
  if (url.protocol !== 'trojan:') throw new Error('Not a trojan:// link');

  const name = decodeURIComponent((url.hash || '').replace(/^#/, '')).trim() || 'Trojan';
  const password = decodeURIComponent(url.username);
  const server = url.hostname;
  const port = url.port ? Number(url.port) : 443;
  const sni = url.searchParams.get('sni') || '';
  const alpn = url.searchParams.get('alpn') || '';
  const insecure = url.searchParams.get('allowInsecure') === '1';
  
  const network = (url.searchParams.get('type') || 'tcp').toLowerCase();
  const host = url.searchParams.get('host') || '';
  const path = url.searchParams.get('path') || '';
  const mode = url.searchParams.get('mode') || '';
  const serviceName = url.searchParams.get('serviceName') || '';

  if (!password || !server) throw new Error('Missing password or server in trojan:// link');

  const safeName = name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'Trojan';
  const filename = `${safeName}.yaml`;

  const proxyLines: string[] = [
    `  - name: "${name}"`,
    '    type: trojan',
    `    server: ${server}`,
    `    port: ${port}`,
    `    password: "${password}"`,
    '    udp: true',
  ];

  if (network !== 'tcp') {
    proxyLines.push(`    network: ${network}`);
  }

  if (sni) proxyLines.push(`    sni: ${sni}`);
  if (insecure) proxyLines.push('    skip-cert-verify: true');
  if (alpn) {
    const alpnList = alpn.split(',').map((a) => a.trim()).filter(Boolean);
    proxyLines.push('    alpn:');
    alpnList.forEach((a) => proxyLines.push(`      - ${a}`));
  }

  if (network === 'xhttp') {
    proxyLines.push('    xhttp-opts:');
    if (mode) proxyLines.push(`      mode: ${mode}`);
    if (host || path) {
      proxyLines.push('      extra:');
      if (host) proxyLines.push(`        host: "${host}"`);
      if (path) proxyLines.push(`        path: "${path}"`);
    }
  } else if (network === 'ws') {
    proxyLines.push('    ws-opts:');
    if (path) proxyLines.push(`      path: "${path}"`);
    if (host) {
      proxyLines.push('      headers:');
      proxyLines.push(`        Host: "${host}"`);
    }
  } else if (network === 'grpc') {
    proxyLines.push('    grpc-opts:');
    if (serviceName) proxyLines.push(`      grpc-service-name: "${serviceName}"`);
  }

  const yaml = [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    '',
    'proxies:',
    ...proxyLines,
    '',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    `      - "${name}"`,
    '      - DIRECT',
    '',
    'rules:',
    '  - MATCH,PROXY',
    '',
  ].join('\n');

  return { yaml, filename };
}

function parseAmneziaWGLink(text: string): { yaml: string; filename: string } {
  let base64Data: string;
  let name = 'AmneziaWG';

  if (text.startsWith('vpn://')) {
    // Format: vpn://awg#BASE64_JSON
    const hashIdx = text.indexOf('#');
    if (hashIdx === -1) throw new Error('Invalid vpn://awg link: missing config data');
    base64Data = text.slice(hashIdx + 1);
  } else {
    // Format: awg://BASE64_JSON#NAME
    const stripped = text.slice('awg://'.length);
    const hashIdx = stripped.lastIndexOf('#');
    if (hashIdx >= 0) {
      base64Data = stripped.slice(0, hashIdx);
      const decodedName = decodeURIComponent(stripped.slice(hashIdx + 1)).trim();
      if (decodedName) name = decodedName;
    } else {
      base64Data = stripped;
    }
  }

  let config: Record<string, string>;
  try {
    const decoded = atob(base64Data.trim());
    config = JSON.parse(decoded);
  } catch {
    throw new Error('Failed to decode AmneziaWG config data');
  }

  const server = config.hostName || config.hostname || config.server || '';
  const port = config.port || '51820';
  const clientIp = (config.client_ip || config.clientIp || '10.0.0.2').split('/')[0];
  const clientIpv6 = (config.client_ipv6 || config.clientIpv6 || '').split('/')[0];
  const privateKey = config.client_priv_key || config.clientPrivKey || config.private_key || '';
  const publicKey = config.server_pub_key || config.serverPubKey || config.public_key || '';
  const psk = config.psk || config.pre_shared_key || '';
  const dns1 = config.dns1 || '1.1.1.1';
  const dns2 = config.dns2 || '';
  const mtu = config.mtu || '1280';

  // AmneziaWG obfuscation parameters
  const jc = config.Jc || config.jc || '';
  const jmin = config.Jmin || config.jmin || '';
  const jmax = config.Jmax || config.jmax || '';
  const s1 = config.S1 || config.s1 || '';
  const s2 = config.S2 || config.s2 || '';
  const h1 = config.H1 || config.h1 || '';
  const h2 = config.H2 || config.h2 || '';
  const h3 = config.H3 || config.h3 || '';
  const h4 = config.H4 || config.h4 || '';

  if (!server) throw new Error('Missing server/hostName in AmneziaWG config');
  if (!privateKey) throw new Error('Missing private key in AmneziaWG config');
  if (!publicKey) throw new Error('Missing server public key in AmneziaWG config');

  const safeName = name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'AmneziaWG';
  const filename = `${safeName}.yaml`;

  const hasAmneziaOpts = !!(jc || jmin || jmax || s1 || s2 || h1 || h2 || h3 || h4);

  const proxyLines: string[] = [
    `  - name: "${name}"`,
    '    type: wireguard',
    `    server: ${server}`,
    `    port: ${port}`,
    `    ip: ${clientIp}`,
    `    private-key: "${privateKey}"`,
    `    public-key: "${publicKey}"`,
  ];

  if (psk) proxyLines.push(`    pre-shared-key: "${psk}"`);
  if (clientIpv6) proxyLines.push(`    ipv6: ${clientIpv6}`);

  proxyLines.push('    dns:');
  proxyLines.push(`      - ${dns1}`);
  if (dns2) proxyLines.push(`      - ${dns2}`);

  proxyLines.push(`    mtu: ${mtu}`);
  proxyLines.push('    udp: true');

  if (hasAmneziaOpts) {
    proxyLines.push('    amnezia-wg-option:');
    if (jc) proxyLines.push(`      jc: ${jc}`);
    if (jmin) proxyLines.push(`      jmin: ${jmin}`);
    if (jmax) proxyLines.push(`      jmax: ${jmax}`);
    if (s1) proxyLines.push(`      s1: ${s1}`);
    if (s2) proxyLines.push(`      s2: ${s2}`);
    if (h1) proxyLines.push(`      h1: ${h1}`);
    if (h2) proxyLines.push(`      h2: ${h2}`);
    if (h3) proxyLines.push(`      h3: ${h3}`);
    if (h4) proxyLines.push(`      h4: ${h4}`);
  }

  const yaml = [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    '',
    'proxies:',
    ...proxyLines,
    '',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    `      - "${name}"`,
    '      - DIRECT',
    '',
    'rules:',
    '  - MATCH,PROXY',
    '',
  ].join('\n');

  return { yaml, filename };
}

function parseWGConfFile(content: string, originalFilename?: string): { yaml: string; filename: string } {
  const lines = content.split(/\r?\n/);
  const sections: Record<string, Record<string, string>> = {};
  let currentSection = '';

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;

    const sectionMatch = line.match(/^\[(\w+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sections[currentSection]) sections[currentSection] = {};
      continue;
    }

    const kvMatch = line.match(/^(\S+)\s*=\s*(.*)$/);
    if (kvMatch && currentSection) {
      const key = kvMatch[1].trim();
      const value = kvMatch[2].trim();
      // For AllowedIPs, append multiple values
      if (key === 'AllowedIPs' && sections[currentSection][key]) {
        sections[currentSection][key] += ',' + value;
      } else {
        sections[currentSection][key] = value;
      }
    }
  }

  const iface = sections['Interface'] || {};
  const peer = sections['Peer'] || {};

  const privateKey = iface['PrivateKey'] || '';
  const addressRaw = iface['Address'] || '';
  const dns = iface['DNS'] || '';
  const mtu = iface['MTU'] || '1280';

  const publicKey = peer['PublicKey'] || '';
  const psk = peer['PresharedKey'] || '';
  const endpoint = peer['Endpoint'] || '';

  if (!privateKey) throw new Error('Missing PrivateKey in [Interface]');
  if (!publicKey) throw new Error('Missing PublicKey in [Peer]');
  if (!endpoint) throw new Error('Missing Endpoint in [Peer]');

  // Parse endpoint -> server:port
  let server: string;
  let port: string;
  if (endpoint.startsWith('[')) {
    // IPv6: [::1]:51820
    const closeBracket = endpoint.indexOf(']');
    server = endpoint.slice(1, closeBracket);
    port = endpoint.slice(closeBracket + 2) || '51820';
  } else {
    const colonIdx = endpoint.lastIndexOf(':');
    if (colonIdx > 0) {
      server = endpoint.slice(0, colonIdx);
      port = endpoint.slice(colonIdx + 1) || '51820';
    } else {
      server = endpoint;
      port = '51820';
    }
  }

  // Parse addresses (can be comma-separated)
  const addresses = addressRaw.split(',').map((a) => a.trim()).filter(Boolean);
  let clientIp = '';
  let clientIpv6 = '';
  for (const addr of addresses) {
    const ip = addr.split('/')[0];
    if (addr.includes(':')) {
      if (!clientIpv6) clientIpv6 = ip;
    } else {
      if (!clientIp) clientIp = ip;
    }
  }
  if (!clientIp) clientIp = '10.0.0.2';

  // Parse DNS
  const dnsServers = dns.split(',').map((d) => d.trim()).filter(Boolean);
  const dns1 = dnsServers[0] || '1.1.1.1';
  const dns2 = dnsServers[1] || '';

  // AmneziaWG obfuscation parameters (from [Interface])
  const jc = iface['Jc'] || '';
  const jmin = iface['Jmin'] || '';
  const jmax = iface['Jmax'] || '';
  const s1 = iface['S1'] || '';
  const s2 = iface['S2'] || '';
  const h1 = iface['H1'] || '';
  const h2 = iface['H2'] || '';
  const h3 = iface['H3'] || '';
  const h4 = iface['H4'] || '';

  const hasAmneziaOpts = !!(jc || jmin || jmax || s1 || s2 || h1 || h2 || h3 || h4);
  const baseName = hasAmneziaOpts ? 'AmneziaWG' : 'WireGuard';

  // Derive name from filename or use protocol name
  let name = baseName;
  if (originalFilename) {
    const stripped = originalFilename.replace(/\.conf$/i, '').trim();
    if (stripped) name = stripped;
  }

  const safeName = name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || baseName;
  const filename = `${safeName}.yaml`;

  const proxyLines: string[] = [
    `  - name: "${name}"`,
    '    type: wireguard',
    `    server: ${server}`,
    `    port: ${port}`,
    `    ip: ${clientIp}`,
    `    private-key: "${privateKey}"`,
    `    public-key: "${publicKey}"`,
  ];

  if (psk) proxyLines.push(`    pre-shared-key: "${psk}"`);
  if (clientIpv6) proxyLines.push(`    ipv6: ${clientIpv6}`);

  proxyLines.push('    dns:');
  proxyLines.push(`      - ${dns1}`);
  if (dns2) proxyLines.push(`      - ${dns2}`);

  proxyLines.push(`    mtu: ${mtu}`);
  proxyLines.push('    udp: true');

  if (hasAmneziaOpts) {
    proxyLines.push('    amnezia-wg-option:');
    if (jc) proxyLines.push(`      jc: ${jc}`);
    if (jmin) proxyLines.push(`      jmin: ${jmin}`);
    if (jmax) proxyLines.push(`      jmax: ${jmax}`);
    if (s1) proxyLines.push(`      s1: ${s1}`);
    if (s2) proxyLines.push(`      s2: ${s2}`);
    if (h1) proxyLines.push(`      h1: ${h1}`);
    if (h2) proxyLines.push(`      h2: ${h2}`);
    if (h3) proxyLines.push(`      h3: ${h3}`);
    if (h4) proxyLines.push(`      h4: ${h4}`);
  }

  const yaml = [
    'mixed-port: 7890',
    'allow-lan: false',
    'mode: rule',
    'log-level: info',
    '',
    'proxies:',
    ...proxyLines,
    '',
    'proxy-groups:',
    '  - name: PROXY',
    '    type: select',
    '    proxies:',
    `      - "${name}"`,
    '      - DIRECT',
    '',
    'rules:',
    '  - MATCH,PROXY',
    '',
  ].join('\n');

  return { yaml, filename };
}

function parseProxyLink(text: string): { yaml: string; filename: string } {
  const trimmed = text.trim();

  if (trimmed.startsWith('vless://')) return parseVlessLink(trimmed);
  if (trimmed.startsWith('hysteria2://') || trimmed.startsWith('hy2://'))
    return parseHysteria2Link(trimmed);
  if (trimmed.startsWith('ss://')) return parseShadowsocksLink(trimmed);
  if (trimmed.startsWith('trojan://')) return parseTrojanLink(trimmed);
  if (trimmed.startsWith('awg://') || trimmed.startsWith('vpn://awg'))
    return parseAmneziaWGLink(trimmed);

  // Detect WireGuard/AmneziaWG .conf content (INI-style with [Interface] and [Peer])
  if (trimmed.includes('[Interface]') && trimmed.includes('[Peer]'))
    return parseWGConfFile(trimmed);

  throw new Error(
    'Unsupported link format. Supported: vless://, hysteria2://, hy2://, ss://, trojan://, awg://, vpn://awg, WireGuard/AmneziaWG .conf',
  );
}

// ─── Компонент ───────────────────────────────────────────────────────────────

function SettingsPage({
  setShowLogsModal,
  configs,
  setConfigs,
  activeConfigId,
  setActiveConfigId,
  setActiveConfigContent,
  setParsedConfig,
  vpnEnabled,
  settings,
  setSettings,
  availableUpdateVersion,
  setNeedsRestart,
}: SettingsPageProps) {
  const { t, language, setLanguage } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deleteConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [mtuError, setMtuError] = useState(false);
  const [mtuDraft, setMtuDraft] = useState(settings.mtu);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [updateStatusText, setUpdateStatusText] = useState<string | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [mihomoCoreName, setMihomoCoreName] = useState<string>('mihomo');
  const [vlessImportError, setVlessImportError] = useState<string | null>(null);
  const [isImportingVless, setIsImportingVless] = useState(false);

  // Config editor modal
  const [showConfigEditor, setShowConfigEditor] = useState(false);
  const [configEditorContent, setConfigEditorContent] = useState('');
  const [configEditorError, setConfigEditorError] = useState<string | null>(null);
  const [isSavingConfig, setIsSavingConfig] = useState(false);

  const [versionClickCount, setVersionClickCount] = useState(0);
  const [versionKickColor, setVersionKickColor] = useState<string | null>(null);
  const [showEasterEggModal, setShowEasterEggModal] = useState(false);
  const [easterEggImageUrl, setEasterEggImageUrl] = useState<string | null>(null);

  // Fake-IP filter input
  const [fakeIpDraft, setFakeIpDraft] = useState('');

  // Sync mtuDraft when settings.mtu changes externally
  useEffect(() => {
    setMtuDraft(settings.mtu);
  }, [settings.mtu]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!isTauri()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const name = await invoke<string>('get_mihomo_binary_name');
        if (cancelled) return;
        if (typeof name === 'string' && name.trim()) {
          setMihomoCoreName(name.trim());
        }
      } catch {
        // ignore
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    autostartPlugin
      .isEnabled()
      .then((enabled) => {
        if (!cancelled) setSettings((prev) => ({ ...prev, autostart: enabled }));
      })
      .catch((e) => console.error('Failed to sync autostart state:', e));
    return () => {
      cancelled = true;
    };
  }, [setSettings]);

  useEffect(() => {
    return () => {
      if (deleteConfirmTimeoutRef.current) clearTimeout(deleteConfirmTimeoutRef.current);
    };
  }, []);

  // Signal restart needed when active config changes while VPN is running
  const prevActiveConfigRef = useRef(activeConfigId);
  useEffect(() => {
    if (prevActiveConfigRef.current !== activeConfigId && vpnEnabled) {
      setNeedsRestart(true);
    }
    prevActiveConfigRef.current = activeConfigId;
  }, [activeConfigId, vpnEnabled, setNeedsRestart]);

  const toggleSetting = useCallback(
    async (key: keyof Settings) => {
      try {
        let nextValue = false;
        setSettings((prev) => {
          nextValue = !prev[key];
          return { ...prev, [key]: nextValue };
        });

        if (key === 'autostart') {
          if (!isTauri()) return;
          try {
            if (nextValue) await autostartPlugin.enable();
            else await autostartPlugin.disable();
          } catch (e) {
            console.error('Failed to set autostart:', e);
            setSettings((prev) => ({ ...prev, [key]: !nextValue }));
            return;
          }
        }

        // These settings require VPN restart — signal via sidebar button
        const settingsRequiringRestart: (keyof Settings)[] = ['enableTun', 'killSwitch', 'tunStack', 'fakeIpFilter'];
        if (vpnEnabled && settingsRequiringRestart.includes(key)) {
          setNeedsRestart(true);
        }
      } catch (e) {
        console.error('Error toggling setting:', e);
        setSettings((prev) => ({ ...prev, [key]: prev[key] }));
      }
    },
    [setSettings, vpnEnabled, setNeedsRestart],
  );

  const handleCheckUpdates = useCallback(async () => {
    if (!isTauri()) {
      setUpdateStatusText(t.settings.updateError);
      return;
    }
    setIsCheckingUpdates(true);
    setIsInstallingUpdate(false);
    setUpdateStatusText(t.settings.checkingUpdates);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = (await invoke('check_for_updates')) as UpdateCheckResult;
      setUpdateCheck(res);
      if (!res?.update_available) {
        setUpdateStatusText(t.settings.upToDate);
      } else {
        setUpdateStatusText(
          t.settings.updateAvailable.replace('{version}', res.latest_version || ''),
        );
      }
    } catch (e) {
      console.error('Update check failed:', e);
      setUpdateStatusText(t.settings.updateError);
    } finally {
      setIsCheckingUpdates(false);
    }
  }, [t.settings]);

  const handleInstallUpdate = useCallback(async () => {
    if (!isTauri() || !updateCheck?.update_available) {
      setUpdateStatusText(t.settings.updateError);
      return;
    }
    setIsInstallingUpdate(true);
    setUpdateStatusText(t.settings.installingUpdate);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('install_update');
    } catch (e) {
      console.error('Failed to install update:', e);
      setUpdateStatusText(t.settings.updateError);
      setIsInstallingUpdate(false);
    }
  }, [t.settings, updateCheck?.update_available]);

  // MTU: free typing in draft, validate only on blur/enter
  const handleMtuDraftChange = useCallback((value: string) => {
    setMtuDraft(value.replace(/\D/g, ''));
  }, []);

  const handleMtuBlur = useCallback(() => {
    const raw = mtuDraft.trim();
    if (!raw) {
      setMtuDraft(MTU_DEFAULT);
      setSettings((prev) => ({ ...prev, mtu: MTU_DEFAULT }));
      if (vpnEnabled) setNeedsRestart(true);
      return;
    }
    const numValue = parseInt(raw, 10);
    if (isNaN(numValue) || numValue < MTU_MIN || numValue > MTU_MAX) {
      setMtuError(true);
      setTimeout(() => setMtuError(false), 400);
      setMtuDraft(settings.mtu);
      return;
    }
    const strValue = String(numValue);
    if (strValue !== settings.mtu) {
      setSettings((prev) => ({ ...prev, mtu: strValue }));
      setMtuDraft(strValue);
      if (vpnEnabled) setNeedsRestart(true);
    }
  }, [mtuDraft, settings.mtu, setSettings, vpnEnabled, setNeedsRestart]);

  const handleMtuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.currentTarget.blur();
      }
    },
    [],
  );

const handleImportConfig = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;

      const content = await file.text();
      const originalFilename = file.name;
      const lowerName = originalFilename.toLowerCase();

      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');

          let importContent: string;
          let importFilename: string;

          if (lowerName.endsWith('.conf')) {
            // === Используем Rust-бэкенд (рекомендуется) ===
            // Он автоматически добавит persistent-keepalive: 25

            // Оборачиваем в полноценный минимальный конфиг
            const fullConfig = await invoke<string>('import_amnezia_wg_as_config', {
              configContent: content,
              proxyName: originalFilename.replace(/\.conf$/i, ''),
            });

            importContent = fullConfig;
            importFilename = originalFilename.replace(/\.conf$/i, '.yaml');
          } else {
            importContent = content;
            importFilename = originalFilename;
          }

          await invoke('import_config', {
            configContent: importContent,
            filename: importFilename,
          });

          const newConfig: Config = {
            id: `config-${Date.now()}-${importFilename}`,
            name: importFilename.replace(/\.(yaml|yml)$/, ''),
            filename: importFilename,
          };

          setConfigs((prev) => [...prev, newConfig]);
          setActiveConfigId(newConfig.id);
        } catch (e) {
          console.error('Failed to import config:', e);
          setVlessImportError(e instanceof Error ? e.message : String(e));
        }
      }

      if (fileInputRef.current) fileInputRef.current.value = '';
    },
    [setConfigs, setActiveConfigId],
  );

  const importProxyFromText = useCallback(
    async (raw: string) => {
      if (!isTauri()) return;
      const text = raw.trim();
      if (!text) throw new Error('Empty clipboard');

      const { yaml, filename } = parseProxyLink(text);

      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('import_config', { configContent: yaml, filename });

      const newConfig: Config = {
        id: `config-${Date.now()}-${filename}`,
        name: filename.replace(/\.(yaml|yml)$/, ''),
        filename,
      };
      setConfigs((prev) => [...prev, newConfig]);
      setActiveConfigId(newConfig.id);
    },
    [setConfigs, setActiveConfigId],
  );

  const handleImportFromClipboard = useCallback(async () => {
    if (!isTauri()) return;
    setVlessImportError(null);
    setIsImportingVless(true);
    try {
      const text = await navigator.clipboard.readText();
      await importProxyFromText(text);
    } catch (e) {
      setVlessImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsImportingVless(false);
    }
  }, [importProxyFromText]);

  const handleExportConfig = useCallback(async () => {
    if (!activeConfigId || !isTauri()) return;
    const config = configs.find((c) => c.id === activeConfigId);
    if (!config?.filename) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { save } = await import('@tauri-apps/plugin-dialog');
      const filePath = await save({
        defaultPath: config.filename,
        filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      });
      if (!filePath) return;
      await invoke('export_config_to_path', { filename: config.filename, path: filePath });
    } catch (e) {
      console.error('Failed to export config:', e);
    }
  }, [activeConfigId, configs]);

  const handleDeleteConfig = useCallback(async () => {
    if (!activeConfigId || !isTauri()) return;
    const config = configs.find((c) => c.id === activeConfigId);
    if (!config) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_config', { filename: config.filename });
      const newConfigs = configs.filter((c) => c.id !== activeConfigId);
      setConfigs(newConfigs);
      setActiveConfigId(newConfigs[0]?.id || '');
      setShowDeleteConfirm(false);
    } catch (e) {
      console.error('Failed to delete config:', e);
    }
  }, [activeConfigId, configs, setConfigs, setActiveConfigId]);

  const handleDeleteClick = useCallback(() => {
    if (!showDeleteConfirm) {
      setShowDeleteConfirm(true);
      if (deleteConfirmTimeoutRef.current) clearTimeout(deleteConfirmTimeoutRef.current);
      deleteConfirmTimeoutRef.current = setTimeout(() => {
        setShowDeleteConfirm(false);
        deleteConfirmTimeoutRef.current = null;
      }, DELETE_CONFIRM_TIMEOUT);
    } else {
      if (deleteConfirmTimeoutRef.current) {
        clearTimeout(deleteConfirmTimeoutRef.current);
        deleteConfirmTimeoutRef.current = null;
      }
      handleDeleteConfig();
    }
  }, [showDeleteConfirm, handleDeleteConfig]);

  // ─── Config Editor ──────────────────────────────────────────────────────────

  const handleOpenConfigEditor = useCallback(async () => {
    if (!activeConfigId || !isTauri()) return;
    const config = configs.find((c) => c.id === activeConfigId);
    if (!config?.filename) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const content = await invoke<string>('read_config', { filename: config.filename });
      setConfigEditorContent(content);
      setConfigEditorError(null);
      setShowConfigEditor(true);
    } catch (e) {
      console.error('Failed to read config:', e);
    }
  }, [activeConfigId, configs]);

  const handleSaveConfigEditor = useCallback(async () => {
    if (!activeConfigId || !isTauri()) return;
    const config = configs.find((c) => c.id === activeConfigId);
    if (!config?.filename) return;

    setIsSavingConfig(true);
    setConfigEditorError(null);

    try {
      const { invoke } = await import('@tauri-apps/api/core');

      // Validate YAML
      let parsed: ParsedConfig;
      try {
        parsed = await invoke<ParsedConfig>('parse_config', {
          configContent: configEditorContent,
        });
      } catch (e) {
        setConfigEditorError(`Invalid config: ${e}`);
        setIsSavingConfig(false);
        return;
      }

      // Save to file
      await invoke('import_config', {
        configContent: configEditorContent,
        filename: config.filename,
      });

      // Update parent state so useConfigStorage won't reload stale content
      setActiveConfigContent(configEditorContent);
      setParsedConfig(parsed);

      setShowConfigEditor(false);

      // Signal restart needed — user clicks sidebar button
      if (vpnEnabled) {
        setNeedsRestart(true);
      }
    } catch (e) {
      setConfigEditorError(`Failed to save: ${e}`);
    } finally {
      setIsSavingConfig(false);
    }
  }, [
    activeConfigId,
    configs,
    configEditorContent,
    vpnEnabled,
    setActiveConfigContent,
    setParsedConfig,
    setNeedsRestart,
  ]);

  const handleLanguageChange = useCallback(
    (lang: Language) => {
      setLanguage(lang);
    },
    [setLanguage],
  );

  const configOptions = useMemo(
    () => configs.map((c) => ({ value: c.id, label: c.name })),
    [configs],
  );

  const closeBehaviorOptions = useMemo(
    () => [
      { value: 'tray', label: t.settings.closeToTray },
      { value: 'exit', label: t.settings.closeExit },
    ],
    [t.settings],
  );

  const tunStackOptions = useMemo(
    () => [
      { value: 'gvisor', label: t.settings.tunStackGvisor },
      { value: 'mixed', label: t.settings.tunStackMixed },
      { value: 'system', label: t.settings.tunStackSystem },
    ],
    [t.settings],
  );

  const mihomoCoreDisplayName = useMemo(() => {
    return `${mihomoCoreName} ${MIHOMO_CORE_VERSION}`;
  }, [mihomoCoreName]);

  const versionKickLevel = useMemo(() => {
    return Math.max(0, versionClickCount - 5);
  }, [versionClickCount]);

  const versionKickShakePx = useMemo(() => {
    const px = Math.min(16, versionKickLevel * 2);
    return `${px}px`;
  }, [versionKickLevel]);

  const handleVersionEasterEggClick = useCallback(() => {
    setVersionClickCount((prev) => {
      const next = prev + 1;
      if (next >= 6) {
        const randomHue = Math.floor(Math.random() * 360);
        const randomSat = 70 + Math.floor(Math.random() * 20);
        const randomLight = 55 + Math.floor(Math.random() * 10);
        setVersionKickColor(`hsl(${randomHue} ${randomSat}% ${randomLight}%)`);
      }
      if (next >= 10) {
        const urls = EASTER_EGG_IMAGE_URLS.filter(Boolean);
        const url = urls.length ? urls[Math.floor(Math.random() * urls.length)] : null;
        setEasterEggImageUrl(url);
        setShowEasterEggModal(true);
        setVersionKickColor(null);
        return 0;
      }
      return next;
    });
  }, []);

  return (
    <div className="page-content">
      <h2 className="page-title">{t.settings.title}</h2>

      <div className="container-narrow">
        {/* Configuration */}
        <div>
          <h3 className="section-heading">{t.settings.configuration}</h3>
          <div className="panel">
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.activeConfig}</span>
              <div className="setting-top">
                <button
                  type="button"
                  onClick={handleImportFromClipboard}
                  className="btn btn-ghost-dark"
                  disabled={isImportingVless}
                >
                  <LuUpload size={18} />
                  <span className="setting-label">{t.settings.importurl}</span>
                </button>
                <CustomSelect
                  value={activeConfigId}
                  onChange={setActiveConfigId}
                  options={configOptions}
                  disabled={configs.length === 0}
                />
              </div>
            </div>
            <div className="config-actions">
              <button
                onClick={handleDeleteClick}
                className="config-action-btn config-delete-btn"
                disabled={!activeConfigId}
              >
                <LuTrash2 size={18} />
                <span
                  className="setting-label delete-label"
                  style={showDeleteConfirm ? { fontWeight: 700 } : { fontWeight: 200 }}
                >
                  {showDeleteConfirm
                    ? t.settings.confirmDelete || 'Confirm?'
                    : t.settings.deleteConfig}
                </span>
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="config-action-btn config-import-btn"
              >
                <LuUpload size={18} />
                <span className="setting-label import-label">{t.settings.importConfig}</span>
              </button>
              <button
                onClick={handleExportConfig}
                className="config-action-btn"
                disabled={!activeConfigId}
              >
                <LuDownload size={18} />
                <span className="setting-label">{t.settings.exportConfig}</span>
              </button>
              <button
                onClick={handleOpenConfigEditor}
                className="config-action-btn"
                disabled={!activeConfigId}
              >
                <LuPencil size={18} />
                <span className="setting-label">{t.settings.editConfig || 'Edit Config'}</span>
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".yaml,.yml,.conf"
              onChange={handleImportConfig}
              style={{ display: 'none' }}
            />

            {vlessImportError && (
              <div className="panel-row disabled">
                <span className="setting-label" style={{ color: 'var(--color-error, #f44)' }}>
                  {vlessImportError}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Main Settings */}
        <div>
          <h3 className="section-heading">{t.settings.mainSettings}</h3>
          <div className="panel">
            <button onClick={() => toggleSetting('autostart')} className="panel-row">
              <span className="setting-label">{t.settings.autoLaunch}</span>
              <div
                className={`toggle ${settings.autostart ? 'on' : ''}`}
                role="switch"
                aria-checked={settings.autostart}
              >
                <div className="toggle-knob" />
              </div>
            </button>
            <button onClick={() => toggleSetting('startminimized')} className="panel-row">
              <span className="setting-label">{t.settings.startminimized}</span>
              <div
                className={`toggle ${settings.startminimized ? 'on' : ''}`}
                role="switch"
                aria-checked={settings.startminimized}
              >
                <div className="toggle-knob" />
              </div>
            </button>
            <button onClick={() => toggleSetting('autoConnect')} className="panel-row">
              <span className="setting-label">{t.settings.autoConnect}</span>
              <div
                className={`toggle ${settings.autoConnect ? 'on' : ''}`}
                role="switch"
                aria-checked={settings.autoConnect}
              >
                <div className="toggle-knob" />
              </div>
            </button>
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.closeBehavior}</span>
              <CustomSelect
                value={settings.closeBehavior}
                onChange={(value) =>
                  setSettings((prev) => ({
                    ...prev,
                    closeBehavior: value as Settings['closeBehavior'],
                  }))
                }
                options={closeBehaviorOptions}
              />
            </div>
            <button onClick={() => toggleSetting('autoRestartOnRuleApply')} className="panel-row">
              <span className="setting-label">{t.settings.autoRestartOnRuleApply}</span>
              <div
                className={`toggle ${settings.autoRestartOnRuleApply ? 'on' : ''}`}
                role="switch"
                aria-checked={settings.autoRestartOnRuleApply}
              >
                <div className="toggle-knob" />
              </div>
            </button>
            <div
              className="panel-row"
              role="button"
              tabIndex={0}
              onClick={() => toggleSetting('killSwitch')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleSetting('killSwitch');
                }
              }}
            >
              <span className="setting-label setting-label-with-help">
                {t.settings.killSwitch}
                <button
                  type="button"
                  className="help-tooltip"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <LuHelpCircle size={14} className="help-icon" />
                  <span className="help-tooltip-content">{t.settings.killSwitchHelp}</span>
                </button>
              </span>
              <div
                className={`toggle ${settings.killSwitch ? 'on' : ''}`}
                role="switch"
                aria-checked={settings.killSwitch}
              >
                <div className="toggle-knob" />
              </div>
            </div>
            <button onClick={() => toggleSetting('enableTun')} className="panel-row">
              <span className="setting-label">{t.settings.enableTun}</span>
              <div
                className={`toggle ${settings.enableTun ? 'on' : ''}`}
                role="switch"
                aria-checked={settings.enableTun}
              >
                <div className="toggle-knob" />
              </div>
            </button>
            <button onClick={() => toggleSetting('snowfall')} className="panel-row">
              <span className="setting-label">{t.settings.snowfall}</span>
              <div
                className={`toggle ${settings.snowfall ? 'on' : ''}`}
                role="switch"
                aria-checked={settings.snowfall}
              >
                <div className="toggle-knob" />
              </div>
            </button>
          </div>
        </div>

        {/* Language */}
        <div>
          <h3 className="section-heading">{t.settings.language}</h3>
          <div className="panel">
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.interfaceLanguage}</span>
              <div className="language-selector" role="radiogroup">
                <button
                  className={`language-btn ${language === 'en' ? 'active' : ''}`}
                  onClick={() => handleLanguageChange('en')}
                >
                  English
                </button>
                <button
                  className={`language-btn ${language === 'ru' ? 'active' : ''}`}
                  onClick={() => handleLanguageChange('ru')}
                >
                  Русский
                </button>
                <button
                  className={`language-btn ${language === 'be' ? 'active' : ''}`}
                  onClick={() => handleLanguageChange('be')}
                >
                  Беларуская
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Advanced */}
        <div>
          <h3 className="section-heading">{t.settings.advanced}</h3>
          <div className="panel">
            <div className="panel-row disabled">
              <span className="setting-label setting-label-with-help">
                {t.settings.mtu}
                <button
                  type="button"
                  className="help-tooltip"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <LuHelpCircle size={14} className="help-icon" />
                  <span className="help-tooltip-content">{t.settings.mtuHelp}</span>
                </button>
              </span>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={mtuDraft}
                onChange={(e) => handleMtuDraftChange(e.target.value)}
                onBlur={handleMtuBlur}
                onKeyDown={handleMtuKeyDown}
                className={`input ${mtuError ? 'input-error input-shake' : ''}`}
                placeholder={`${MTU_MIN}–${MTU_MAX}`}
              />
            </div>
            <div className="panel-row disabled">
              <span className="setting-label setting-label-with-help">
                {t.settings.tunStack}
                <button
                  type="button"
                  className="help-tooltip"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <LuHelpCircle size={14} className="help-icon" />
                  <span className="help-tooltip-content">{t.settings.tunStackHelp}</span>
                </button>
              </span>
              <CustomSelect
                value={settings.tunStack}
                onChange={(value) => {
                  setSettings((prev) => ({
                    ...prev,
                    tunStack: value as Settings['tunStack'],
                  }));
                  if (vpnEnabled) setNeedsRestart(true);
                }}
                options={tunStackOptions}
              />
            </div>
            <div className="panel-row disabled" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span className="setting-label setting-label-with-help">
                  {t.settings.fakeIpFilter}
                  <button
                    type="button"
                    className="help-tooltip"
                    onClick={(e) => e.stopPropagation()}
                    onMouseDown={(e) => e.stopPropagation()}
                  >
                    <LuHelpCircle size={14} className="help-icon" />
                    <span className="help-tooltip-content">{t.settings.fakeIpFilterHelp}</span>
                  </button>
                </span>
              </div>
              <div className="fake-ip-filter-list">
                {settings.fakeIpFilter.map((filter, idx) => (
                  <div key={idx} className="fake-ip-filter-item">
                    <span className="fake-ip-filter-text">{filter}</span>
                    <button
                      type="button"
                      className="fake-ip-filter-remove"
                      onClick={() => {
                        setSettings((prev) => ({
                          ...prev,
                          fakeIpFilter: prev.fakeIpFilter.filter((_, i) => i !== idx),
                        }));
                        if (vpnEnabled) setNeedsRestart(true);
                      }}
                      aria-label="Remove"
                    >
                      <LuX size={14} />
                    </button>
                  </div>
                ))}
              </div>
              <div className="fake-ip-filter-add-row">
                <input
                  type="text"
                  className="input fake-ip-filter-input"
                  value={fakeIpDraft}
                  onChange={(e) => setFakeIpDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      const val = fakeIpDraft.trim();
                      if (val && !settings.fakeIpFilter.includes(val)) {
                        setSettings((prev) => ({
                          ...prev,
                          fakeIpFilter: [...prev.fakeIpFilter, val],
                        }));
                        setFakeIpDraft('');
                        if (vpnEnabled) setNeedsRestart(true);
                      }
                    }
                  }}
                  placeholder={t.settings.fakeIpFilterPlaceholder}
                />
                <button
                  type="button"
                  className="btn btn-ghost-dark fake-ip-filter-add-btn"
                  onClick={() => {
                    const val = fakeIpDraft.trim();
                    if (val && !settings.fakeIpFilter.includes(val)) {
                      setSettings((prev) => ({
                        ...prev,
                        fakeIpFilter: [...prev.fakeIpFilter, val],
                      }));
                      setFakeIpDraft('');
                      if (vpnEnabled) setNeedsRestart(true);
                    }
                  }}
                >
                  <LuPlus size={16} />
                  <span>{t.settings.fakeIpFilterAdd}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Logs */}
        <div>
          <h3 className="section-heading">{t.settings.logsAndDiagnostics}</h3>
          <div className="panel">
            <button onClick={() => setShowLogsModal(true)} className="panel-row">
              <div className="settings-section-container">
                <LuFileText size={18} />
                <span className="setting-label">{t.settings.logs}</span>
              </div>
              <LuChevronRight size={18} />
            </button>
          </div>
        </div>

        {/* About */}
        <div>
          <h3 className="section-heading">{t.settings.about}</h3>
          <div className="panel">
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.version}</span>
              <span
                className={`setting-value ${versionKickLevel > 0 ? 'version-kicked' : ''}`}
                role="button"
                tabIndex={0}
                onClick={handleVersionEasterEggClick}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleVersionEasterEggClick();
                  }
                }}
                style={
                  versionKickLevel > 0
                    ? ({
                        color: versionKickColor ?? undefined,
                        ['--version-kick-shake' as any]: versionKickShakePx,
                      } as CSSProperties)
                    : undefined
                }
              >
                {__APP_VERSION__}
              </span>
            </div>
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.versioncore}</span>
              <span className="setting-value">{mihomoCoreDisplayName}</span>
            </div>
            <button onClick={() => toggleSetting('autoCheckUpdates')} className="panel-row">
              <span className="setting-label">{t.settings.autoCheckUpdates}</span>
              <div
                className={`toggle ${settings.autoCheckUpdates ? 'on' : ''}`}
                role="switch"
                aria-checked={settings.autoCheckUpdates}
              >
                <div className="toggle-knob" />
              </div>
            </button>
            <div className="config-actions">
              <button
                onClick={handleCheckUpdates}
                className="config-action-btn"
                disabled={isCheckingUpdates || isInstallingUpdate}
              >
                <LuRefreshCw size={18} />
                <span className="setting-label">
                  <div className="setting-check-update">
                    {availableUpdateVersion ? (
                      <span className="update-lamp" aria-hidden="true" />
                    ) : null}
                    {t.settings.checkUpdates}
                  </div>
                </span>
              </button>
              {updateCheck?.update_available && (
                <button
                  onClick={handleInstallUpdate}
                  className="config-action-btn"
                  disabled={isCheckingUpdates || isInstallingUpdate}
                >
                  <LuDownload size={18} />
                  <span className="setting-label">{t.settings.updateNow}</span>
                </button>
              )}
            </div>
            {updateStatusText && (
              <div className="panel-row disabled">
                <span className="setting-label">{updateStatusText}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ─── Config Editor Modal ──────────────────────────────────────────── */}
      {showConfigEditor && (
        <div
          className="modal-backdrop animate-fadeIn"
          onClick={() => setShowConfigEditor(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="modal config-editor-modal animate-scaleIn"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">
                {t.settings.editConfig || 'Edit Config'}
                {' — '}
                {configs.find((c) => c.id === activeConfigId)?.name || ''}
              </h3>
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={handleSaveConfigEditor}
                  className="btn btn-icon"
                  disabled={isSavingConfig}
                  aria-label="Save"
                  title="Save"
                >
                  <LuSave size={20} />
                </button>
                <button
                  type="button"
                  onClick={() => setShowConfigEditor(false)}
                  className="btn btn-icon"
                  aria-label={t.common.close}
                >
                  <LuX size={20} />
                </button>
              </div>
            </div>
            <div className="modal-body config-editor-body">
              {configEditorError && (
                <div className="config-editor-error">{configEditorError}</div>
              )}
              <textarea
                className="config-editor-textarea"
                value={configEditorContent}
                onChange={(e) => setConfigEditorContent(e.target.value)}
                spellCheck={false}
                autoFocus
              />
            </div>
          </div>
        </div>
      )}

      {/* ─── Easter Egg Modal ─────────────────────────────────────────────── */}
      {showEasterEggModal && (
        <div
          className="modal-backdrop animate-fadeIn"
          onClick={() => setShowEasterEggModal(false)}
          role="dialog"
          aria-modal="true"
        >
          <div
            className="modal easteregg-modal animate-scaleIn"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">Спешл фо азат</h3>
              <div className="modal-actions">
                <button
                  type="button"
                  onClick={() => setShowEasterEggModal(false)}
                  className="btn btn-icon"
                  aria-label={t.common.close}
                >
                  <LuX size={20} />
                </button>
              </div>
            </div>
            <div className="modal-body easteregg-modal-body">
              {easterEggImageUrl ? (
                <img src={easterEggImageUrl} alt="" className="easteregg-image" />
              ) : (
                <div className="easteregg-empty">боо</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(SettingsPage);