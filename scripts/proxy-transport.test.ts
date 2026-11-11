import { expect, test } from 'bun:test';
import { appendProxyTransport, readLinkParams, vlessEncryptionParam } from '../src/utils/proxyTransport.ts';

test('xhttp reality keeps path and host on xhttp-opts', () => {
  const lines: string[] = [];
  appendProxyTransport(lines, {
    network: 'xhttp',
    security: 'reality',
    pbk: 'PUBKEY',
    sid: 'abcd',
    flow: 'xtls-rprx-vision',
    spx: '/',
    host: 'www.example.com',
    path: '/xh',
    mode: 'stream-one',
    extra: '{"xPaddingBytes":"100-1000"}',
    sni: 'www.example.com',
  });
  const text = lines.join('\n');

  expect(text).toContain('xhttp-opts:');
  expect(text).toContain('mode: stream-one');
  expect(text).toContain('host: "www.example.com"');
  expect(text).toContain('path: "/xh"');
  expect(text).toContain('x-padding-bytes: "100-1000"');
  expect(text).toContain('client-fingerprint: chrome');
  expect(text).toContain('spider-x: "/"');
  expect(text).toContain('public-key: "PUBKEY"');
  expect(text).toContain('short-id: "abcd"');
  expect(text).not.toContain('support-x25519mlkem768');
  expect(text).not.toContain('extra:');
  expect(text).not.toContain('xPaddingBytes');
  expect(text).not.toContain('packet-encoding');
  expect(text).not.toContain('flow:');
});

test('xhttp encryption keeps vision flow', () => {
  const lines: string[] = [];
  appendProxyTransport(lines, {
    network: 'xhttp',
    security: 'reality',
    flow: 'xtls-rprx-vision',
    encryption: 'mlkem768x25519plus.native.0rtt.abc',
    path: '/xh',
  });
  const text = lines.join('\n');

  expect(text).toContain('encryption: "mlkem768x25519plus.native.0rtt.abc"');
  expect(text).toContain('flow: xtls-rprx-vision');
  expect(text).toContain('path: "/xh"');
  expect(text).not.toContain('packet-encoding');
});

test('tcp reality keeps xudp and flow', () => {
  const lines: string[] = [];
  appendProxyTransport(lines, {
    network: 'tcp',
    security: 'reality',
    fp: 'firefox',
    flow: 'xtls-rprx-vision',
    pbk: 'PUBKEY',
    sid: 'aa',
  });
  const text = lines.join('\n');

  expect(text).toContain('packet-encoding: xudp');
  expect(text).toContain('flow: xtls-rprx-vision');
  expect(text).toContain('client-fingerprint: firefox');
  expect(text).toContain('reality-opts:');
  expect(text).not.toContain('xhttp-opts:');
});

test('reality mlkem is written only when the link asks for it', () => {
  const absent = readLinkParams('?security=reality&pbk=abc+def%2Fgw%3D&sid=9dde&spx=%2Ff3b23b93fb4baa5&type=tcp');
  expect(absent.spx).toBe('/f3b23b93fb4baa5');
  expect(absent['support-x25519mlkem768']).toBeUndefined();

  const omitted: string[] = [];
  appendProxyTransport(omitted, {
    network: 'tcp',
    security: 'reality',
    pbk: absent.pbk,
    sid: absent.sid,
    spx: absent.spx,
    mlkem: absent['support-x25519mlkem768'],
  });
  const omittedText = omitted.join('\n');
  expect(omittedText).toContain('spider-x: "/f3b23b93fb4baa5"');
  expect(omittedText).toContain('public-key: "abc+def/gw="');
  expect(omittedText).not.toContain('support-x25519mlkem768');

  const enabled: string[] = [];
  appendProxyTransport(enabled, {
    network: 'tcp',
    security: 'reality',
    pbk: 'PUBKEY',
    sid: '00',
    mlkem: 'true',
  });
  expect(enabled.join('\n')).toContain('support-x25519mlkem768: true');
});

test('vless encryption is quoted and a mistaken packetEncoding is recovered', () => {
  const params = readLinkParams('?encryption=mlkem768x25519plus.native.0rtt.abc%2Bdef&type=xhttp');
  expect(vlessEncryptionParam(params)).toBe('mlkem768x25519plus.native.0rtt.abc+def');

  const mistaken = readLinkParams('?packetEncoding=mlkem768x25519plus.native.0rtt.key&encryption=none');
  expect(vlessEncryptionParam(mistaken)).toBe('mlkem768x25519plus.native.0rtt.key');
  expect(vlessEncryptionParam(readLinkParams('?encryption=none'))).toBe('');

  const lines: string[] = [];
  appendProxyTransport(lines, {
    network: 'xhttp',
    encryption: vlessEncryptionParam(params),
    path: '/megakek',
  });
  const text = lines.join('\n');
  expect(text).toContain('encryption: "mlkem768x25519plus.native.0rtt.abc+def"');
  expect(text).not.toContain('packet-encoding');
});

test('xhttp extra maps xmux onto reuse-settings and drops server-only fields', () => {
  const lines: string[] = [];
  appendProxyTransport(lines, {
    network: 'xhttp',
    path: '/megakek',
    mode: 'auto',
    extra: JSON.stringify({
      xPaddingBytes: '100-1000',
      xPaddingObfsMode: false,
      scMaxBufferedPosts: 30,
      scStreamUpServerSecs: '20-80',
      scMaxEachPostBytes: '1000000',
      scMinPostsIntervalMs: '30',
      uplinkChunkSize: 0,
      noGRPCHeader: false,
      xmux: {
        maxConcurrency: '16-32',
        maxConnections: 0,
        cMaxReuseTimes: 0,
        hMaxRequestTimes: '600-900',
        hMaxReusableSecs: '1800-3000',
        hKeepAlivePeriod: 0,
      },
      enableXmux: true,
    }),
  });
  const text = lines.join('\n');

  expect(text).toContain('x-padding-bytes: "100-1000"');
  expect(text).toContain('reuse-settings:');
  expect(text).toContain('max-concurrency: "16-32"');
  expect(text).toContain('h-max-request-times: "600-900"');
  expect(text).toContain('h-max-reusable-secs: "1800-3000"');
  expect(text).not.toContain('max-connections');
  expect(text).not.toContain('c-max-reuse-times');
  expect(text).not.toContain('h-keep-alive-period');
  expect(text).not.toContain('scMaxBufferedPosts');
  expect(text).not.toContain('sc-stream-up');
  expect(text).not.toContain('sc-max-each-post-bytes');
  expect(text).not.toContain('xPadding');
  expect(text).not.toContain('extra:');
});

test('broken xhttp extra is skipped', () => {
  const lines: string[] = [];
  appendProxyTransport(lines, {
    network: 'xhttp',
    path: '/',
    extra: '{not json',
  });
  const text = lines.join('\n');

  expect(text).toContain('path: "/"');
  expect(text).not.toContain('extra:');
  expect(text).not.toContain('packet-encoding');
});
