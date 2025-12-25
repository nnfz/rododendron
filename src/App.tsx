import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import Snowfall from 'react-snowfall';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import HomePage from './components/HomePage';
import RulesPage from './components/RulesPage';
import SettingsPage from './components/SettingsPage';
import LogsModal from './components/LogsModal';
import { useVPNState } from './hooks/useVPNState';
import { useVPNStats } from './hooks/useVPNStat';
import { useSettingsStorage } from './hooks/useSettingsStorage';
import { useRulesStorage } from './hooks/useRulesStorage';
import type { Rule, Log, LogLevel, Config, ParsedConfig } from './types';
import { isTauri } from './utils/isTauri';

function formatTime(date: Date): string {
  return date.toTimeString().split(' ')[0];
}

export default function App() {
  const initialLoadDone = useRef(false);
  const autoConnectTriggeredRef = useRef(false);
  const autoConnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasVpnEnabledRef = useRef(false);
  const restartVpnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartVpnInFlightRef = useRef(false);
  const restartVpnPendingRulesRef = useRef<Rule[] | null>(null);
  const prevNarrowLayoutRef = useRef<boolean | null>(null);
  const [isNarrowLayout, setIsNarrowLayout] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePage, setActivePage] = useState<'home' | 'rules' | 'settings'>('home');
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [rules, setRules] = useState<Rule[]>([]);
  const [configRulesLoaded, setConfigRulesLoaded] = useState<string | null>(null);
  const [settings, setSettings] = useSettingsStorage();
  const [logs, setLogs] = useState<Log[]>([]);
  
  const [configs, setConfigs] = useState<Config[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string>('');
  const [activeConfigContent, setActiveConfigContent] = useState<string | null>(null);
  const [activeConfigFilename, setActiveConfigFilename] = useState<string | null>(null);
  const [parsedConfig, setParsedConfig] = useState<ParsedConfig | null>(null);
  
  // Logging function
  const addLog = useCallback((level: LogLevel, message: string) => {
    setLogs(prev => [{
      id: Date.now(),
      time: formatTime(new Date()),
      level,
      message
    }, ...prev].slice(0, 1000));
  }, []);
  
  // Loading configurations on start
  useEffect(() => {
    if (!isTauri()) return;
    
    const loadConfigs = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const filenames = await invoke<string[]>('list_configs');
        const loadedConfigs: Config[] = filenames.map((filename) => ({
          id: `config-${filename}`,
          name: filename.replace(/\.(yaml|yml)$/, ''),
          filename,
        }));
        setConfigs(loadedConfigs);
        
        // Restore active config
        const savedActive = localStorage.getItem('vpn-active-config');
        if (savedActive && loadedConfigs.some(c => c.id === savedActive)) {
          setActiveConfigId(savedActive);
        } else if (loadedConfigs.length > 0) {
          setActiveConfigId(loadedConfigs[0].id);
        }
      } catch (e) {
        console.error('Failed to load configs:', e);
      }
    };
    
    loadConfigs();
  }, []);

  // Update activeConfigFilename when activeConfigId changes
  useEffect(() => {
    const config = configs.find(c => c.id === activeConfigId);
    setActiveConfigFilename(config?.filename || null);
  }, [configs, activeConfigId]);

  // Loading active config content
  useEffect(() => {
    if (!activeConfigId || !isTauri() || !activeConfigFilename) return;
    
    const loadContent = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const content = await invoke<string>('read_config', { filename: activeConfigFilename });
        setActiveConfigContent(content);
        
        const parsed = await invoke<ParsedConfig>('parse_config', { configContent: content });
        setParsedConfig(parsed);
        
        localStorage.setItem('vpn-active-config', activeConfigId);
      } catch (e) {
        console.error('Failed to load config:', e);
      }
    };
    
    loadContent();
  }, [activeConfigId, activeConfigFilename]);

  const {
    vpnEnabled,
    vpnStatus,
    isConnecting,
    error: vpnError,
    startVPN,
    stopVPN,
  } = useVPNState();


  // Global VPN statistics
  const proxyName = vpnStatus?.proxy_name || parsedConfig?.proxy_name || 'Unknown';
  const { traffic, latency, formatUptime, formatTraffic } = useVPNStats(vpnEnabled, proxyName);

  const restartVPN = useCallback(async (rulesOverride?: Rule[]) => {
    // Coalesce rapid changes: keep only the latest rules snapshot.
    restartVpnPendingRulesRef.current = rulesOverride ?? rules;

    if (restartVpnTimeoutRef.current) {
      clearTimeout(restartVpnTimeoutRef.current);
    }

    restartVpnTimeoutRef.current = setTimeout(async () => {
      if (restartVpnInFlightRef.current) return;
      if (!activeConfigContent) {
        addLog('ERROR', 'No active config content found');
        return;
      }
      if (!activeConfigFilename) {
        addLog('ERROR', 'No active config filename found');
        return;
      }

      restartVpnInFlightRef.current = true;
      try {
        while (restartVpnPendingRulesRef.current) {
          const rulesToApply = restartVpnPendingRulesRef.current;
          restartVpnPendingRulesRef.current = null;

          addLog('INFO', 'Restarting VPN...');
          await stopVPN();
          await new Promise(resolve => setTimeout(resolve, 1000));
          await startVPN(
            activeConfigContent,
            activeConfigFilename,
            rulesToApply,
            settings.logLevel,
            settings.enableTun,
            settings.mtu,
            settings.killSwitch
          );
          addLog('INFO', 'VPN restarted');
        }
      } finally {
        restartVpnInFlightRef.current = false;
      }
    }, 500);
  }, [activeConfigContent, activeConfigFilename, rules, settings.logLevel, settings.enableTun, settings.mtu, settings.killSwitch, stopVPN, startVPN, addLog]);

  useEffect(() => {
    if (!isTauri()) return;
    const run = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        await new Promise(resolve => setTimeout(resolve, 100));
        if (settings.startminimized) {
          await win.hide();
        } else {
          await win.show();
          await win.setFocus();
        }
      } catch (e) {
        console.error('Failed to update window visibility:', e);
      }
    };
    run();
  }, [settings.startminimized]);

  useEffect(() => {
    if (!isTauri()) return;
    const run = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_autostart', { enabled: settings.autostart });
      } catch (e) {
        console.error('Failed to set autostart:', e);
      }
    };
    run();
  }, [settings.autostart]);

  useRulesStorage(rules, setRules);

  // Loading rules from config
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
        const existingKeys = new Set(prev.map(r => `${r.ruleType}:${r.app.toLowerCase()}`));
        const newRules = configRules.filter(r => !existingKeys.has(`${r.ruleType}:${r.app.toLowerCase()}`));
        return [...prev, ...newRules];
      });
    }
    setConfigRulesLoaded(activeConfigId);
    setTimeout(() => {
      initialLoadDone.current = true;
    }, 100);
  }, [parsedConfig, activeConfigId, configRulesLoaded]);

  // Auto-saving rules to config
  useEffect(() => {
    if (!isTauri() || !activeConfigFilename || !initialLoadDone.current) return;
    
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
      } catch (e) {
        console.error('Failed to save rules:', e);
      }
    };
    
    const timeout = setTimeout(saveRules, 500);
    return () => clearTimeout(timeout);
  }, [rules, activeConfigFilename]);

  const handleToggleVPN = useCallback(async () => {
    if (vpnEnabled) {
      if (settings.killSwitch) {
        addLog('WARNING', 'Kill switch is enabled. Disable it in Settings to disconnect.');
        return;
      }
      await stopVPN();
    } else {
      if (!activeConfigContent || !activeConfigFilename) {
        addLog('ERROR', 'No config selected or invalid config file');
        return;
      }
      try {
        await startVPN(
          activeConfigContent,
          activeConfigFilename,
          rules,
          settings.logLevel,
          settings.enableTun,
          settings.mtu,
          settings.killSwitch
        );
      } catch (error) {
        addLog('ERROR', `Failed to start VPN: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [vpnEnabled, activeConfigContent, activeConfigFilename, rules, settings.logLevel, settings.enableTun, settings.mtu, settings.killSwitch, startVPN, stopVPN, addLog]);

  useEffect(() => {
    return () => {
      if (autoConnectTimeoutRef.current) {
        clearTimeout(autoConnectTimeoutRef.current);
        autoConnectTimeoutRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (!settings.autoConnect) {
      autoConnectTriggeredRef.current = false;
      if (autoConnectTimeoutRef.current) {
        clearTimeout(autoConnectTimeoutRef.current);
        autoConnectTimeoutRef.current = null;
      }
      return;
    }
    if (vpnEnabled || isConnecting) return;
    if (!activeConfigContent || !activeConfigFilename) return;

    if (autoConnectTriggeredRef.current) return;
    if (autoConnectTimeoutRef.current) return;

    addLog('INFO', 'Auto-connect: scheduled...');
    autoConnectTimeoutRef.current = setTimeout(() => {
      autoConnectTimeoutRef.current = null;
      autoConnectTriggeredRef.current = true;
      addLog('INFO', 'Auto-connect: connecting...');
      handleToggleVPN();
    }, 1500);
  }, [settings.autoConnect, vpnEnabled, isConnecting, activeConfigContent, activeConfigFilename, handleToggleVPN, addLog]);

  useEffect(() => {
    if (!settings.killSwitch) {
      wasVpnEnabledRef.current = vpnEnabled;
      return;
    }
    if (wasVpnEnabledRef.current && !vpnEnabled && !isConnecting) {
      addLog('WARNING', 'VPN stopped while kill switch is enabled. Attempting to reconnect...');
      handleToggleVPN();
    }
    wasVpnEnabledRef.current = vpnEnabled;
  }, [vpnEnabled, isConnecting, settings.killSwitch, handleToggleVPN, addLog]);

  useEffect(() => {
    if (vpnError) {
      addLog('ERROR', vpnError);
    }
  }, [vpnError, addLog]);

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => {
    const update = () => {
      const narrow = window.innerWidth < 1140;
      setIsNarrowLayout(narrow);
      if (prevNarrowLayoutRef.current === null || prevNarrowLayoutRef.current !== narrow) {
        setSidebarOpen(!narrow);
        prevNarrowLayoutRef.current = narrow;
      }
    };
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  useEffect(() => {
    if (isNarrowLayout) {
      setSidebarOpen(false);
    }
  }, [activePage, isNarrowLayout]);

  const setActiveTab = useCallback((tab: 'home' | 'rules' | 'settings') => {
    setActivePage(tab);
    if (isNarrowLayout) {
      setSidebarOpen(false);
    }
  }, [isNarrowLayout]);
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
            hasConfig={!!activeConfigContent}
            uptime={formatUptime()}
            traffic={{ up: formatTraffic(traffic.up), down: formatTraffic(traffic.down) }}
            latency={latency}
            restartVPN={restartVPN}
          />
        );
      case 'rules':
        return (
          <RulesPage 
            rules={rules}
            setRules={setRules}
            vpnEnabled={vpnEnabled}
            restartVPN={restartVPN}
            activeConfigFilename={activeConfigFilename}
          />
        );
      case 'settings':
        return (
          <SettingsPage 
            setShowLogsModal={setShowLogsModal}
            configs={configs}
            setConfigs={setConfigs}
            activeConfigId={activeConfigId}
            setActiveConfigId={setActiveConfigId}
            setActiveConfigContent={setActiveConfigContent}
            setParsedConfig={setParsedConfig}
            vpnEnabled={vpnEnabled}
            restartVPN={restartVPN}
          />
        );
      default:
        return null;
    }
  }, [
    activePage,
    vpnEnabled,
    vpnStatus,
    parsedConfig,
    isConnecting,
    vpnError,
    handleToggleVPN,
    activeConfigContent,
    activeConfigFilename,
    configs,
    activeConfigId,
    rules,
    setRules,
    restartVPN,
    traffic,
    latency,
    formatUptime,
    formatTraffic,
  ]);

  return (
   
    <div className="app-root">
      {settings.snowfall && (
        <Snowfall
          color="white"
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            width: '100vw',
            height: '100vh',
            pointerEvents: 'none',
            zIndex: 9999,
          }}
        />
      )}
      <Titlebar
        showSidebarToggle={isNarrowLayout}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen(v => !v)}
      />
      {isNarrowLayout && sidebarOpen && (
        <div
          className="sidebar-overlay"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}
      <div className="app-container">
        <Sidebar 
          activeTab={activePage} 
          setActiveTab={setActiveTab} 
          vpnEnabled={vpnEnabled} 
          restartVPN={restartVPN}
          hasConfig={!!activeConfigContent}
          className={isNarrowLayout ? `sidebar-floating ${sidebarOpen ? 'sidebar-open' : ''}` : ''}
        />
        <main className="app-main">{pageContent}</main>
      </div>
      <LogsModal 
        showLogsModal={showLogsModal} 
        setShowLogsModal={setShowLogsModal} 
        logs={logs} 
        settings={settings} 
        setSettings={setSettings} 
        vpnEnabled={vpnEnabled}
      />
    </div>
  );
}