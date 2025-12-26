import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import Snowfall from 'react-snowfall';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import HomePage from './components/HomePage';
import RulesPage from './components/RulesPage';
import SettingsPage from './components/SettingsPage';
import LogsModal from './components/LogsModal';
import { useVPNState } from './hooks/useVPNState';
import { useSettingsStorage } from './hooks/useSettingsStorage';
import { useRulesStorage } from './hooks/useRulesStorage';
import type { Rule, Log, LogLevel, Config, ParsedConfig } from './types';
import { useI18n } from './i18n';
import { isTauri } from './utils/isTauri';

const EMPTY_LOGS: Log[] = [];
const HOME_SNAPSHOT_KEY = 'vpn-home-display-snapshot';
const ACTIVE_CONFIG_KEY = 'vpn-active-config';
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const LAST_UPDATE_NOTIFIED_KEY = 'vpn-last-update-notified';

function formatTime(date: Date): string {
  return date.toTimeString().split(' ')[0];
}

export default function App() {
  const { t } = useI18n();
  
  // Refs для оптимизации
  const initialLoadDone = useRef(false);
  const autoConnectTriggeredRef = useRef(false);
  const autoConnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasVpnEnabledRef = useRef(false);
  const restartVpnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartVpnInFlightRef = useRef(false);
  const restartVpnPendingRulesRef = useRef<Rule[] | null>(null);
  const prevNarrowLayoutRef = useRef<boolean | null>(null);
  
  // UI State
  const [isNarrowLayout, setIsNarrowLayout] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePage, setActivePage] = useState<'home' | 'rules' | 'settings'>('home');
  const [showLogsModal, setShowLogsModal] = useState(false);
  
  // Data State
  const [rules, setRules] = useState<Rule[]>([]);
  const [configRulesLoaded, setConfigRulesLoaded] = useState<string | null>(null);
  const [settings, setSettings] = useSettingsStorage();
  const [logs, setLogs] = useState<Log[]>([]);
  const [configsLoaded, setConfigsLoaded] = useState(false);
  const [dismissNoConfigSplash, setDismissNoConfigSplash] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [availableUpdateVersion, setAvailableUpdateVersion] = useState<string | null>(null);
  
  // Config State
  const [configs, setConfigs] = useState<Config[]>([]);
  const [activeConfigId, setActiveConfigId] = useState<string>('');
  const [activeConfigContent, setActiveConfigContent] = useState<string | null>(null);
  const [activeConfigFilename, setActiveConfigFilename] = useState<string | null>(null);
  const [parsedConfig, setParsedConfig] = useState<ParsedConfig | null>(null);
  const [parsedConfigFilename, setParsedConfigFilename] = useState<string | null>(null);
  const [connectedConfigSnapshot, setConnectedConfigSnapshot] = useState<{
    proxy_name: string | null;
    server_address: string | null;
    mixed_port: number | null;
  } | null>(null);
  const [homeDisplaySnapshot, setHomeDisplaySnapshot] = useState<{
    proxyName: string;
    serverName: string;
    port: number;
  } | null>(null);

  // Восстановление snapshot из localStorage
  useEffect(() => {
    const saved = localStorage.getItem(HOME_SNAPSHOT_KEY);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as { proxyName?: unknown; serverName?: unknown; port?: unknown };
      if (typeof parsed?.proxyName === 'string' && typeof parsed?.serverName === 'string' && typeof parsed?.port === 'number') {
        setHomeDisplaySnapshot({ proxyName: parsed.proxyName, serverName: parsed.serverName, port: parsed.port });
      }
    } catch {
      // ignore
    }
  }, []);

  // Сохранение snapshot в localStorage
  useEffect(() => {
    if (!homeDisplaySnapshot) return;
    try {
      localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify(homeDisplaySnapshot));
    } catch {
      // ignore
    }
  }, [homeDisplaySnapshot]);
  
  // Logging function
  const addLog = useCallback((level: LogLevel, message: string) => {
    setLogs(prev => [{
      id: Date.now(),
      time: formatTime(new Date()),
      level,
      message
    }, ...prev].slice(0, 1000));
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    if (!settings.autoCheckUpdates) {
      setUpdateAvailable(false);
      setAvailableUpdateVersion(null);
      return;
    }

    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    const notifyUpdate = async (version: string) => {
      const message = `Update available: v${version}`;

      try {
        if (typeof Notification === 'undefined') return;
        if (Notification.permission === 'granted') {
          new Notification('Rododendron', { body: message });
          return;
        }
        if (Notification.permission !== 'denied') {
          const res = await Notification.requestPermission();
          if (res === 'granted') {
            new Notification('Rododendron', { body: message });
          }
        }
      } catch {
        // ignore
      }
    };

    const runCheck = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const res = (await invoke('check_for_updates')) as { update_available: boolean; latest_version?: string };

        if (cancelled) return;
        const isAvailable = !!res?.update_available;
        setUpdateAvailable(isAvailable);
        const v = typeof res?.latest_version === 'string' ? res.latest_version : null;

        setAvailableUpdateVersion(isAvailable ? v : null);

        if (isAvailable && v) {
          const lastNotified = localStorage.getItem(LAST_UPDATE_NOTIFIED_KEY);
          if (lastNotified !== v) {
            localStorage.setItem(LAST_UPDATE_NOTIFIED_KEY, v);
            addLog('INFO', `Update available: v${v}`);
            await notifyUpdate(v);
          }
        }
      } catch (e) {
        if (!cancelled) {
          console.error('Auto update check failed:', e);
        }
      }
    };

    runCheck();
    interval = setInterval(runCheck, UPDATE_CHECK_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (interval) {
        clearInterval(interval);
      }
    };
  }, [settings.autoCheckUpdates, addLog]);
  
  // Загрузка конфигураций
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
        setConfigsLoaded(true);
        
        const savedActive = localStorage.getItem(ACTIVE_CONFIG_KEY);
        if (savedActive && loadedConfigs.some(c => c.id === savedActive)) {
          setActiveConfigId(savedActive);
        } else if (loadedConfigs.length > 0) {
          setActiveConfigId(loadedConfigs[0].id);
        }
      } catch (e) {
        console.error('Failed to load configs:', e);
        setConfigsLoaded(true);
      }
    };
    
    loadConfigs();
  }, []);

  useEffect(() => {
    if (!configsLoaded) return;
    if (configs.length > 0) {
      setDismissNoConfigSplash(false);
    }
  }, [configsLoaded, configs.length]);

  const noConfigs = configsLoaded && configs.length === 0;

  const wrappedSetActiveConfigId = useCallback<Dispatch<SetStateAction<string>>>(
    (value) => {
      const nextId = typeof value === 'function' ? value(activeConfigId) : value;

      initialLoadDone.current = false;
      setConfigRulesLoaded(null);
      setRules([]);
      setActiveConfigContent(null);
      setParsedConfig(null);
      setParsedConfigFilename(null);

      setActiveConfigId(nextId);
    },
    [activeConfigId]
  );

  useEffect(() => {
    if (!noConfigs) return;
    if (activePage !== 'settings') {
      setActivePage('settings');
    }
  }, [noConfigs, activePage]);

  // Обновление activeConfigFilename
  useEffect(() => {
    const config = configs.find(c => c.id === activeConfigId);
    setActiveConfigFilename(config?.filename || null);
  }, [configs, activeConfigId]);

  // Загрузка активной конфигурации
  useEffect(() => {
    if (!activeConfigId || !isTauri() || !activeConfigFilename) return;
    let cancelled = false;
    const expectedConfigId = activeConfigId;
    const expectedFilename = activeConfigFilename;
    
    const loadContent = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const content = await invoke<string>('read_config', { filename: expectedFilename });
        if (cancelled || expectedConfigId !== activeConfigId || expectedFilename !== activeConfigFilename) return;

        setActiveConfigContent(content);
        
        const parsed = await invoke<ParsedConfig>('parse_config', { configContent: content });
        if (cancelled || expectedConfigId !== activeConfigId || expectedFilename !== activeConfigFilename) return;

        setParsedConfig(parsed);
        setParsedConfigFilename(expectedFilename);
        
        localStorage.setItem(ACTIVE_CONFIG_KEY, activeConfigId);
      } catch (e) {
        console.error('Failed to load config:', e);
      }
    };
    
    loadContent();
    return () => {
      cancelled = true;
    };
  }, [activeConfigId, activeConfigFilename]);

  const {
    vpnEnabled,
    vpnStatus,
    isConnecting,
    error: vpnError,
    startVPN,
    stopVPN,
  } = useVPNState();

  useEffect(() => {
    if (!vpnEnabled || connectedConfigSnapshot) return;
    if (!parsedConfig || !activeConfigFilename || parsedConfigFilename !== activeConfigFilename) return;

    setConnectedConfigSnapshot({
      proxy_name: parsedConfig.proxy_name ?? null,
      server_address: parsedConfig.server_address ?? null,
      mixed_port: typeof parsedConfig.mixed_port === 'number' ? parsedConfig.mixed_port : null,
    });
  }, [vpnEnabled, connectedConfigSnapshot, parsedConfig, parsedConfigFilename, activeConfigFilename]);

  useEffect(() => {
    setHomeDisplaySnapshot(prev => {
      const prevProxy = prev?.proxyName;
      const prevServer = prev?.serverName;
      const prevPort = prev?.port;

      if (vpnEnabled) {
        const proxyName = vpnStatus?.proxy_name || connectedConfigSnapshot?.proxy_name || prevProxy;
        const serverName = vpnStatus?.server || connectedConfigSnapshot?.server_address || prevServer;
        const port = vpnStatus?.port || connectedConfigSnapshot?.mixed_port || prevPort;
        if (!proxyName && !serverName && !port) return prev;
        return {
          proxyName: proxyName || 'Unknown',
          serverName: serverName || 'Not configured',
          port: port || 7890,
        };
      }

      const proxyName = parsedConfig?.proxy_name || prevProxy;
      const serverName = parsedConfig?.server_address || prevServer;
      const port = parsedConfig?.mixed_port || prevPort;
      if (!proxyName && !serverName && !port) return prev;
      return {
        proxyName: proxyName || 'Unknown',
        serverName: serverName || 'Not configured',
        port: port || 7890,
      };
    });
  }, [vpnEnabled, vpnStatus, connectedConfigSnapshot, parsedConfig]);

  const activeConfigName = useMemo(() => {
    const c = configs.find(x => x.id === activeConfigId);
    return c?.name || c?.filename || null;
  }, [configs, activeConfigId]);

  const restartVPN = useCallback(async (rulesOverride?: Rule[]) => {
    restartVpnPendingRulesRef.current = rulesOverride ?? rules;

    if (restartVpnTimeoutRef.current) {
      clearTimeout(restartVpnTimeoutRef.current);
    }

    restartVpnTimeoutRef.current = setTimeout(async () => {
      if (restartVpnInFlightRef.current) return;
      if (!activeConfigContent || !activeConfigFilename) {
        addLog('ERROR', 'No active config content found');
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
  }, [activeConfigContent, activeConfigFilename, rules, settings, stopVPN, startVPN, addLog]);

  // Window visibility
  useEffect(() => {
    if (!isTauri()) return;
    const run = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        await new Promise(resolve => setTimeout(resolve, 100));
        if (settings.startminimized) {
          if (!win.isMinimized()) {
            await win.hide();
          }
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

  // Autostart
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

  // Close behavior
  useEffect(() => {
    if (!isTauri()) return;
    const run = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_close_behavior', { behavior: settings.closeBehavior });
      } catch (e) {
        console.error('Failed to set close behavior:', e);
      }
    };
    run();
  }, [settings.closeBehavior]);

  useRulesStorage(activeConfigId, rules, setRules);

  useEffect(() => {
    initialLoadDone.current = false;
    setConfigRulesLoaded(null);
    setActiveConfigContent(null);
    setParsedConfig(null);
    setParsedConfigFilename(null);
  }, [activeConfigId]);

  // Загрузка правил из конфига
  useEffect(() => {
    if (!parsedConfig || !activeConfigId) return;
    if (!activeConfigFilename || parsedConfigFilename !== activeConfigFilename) return;
    if (configRulesLoaded === activeConfigId) return;

    const rulesStorageKey = `vpn-rules:${activeConfigId}`;
    let savedRules: Rule[] = [];
    try {
      const saved = localStorage.getItem(rulesStorageKey);
      if (saved) {
        savedRules = JSON.parse(saved) as Rule[];
      }
    } catch {
      savedRules = [];
    }

    const makeRuleKey = (rule: Pick<Rule, 'app' | 'rule' | 'ruleType'>) => {
      const type = rule.ruleType || 'process';
      const app = rule.app.trim().toLowerCase();
      const action = rule.rule.trim();
      return `${type}:${app}:${action}`;
    };

    const savedByKey = new Map<string, Rule>();
    for (const r of savedRules) {
      savedByKey.set(makeRuleKey(r), r);
    }

    const baseId = Date.now();
    const configRules: Rule[] = parsedConfig.rules.map((r, idx) => {
      const ruleType: Rule['ruleType'] =
        r.rule_type === 'process' || r.rule_type === 'domain' || r.rule_type === 'domain_keyword' || r.rule_type === 'ip'
          ? r.rule_type
          : 'domain';

      const nextRule: Rule = {
        id: baseId + idx,
        app: r.target,
        rule: r.action === 'PROXY' ? 'Via VPN' : 'Direct',
        active: true,
        ruleType,
      };

      const saved = savedByKey.get(makeRuleKey(nextRule));
      if (saved) {
        return { ...nextRule, id: saved.id, active: saved.active };
      }
      return nextRule;
    });

    const configKeys = new Set(configRules.map(makeRuleKey));
    const missingSavedInactive = savedRules.filter(r => !r.active && !configKeys.has(makeRuleKey(r)));

    setRules([...configRules, ...missingSavedInactive]);
    setConfigRulesLoaded(activeConfigId);
    setTimeout(() => {
      initialLoadDone.current = true;
    }, 100);
  }, [parsedConfig, parsedConfigFilename, activeConfigId, activeConfigFilename, configRulesLoaded]);

  // Авто-сохранение правил
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
        
        await invoke('save_rules_to_config', { filename: activeConfigFilename, userRules });
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
      setConnectedConfigSnapshot(null);
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

        setConnectedConfigSnapshot({
          proxy_name: parsedConfig?.proxy_name ?? null,
          server_address: parsedConfig?.server_address ?? null,
          mixed_port: typeof parsedConfig?.mixed_port === 'number' ? parsedConfig.mixed_port : null,
        });
      } catch (error) {
        addLog('ERROR', `Failed to start VPN: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, [vpnEnabled, activeConfigContent, activeConfigFilename, rules, settings, startVPN, stopVPN, addLog, parsedConfig]);

  // Auto-connect cleanup
  useEffect(() => {
    return () => {
      if (autoConnectTimeoutRef.current) {
        clearTimeout(autoConnectTimeoutRef.current);
        autoConnectTimeoutRef.current = null;
      }
    };
  }, []);

  // Auto-connect logic
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
    if (autoConnectTriggeredRef.current || autoConnectTimeoutRef.current) return;

    addLog('INFO', 'Auto-connect: scheduled...');
    autoConnectTimeoutRef.current = setTimeout(() => {
      autoConnectTimeoutRef.current = null;
      autoConnectTriggeredRef.current = true;
      addLog('INFO', 'Auto-connect: connecting...');
      handleToggleVPN();
    }, 1500);
  }, [settings.autoConnect, vpnEnabled, isConnecting, activeConfigContent, activeConfigFilename, handleToggleVPN, addLog]);

  // Kill switch logic
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

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen(v => !v);
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('dark');
  }, []);

  // Layout resize handler
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
    if (noConfigs && tab !== 'settings') return;
    setActivePage(tab);
    if (isNarrowLayout) {
      setSidebarOpen(false);
    }
  }, [isNarrowLayout, noConfigs]);

  const pageContent = useMemo(() => {
    switch (activePage) {
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
            setActiveConfigId={wrappedSetActiveConfigId}
            setActiveConfigContent={setActiveConfigContent}
            setParsedConfig={setParsedConfig}
            vpnEnabled={vpnEnabled}
            restartVPN={restartVPN}
            settings={settings}
            setSettings={setSettings}
            availableUpdateVersion={availableUpdateVersion}
          />
        );
      default:
        return null;
    }
  }, [
    activePage,
    vpnEnabled,
    activeConfigFilename,
    configs,
    activeConfigId,
    rules,
    restartVPN,
    settings,
    wrappedSetActiveConfigId,
    availableUpdateVersion,
  ]);

  return (
    <div className="app-root">
      {configsLoaded && configs.length === 0 && !dismissNoConfigSplash && (
        <div className="no-config-overlay">
          <div className="no-config-card">
            <div className="no-config-title">{t.welcome.addConfigTitle}</div>
            <div className="no-config-subtitle">{t.welcome.addConfigSubtitle}</div>
            <div className="no-config-actions">
              <button
                type="button"
                className="btn btn-primary-dark"
                onClick={() => {
                  setActivePage('settings');
                  setDismissNoConfigSplash(true);
                }}
              >
                {t.welcome.openSettings}
              </button>
            </div>
          </div>
        </div>
      )}
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
        onToggleSidebar={handleToggleSidebar}
        closeBehavior={settings.closeBehavior}
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
          hasUpdate={updateAvailable}
          className={isNarrowLayout ? `sidebar-floating ${sidebarOpen ? 'sidebar-open' : ''}` : ''}
        />
        <main className="app-main">
          <div hidden={activePage !== 'home'}>
            <HomePage 
              vpnEnabled={vpnEnabled} 
              vpnStatus={vpnStatus}
              parsedConfig={parsedConfig}
              connectedConfigSnapshot={connectedConfigSnapshot}
              homeDisplaySnapshot={homeDisplaySnapshot}
              activeConfigName={activeConfigName}
              pollingEnabled={activePage === 'home'}
              isConnecting={isConnecting}
              error={vpnError}
              toggleVPN={handleToggleVPN} 
              hasConfig={!!activeConfigContent}
            />
          </div>
          {activePage !== 'home' ? pageContent : null}
        </main>
      </div>
      <LogsModal 
        showLogsModal={showLogsModal} 
        setShowLogsModal={setShowLogsModal} 
        logs={showLogsModal ? logs : EMPTY_LOGS} 
        setLogs={setLogs}
        settings={settings} 
        setSettings={setSettings} 
        vpnEnabled={vpnEnabled}
      />
    </div>
  );
}