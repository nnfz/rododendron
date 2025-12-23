import React, { useRef, useCallback, useEffect } from 'react';
import { LuChevronRight, LuFileText, LuUpload, LuTrash2 } from 'react-icons/lu';
import CustomSelect from './CustomSelect';
import { useI18n } from '../i18n';
import type { Language } from '../i18n/translations';
import type { Settings, Config, ParsedConfig } from '../types';
import type { Dispatch, SetStateAction } from 'react';

interface SettingsPageProps {
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
  setShowLogsModal: (show: boolean) => void;
  configs: Config[];
  setConfigs: Dispatch<SetStateAction<Config[]>>;
  activeConfigId: string;
  setActiveConfigId: Dispatch<SetStateAction<string>>;
  setActiveConfigContent: Dispatch<SetStateAction<string | null>>;
  setParsedConfig: Dispatch<SetStateAction<ParsedConfig | null>>;
}

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
const APP_VERSION = '0.1.0';

export default function SettingsPage({ 
  settings, 
  setSettings, 
  setShowLogsModal,
  configs,
  setConfigs,
  activeConfigId,
  setActiveConfigId,
  setActiveConfigContent,
  setParsedConfig,
}: SettingsPageProps) {
  const { t, language, setLanguage } = useI18n();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load configs on mount
  useEffect(() => {
    if (!isTauri) return;
    
    const loadConfigs = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const filenames = await invoke<string[]>('list_configs');
        const loadedConfigs: Config[] = filenames.map((filename, idx) => ({
          id: `config-${idx}-${filename}`,
          name: filename.replace(/\.(yaml|yml)$/, ''),
          filename,
        }));
        setConfigs(loadedConfigs);
        
        // Restore active config from localStorage
        const savedId = localStorage.getItem('vpn-active-config');
        if (savedId && loadedConfigs.some(c => c.id === savedId)) {
          setActiveConfigId(savedId);
        } else if (loadedConfigs.length > 0) {
          setActiveConfigId(loadedConfigs[0].id);
        }
      } catch (e) {
        console.error('Failed to load configs:', e);
      }
    };
    
    loadConfigs();
  }, [setConfigs, setActiveConfigId]);

  // Load config content when selection changes
  useEffect(() => {
    if (!activeConfigId || !isTauri) {
      setActiveConfigContent(null);
      setParsedConfig(null);
      return;
    }
    
    const config = configs.find(c => c.id === activeConfigId);
    if (!config) return;

    const loadContent = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const content = await invoke<string>('read_config', { filename: config.filename });
        setActiveConfigContent(content);
        
        const parsed = await invoke<ParsedConfig>('parse_config', { configContent: content });
        setParsedConfig(parsed);
        
        localStorage.setItem('vpn-active-config', activeConfigId);
      } catch (e) {
        console.error('Failed to load config:', e);
      }
    };
    
    loadContent();
  }, [activeConfigId, configs, setActiveConfigContent, setParsedConfig]);

  const toggleSetting = useCallback((key: keyof Settings) => {
    setSettings(prev => ({ ...prev, [key]: !prev[key] }));
  }, [setSettings]);

  const handleImportConfig = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    
    const content = await file.text();
    const filename = file.name;
    
    if (isTauri) {
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

  const handleDeleteConfig = useCallback(async () => {
    if (!activeConfigId || !isTauri) return;
    
    const config = configs.find(c => c.id === activeConfigId);
    if (!config) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_config', { filename: config.filename });
      
      const newConfigs = configs.filter(c => c.id !== activeConfigId);
      setConfigs(newConfigs);
      setActiveConfigId(newConfigs[0]?.id || '');
    } catch (e) {
      console.error('Failed to delete config:', e);
    }
  }, [activeConfigId, configs, setConfigs, setActiveConfigId]);

  const handleLanguageChange = useCallback((lang: Language) => {
    setLanguage(lang);
  }, [setLanguage]);

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
              <CustomSelect 
                value={activeConfigId} 
                onChange={setActiveConfigId} 
                options={configs.map(c => ({ value: c.id, label: c.name }))} 
                disabled={configs.length === 0} 
              />
            </div>
            <div className="config-actions">
              <button 
                onClick={handleDeleteConfig} 
                className="config-action-btn config-delete-btn" 
                disabled={!activeConfigId}
              >
                <LuTrash2 size={18} />
                <span className="setting-label">{t.settings.deleteConfig}</span>
              </button>
              <button 
                onClick={() => fileInputRef.current?.click()} 
                className="config-action-btn"
              >
                <LuUpload size={18} />
                <span className="setting-label">{t.settings.importConfig}</span>
              </button>
            </div>
            <input 
              ref={fileInputRef} 
              type="file" 
              accept=".yaml,.yml" 
              onChange={handleImportConfig} 
              style={{ display: 'none' }} 
            />
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
            <button onClick={() => toggleSetting('killSwitch')} className="panel-row">
              <span className="setting-label">{t.settings.killSwitch}</span>
              <div className={`toggle ${settings.killSwitch ? 'on' : ''}`} role="switch" aria-checked={settings.killSwitch}>
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
              <span className="setting-label">{t.settings.mtu}</span>
              <input 
                type="text" 
                value={settings.mtu} 
                onChange={e => setSettings(prev => ({ ...prev, mtu: e.target.value.replace(/\D/g, '') }))} 
                className="input" 
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
              <span className="setting-value">{APP_VERSION}</span>
            </div>
            <div className="panel-row disabled">
              <span className="setting-label">{t.settings.versioncore}</span>
              <span className="setting-value">mihomo</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
