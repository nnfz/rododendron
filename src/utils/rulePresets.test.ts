import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Rule } from '../types';
import {
  loadOrMigratePresets,
  memoryStore,
  mergeSavedAndParsedRules,
  nextPresetName,
  rulesFromTemplate,
  RULE_TEMPLATES,
  withActiveRules,
  withoutPreset,
} from './rulePresets.ts';

function rule(partial: Partial<Rule> & Pick<Rule, 'id' | 'app' | 'rule'>): Rule {
  return {
    active: true,
    ruleType: 'process',
    ...partial,
  };
}

describe('loadOrMigratePresets', () => {
  it('turns the active profile rules into the main preset', () => {
    const store = memoryStore({
      'vpn-rules:config-home.yaml': JSON.stringify([
        rule({ id: 4, app: 'chrome.exe', rule: 'Via VPN', tags: [1] }),
      ]),
    });
    const stored = loadOrMigratePresets(store, [
      { id: 'config-home.yaml', name: 'Home', userRuleLines: null },
    ], 'config-home.yaml', 'Main');

    assert.equal(stored.activeId, 'default');
    assert.deepEqual(stored.presets, [{
      id: 'default',
      name: 'Main',
      rules: [rule({ id: 4, app: 'chrome.exe', rule: 'Via VPN', tags: [1] })],
    }]);
    assert.equal(store.getItem('vpn-rules:config-home.yaml'), null);
  });

  it('keeps other profiles as switchable presets and leaves an empty active profile empty', () => {
    const store = memoryStore({
      'vpn-rules:config-home.yaml': JSON.stringify([]),
      'vpn-rules:config-work.yaml': JSON.stringify([
        rule({ id: 2, app: 'slack.exe', rule: 'Direct' }),
      ]),
    });
    const stored = loadOrMigratePresets(store, [
      { id: 'config-home.yaml', name: 'Home', userRuleLines: null },
      { id: 'config-work.yaml', name: 'Work', userRuleLines: null },
    ], 'config-home.yaml', 'Main');

    assert.equal(stored.activeId, 'default');
    assert.deepEqual(stored.presets.map(preset => [preset.name, preset.rules.map(item => item.app)]), [
      ['Main', []],
      ['Work', ['slack.exe']],
    ]);
  });

  it('keeps migrating when the default name and a profile name are missing', () => {
    const store = memoryStore({
      'vpn-rules:config-work.yaml': JSON.stringify([
        rule({ id: 2, app: 'slack.exe', rule: 'Direct' }),
      ]),
    });
    const stored = loadOrMigratePresets(store, [
      { id: 'config-home.yaml', name: undefined as unknown as string, userRuleLines: null },
      { id: 'config-work.yaml', name: 'Work', userRuleLines: null },
    ], 'config-home.yaml', undefined as unknown as string);

    assert.equal(stored.activeId, 'default');
    assert.deepEqual(stored.presets.map(preset => [preset.name, preset.rules.map(item => item.app)]), [
      ['Main', []],
      ['Work', ['slack.exe']],
    ]);
    assert.equal(store.getItem('vpn-rules:config-work.yaml'), null);
  });

  it('names the active profile Main and keeps the other profile preset', () => {
    const store = memoryStore({
      'vpn-rules:config-home.yaml': JSON.stringify([
        rule({ id: 1, app: 'chrome.exe', rule: 'Via VPN' }),
      ]),
      'vpn-rules:config-work.yaml': JSON.stringify([
        rule({ id: 2, app: 'slack.exe', rule: 'Direct' }),
      ]),
    });
    const stored = loadOrMigratePresets(store, [
      { id: 'config-home.yaml', name: 'Home', userRuleLines: null },
      { id: 'config-work.yaml', name: 'Work', userRuleLines: null },
    ], 'config-home.yaml', 'Main');

    assert.deepEqual(stored.presets.map(preset => preset.name), ['Main', 'Work']);
    assert.equal(stored.presets[0].rules[0].app, 'chrome.exe');
    assert.equal(stored.presets[1].rules[0].app, 'slack.exe');
  });

  it('restores subscription rules and does not replace them when another profile appears later', () => {
    const store = memoryStore({
      'vpn-rules:config-sub.yaml': JSON.stringify([
        rule({ id: 7, app: 'chrome.exe', rule: 'Via VPN', active: false, tags: [3] }),
      ]),
    });
    const hints = [{
      id: 'config-sub.yaml',
      name: 'Sub',
      userRuleLines: ['PROCESS-NAME,chrome.exe,PROXY'],
    }];
    const first = loadOrMigratePresets(store, hints, 'config-sub.yaml', 'Main');
    assert.equal(first.presets[0].rules[0].tags?.[0], 3);
    assert.equal(first.presets[0].rules[0].active, true);

    const second = loadOrMigratePresets(store, [
      ...hints,
      {
        id: 'config-new.yaml',
        name: 'New',
        userRuleLines: ['PROCESS-NAME,discord.exe,PROXY'],
      },
    ], 'config-new.yaml', 'Main');
    assert.deepEqual(second, first);
  });

  it('merges parsed local rules with inactive saved rules', () => {
    const saved = [rule({ id: 9, app: 'old.exe', rule: 'Direct', active: false, tags: [2] })];
    const merged = mergeSavedAndParsedRules(saved, [{
      rule_type: 'domain',
      target: 'example.com',
      action: 'PROXY',
      raw: 'DOMAIN,example.com,PROXY',
    }], 20);
    assert.deepEqual(merged.map(item => [item.app, item.active, item.tags?.[0] ?? null]), [
      ['example.com', true, null],
      ['old.exe', false, 2],
    ]);
  });
});

describe('preset edits', () => {
  it('updates only the active preset and can switch by deleting it', () => {
    const state = {
      activeId: 'default',
      presets: [
        { id: 'default', name: 'Main', rules: [rule({ id: 1, app: 'chrome.exe', rule: 'Via VPN' })] },
        { id: 'work', name: 'Work', rules: [rule({ id: 2, app: 'slack.exe', rule: 'Direct' })] },
      ],
    };
    const edited = withActiveRules(state, []);
    assert.equal(edited.presets[1].rules[0].app, 'slack.exe');
    const removed = withoutPreset(edited, 'default');
    assert.equal(removed.activeId, 'work');
    assert.equal(withoutPreset(removed, 'work'), removed);
    assert.equal(nextPresetName(removed.presets, 'Work'), 'Work 2');
  });

  it('builds process rules from a template', () => {
    const browsers = RULE_TEMPLATES.find(template => template.id === 'browsers');
    assert.ok(browsers);
    const rules = rulesFromTemplate(browsers, 10);
    assert.deepEqual(rules.map(item => [item.id, item.app, item.rule, item.ruleType]), [
      [10, 'chrome.exe', 'Via VPN', 'process'],
      [11, 'msedge.exe', 'Via VPN', 'process'],
      [12, 'firefox.exe', 'Via VPN', 'process'],
      [13, 'opera.exe', 'Via VPN', 'process'],
      [14, 'brave.exe', 'Via VPN', 'process'],
    ]);
  });
});
