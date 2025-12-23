import { useState, useCallback, useEffect, type Dispatch, type SetStateAction } from 'react';
import { LuPlus, LuX, LuSave, LuXCircle, LuSearch, LuMonitor, LuLoader2, LuGlobe, LuAsterisk, LuMapPin } from 'react-icons/lu';
import CustomSelect from './CustomSelect';
import { useI18n } from '../i18n';
import type { Rule } from '../types';

interface RulesPageProps {
  rules: Rule[];
  setRules: Dispatch<SetStateAction<Rule[]>>;
}

interface ProcessInfo {
  pid: number;
  name: string;
  path: string | null;
  icon: string | null;
}

type RuleTargetType = 'process' | 'domain' | 'domain_keyword' | 'ip';
type RuleType = 'vpn' | 'direct';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

const RULE_TYPE_ICONS: Record<RuleTargetType, React.ReactNode> = {
  process: <LuMonitor size={14} />,
  domain: <LuGlobe size={14} />,
  domain_keyword: <LuAsterisk size={14} />,
  ip: <LuMapPin size={14} />,
};

export default function RulesPage({ rules, setRules }: RulesPageProps) {
  const { t } = useI18n();
  const [editingRule, setEditingRule] = useState<Rule | null>(null);
  const [newRuleValue, setNewRuleValue] = useState('');
  const [newRuleType, setNewRuleType] = useState<RuleType>('vpn');
  const [ruleTargetType, setRuleTargetType] = useState<RuleTargetType>('process');
  const [showAddRule, setShowAddRule] = useState(false);
  const [showProcessScanner, setShowProcessScanner] = useState(false);
  const [processSearch, setProcessSearch] = useState('');
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [isLoadingProcesses, setIsLoadingProcesses] = useState(false);
  const [processError, setProcessError] = useState<string | null>(null);

  useEffect(() => {
    if (!showProcessScanner) return;
    const fetchProcesses = async () => {
      setIsLoadingProcesses(true);
      setProcessError(null);
      try {
        if (isTauri) {
          const { invoke } = await import('@tauri-apps/api/core');
          const result = await invoke<ProcessInfo[]>('get_running_processes');
          setProcesses(result);
        } else {
          setProcesses([
            { pid: 1234, name: 'chrome.exe', path: 'C:\\Program Files\\Google\\Chrome\\chrome.exe', icon: null },
            { pid: 2345, name: 'telegram.exe', path: 'C:\\Users\\User\\AppData\\Telegram\\Telegram.exe', icon: null },
          ]);
        }
      } catch (err) {
        setProcessError(err instanceof Error ? err.message : 'Failed to scan processes');
      } finally {
        setIsLoadingProcesses(false);
      }
    };
    fetchProcesses();
  }, [showProcessScanner]);

  const toggleRule = useCallback((id: number) => {
    setRules(prev => prev.map(rule => (rule.id === id ? { ...rule, active: !rule.active } : rule)));
  }, [setRules]);

  const deleteRule = useCallback((id: number) => {
    setRules(prev => prev.filter(rule => rule.id !== id));
  }, [setRules]);

  const saveEditRule = useCallback(() => {
    if (!editingRule) return;
    setRules(prev => prev.map(rule => (rule.id === editingRule.id ? editingRule : rule)));
    setEditingRule(null);
  }, [editingRule, setRules]);

  const addNewRule = useCallback(() => {
    if (!newRuleValue.trim()) return;
    const newRule: Rule = {
      id: Math.max(0, ...rules.map(r => r.id), 0) + 1,
      app: newRuleValue.trim(),
      rule: newRuleType === 'vpn' ? 'Via VPN' : 'Direct',
      active: true,
      ruleType: ruleTargetType,
    };
    setRules(prev => [...prev, newRule]);
    setNewRuleValue('');
    setNewRuleType('vpn');
    setShowAddRule(false);
  }, [newRuleValue, newRuleType, ruleTargetType, rules, setRules]);

  const selectProcess = useCallback((processName: string) => {
    setNewRuleValue(processName);
    setShowProcessScanner(false);
    setProcessSearch('');
  }, []);

  const filteredProcesses = processes.filter(
    p => p.name.toLowerCase().includes(processSearch.toLowerCase()) ||
      (p.path && p.path.toLowerCase().includes(processSearch.toLowerCase()))
  );

  const getPlaceholder = () => {
    switch (ruleTargetType) {
      case 'process': return t.rules.placeholder.process;
      case 'domain': return 'youtube.com';
      case 'domain_keyword': return 'youtube';
      case 'ip': return t.rules.placeholder.ip;
    }
  };

  const getInputLabel = () => {
    switch (ruleTargetType) {
      case 'process': return t.rules.processName;
      case 'domain': return t.rules.domain;
      case 'domain_keyword': return t.rules.domainkey;
      case 'ip': return t.rules.ipAddress;
    }
  };

  return (
    <div className="page-content animate-fadeIn">
      <div className="page-header">
        <h2 className="page-title">{t.rules.title}</h2>
        <button onClick={() => setShowAddRule(!showAddRule)} className="btn btn-ghost-dark">
          <LuPlus size={16} />
          {t.rules.addRule}
        </button>
      </div>

      {showAddRule && (
        <div className="panel animate-slideDown" style={{ marginBottom: '1.5rem' }}>
          <div className="add-rule-form">
            <div className="add-rule-type-selector">
              <button className={`type-btn ${ruleTargetType === 'process' ? 'active' : ''}`} onClick={() => setRuleTargetType('process')}>
                <LuMonitor size={16} />
                {t.rules.process}
              </button>
              <div className="type-btn-split">
                <button className={`type-btn type-btn-left ${ruleTargetType === 'domain' ? 'active' : ''}`} onClick={() => setRuleTargetType('domain')}>
                  <LuGlobe size={16} />
                  {t.rules.domain}
                </button>
                <button className={`type-btn type-btn-right ${ruleTargetType === 'domain_keyword' ? 'active' : ''}`} onClick={() => setRuleTargetType('domain_keyword')}>
                  <LuAsterisk size={16} />
                  {t.rules.domainkey}
                </button>
              </div>
              <button className={`type-btn ${ruleTargetType === 'ip' ? 'active' : ''}`} onClick={() => setRuleTargetType('ip')}>
                <LuMapPin size={16} />
                {t.rules.ipAddress}
              </button>
            </div>

            <div className="add-rule-row">
              <div className="add-rule-input">
                <label className="input-label">{getInputLabel()}</label>
                <input type="text" value={newRuleValue} onChange={e => setNewRuleValue(e.target.value)} placeholder={getPlaceholder()} className="input" style={{ width: '100%' }} />
              </div>
              {ruleTargetType === 'process' && (
                <button onClick={() => setShowProcessScanner(true)} className="btn btn-secondary-dark" aria-label={t.rules.scan}>
                  <LuSearch size={16} />
                  {t.rules.scan}
                </button>
              )}
              <div className="add-rule-select">
                <label className="input-label">{t.rules.routeVia}</label>
                <CustomSelect value={newRuleType} onChange={val => setNewRuleType(val as RuleType)} options={[{ value: 'vpn', label: 'VPN' }, { value: 'direct', label: 'Direct' }]} style={{ width: '100%' }} />
              </div>
            </div>

            <div className="flex-end">
              <button onClick={addNewRule} className="btn btn-primary-dark">{t.rules.addRule}</button>
              <button onClick={() => setShowAddRule(false)} className="btn btn-secondary-dark">{t.rules.cancel}</button>
            </div>
          </div>
        </div>
      )}

      <div className="panel">
        <div className="grid-12 header-grid">
          <div className="col-span-1">Type</div>
          <div className="col-span-4">Target</div>
          <div className="col-span-3">Rule</div>
          <div className="col-span-2">Status</div>
          <div className="col-span-2 text-right">Actions</div>
        </div>

        {rules.length === 0 && (
          <div className="panel-row" style={{ justifyContent: 'center', color: 'var(--muted)' }}>
            No rules yet. Click "Add Rule" to create one.
          </div>
        )}

        {rules.map(rule => (
          <div key={rule.id} className="grid-12 row">
            {editingRule?.id === rule.id ? (
              <>
                <div className="col-span-1">
                  {RULE_TYPE_ICONS[editingRule.ruleType || 'process']}
                </div>
                <div className="col-span-4">
                  <input type="text" value={editingRule.app} onChange={e => setEditingRule({ ...editingRule, app: e.target.value })} className="input" style={{ width: '100%' }} />
                </div>
                <div className="col-span-3">
                  <CustomSelect value={editingRule.rule === 'Via VPN' ? 'vpn' : 'direct'} onChange={val => setEditingRule({ ...editingRule, rule: val === 'vpn' ? 'Via VPN' : 'Direct' })} options={[{ value: 'vpn', label: t.rules.viaVpn }, { value: 'direct', label: t.rules.direct }]} style={{ width: '100%' }} />
                </div>
                <div className="col-span-2" />
                <div className="col-span-2 flex-end">
                  <button onClick={saveEditRule} className="btn btn-icon btn-primary-dark" aria-label={t.common.save}><LuSave size={16} /></button>
                  <button onClick={() => setEditingRule(null)} className="btn btn-icon btn-secondary-dark" aria-label={t.rules.cancel}><LuXCircle size={16} /></button>
                </div>
              </>
            ) : (
              <>
                <div className="col-span-1 flex-center">
                  <span className="rule-type-icon" title={rule.ruleType || 'process'}>
                    {RULE_TYPE_ICONS[rule.ruleType || 'process']}
                  </span>
                </div>
                <div className="col-span-4">
                  <span className="rule-app">{rule.app}</span>
                </div>
                <div className="col-span-3"><span className="rule-type">{rule.rule}</span></div>
                <div className="col-span-2">
                  <button onClick={() => toggleRule(rule.id)} className={`btn-pill ${rule.active ? 'active' : 'inactive'}`}>
                    {rule.active ? t.rules.active : t.rules.inactive}
                  </button>
                </div>
                <div className="col-span-2 flex-end">
                  <button onClick={() => setEditingRule({ ...rule })} className="btn btn-icon" aria-label={t.common.edit}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 21v-3.75L14.06 6.19a2 2 0 112.83 2.83L5.87 20.08 3 21z" />
                    </svg>
                  </button>
                  <button onClick={() => deleteRule(rule.id)} className="btn btn-icon" aria-label={t.common.delete}><LuX size={16} /></button>
                </div>
              </>
            )}
          </div>
        ))}
      </div>

      {/* Process Scanner Modal */}
      {showProcessScanner && (
        <div className="modal-backdrop animate-fadeIn" onClick={() => setShowProcessScanner(false)} role="dialog" aria-modal="true">
          <div className="modal process-scanner-modal animate-scaleIn" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h3 className="modal-title">{t.rules.runningProcesses}</h3>
              <button onClick={() => setShowProcessScanner(false)} className="btn btn-icon" aria-label={t.common.close}><LuX size={20} /></button>
            </div>
            <div className="process-search">
              <input type="text" value={processSearch} onChange={e => setProcessSearch(e.target.value)} placeholder={t.rules.searchProcesses} className="input" style={{ width: '100%' }} autoFocus />
            </div>
            <div className="process-list">
              {isLoadingProcesses && <div className="process-loading"><LuLoader2 size={24} className="spin" /><span>Scanning...</span></div>}
              {processError && <div className="process-error"><span>{processError}</span></div>}
              {!isLoadingProcesses && !processError && filteredProcesses.length === 0 && <div className="process-empty"><span>No processes found</span></div>}
              {!isLoadingProcesses && !processError && filteredProcesses.map(process => (
                <div key={`${process.pid}-${process.name}`} className="process-item" onClick={() => selectProcess(process.name)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') selectProcess(process.name); }}>
                  <div className="process-icon">
                    {process.icon ? <img src={`data:image/png;base64,${process.icon}`} alt="" width={20} height={20} /> : <LuMonitor size={16} />}
                  </div>
                  <div className="process-info">
                    <div className="process-name">{process.name}</div>
                    {process.path && <div className="process-path">{process.path}</div>}
                  </div>
                  <div className="process-pid">PID: {process.pid}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
