import type { Rule } from '../types';

export function subscriptionRuleKey(rule: Pick<Rule, 'app' | 'rule' | 'ruleType'>): string {
  const type = rule.ruleType || 'process';
  return `${type}:${rule.app.trim().toLowerCase()}:${rule.rule.trim()}`;
}

export function ruleFromStoredLine(line: string, id: number): Rule | null {
  const parts = line.split(',').map(part => part.trim());
  if (parts.length < 3 || !parts[0]) return null;
  const kind = parts[0].toUpperCase();
  const policy = parts[2].toUpperCase();
  let app = parts[1];
  let ruleType: Rule['ruleType'];
  if (kind === 'PROCESS-NAME') ruleType = 'process';
  else if (kind === 'DOMAIN' || kind === 'DOMAIN-SUFFIX') ruleType = 'domain';
  else if (kind === 'DOMAIN-KEYWORD') ruleType = 'domain_keyword';
  else if (kind === 'IP-CIDR' || kind === 'IP-CIDR6') {
    ruleType = 'ip';
    app = app.replace(/\/32$/i, '');
  } else {
    return null;
  }
  if (!app) return null;
  return {
    id,
    app,
    rule: policy === 'DIRECT' ? 'Direct' : 'Via VPN',
    active: true,
    ruleType,
  };
}

/**
 * Subscription metadata is the saved rule list. An empty local cache is not a
 * delete. Metadata wins when it has rules; an empty metadata list falls back
 * to local rules so an unsynced cache can be stored on the next save.
 */
export function selectSubscriptionRules(metaLines: string[] | null | undefined, localRules: Rule[]): Rule[] {
  const fromMeta: Rule[] = [];
  (metaLines ?? []).forEach((line, index) => {
    const rule = ruleFromStoredLine(line, index + 1);
    if (rule) fromMeta.push(rule);
  });
  if (fromMeta.length === 0) return localRules;

  const localByKey = new Map<string, Rule>();
  for (const rule of localRules) localByKey.set(subscriptionRuleKey(rule), rule);
  const activeKeys = new Set<string>();
  const active = fromMeta.map(rule => {
    const key = subscriptionRuleKey(rule);
    activeKeys.add(key);
    const saved = localByKey.get(key);
    if (!saved) return rule;
    return { ...rule, id: saved.id, tags: saved.tags, active: true };
  });
  const inactive = localRules.filter(rule => !rule.active && !activeKeys.has(subscriptionRuleKey(rule)));
  return [...active, ...inactive];
}
