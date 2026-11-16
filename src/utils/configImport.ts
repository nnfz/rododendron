import { appendProxyTransport, readLinkParams, vlessEncryptionParam } from './proxyTransport';

export type ImportedProxy = { yaml: string; filename: string };

function parseVlessLink(text: string): { yaml: string; filename: string } {
  const url = new URL(text);
  if (url.protocol !== 'vless:') throw new Error('Not a vless:// link');
  if (!url.username) throw new Error('Missing UUID in vless:// link');

  const name = decodeURIComponent((url.hash || '').replace(/^#/, '')).trim() || 'VLESS';
  const server = url.hostname;
  const port = url.port ? Number(url.port) : 443;
  const params = readLinkParams(url.search);
  const network = (params.type || 'tcp').toLowerCase();
  const security = (params.security || '').toLowerCase();
  const pbk = params.pbk || '';
  const fp = params.fp || '';
  const sni = params.sni || '';
  const sid = params.sid || '';
  const flow = params.flow || '';
  const tlsEnabled = security === 'reality' || security === 'tls';
  const host = params.host || '';
  const path = params.path || '';
  const mode = params.mode || '';
  const serviceName = params.serviceName || '';
  const spx = params.spx || '';
  const extra = params.extra || '';
  const encryption = vlessEncryptionParam(params);
  const mlkem = params['support-x25519mlkem768'];

  const safeName = name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'VLESS';
  const filename = `${safeName}.yaml`;

  const proxyLines: string[] = [
    `  - name: "${name}"`,
    '    type: vless',
    `    server: ${server}`,
    `    port: ${port}`,
    `    uuid: ${url.username}`,
    '    udp: true',
    `    network: ${network}`,
    `    tls: ${tlsEnabled}`,
  ];

  appendProxyTransport(proxyLines, {
    network,
    security,
    pbk,
    fp,
    sni,
    sid,
    flow,
    spx,
    host,
    path,
    mode,
    extra,
    serviceName,
    encryption,
    mlkem,
    sniKey: 'servername',
  });

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
  const params = readLinkParams(url.search);
  const sni = params.sni || '';
  const alpn = params.alpn || '';
  const insecure = params.allowInsecure === '1';
  const network = (params.type || 'tcp').toLowerCase();
  const security = (params.security || '').toLowerCase();
  const pbk = params.pbk || '';
  const fp = params.fp || '';
  const sid = params.sid || '';
  const flow = params.flow || '';
  const spx = params.spx || '';
  const host = params.host || '';
  const path = params.path || '';
  const mode = params.mode || '';
  const extra = params.extra || '';
  const serviceName = params.serviceName || '';
  const mlkem = params['support-x25519mlkem768'];

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

  if (insecure) proxyLines.push('    skip-cert-verify: true');
  if (alpn) {
    const alpnList = alpn.split(',').map((a) => a.trim()).filter(Boolean);
    proxyLines.push('    alpn:');
    alpnList.forEach((a) => proxyLines.push(`      - ${a}`));
  }

  appendProxyTransport(proxyLines, {
    network,
    security,
    pbk,
    fp,
    sni,
    sid,
    flow,
    spx,
    host,
    path,
    mode,
    extra,
    serviceName,
    mlkem,
    sniKey: 'sni',
  });

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

export function parseProxyLink(text: string): ImportedProxy {
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
