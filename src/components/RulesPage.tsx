import { memo, useEffect, useState, useCallback, type Dispatch, type SetStateAction } from 'react';
import { LuPlus, LuTrash2, LuSearch, LuMonitor, LuGlobe, LuHash, LuX, LuHelpCircle } from 'react-icons/lu';
import { useI18n } from '../i18n';
import type { Rule } from '../types';
import { isTauri } from '../utils/isTauri';
import CustomSelect from './CustomSelect';

interface RulesPageProps {
  rules: Rule[];
  setRules: Dispatch<SetStateAction<Rule[]>>;
  vpnEnabled: boolean;
  restartVPN: (rulesOverride?: Rule[]) => Promise<void>;
  activeConfigFilename: string | null;
}

type RuleType = 'process' | 'domain' | 'domain_keyword';

function RulesPage({ rules, setRules, vpnEnabled, restartVPN }: RulesPageProps) {
  const { t } = useI18n();
  const [osPlatform, setOsPlatform] = useState<'windows' | 'macos' | 'linux' | 'unknown'>('unknown');
  const [newRuleApp, setNewRuleApp] = useState('');
  const [newRuleType, setNewRuleType] = useState<RuleType>('process');
  const [newRuleAction, setNewRuleAction] = useState<'Via VPN' | 'Direct'>('Via VPN');
  const [newRuleInputError, setNewRuleInputError] = useState(false);
  const [newRuleInputShake, setNewRuleInputShake] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [showProcessScanner, setShowProcessScanner] = useState(false);
  const [processes, setProcesses] = useState<
    Array<{ name: string; pid: number; path?: string | null; icon?: string | null }>
  >([]);
  const [isLoadingProcesses, setIsLoadingProcesses] = useState(false);
  const [processSearchQuery, setProcessSearchQuery] = useState('');

  useEffect(() => {
    if (!isTauri()) return;
    const ua = navigator.userAgent.toLowerCase();
    if (ua.includes("windows")) setOsPlatform('windows');
    else if (ua.includes("mac os") || ua.includes("macos")) setOsPlatform('macos');
    else if (ua.includes("linux")) setOsPlatform('linux');
    else setOsPlatform('unknown');
  }, []);

  const exportRulesToConfig = useCallback(async () => {
    if (!isTauri()) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');

      const userRules = rules.map(r => ({
        id: r.id,
        app: r.app,
        rule: r.rule,
        active: r.active,
        rule_type: r.ruleType,
      }));

      const { open } = await import('@tauri-apps/plugin-dialog');
      const selected = await open({
        multiple: false,
        filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      });

      if (!selected || typeof selected !== 'string') return;

      await invoke('save_rules_to_path', { path: selected, userRules });
    } catch (e) {
      console.error('Failed to export rules to config:', e);
    }
  }, [rules]);

  const loadProcesses = useCallback(async () => {
    if (!isTauri()) return;
    setIsLoadingProcesses(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const procs = await invoke<
        Array<{ name: string; pid: number; path?: string | null; icon?: string | null }>
      >('get_running_processes');
      setProcesses(procs);
    } catch (e) {
      console.error('Failed to load processes:', e);
    } finally {
      setIsLoadingProcesses(false);
    }
  }, []);

  const openProcessScanner = useCallback(() => {
    setShowProcessScanner(true);
    loadProcesses();
  }, [loadProcesses]);

  const selectProcess = useCallback((processName: string) => {
    setNewRuleApp(processName);
    setShowProcessScanner(false);
    setProcessSearchQuery('');
  }, []);

  const toggleRule = useCallback(async (id: number) => {
    const nextRules = rules.map(r => r.id === id ? { ...r, active: !r.active } : r);
    setRules(nextRules);
    if (vpnEnabled) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await restartVPN(nextRules);
    }
  }, [rules, setRules, vpnEnabled, restartVPN]);

  const isValidProcessTarget = useCallback((raw: string): boolean => {
    const s = raw.trim();
    if (!s) return false;
    const lower = s.toLowerCase();

    // Disallow obvious URLs/paths; process rules should be just a process name.
    if (lower.includes('://') || s.includes('/') || s.includes('\\')) return false;

    // Some characters are invalid/unsafe to store as a process target.
    if (/[<>:"|?*]/.test(s)) return false;

    // Avoid confusing process rule with domain.
    if (lower.endsWith('.com')) return false;

    if (osPlatform === 'windows') {
      // Keep strict Windows expectations to prevent user mistakes.
      if (s.includes('@')) return false;
      if (s.includes(' ')) return false;
      const allowedExtensions = ['.exe', '.bat', '.cmd', '.scr'];
      if (!allowedExtensions.some(ext => lower.endsWith(ext))) return false;
      return true;
    }

    // macOS/Linux: allow spaces, and do not require .exe.
    if (s.includes('@')) return false;
    return true;
  }, [osPlatform]);

  const triggerNewRuleInputError = useCallback(() => {
    setNewRuleInputError(true);
    setNewRuleInputShake(true);
    setTimeout(() => setNewRuleInputShake(false), 400);
  }, []);

  const deleteRule = useCallback(async (id: number) => {
    const nextRules = rules.filter(r => r.id !== id);
    setRules(nextRules);
    if (vpnEnabled) {
      await restartVPN(nextRules);
    }
  }, [rules, setRules, vpnEnabled, restartVPN]);

  const addRule = useCallback(async () => {
    const normalizeTarget = (raw: string) => {
      const t = raw.trim();
      if (!t) return '';
      if (newRuleType === 'domain' || newRuleType === 'domain_keyword') {
        return t.toLowerCase();
      }
      return t;
    };

    const targets = newRuleApp
      .split(',')
      .map(normalizeTarget)
      .filter(Boolean);

    if (targets.length === 0) return;

    if (newRuleType === 'process') {
      const hasInvalid = targets.some(t => !isValidProcessTarget(t));
      if (hasInvalid) {
        triggerNewRuleInputError();
        return;
      }
    }

    const existingKeys = new Set(rules.map(r => `${r.ruleType}:${r.app.toLowerCase()}:${r.rule}`));
    const seenInInput = new Set<string>();

    const baseId = Date.now();
    const newRules: Rule[] = [];
    for (const target of targets) {
      const key = `${newRuleType}:${target.toLowerCase()}:${newRuleAction}`;
      if (existingKeys.has(key)) continue;
      if (seenInInput.has(key)) continue;
      seenInInput.add(key);
      newRules.push({
        id: baseId + newRules.length,
        app: target,
        rule: newRuleAction,
        active: true,
        ruleType: newRuleType,
      });
    }

    if (newRules.length === 0) {
      setNewRuleInputError(false);
      return;
    }

    const nextRules = [...rules, ...newRules];
    setRules(nextRules);
    setNewRuleApp('');
    setNewRuleInputError(false);

    if (vpnEnabled) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await restartVPN(nextRules);
    }
  }, [newRuleApp, newRuleAction, newRuleType, rules, setRules, vpnEnabled, restartVPN, isValidProcessTarget, triggerNewRuleInputError]);

  const handleKeyPress = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      addRule();
    }
  }, [addRule]);

  const filteredRules = rules.filter(rule =>
    rule.app.toLowerCase().includes(searchQuery.toLowerCase())
  );
  const filteredProcesses = processes.filter(proc =>
    proc.name.toLowerCase().includes(processSearchQuery.toLowerCase())
  );

  const getRuleTypeLabel = (type: string) => {
    switch (type) {
      case 'process': return 'Process';
      case 'domain': return 'Domain';
      case 'domain_keyword': return 'Keyword';
      default: return type;
    }
  };
  const getRuleTypeLabelPlaceholder = (type: string) => {
    switch (type) {
      case 'process': return osPlatform === 'windows' ? 'chrome.exe' : 'Google Chrome';
      case 'domain': return 'youtube.com';
      case 'domain_keyword': return 'youtube';
      default: return type;
    }
  };

  const getRuleTypeIcon = (type: string) => {
    switch (type) {
      case 'process': return <LuMonitor size={14} />;
      case 'domain': return <LuGlobe size={14} />;
      case 'domain_keyword': return <LuHash size={14} />;
      default: return <LuMonitor size={14} />;
    }
  };

  const getAppNameTranslation = (appName: string) => {
    switch (appName) {
      case 'process': return t.rules.process;
      case 'domain': return t.rules.domain;
      case 'domain_keyword': return t.rules.domainkey;
      default: return appName;
    }
  };

  return (
    <div className="page-content">
      <div className="page-header">
        <h2 className="page-title">{t.rules.title}</h2>
      </div>

      <div className="container-narrow">
        {isTauri() && (
          <div className="panel">
            <div className="panel-row disabled" style={{ justifyContent: 'space-between' }}>
              <span className="setting-label">
                {t.rules.title}
                <button
                  type="button"
                  className="help-tooltip"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <LuHelpCircle size={14} className="help-icon" />
                  <span className="help-tooltip-content">{t.rules.exportToConfigHelp}</span>
                </button>
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <button onClick={exportRulesToConfig} className="btn btn-primary-dark">
                  {t.rules.exportToConfig}
                </button>
              </div>
            </div>
          </div>
        )}

        <div className="panel">
          <div className="add-rule-form">
            <div className="add-rule-type-selector">
              <button
                onClick={() => setNewRuleType('process')}
                className={`type-btn ${newRuleType === 'process' ? 'active' : ''}`}
              >
                <LuMonitor size={16} />
                {t.rules.process}
              </button>
              <button
                onClick={() => setNewRuleType('domain')}
                className={`type-btn ${newRuleType === 'domain' ? 'active' : ''}`}
              >
                <LuGlobe size={16} />
                {t.rules.domain}
              </button>
              <button
                onClick={() => setNewRuleType('domain_keyword')}
                className={`type-btn ${newRuleType === 'domain_keyword' ? 'active' : ''}`}
              >
                <LuHash size={16} />
                {t.rules.domainkey}
              </button>
            </div>

            <div className="add-rule-row">
              <div className="add-rule-input">
                <input
                  type="text"
                  placeholder={`${getRuleTypeLabelPlaceholder(newRuleType).toLowerCase()}`}
                  value={newRuleApp}
                  onChange={e => {
                    setNewRuleApp(e.target.value);
                    setNewRuleInputError(false);
                  }}
                  onKeyPress={handleKeyPress}
                  className={`input ${newRuleInputError ? 'input-error' : ''} ${newRuleInputShake ? 'input-shake' : ''}`}
                  style={{ width: '100%' }}
                />
              </div>
              <CustomSelect
                value={newRuleAction}
                onChange={(val) => setNewRuleAction(val as 'Via VPN' | 'Direct')}
                options={[
                  { value: 'Via VPN', label: t.rules.viaVpn },
                  { value: 'Direct', label: t.rules.direct },
                ]}
                className="add-rule-select"
                style={{ width: '10rem' }}
              />
              {newRuleType === 'process' && isTauri() && (
                <button onClick={openProcessScanner} className="btn btn-ghost-dark">
                  <LuSearch size={18} />
                  {t.rules.scan}
                </button>
              )}
              <button onClick={addRule} className="btn btn-primary-dark">
                <LuPlus size={18} />
                {t.rules.addRule}
              </button>
            </div>
          </div>
        </div>

        {rules.length > 0 && (
          <div className="panel">
            <div className="panel-row disabled">
              <div className="flex-center" style={{ width: '100%' }}>
                <LuSearch size={18} />
                <input
                  type="text"
                  placeholder={t.rules.searchRules}
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="input"
                  style={{ width: '100%', border: 'none', background: 'transparent' }}
                />
              </div>
            </div>
          </div>
        )}

        {filteredRules.length > 0 ? (
          <div className="panel">
            <div className="header-grid grid-12">
              <div className="col-span-1">{t.rules.type}</div>
              <div className="col-span-4">{t.rules.target}</div>
              <div className="col-span-3">{t.rules.action}</div>
              <div className="col-span-2">{t.rules.status}</div>
              <div className="col-span-2 text-right">{t.rules.actions}</div>
            </div>
            {filteredRules.map(rule => (
              <div key={rule.id} className="row grid-12">
                <div className="col-span-1">
                  <span className="rule-type-badge">
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      {getRuleTypeIcon(rule.ruleType)}
                      {getRuleTypeLabel(getAppNameTranslation(rule.ruleType))}
                    </div>
                  </span>
                </div>
                <div className="col-span-4">
                  <span className="rule-app">{rule.app}</span>
                </div>
                <div className="col-span-3">
                  <span className={`tag ${rule.rule === 'Via VPN' ? 'tag-proxy-active' : 'tag-proxy-inactive'}`}>
                    {rule.rule === 'Via VPN' ? t.rules.viaVpn : t.rules.direct}
                  </span>
                </div>
                <div className="col-span-2">
                  <button
                    onClick={() => toggleRule(rule.id)}
                    className={`btn-pill ${rule.active ? 'active' : 'inactive'}`}
                  >
                    {rule.active ? t.rules.active : t.rules.inactive}
                  </button>
                </div>
                <div className="col-span-2 text-right">
                  <button onClick={() => deleteRule(rule.id)} className="btn btn-icon">
                    <LuTrash2 size={18} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="panel">
            <div className="panel-row disabled" style={{ justifyContent: 'center', padding: '3rem' }}>
              <span className="setting-label">
                {searchQuery ? 'No rules found' : t.rules.noRules}
              </span>
            </div>
          </div>
        )}
      </div>

      {showProcessScanner && (
        <div className="modal-backdrop" onClick={() => setShowProcessScanner(false)}>
          <div className="modal process-scanner-modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{t.rules.runningProcesses}</h3>
              <button onClick={() => setShowProcessScanner(false)} className="btn btn-icon">
                <LuX size={18} />
              </button>
            </div>
            <div className="process-search">
              <input
                type="text"
                placeholder={t.rules.searchProcesses}
                value={processSearchQuery}
                onChange={e => setProcessSearchQuery(e.target.value)}
                className="input"
                style={{ width: '100%' }}
                autoFocus
              />
            </div>
            <div className="process-list">
              {isLoadingProcesses ? (
                <div className="process-loading">
                  <LuMonitor size={24} className="spin" />
                  {t.rules.loadingProcesses}
                </div>
              ) : filteredProcesses.length > 0 ? (
                filteredProcesses.map(proc => (
                  <div
                    key={proc.pid}
                    className="process-item"
                    onClick={() => selectProcess(proc.name)}
                  >
                    <div className="process-icon">
                      {proc.icon ? (
                        <img
                          src={`data:image/png;base64,${proc.icon}`}
                          alt={proc.name}
                          draggable={false}
                        />
                      ) : (
                        <LuMonitor size={18} />
                      )}
                    </div>
                    <div className="process-info">
                      <div className="process-name">{proc.name}</div>
                      {proc.path ? <div className="process-path">{proc.path}</div> : null}
                    </div>
                    <div className="process-pid">PID: {proc.pid}</div>
                  </div>
                ))
              ) : (
                <div className="process-empty">{t.rules.noProcessesFound}</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default memo(RulesPage);