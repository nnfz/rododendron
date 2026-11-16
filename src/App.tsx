import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import Snowfall from 'react-snowfall';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import HomePage from './components/HomePage';
import RulesPage from './components/RulesPage';
import SettingsPage from './components/SettingsPage';
import ConnectionsPage from './components/ConnectionsPage';
import LogsModal from './components/LogsModal';
import { useVPNState } from './hooks/useVPNState';
import { useSettingsStorage } from './hooks/useSettingsStorage';
import { useRulePresets } from './hooks/useRulePresets';
import { useTagsStorage } from './hooks/useTagsStorage';
import type { Rule, Tag, Log, LogLevel, Config, ParsedConfig, RenamedConfig, SubscriptionInfo, TabType } from './types';
import { useI18n } from './i18n';
import { isTauri } from './utils/isTauri';
import { syncAutostart } from './utils/autostart';
import { PRESETS_STORAGE_KEY, type ProfileRuleHint } from './utils/rulePresets';

const EMPTY_LOGS: Log[] = [];
const HOME_SNAPSHOT_KEY = 'vpn-home-display-snapshot';
const ACTIVE_CONFIG_KEY = 'vpn-active-config';
const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const TEST_UPDATE_NOTIFY_INTERVAL_MS = 12 * 60 * 60 * 1000;

function formatTime(date: Date): string {
  return date.toTimeString().split(' ')[0];
}

export default function App() {
  const { t } = useI18n();

  const autoConnectTriggeredRef = useRef(false);
  const autoConnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wasVpnEnabledRef = useRef(false);
  const userStopRef = useRef(false);
  const restartVpnTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const restartVpnInFlightRef = useRef(false);
  const restartVpnPendingRulesRef = useRef<Rule[] | null>(null);
  const prevNarrowLayoutRef = useRef<boolean | null>(null);
  const updateNotifiedThisStartupRef = useRef(false);

  const [isNarrowLayout, setIsNarrowLayout] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [activePage, setActivePage] = useState<TabType>('home');
  const [showLogsModal, setShowLogsModal] = useState(false);

  const [tags, setTags] = useState<Tag[]>([]);
  const [profileRuleHints, setProfileRuleHints] = useState<ProfileRuleHint[] | null>(null);
  const {
    presets,
    activePresetId,
    rules,
    ready: presetsReady,
    setRules,
    selectPreset,
    createPreset,
    renamePreset,
    deletePreset,
    migrateIfNeeded,
  } = useRulePresets(t.rules.defaultPreset);
  useTagsStorage(tags, setTags);
  const [settings, setSettings] = useSettingsStorage();
  const [logs, setLogs] = useState<Log[]>([]);
  const [configsLoaded, setConfigsLoaded] = useState(false);
  const [dismissNoConfigSplash, setDismissNoConfigSplash] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [availableUpdateVersion, setAvailableUpdateVersion] = useState<string | null>(null);

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
  const [vpnRunningConfigId, setVpnRunningConfigId] = useState<string | null>(null);
  const [restartRequiredForConfig, setRestartRequiredForConfig] = useState(false);
  const [homeDisplaySnapshot, setHomeDisplaySnapshot] = useState<{
    proxyName: string;
    serverName: string;
    port: number;
  } | null>(null);
  const [subscriptionInfo, setSubscriptionInfo] = useState<SubscriptionInfo | null>(null);
  const [configReloadToken, setConfigReloadToken] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem(HOME_SNAPSHOT_KEY);
    if (!saved) return;
    try {
      const parsed = JSON.parse(saved) as { proxyName?: unknown; serverName?: unknown; port?: unknown };
      if (
        typeof parsed?.proxyName === 'string' &&
        typeof parsed?.serverName === 'string' &&
        typeof parsed?.port === 'number'
      ) {
        setHomeDisplaySnapshot({ proxyName: parsed.proxyName, serverName: parsed.serverName, port: parsed.port });
      }
    } catch {
      // ignore
    }
  }, []);

  const notifyUpdate = useCallback(async (version: string) => {
    const message = `Update available: v${version}`;
    try {
      const plugin = await import('@tauri-apps/plugin-notification');
      await plugin.sendNotification({ title: 'Rododendron', body: message });
      return;
    } catch { /* ignore */ }
    try {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission === 'granted') {
        new Notification('Rododendron', { body: message });
        return;
      }
      if (Notification.permission !== 'denied') {
        const res = await Notification.requestPermission();
        if (res === 'granted') new Notification('Rododendron', { body: message });
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    if (!availableUpdateVersion) return;
    const tick = () => { void notifyUpdate(availableUpdateVersion); };
    tick();
    const id = setInterval(tick, TEST_UPDATE_NOTIFY_INTERVAL_MS);
    return () => clearInterval(id);
  }, [availableUpdateVersion, notifyUpdate]);

  useEffect(() => {
    if (!homeDisplaySnapshot) return;
    try { localStorage.setItem(HOME_SNAPSHOT_KEY, JSON.stringify(homeDisplaySnapshot)); } catch { /* ignore */ }
  }, [homeDisplaySnapshot]);

  const addLog = useCallback((level: LogLevel, message: string) => {
    setLogs(prev =>
      [{ id: Date.now(), time: formatTime(new Date()), level, message }, ...prev].slice(0, 1000)
    );
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    if (!settings.autoCheckUpdates) {
      setUpdateAvailable(false);
      setAvailableUpdateVersion(null);
      updateNotifiedThisStartupRef.current = false;
      return;
    }
    updateNotifiedThisStartupRef.current = false;
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;
    const runCheck = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const res = (await invoke('check_for_updates')) as { update_available: boolean; latest_version?: string };
        if (cancelled) return;
        const isAvailable = !!res?.update_available;
        setUpdateAvailable(isAvailable);
        const v = typeof res?.latest_version === 'string' ? res.latest_version : null;
        setAvailableUpdateVersion(isAvailable ? v : null);
        if (isAvailable && v && !updateNotifiedThisStartupRef.current) {
          updateNotifiedThisStartupRef.current = true;
          addLog('INFO', `Update available: v${v}`);
          await notifyUpdate(v);
        }
      } catch (e) {
        if (!cancelled) console.error('Auto update check failed:', e);
      }
    };
    runCheck();
    interval = setInterval(runCheck, UPDATE_CHECK_INTERVAL_MS);
    return () => { cancelled = true; if (interval) clearInterval(interval); };
  }, [settings.autoCheckUpdates, addLog, notifyUpdate]);

  useEffect(() => {
    if (!isTauri()) {
      setProfileRuleHints([]);
      setConfigsLoaded(true);
      return;
    }
    const loadConfigs = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const filenames = await invoke<string[]>('list_configs');
        const presetsExist = localStorage.getItem(PRESETS_STORAGE_KEY) != null;
        const hints: ProfileRuleHint[] = [];
        const loadedConfigs: Config[] = [];
        for (const filename of filenames) {
          let name = filename.replace(/\.(yaml|yml)$/, '');
          let userRuleLines: string[] | null = null;
          let parsedRules: ParsedConfig['rules'] | undefined;
          try {
            const info = await invoke<SubscriptionInfo | null>('subscription_meta', { filename });
            if (info) {
              const title = info.title?.trim();
              if (title) name = title;
              userRuleLines = info.userRuleLines ?? [];
            }
          } catch {
            // A local profile has no subscription metadata.
          }
          if (!presetsExist && userRuleLines == null) {
            try {
              const content = await invoke<string>('read_config', { filename });
              const parsed = await invoke<ParsedConfig>('parse_config', { configContent: content });
              parsedRules = parsed.rules;
            } catch {
              // The file is loaded again when the profile opens.
            }
          }
          const id = `config-${filename}`;
          loadedConfigs.push({ id, name, filename });
          hints.push({ id, name, userRuleLines, parsedRules });
        }
        setProfileRuleHints(hints);
        setConfigs(loadedConfigs);
        const savedActive = localStorage.getItem(ACTIVE_CONFIG_KEY);
        if (savedActive && loadedConfigs.some(config => config.id === savedActive)) {
          setActiveConfigId(savedActive);
        } else if (loadedConfigs.length > 0) {
          setActiveConfigId(loadedConfigs[0].id);
        }
      } catch (e) {
        console.error('Failed to load configs:', e);
        setProfileRuleHints([]);
      } finally {
        setConfigsLoaded(true);
      }
    };
    void loadConfigs();
  }, []);

  useEffect(() => {
    if (!configsLoaded) return;
    if (configs.length > 0) setDismissNoConfigSplash(false);
  }, [configsLoaded, configs.length]);

  const noConfigs = configsLoaded && configs.length === 0;

  const wrappedSetActiveConfigId = useCallback<Dispatch<SetStateAction<string>>>(
    value => {
      const nextId = typeof value === 'function' ? value(activeConfigId) : value;
      setActiveConfigContent(null);
      setParsedConfig(null);
      setParsedConfigFilename(null);
      setHomeDisplaySnapshot(null);
      setConnectedConfigSnapshot(null);
      setActiveConfigId(nextId);
    },
    [activeConfigId]
  );

  useEffect(() => {
    if (!configsLoaded || profileRuleHints === null) return;
    migrateIfNeeded(profileRuleHints, activeConfigId || null);
  }, [configsLoaded, profileRuleHints, activeConfigId, migrateIfNeeded]);

  useEffect(() => {
    if (!noConfigs) return;
    if (activePage !== 'connections' && activePage !== 'settings') setActivePage('connections');
  }, [noConfigs, activePage]);

  useEffect(() => {
    const config = configs.find(c => c.id === activeConfigId);
    setActiveConfigFilename(config?.filename || null);
  }, [configs, activeConfigId]);

  const activeConfigName = useMemo(() => {
    const c = configs.find(x => x.id === activeConfigId);
    return c?.name || c?.filename || null;
  }, [configs, activeConfigId]);

  useEffect(() => {
    setSubscriptionInfo(null);
  }, [activeConfigFilename]);

  useEffect(() => {
    if (!activeConfigFilename || !isTauri()) return;
    let cancelled = false;
    const filename = activeConfigFilename;
    const loadSubscription = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const info = await invoke<SubscriptionInfo | null>('subscription_meta', { filename });
        if (!cancelled) setSubscriptionInfo(info);
      } catch {
        if (!cancelled) setSubscriptionInfo(null);
      }
    };
    void loadSubscription();
    return () => { cancelled = true; };
  }, [activeConfigFilename, configReloadToken]);

  const handleSubscriptionAdded = useCallback((info: SubscriptionInfo) => {
    const existing = configs.find(config => config.filename === info.filename);
    const nextId = existing?.id ?? `config-${info.filename}`;
    if (!existing) {
      setConfigs(prev => (
        prev.some(config => config.filename === info.filename)
          ? prev
          : [...prev, {
              id: nextId,
              name: info.title.trim() || info.filename.replace(/\.(yaml|yml)$/, ''),
              filename: info.filename,
            }]
      ));
    }
    setSubscriptionInfo(info);
    wrappedSetActiveConfigId(nextId);
  }, [configs, wrappedSetActiveConfigId]);

  const handleSubscriptionUpdated = useCallback((info: SubscriptionInfo) => {
    const title = info.title.trim();
    if (title) {
      setConfigs(prev => prev.map(config => (
        config.filename === info.filename && config.name !== title
          ? { ...config, name: title }
          : config
      )));
    }
    if (info.filename !== activeConfigFilename) return;
    setSubscriptionInfo(info);
    setConfigReloadToken(token => token + 1);
  }, [activeConfigFilename]);

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
    return () => { cancelled = true; };
  }, [activeConfigId, activeConfigFilename, configReloadToken]);

  const { vpnEnabled, vpnStatus, isConnecting, error: vpnError, startVPN, stopVPN } = useVPNState();

  const selectServer = useCallback(async (filename: string, serverId: string) => {
    if (!serverId || !filename || !isTauri()) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const info = await invoke<SubscriptionInfo>('set_selected_server', { filename, serverId });
    setSubscriptionInfo(info);
    setConfigReloadToken(token => token + 1);
  }, []);

  const subscriptionFilename = subscriptionInfo?.filename ?? null;
  const subscriptionIntervalHours = subscriptionInfo?.intervalHours ?? null;
  const subscriptionUpdatedAt = subscriptionInfo?.updatedAt ?? null;

  useEffect(() => {
    if (!subscriptionFilename || !subscriptionIntervalHours || !subscriptionUpdatedAt || !isTauri()) return;
    const lastUpdate = new Date(subscriptionUpdatedAt.replace(' ', 'T')).getTime();
    if (Number.isNaN(lastUpdate)) return;
    const intervalMs = subscriptionIntervalHours * 60 * 60 * 1000;
    let cancelled = false;
    let running = false;
    const check = async () => {
      if (cancelled || running || Date.now() - lastUpdate < intervalMs) return;
      running = true;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const info = await invoke<SubscriptionInfo>('update_subscription', { filename: subscriptionFilename });
        if (!cancelled) handleSubscriptionUpdated(info);
      } catch (error) {
        addLog('ERROR', error instanceof Error ? error.message : String(error));
      } finally {
        running = false;
      }
    };
    void check();
    const timer = setInterval(() => { void check(); }, 15 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [subscriptionFilename, subscriptionIntervalHours, subscriptionUpdatedAt, handleSubscriptionUpdated, addLog]);

  useEffect(() => {
    if (!vpnEnabled) { setVpnRunningConfigId(null); setRestartRequiredForConfig(false); }
  }, [vpnEnabled]);

  useEffect(() => {
    if (!isTauri()) return;
    const run = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_tray_vpn_enabled', { enabled: vpnEnabled });
      } catch (e) { console.error('Failed to update tray icon:', e); }
    };
    run();
  }, [vpnEnabled]);

  useEffect(() => {
    if (!vpnEnabled) return;
    if (!vpnRunningConfigId || !activeConfigId) return;
    setRestartRequiredForConfig(activeConfigId !== vpnRunningConfigId);
  }, [vpnEnabled, vpnRunningConfigId, activeConfigId]);

  useEffect(() => {
    if (!vpnEnabled || connectedConfigSnapshot) return;
    if (!parsedConfig || !activeConfigFilename || parsedConfigFilename !== activeConfigFilename) return;
    setConnectedConfigSnapshot({
      proxy_name: parsedConfig.proxy_name ?? null,
      server_address: parsedConfig.server_address ?? null,
      mixed_port: typeof parsedConfig.mixed_port === 'number' ? parsedConfig.mixed_port : null,
    });
  }, [vpnEnabled, connectedConfigSnapshot, parsedConfig, parsedConfigFilename, activeConfigFilename]);

  const selectedSubscriptionNode = useMemo(() => {
    const selectedId = subscriptionInfo?.selectedServerId;
    if (!subscriptionInfo || !selectedId) return null;
    const matches = subscriptionInfo.nodes.filter(node => node.id === selectedId);
    return matches.length === 1 ? matches[0] : null;
  }, [subscriptionInfo]);

  useEffect(() => {
    setHomeDisplaySnapshot(prev => {
      const prevProxy = prev?.proxyName;
      const prevServer = prev?.serverName;
      const prevPort = prev?.port;
      if (vpnEnabled) {
        const proxyName = selectedSubscriptionNode?.name || vpnStatus?.proxy_name || connectedConfigSnapshot?.proxy_name || prevProxy;
        const serverName = selectedSubscriptionNode?.server || vpnStatus?.server || connectedConfigSnapshot?.server_address || prevServer;
        const port = selectedSubscriptionNode?.port || vpnStatus?.port || connectedConfigSnapshot?.mixed_port || prevPort;
        if (!proxyName && !serverName && !port) return prev;
        return { proxyName: proxyName || 'Unknown', serverName: serverName || 'Not configured', port: port || 7890 };
      }
      const proxyName = parsedConfig?.proxy_name || prevProxy;
      const serverName = parsedConfig?.server_address || prevServer;
      const port = parsedConfig?.mixed_port || prevPort;
      if (!proxyName && !serverName && !port) return prev;
      return { proxyName: proxyName || 'Unknown', serverName: serverName || 'Not configured', port: port || 7890 };
    });
  }, [vpnEnabled, vpnStatus, connectedConfigSnapshot, parsedConfig, selectedSubscriptionNode]);

  const restartVPN = useCallback(
    async (rulesOverride?: Rule[]) => {
      restartVpnPendingRulesRef.current = rulesOverride ?? rules;
      if (restartVpnTimeoutRef.current) clearTimeout(restartVpnTimeoutRef.current);

      const runRestart = async () => {
        if (restartVpnInFlightRef.current) {
          restartVpnTimeoutRef.current = setTimeout(() => { void runRestart(); }, 200);
          return;
        }
        if (!activeConfigContent || !activeConfigFilename) { addLog('ERROR', 'No active config content found'); return; }
        restartVpnInFlightRef.current = true;
        try {
          while (restartVpnPendingRulesRef.current) {
            const rulesToApply = restartVpnPendingRulesRef.current;
            restartVpnPendingRulesRef.current = null;
            const isRulesHotReload = rulesOverride !== undefined;
            if (isRulesHotReload && isTauri()) {
              try {
                const { invoke } = await import('@tauri-apps/api/core');
                const userRules = rulesToApply.map(r => ({ id: r.id, app: r.app, rule: r.rule, active: r.active, rule_type: r.ruleType || 'process' }));
                const finalConfig = (await invoke('generate_config', { baseConfig: activeConfigContent, userRules, tunMode: settings.tunMode, configFilename: activeConfigFilename })) as string;
                addLog('INFO', 'Applying rules without restart...');
                await invoke('reload_mihomo_config', { configContent: finalConfig, configFilename: activeConfigFilename });
                addLog('INFO', 'Rules applied');
                continue;
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                addLog('ERROR', `Hot reload failed, falling back to restart: ${msg}`);
              }
            }
            addLog('INFO', 'Restarting VPN...');
            await startVPN(activeConfigContent, activeConfigFilename, rulesToApply, undefined, settings.tunMode);
            setVpnRunningConfigId(activeConfigId || null);
            setRestartRequiredForConfig(false);
            addLog('INFO', 'VPN restarted');
          }
        } finally { restartVpnInFlightRef.current = false; }
      };

      restartVpnTimeoutRef.current = setTimeout(() => { void runRestart(); }, 500);
    },
    [activeConfigContent, activeConfigFilename, rules, settings, startVPN, addLog, activeConfigId]
  );

  useEffect(() => {
    if (!isTauri()) return;
    let unlistenStart: null | (() => void) = null;
    let unlistenRestart: null | (() => void) = null;
    const setup = async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');
        unlistenStart = await listen('tray://start', async () => {
          if (vpnEnabled) return;
          if (!presetsReady) return;
          if (!activeConfigContent || !activeConfigFilename) { addLog('ERROR', 'No active config selected for Start'); return; }
          try {
            addLog('INFO', 'Starting VPN (tray)...');
            await startVPN(activeConfigContent, activeConfigFilename, rules, undefined, settings.tunMode);
            setVpnRunningConfigId(activeConfigId || null);
            setRestartRequiredForConfig(false);
            setConnectedConfigSnapshot({ proxy_name: parsedConfig?.proxy_name ?? null, server_address: parsedConfig?.server_address ?? null, mixed_port: typeof parsedConfig?.mixed_port === 'number' ? parsedConfig.mixed_port : null });
          } catch (error) { addLog('ERROR', `Failed to start VPN: ${error instanceof Error ? error.message : String(error)}`); }
        });
        unlistenRestart = await listen('tray://restart', async () => {
          if (!activeConfigContent || !activeConfigFilename) { addLog('ERROR', 'No active config selected for Restart'); return; }
          addLog('INFO', 'Restarting VPN (tray)...');
          await restartVPN();
        });
      } catch (e) { console.error('Failed to setup tray listeners:', e); }
    };
    setup();
    return () => { try { unlistenStart?.(); } catch {} try { unlistenRestart?.(); } catch {} };
  }, [vpnEnabled, activeConfigContent, activeConfigFilename, rules, settings, startVPN, restartVPN, addLog, parsedConfig, activeConfigId, presetsReady]);

  useEffect(() => {
    if (!isTauri()) return;
    const run = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        await new Promise(resolve => setTimeout(resolve, 100));
        if (settings.startminimized) { if (!win.isMinimized()) await win.hide(); }
        else { await win.show(); await win.setFocus(); }
      } catch (e) { console.error('Failed to update window visibility:', e); }
    };
    run();
  }, [settings.startminimized]);

  useEffect(() => {
    if (!isTauri()) return;
    const run = async () => {
      try {
        await syncAutostart(settings.autostart);
      } catch (e) {
        console.error('Failed to sync autostart:', e);
      }
    };
    run();
  }, [settings.autostart]);

  useEffect(() => {
    if (!isTauri()) return;
    const run = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('set_close_behavior', { behavior: settings.closeBehavior });
      } catch (e) { console.error('Failed to set close behavior:', e); }
    };
    run();
  }, [settings.closeBehavior]);

  useEffect(() => {
    setActiveConfigContent(null);
    setParsedConfig(null);
    setParsedConfigFilename(null);
  }, [activeConfigId]);

  useEffect(() => {
    if (!presetsReady || !isTauri() || !activeConfigFilename) return;
    const saveRules = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const userRules = rules.map(rule => ({
          id: rule.id,
          app: rule.app,
          rule: rule.rule,
          active: rule.active,
          rule_type: rule.ruleType || 'process',
        }));
        await invoke('save_rules_to_config', { filename: activeConfigFilename, userRules });
      } catch (e) { console.error('Failed to save rules:', e); }
    };
    const timeout = setTimeout(saveRules, 500);
    return () => clearTimeout(timeout);
  }, [rules, activeConfigFilename, presetsReady]);

  const handleToggleVPN = useCallback(async () => {
    if (vpnEnabled || isConnecting) {
      userStopRef.current = true;
      await stopVPN();
      setConnectedConfigSnapshot(null);
    } else {
      userStopRef.current = false;
      if (!presetsReady) return;
      if (!activeConfigContent || !activeConfigFilename) { addLog('ERROR', 'No config selected or invalid config file'); return; }
      try {
        await startVPN(activeConfigContent, activeConfigFilename, rules, undefined, settings.tunMode);
        setVpnRunningConfigId(activeConfigId || null);
        setRestartRequiredForConfig(false);
        setConnectedConfigSnapshot({ proxy_name: parsedConfig?.proxy_name ?? null, server_address: parsedConfig?.server_address ?? null, mixed_port: typeof parsedConfig?.mixed_port === 'number' ? parsedConfig.mixed_port : null });
      } catch (error) { addLog('ERROR', `Failed to start VPN: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }, [vpnEnabled, isConnecting, activeConfigContent, activeConfigFilename, rules, settings, startVPN, stopVPN, addLog, parsedConfig, activeConfigId, presetsReady]);

  useEffect(() => {
    return () => { if (autoConnectTimeoutRef.current) { clearTimeout(autoConnectTimeoutRef.current); autoConnectTimeoutRef.current = null; } };
  }, []);

  useEffect(() => {
    if (!settings.autoConnect) {
      autoConnectTriggeredRef.current = false;
      if (autoConnectTimeoutRef.current) { clearTimeout(autoConnectTimeoutRef.current); autoConnectTimeoutRef.current = null; }
      return;
    }
    if (vpnEnabled || isConnecting) return;
    if (!presetsReady) return;
    if (!activeConfigContent || !activeConfigFilename) return;
    if (autoConnectTriggeredRef.current || autoConnectTimeoutRef.current) return;
    addLog('INFO', 'Auto-connect: scheduled...');
    autoConnectTimeoutRef.current = setTimeout(() => {
      autoConnectTimeoutRef.current = null;
      autoConnectTriggeredRef.current = true;
      addLog('INFO', 'Auto-connect: connecting...');
      handleToggleVPN();
    }, 1500);
  }, [settings.autoConnect, vpnEnabled, isConnecting, activeConfigContent, activeConfigFilename, handleToggleVPN, addLog, presetsReady]);

  useEffect(() => {
    if (userStopRef.current) {
      userStopRef.current = false;
      wasVpnEnabledRef.current = vpnEnabled;
      return;
    }
    if (!settings.killSwitch) { wasVpnEnabledRef.current = vpnEnabled; return; }
    if (wasVpnEnabledRef.current && !vpnEnabled && !isConnecting) {
      addLog('WARNING', 'VPN stopped while kill switch is enabled. Attempting to reconnect...');
      handleToggleVPN();
    }
    wasVpnEnabledRef.current = vpnEnabled;
  }, [vpnEnabled, isConnecting, settings.killSwitch, handleToggleVPN, addLog]);

  useEffect(() => { if (vpnError) addLog('ERROR', vpnError); }, [vpnError, addLog]);

  const handleToggleSidebar = useCallback(() => {
    setSidebarOpen(v => !v);
  }, []);

  useEffect(() => { document.documentElement.classList.add('dark'); }, []);

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
    if (isNarrowLayout) setSidebarOpen(false);
  }, [activePage, isNarrowLayout]);

  const markRestartRequired = useCallback(() => {
    setRestartRequiredForConfig(true);
  }, []);

  const handleImported = useCallback((filename: string) => {
    const canonicalId = `config-${filename}`;
    const stem = filename.replace(/\.(yaml|yml)$/, '');
    const existing = configs.find(config => config.filename === filename);
    if (!existing) {
      setConfigs(prev => (
        prev.some(config => config.filename === filename)
          ? prev
          : [...prev, { id: canonicalId, name: stem, filename }]
      ));
    }
    const nextId = existing?.id ?? canonicalId;
    if (activeConfigId !== nextId) wrappedSetActiveConfigId(nextId);
    else setConfigReloadToken(token => token + 1);
  }, [configs, activeConfigId, wrappedSetActiveConfigId]);

  const handleDeleted = useCallback((config: Config) => {
    const remaining = configs.filter(item => item.id !== config.id);
    setConfigs(remaining);
    if (activeConfigId === config.id) wrappedSetActiveConfigId(remaining[0]?.id || '');
  }, [configs, activeConfigId, wrappedSetActiveConfigId]);

  const handleRenamed = useCallback((previous: Config, renamed: RenamedConfig) => {
    if (renamed.subscription || renamed.filename === previous.filename) {
      const title = renamed.title.trim() || previous.name;
      setConfigs(prev => prev.map(config => (
        config.id === previous.id ? { ...config, name: title } : config
      )));
      return;
    }
    const newId = `config-${renamed.filename}`;
    setConfigs(prev => prev.map(config => (
      config.id === previous.id
        ? { id: newId, name: renamed.title, filename: renamed.filename }
        : config
    )));
    if (activeConfigId === previous.id) {
      setHomeDisplaySnapshot(null);
      setConnectedConfigSnapshot(null);
      setActiveConfigId(newId);
    }
    setVpnRunningConfigId(current => (current === previous.id ? newId : current));
  }, [activeConfigId]);

  const setActiveTab = useCallback(
    (tab: TabType) => {
      if (noConfigs && tab !== 'connections' && tab !== 'settings') return;
      setActivePage(tab);
      if (isNarrowLayout) setSidebarOpen(false);
    },
    [isNarrowLayout, noConfigs]
  );

  const pageContent = useMemo(() => {
    switch (activePage) {
      case 'connections':
        return (
          <ConnectionsPage
            configs={configs}
            activeConfigId={activeConfigId}
            activeConfigFilename={activeConfigFilename}
            setActiveConfigId={wrappedSetActiveConfigId}
            subscriptionInfo={subscriptionInfo}
            onSubscriptionAdded={handleSubscriptionAdded}
            onSubscriptionUpdated={handleSubscriptionUpdated}
            onSelectServer={selectServer}
            onRenamed={handleRenamed}
            onDeleted={handleDeleted}
            onImported={handleImported}
            setActiveConfigContent={setActiveConfigContent}
            setParsedConfig={setParsedConfig}
            vpnEnabled={vpnEnabled}
            onNeedsRestart={markRestartRequired}
          />
        );
      case 'rules':
        return (
          <RulesPage
            rules={rules}
            setRules={setRules}
            presets={presets}
            activePresetId={activePresetId}
            presetsReady={presetsReady}
            onSelectPreset={selectPreset}
            onCreatePreset={createPreset}
            onRenamePreset={renamePreset}
            onDeletePreset={deletePreset}
            tags={tags}
            setTags={setTags}
            vpnEnabled={vpnEnabled}
            restartVPN={restartVPN}
            autoRestartOnRuleApply={settings.autoRestartOnRuleApply}
          />
        );
      case 'settings':
        return (
          <SettingsPage
            setShowLogsModal={setShowLogsModal}
            vpnEnabled={vpnEnabled}
            settings={settings}
            setSettings={setSettings}
            availableUpdateVersion={availableUpdateVersion}
            setNeedsRestart={setRestartRequiredForConfig}
          />
        );
      default:
        return null;
    }
  }, [activePage, vpnEnabled, activeConfigFilename, configs, activeConfigId, rules, presets, activePresetId, presetsReady, tags, restartVPN, settings, wrappedSetActiveConfigId, availableUpdateVersion, subscriptionInfo, handleSubscriptionAdded, handleSubscriptionUpdated, selectServer, handleRenamed, handleDeleted, handleImported, markRestartRequired, setRules, selectPreset, createPreset, renamePreset, deletePreset]);

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
                onClick={() => { setActivePage('connections'); setDismissNoConfigSplash(true); }}
              >
                {t.welcome.openConnections}
              </button>
            </div>
          </div>
        </div>
      )}
      {settings.snowfall && (
        <Snowfall
          color="white"
          style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', pointerEvents: 'none', zIndex: 9999 }}
        />
      )}
      <Titlebar
        showSidebarToggle={isNarrowLayout}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={handleToggleSidebar}
        closeBehavior={settings.closeBehavior}
      />
      {isNarrowLayout && sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} aria-hidden="true" />
      )}
      <div className="app-container">
        <Sidebar
          activeTab={activePage}
          setActiveTab={setActiveTab}
          vpnEnabled={vpnEnabled}
          restartVPN={restartVPN}
          needsRestart={restartRequiredForConfig}
          hasConfig={configs.length > 0}
          hasUpdate={updateAvailable}
          activeConfigName={activeConfigName}
          className={isNarrowLayout ? 'sidebar-floating' : ''}
          isOpen={!isNarrowLayout || sidebarOpen}
        />
        <main className="app-main">
          <div hidden={activePage !== 'home'}>
            <HomePage
              vpnEnabled={vpnEnabled} vpnStatus={vpnStatus} parsedConfig={parsedConfig}
              connectedConfigSnapshot={connectedConfigSnapshot} homeDisplaySnapshot={homeDisplaySnapshot}
              activeConfigName={activeConfigName} pollingEnabled={activePage === 'home'}
              isConnecting={isConnecting} error={vpnError}
              toggleVPN={handleToggleVPN} hasConfig={!!activeConfigContent}
            />
          </div>
          {activePage !== 'home' ? pageContent : null}
        </main>
      </div>
      <LogsModal
        showLogsModal={showLogsModal} setShowLogsModal={setShowLogsModal}
        logs={showLogsModal ? logs : EMPTY_LOGS} setLogs={setLogs}
        vpnEnabled={vpnEnabled}
      />
    </div>
  );
}