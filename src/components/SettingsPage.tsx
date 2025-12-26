import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LuChevronRight, LuDownload, LuFileText, LuHelpCircle, LuRefreshCw, LuUpload, LuTrash2 } from 'react-icons/lu';
import CustomSelect from './CustomSelect';
import { useI18n } from '../i18n';
import type { Language } from '../i18n/translations';
import type { Settings, Config, ParsedConfig } from '../types';
import type { Dispatch, SetStateAction } from 'react';
import { isTauri } from '../utils/isTauri';

interface SettingsPageProps {
  setShowLogsModal: (show: boolean) => void;
  configs: Config[];
  setConfigs: Dispatch<SetStateAction<Config[]>>;
  activeConfigId: string;
  setActiveConfigId: Dispatch<SetStateAction<string>>;
  setActiveConfigContent: Dispatch<SetStateAction<string | null>>;
  setParsedConfig: Dispatch<SetStateAction<ParsedConfig | null>>;
  vpnEnabled: boolean;
  restartVPN: (rulesOverride?: any[]) => Promise<void>;
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  availableUpdateVersion: string | null;
}

type UpdateCheckResult = {
  current_version: string;
  latest_version: string;
  update_available: boolean;
  asset_name?: string | null;
  download_url?: string | null;
  release_notes?: string | null;
};

const MTU_MIN = 1280;
const MTU_MAX = 1500;
const MTU_DEFAULT = '1500';
const DELETE_CONFIRM_TIMEOUT = 3000;
const MIHOMO_CORE_VERSION = '1.19.18';

function SettingsPage({
  setShowLogsModal,
  configs,
  setConfigs,
  activeConfigId,
  setActiveConfigId,
  settings,
  setSettings,
  vpnEnabled,
  restartVPN,
  availableUpdateVersion,
}: SettingsPageProps) {
  const { t, language, setLanguage } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const deleteConfirmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [mtuError, setMtuError] = useState(false);
  const [updateCheck, setUpdateCheck] = useState<UpdateCheckResult | null>(null);
  const [updateStatusText, setUpdateStatusText] = useState<string | null>(null);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [mihomoCoreName, setMihomoCoreName] = useState<string>('mihomo');
  const [vlessImportError, setVlessImportError] = useState<string | null>(null);
  const [isImportingVless, setIsImportingVless] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (!isTauri()) return;
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const name = await invoke<string>('get_mihomo_binary_name');
        if (cancelled) return;
        if (typeof name === 'string' && name.trim()) {
          setMihomoCoreName(name.trim());
        }
      } catch {
        // ignore
      }
    };

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    return () => {
      if (deleteConfirmTimeoutRef.current) {
        clearTimeout(deleteConfirmTimeoutRef.current);
      }
    };
  }, []);



  const toggleSetting = useCallback(async (key: keyof Settings) => {
    try {
      let nextValue = false;
      setSettings(prev => {
        nextValue = !prev[key];
        return { ...prev, [key]: nextValue };
      });

      const settingsRequiringRestart: (keyof Settings)[] = ['enableTun', 'killSwitch'];
      if (vpnEnabled && settingsRequiringRestart.includes(key)) {
        try {
          await restartVPN();
        } catch (e) {
          console.error('Failed to restart VPN:', e);
          setSettings(prev => ({ ...prev, [key]: !nextValue }));
        }
      }
    } catch (e) {
      console.error('Error toggling setting:', e);
      setSettings(prev => ({ ...prev, [key]: prev[key] }));
    }
  }, [setSettings, vpnEnabled, restartVPN]);

  const handleCheckUpdates = useCallback(async () => {
    if (!isTauri()) {
      setUpdateStatusText(t.settings.updateError);
      return;
    }

    setIsCheckingUpdates(true);
    setIsInstallingUpdate(false);
    setUpdateStatusText(t.settings.checkingUpdates);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const res = await invoke('check_for_updates') as UpdateCheckResult;
      setUpdateCheck(res);

      if (!res?.update_available) {
        setUpdateStatusText(t.settings.upToDate);
      } else {
        setUpdateStatusText(t.settings.updateAvailable.replace('{version}', res.latest_version || ''));
      }
    } catch (e) {
      console.error('Update check failed:', e);
      setUpdateStatusText(t.settings.updateError);
    } finally {
      setIsCheckingUpdates(false);
    }
  }, [t.settings]);

  const handleInstallUpdate = useCallback(async () => {
    if (!isTauri() || !updateCheck?.update_available) {
      setUpdateStatusText(t.settings.updateError);
      return;
    }

    setIsInstallingUpdate(true);
    setUpdateStatusText(t.settings.installingUpdate);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('install_update');
    } catch (e) {
      console.error('Failed to install update:', e);
      setUpdateStatusText(t.settings.updateError);
      setIsInstallingUpdate(false);
    }
  }, [t.settings, updateCheck?.update_available]);

  const handleMtuChange = useCallback(async (value: string) => {
    const numValue = parseInt(value, 10);

    if (value && (numValue < MTU_MIN || numValue > MTU_MAX)) {
      setMtuError(true);
      setTimeout(() => setMtuError(false), 400);
      return;
    }

    setSettings(prev => ({ ...prev, mtu: value }));

    if (vpnEnabled && value) {
      await new Promise(resolve => setTimeout(resolve, 100));
      await restartVPN();
    }
  }, [setSettings, vpnEnabled, restartVPN]);

  const handleImportConfig = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const content = await file.text();
    const filename = file.name;

    if (isTauri()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('import_config', { configContent: content, filename });

        const newConfig: Config = {
          id: `config-${Date.now()}-${filename}`,
          name: filename.replace(/\.(yaml|yml)$/, ''),
          filename,
        };

        setConfigs(prev => [...prev, newConfig]);
        setActiveConfigId(newConfig.id);
      } catch (e) {
        console.error('Failed to import config:', e);
      }
    }

    if (fileInputRef.current) fileInputRef.current.value = '';
  }, [setConfigs, setActiveConfigId]);

  const importVlessFromText = useCallback(async (raw: string) => {
    if (!isTauri()) return;
    const text = raw.trim();
    if (!text) return;

    const url = new URL(text);
    if (url.protocol !== 'vless:') {
      throw new Error('Clipboard does not contain a vless:// link');
    }
    if (!url.username) {
      throw new Error('Missing UUID in vless:// link');
    }

    const name = decodeURIComponent((url.hash || '').replace(/^#/, '')).trim() || 'VLESS';
    const server = url.hostname;
    const port = url.port ? Number(url.port) : 443;

    const network = (url.searchParams.get('type') || 'tcp').toLowerCase();
    const security = (url.searchParams.get('security') || '').toLowerCase();
    const pbk = url.searchParams.get('pbk') || '';
    const fp = url.searchParams.get('fp') || '';
    const sni = url.searchParams.get('sni') || '';
    const sid = url.searchParams.get('sid') || '';
    const flow = url.searchParams.get('flow') || '';

    const tlsEnabled = security === 'reality' || security === 'tls';

    const safeName = name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60) || 'VLESS';
    const filename = `${safeName}.yaml`;

    const yaml = [
      'mixed-port: 7890',
      'allow-lan: false',
      'mode: rule',
      'log-level: info',
      '',
      'proxies:',
      `  - name: ${name}`,
      '    type: vless',
      `    server: ${server}`,
      `    port: ${port}`,
      `    uuid: ${url.username}`,
      '    udp: true',
      `    network: ${network}`,
      '',
      `    tls: ${tlsEnabled ? 'true' : 'false'}`,
      ...(sni ? [`    servername: ${sni}`] : []),
      ...(fp ? [`    client-fingerprint: ${fp}`] : []),
      ...(flow ? [`    flow: ${flow}`] : []),
      '',
      ...(security === 'reality'
        ? [
          '    reality-opts:',
          ...(pbk ? [`      public-key: ${pbk}`] : []),
          ...(sid ? [`      short-id: ${sid}`] : []),
        ]
        : []),
      '',
      'proxy-groups:',
      '  - name: PROXY',
      '    type: select',
      '    proxies:',
      `      - ${name}`,
      '      - DIRECT',
      '',
      'rules:',
      '- MATCH,PROXY',
      '',
    ].join('\n');

    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('import_config', { configContent: yaml, filename });

    const newConfig: Config = {
      id: `config-${Date.now()}-${filename}`,
      name: filename.replace(/\.(yaml|yml)$/, ''),
      filename,
    };
    setConfigs(prev => [...prev, newConfig]);
    setActiveConfigId(newConfig.id);
  }, [setConfigs, setActiveConfigId]);

  const handleImportVlessFromClipboard = useCallback(async () => {
    if (!isTauri()) return;

    setVlessImportError(null);
    setIsImportingVless(true);
    try {
      const text = await navigator.clipboard.readText();
      await importVlessFromText(text);
    } catch (e) {
      setVlessImportError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsImportingVless(false);
    }
  }, [importVlessFromText]);

  const handleExportConfig = useCallback(async () => {
    if (!activeConfigId || !isTauri()) return;

    const config = configs.find(c => c.id === activeConfigId);
    if (!config?.filename) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { save } = await import('@tauri-apps/plugin-dialog');

      const filePath = await save({
        defaultPath: config.filename,
        filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      });

      if (!filePath) return;
      await invoke('export_config_to_path', { filename: config.filename, path: filePath });
    } catch (e) {
      console.error('Failed to export config:', e);
    }
  }, [activeConfigId, configs]);

  const handleDeleteConfig = useCallback(async () => {
    if (!activeConfigId || !isTauri()) return;

    const config = configs.find(c => c.id === activeConfigId);
    if (!config) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_config', { filename: config.filename });

      const newConfigs = configs.filter(c => c.id !== activeConfigId);
      setConfigs(newConfigs);
      setActiveConfigId(newConfigs[0]?.id || '');
      setShowDeleteConfirm(false);
    } catch (e) {
      console.error('Failed to delete config:', e);
    }
  }, [activeConfigId, configs, setConfigs, setActiveConfigId]);

  const handleDeleteClick = useCallback(() => {
    if (!showDeleteConfirm) {
      setShowDeleteConfirm(true);

      if (deleteConfirmTimeoutRef.current) {
        clearTimeout(deleteConfirmTimeoutRef.current);
      }

      deleteConfirmTimeoutRef.current = setTimeout(() => {
        setShowDeleteConfirm(false);
        deleteConfirmTimeoutRef.current = null;
      }, DELETE_CONFIRM_TIMEOUT);
    } else {
      if (deleteConfirmTimeoutRef.current) {
        clearTimeout(deleteConfirmTimeoutRef.current);
        deleteConfirmTimeoutRef.current = null;
      }
      handleDeleteConfig();
    }
  }, [showDeleteConfirm, handleDeleteConfig]);

  const handleLanguageChange = useCallback((lang: Language) => {
    setLanguage(lang);
  }, [setLanguage]);

  const configOptions = useMemo(() =>
    configs.map(c => ({ value: c.id, label: c.name })),
    [configs]
  );

  const closeBehaviorOptions = useMemo(() => [
    { value: 'tray', label: t.settings.closeToTray },
    { value: 'exit', label: t.settings.closeExit },
  ], [t.settings]);

  const mihomoCoreDisplayName = useMemo(() => {
    const base = mihomoCoreName.replace(/\.[^./\\]+$/, '');
    return `${base} (${MIHOMO_CORE_VERSION})`;
  }, [mihomoCoreName]);

  return (
    <div className="page-content">
      <h2 className="page-title">{t.settings.title}</h2>

      <div className="container-narrow">
        {/* Configuration */}
        <div>
          <h3 className="section-heading">{t.settings.configuration}</h3>
          <div className="panel">
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.activeConfig}</span>
              <div className='setting-top'>
                <button
                  type="button"
                  onClick={handleImportVlessFromClipboard}
                  className="btn btn-ghost-dark"
                  disabled={isImportingVless}
                >
                  <LuUpload size={18} />
                  <span className="setting-label">{t.settings.importurl}</span>
                </button>
                <CustomSelect
                  value={activeConfigId}
                  onChange={setActiveConfigId}
                  options={configOptions}
                  disabled={configs.length === 0}
                />
              </div>
            </div>
            <div className="config-actions">
              <button
                onClick={handleDeleteClick}
                className="config-action-btn config-delete-btn"
                disabled={!activeConfigId}
              >
                <LuTrash2 size={18} />
                <span className="setting-label delete-label" style={showDeleteConfirm ? { fontWeight: 700 } : { fontWeight: 200 }}>
                  {showDeleteConfirm ? t.settings.confirmDelete || 'Confirm?' : t.settings.deleteConfig}
                </span>
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                className="config-action-btn config-import-btn"
              >
                <LuUpload size={18} />
                <span className="setting-label import-label">{t.settings.importConfig}</span>
              </button>
              <button
                onClick={handleExportConfig}
                className="config-action-btn"
                disabled={!activeConfigId}
              >
                <LuDownload size={18} />
                <span className="setting-label">{t.settings.exportConfig}</span>
              </button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".yaml,.yml"
              onChange={handleImportConfig}
              style={{ display: 'none' }}
            />

            {vlessImportError && (
              <div className="panel-row disabled">
                <span className="setting-label">{vlessImportError}</span>
              </div>
            )}
          </div>
        </div>

        {/* Main Settings */}
        <div>
          <h3 className="section-heading">{t.settings.mainSettings}</h3>
          <div className="panel">
            <button onClick={() => toggleSetting('autostart')} className="panel-row">
              <span className="setting-label">{t.settings.autoLaunch}</span>
              <div className={`toggle ${settings.autostart ? 'on' : ''}`} role="switch" aria-checked={settings.autostart}>
                <div className="toggle-knob" />
              </div>
            </button>
            <button onClick={() => toggleSetting('startminimized')} className="panel-row">
              <span className="setting-label">{t.settings.startminimized}</span>
              <div className={`toggle ${settings.startminimized ? 'on' : ''}`} role="switch" aria-checked={settings.startminimized}>
                <div className="toggle-knob" />
              </div>
            </button>
            <button onClick={() => toggleSetting('autoConnect')} className="panel-row">
              <span className="setting-label">{t.settings.autoConnect}</span>
              <div className={`toggle ${settings.autoConnect ? 'on' : ''}`} role="switch" aria-checked={settings.autoConnect}>
                <div className="toggle-knob" />
              </div>
            </button>

            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.closeBehavior}</span>
              <CustomSelect
                value={settings.closeBehavior}
                onChange={(value) => setSettings(prev => ({ ...prev, closeBehavior: value as Settings['closeBehavior'] }))}
                options={closeBehaviorOptions}
              />
            </div>

            <div
              className="panel-row"
              role="button"
              tabIndex={0}
              onClick={() => toggleSetting('killSwitch')}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toggleSetting('killSwitch');
                }
              }}
            >
              <span className="setting-label setting-label-with-help">
                {t.settings.killSwitch}
                <button
                  type="button"
                  className="help-tooltip"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <LuHelpCircle size={14} className="help-icon" />
                  <span className="help-tooltip-content">{t.settings.killSwitchHelp}</span>
                </button>
              </span>
              <div className={`toggle ${settings.killSwitch ? 'on' : ''}`} role="switch" aria-checked={settings.killSwitch}>
                <div className="toggle-knob" />
              </div>
            </div>
            <button onClick={() => toggleSetting('enableTun')} className="panel-row">
              <span className="setting-label">{t.settings.enableTun}</span>
              <div className={`toggle ${settings.enableTun ? 'on' : ''}`} role="switch" aria-checked={settings.enableTun}>
                <div className="toggle-knob" />
              </div>
            </button>
            <button onClick={() => toggleSetting('snowfall')} className="panel-row">
              <span className="setting-label">{t.settings.snowfall}</span>
              <div className={`toggle ${settings.snowfall ? 'on' : ''}`} role="switch" aria-checked={settings.snowfall}>
                <div className="toggle-knob" />
              </div>
            </button>
          </div>
        </div>

        {/* Language */}
        <div>
          <h3 className="section-heading">{t.settings.language}</h3>
          <div className="panel">
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.interfaceLanguage}</span>
              <div className="language-selector" role="radiogroup">
                <button className={`language-btn ${language === 'en' ? 'active' : ''}`} onClick={() => handleLanguageChange('en')}>English</button>
                <button className={`language-btn ${language === 'ru' ? 'active' : ''}`} onClick={() => handleLanguageChange('ru')}>Русский</button>
                <button className={`language-btn ${language === 'be' ? 'active' : ''}`} onClick={() => handleLanguageChange('be')}>Беларуская</button>
              </div>
            </div>
          </div>
        </div>

        {/* Advanced */}
        <div>
          <h3 className="section-heading">{t.settings.advanced}</h3>
          <div className="panel">
            <div className="panel-row disabled">
              <span className="setting-label setting-label-with-help">
                {t.settings.mtu}
                <button
                  type="button"
                  className="help-tooltip"
                  onClick={(e) => e.stopPropagation()}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <LuHelpCircle size={14} className="help-icon" />
                  <span className="help-tooltip-content">{t.settings.mtuHelp}</span>
                </button>
              </span>
              <input
                type="number"
                min={MTU_MIN}
                max={MTU_MAX}
                value={settings.mtu}
                onChange={e => handleMtuChange(e.target.value.replace(/\D/g, ''))}
                onBlur={() => {
                  if (!settings.mtu) {
                    setSettings(prev => ({ ...prev, mtu: MTU_DEFAULT }));
                  }
                }}
                className={`input ${mtuError ? 'input-error input-shake' : ''}`}
              />
            </div>
          </div>
        </div>

        {/* Logs */}
        <div>
          <h3 className="section-heading">{t.settings.logsAndDiagnostics}</h3>
          <div className="panel">
            <button onClick={() => setShowLogsModal(true)} className="panel-row">
              <div className="settings-section-container">
                <LuFileText size={18} />
                <span className="setting-label">{t.settings.logs}</span>
              </div>
              <LuChevronRight size={18} />
            </button>
          </div>
        </div>

        {/* About */}
        <div>
          <h3 className="section-heading">{t.settings.about}</h3>
          <div className="panel">
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.version}</span>
              <span className="setting-value">{__APP_VERSION__}</span>
            </div>
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.versioncore}</span>
              <span className="setting-value">{mihomoCoreDisplayName}</span>
            </div>

            <button onClick={() => toggleSetting('autoCheckUpdates')} className="panel-row">
              <span className="setting-label">{t.settings.autoCheckUpdates}</span>
              <div className={`toggle ${settings.autoCheckUpdates ? 'on' : ''}`} role="switch" aria-checked={settings.autoCheckUpdates}>
                <div className="toggle-knob" />
              </div>
            </button>

            <div className="config-actions">
              <button
                onClick={handleCheckUpdates}
                className="config-action-btn"
                disabled={isCheckingUpdates || isInstallingUpdate}
              >
                <LuRefreshCw size={18} />
                
                <span className="setting-label">
                  <div className='setting-check-update'>
                    {availableUpdateVersion ? <span className="update-lamp" aria-hidden="true" /> : null}
                    {t.settings.checkUpdates}
                  </div>
                </span>
              </button>

              {updateCheck?.update_available && (
                <button
                  onClick={handleInstallUpdate}
                  className="config-action-btn"
                  disabled={isCheckingUpdates || isInstallingUpdate}
                >
                  <LuDownload size={18} />
                  <span className="setting-label">{t.settings.updateNow}</span>
                </button>
              )}
            </div>

            {updateStatusText && (
              <div className="panel-row disabled">
                <span className="setting-label">{updateStatusText}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(SettingsPage);