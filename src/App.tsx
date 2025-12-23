import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import HomePage from './components/HomePage';
import RulesPage from './components/RulesPage';
import SettingsPage from './components/SettingsPage';
import LogsModal from './components/LogsModal';
import { useVPNState } from './hooks/useVPNState';
import { useSettingsStorage } from './hooks/useSettingsStorage';
import { useRulesStorage } from './hooks/useRulesStorage';
import type { Rule, Log, Settings, LogLevel, Config, ParsedConfig } from './types';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

window.addEventListener('load', async () => {
  await new Promise(resolve => setTimeout(resolve, 100));
  await getCurrentWindow().show();
});

function formatTime(date: Date): string {
  return date.toTimeString().split(' ')[0];
}

export default function App() {
  const [activePage, setActivePage] = useState<'home' | 'rules' | 'settings'>('home');
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [configRulesLoaded, setConfigRulesLoaded] = useState<string | null>(null);
  const [settings, setSettings] = useState<Settings>({
    autostart: false,
    startminimized: false,
    killSwitch: false,
    autoConnect: true,
    logLevel: 'Info',
    mtu: '1500',
  });
  const [logs, setLogs] = useState<Log[]>([]);
  
  // Config state
  const [configs, setConfigs] = useState<Config[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string>('');
  const [activeConfigContent, setActiveConfigContent] = useState<string | null>(null);
  const [parsedConfig, setParsedConfig] = useState<ParsedConfig | null>(null);
  
  // Track if initial load is done
  const initialLoadDone = useRef(false);

  const { 
    vpnEnabled, 
    vpnStatus, 
    isConnecting, 
    error: vpnError,
    startVPN, 
    stopVPN, 
    restartVPN 
  } = useVPNState();

  useSettingsStorage(settings, setSettings);
  useRulesStorage(rules, setRules);

  // Get active config filename
  const activeConfigFilename = useMemo(() => {
    const config = configs.find(c => c.id === activeConfigId);
    return config?.filename || null;
  }, [configs, activeConfigId]);

  // Load rules from parsed config (only once per config)
  useEffect(() => {
    if (!parsedConfig || !activeConfigId) return;
    if (configRulesLoaded === activeConfigId) return;
    
    const configRules: Rule[] = parsedConfig.rules.map((r, idx) => ({
      id: Date.now() + idx,
      app: r.target,
      rule: r.action === 'PROXY' ? 'Via VPN' : 'Direct',
      active: true,
      ruleType: (r.rule_type === 'process' || r.rule_type === 'domain' || 
                 r.rule_type === 'domain_keyword' || r.rule_type === 'ip') 
        ? r.rule_type 
        : 'domain',
    }));
    
    if (configRules.length > 0) {
      setRules(prev => {
        const existingApps = new Set(prev.map(r => r.app.toLowerCase()));
        const newRules = configRules.filter(r => !existingApps.has(r.app.toLowerCase()));
        return [...prev, ...newRules];
      });
    }
    setConfigRulesLoaded(activeConfigId);
    // Mark initial load as done after a short delay
    setTimeout(() => {
      initialLoadDone.current = true;
    }, 100);
  }, [parsedConfig, activeConfigId, configRulesLoaded]);

  // Auto-save rules to config file when rules change
  useEffect(() => {
    if (!isTauri || !activeConfigFilename || !initialLoadDone.current) return;
    if (rules.length === 0) return;
    
    const saveRules = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const userRules = rules.map(r => ({
          id: r.id,
          app: r.app,
          rule: r.rule,
          active: r.active,
          rule_type: r.ruleType || 'process',
        }));
        
        await invoke('save_rules_to_config', {
          filename: activeConfigFilename,
          userRules,
        });
        console.log('Rules saved to config');
      } catch (e) {
        console.error('Failed to save rules:', e);
      }
    };
    
    // Debounce save
    const timeout = setTimeout(saveRules, 500);
    return () => clearTimeout(timeout);
  }, [rules, activeConfigFilename]);

  const addLog = useCallback((level: LogLevel, message: string) => {
    setLogs(prev => [{
      id: Date.now(),
      time: formatTime(new Date()),
      level,
      message,
    }, ...prev].slice(0, 100));
  }, []);

  const handleToggleVPN = useCallback(async () => {
    if (vpnEnabled) {
      addLog('INFO', 'Disconnecting...');
      await stopVPN();
      addLog('INFO', 'VPN disconnected');
    } else {
      if (!activeConfigContent) {
        addLog('ERROR', 'No config selected');
        return;
      }
      addLog('INFO', 'Connecting...');
      await startVPN(activeConfigContent, rules, settings.logLevel);
    }
  }, [vpnEnabled, activeConfigContent, rules, settings.logLevel, startVPN, stopVPN, addLog]);

  const handleRestartVPN = useCallback(async () => {
    if (!activeConfigContent) return;
    addLog('INFO', 'Restarting VPN...');
    await restartVPN(activeConfigContent, rules, settings.logLevel);
  }, [activeConfigContent, rules, settings.logLevel, restartVPN, addLog]);

  useEffect(() => {
    if (vpnEnabled && vpnStatus) {
      addLog('INFO', `Connected to ${vpnStatus.server || 'server'}`);
    }
  }, [vpnEnabled]);

  useEffect(() => {
    if (vpnError) {
      addLog('ERROR', vpnError);
    }
  }, [vpnError, addLog]);

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  const pageContent = useMemo(() => {
    switch (activePage) {
      case 'home':
        return (
          <HomePage 
            vpnEnabled={vpnEnabled} 
            vpnStatus={vpnStatus}
            parsedConfig={parsedConfig}
            isConnecting={isConnecting}
            error={vpnError}
            toggleVPN={handleToggleVPN} 
            restartVPN={handleRestartVPN}
            hasConfig={!!activeConfigContent}
          />
        );
      case 'rules':
        return <RulesPage rules={rules} setRules={setRules} />;
      case 'settings':
        return (
          <SettingsPage 
            settings={settings} 
            setSettings={setSettings} 
            setShowLogsModal={setShowLogsModal}
            configs={configs}
            setConfigs={setConfigs}
            activeConfigId={activeConfigId}
            setActiveConfigId={setActiveConfigId}
            setActiveConfigContent={setActiveConfigContent}
            setParsedConfig={setParsedConfig}
          />
        );
    }
  }, [
    activePage, vpnEnabled, vpnStatus, parsedConfig, isConnecting, 
    handleToggleVPN, handleRestartVPN, activeConfigContent, rules, 
    settings, configs, activeConfigId
  ]);

  return (
    <div className="app-root">
      <Titlebar />
      <div className="app-container">
        <Sidebar activeTab={activePage} setActiveTab={setActivePage} vpnEnabled={vpnEnabled} />
        <main className="app-main">{pageContent}</main>
      </div>
      <LogsModal 
        showLogsModal={showLogsModal} 
        setShowLogsModal={setShowLogsModal} 
        logs={logs} 
        settings={settings} 
        setSettings={setSettings} 
      />
    </div>
  );
}