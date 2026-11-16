import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Rule } from '../types';
import { ruleFromStoredLine, selectSubscriptionRules } from './subscriptionRules.ts';

function rule(partial: Partial<Rule> & Pick<Rule, 'id' | 'app' | 'rule'>): Rule {
  return {
    active: true,
    ruleType: 'process',
    ...partial,
  };
}

describe('selectSubscriptionRules', () => {
  it('restores metadata rules when localStorage is empty', () => {
    const selected = selectSubscriptionRules(['PROCESS-NAME,chrome.exe,PROXY'], []);
    assert.deepEqual(selected, [
      rule({ id: 1, app: 'chrome.exe', rule: 'Via VPN', ruleType: 'process' }),
    ]);
  });

  it('keeps a local cache when metadata has no rules yet', () => {
    const local = [rule({ id: 7, app: 'firefox.exe', rule: 'Direct', ruleType: 'process' })];
    assert.deepEqual(selectSubscriptionRules([], local), local);
    assert.deepEqual(selectSubscriptionRules(null, local), local);
  });

  it('returns an empty list only when both stores are empty', () => {
    assert.deepEqual(selectSubscriptionRules([], []), []);
    assert.deepEqual(selectSubscriptionRules(undefined, []), []);
  });

  it('prefers metadata over a stale inactive local copy and keeps tags', () => {
    const local = [
      rule({ id: 42, app: 'chrome.exe', rule: 'Via VPN', active: false, tags: [3] }),
      rule({ id: 9, app: 'old.exe', rule: 'Direct', active: false }),
    ];
    const selected = selectSubscriptionRules(['PROCESS-NAME,chrome.exe,PROXY'], local);
    assert.equal(selected[0].id, 42);
    assert.equal(selected[0].active, true);
    assert.deepEqual(selected[0].tags, [3]);
    assert.equal(selected[1].app, 'old.exe');
    assert.equal(selected[1].active, false);
  });

  it('drops a local active rule that metadata does not contain', () => {
    const local = [rule({ id: 5, app: 'extra.exe', rule: 'Via VPN', active: true })];
    const selected = selectSubscriptionRules(['DOMAIN,example.com,PROXY'], local);
    assert.deepEqual(selected.map(item => item.app), ['example.com']);
  });

  it('parses domain, keyword, and ip rules without treating MATCH as a user rule', () => {
    const selected = selectSubscriptionRules(
      [
        'DOMAIN,Example.com,PROXY',
        'DOMAIN-KEYWORD,example,DIRECT',
        'IP-CIDR,1.2.3.4/32,DIRECT,no-resolve',
        'MATCH,PROXY',
        'SUB-RULE,(PROCESS-NAME,chrome.exe),rododendron-subscription',
      ],
      [],
    );
    assert.deepEqual(
      selected.map(item => [item.ruleType, item.app, item.rule]),
      [
        ['domain', 'Example.com', 'Via VPN'],
        ['domain_keyword', 'example', 'Direct'],
        ['ip', '1.2.3.4', 'Direct'],
      ],
    );
  });

  it('ignores a metadata list that contains only a terminal match', () => {
    const local = [rule({ id: 2, app: 'chrome.exe', rule: 'Via VPN' })];
    assert.equal(ruleFromStoredLine('MATCH,DIRECT', 1), null);
    assert.deepEqual(selectSubscriptionRules(['MATCH,DIRECT'], local), local);
  });
});
