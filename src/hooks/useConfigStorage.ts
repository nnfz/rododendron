import { useEffect, useRef, useState, useCallback, type Dispatch, type SetStateAction } from 'react';
import type { Config, ParsedConfig } from '../types';
import { isTauri } from '../utils/isTauri';
const ACTIVE_KEY = 'vpn-active-config';

export type { Config };

export function useConfigStorage(
  configs: Config[],
  setConfigs: Dispatch<SetStateAction<Config[]>>,
  activeConfig: string,
  setActiveConfig: Dispatch<SetStateAction<string>>
) {
  const isInitialized = useRef(false);
  const [activeConfigContent, setActiveConfigContent] = useState<string | null>(null);
  const [parsedConfig, setParsedConfig] = useState<ParsedConfig | null>(null);

  // Load configs on mount
  useEffect(() => {
    const loadConfigs = async () => {
      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const filenames = await invoke<string[]>('list_configs');
          const loadedConfigs: Config[] = filenames.map((filename, idx) => ({
            id: `config-${idx}`,
            name: filename.replace(/\.(yaml|yml)$/, ''),
            filename,
          }));
          setConfigs(loadedConfigs);
          
          // Restore active config
          const savedActive = localStorage.getItem(ACTIVE_KEY);
          if (savedActive && loadedConfigs.some(c => c.id === savedActive)) {
            setActiveConfig(savedActive);
          } else if (loadedConfigs.length > 0) {
            setActiveConfig(loadedConfigs[0].id);
          }
        } catch (e) {
          console.error('Failed to load configs:', e);
        }
      }
      isInitialized.current = true;
    };
    
    loadConfigs();
  }, [setConfigs, setActiveConfig]);

  // Load active config content when selection changes
  useEffect(() => {
    if (!activeConfig || !isInitialized.current) return;
    
    const loadContent = async () => {
      const config = configs.find(c => c.id === activeConfig);
      if (!config) {
        setActiveConfigContent(null);
        setParsedConfig(null);
        return;
      }

      if (isTauri()) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const content = await invoke<string>('read_config', { filename: config.filename });
          setActiveConfigContent(content);
          
          // Parse config
          const parsed = await invoke<ParsedConfig>('parse_config', { configContent: content });
          setParsedConfig(parsed);
        } catch (e) {
          console.error('Failed to load config content:', e);
        }
      }
    };
    
    loadContent();
    localStorage.setItem(ACTIVE_KEY, activeConfig);
  }, [activeConfig, configs]);

  // Import new config
  const importConfig = useCallback(async (content: string, filename: string): Promise<Config | null> => {
    if (!isTauri()) return null;
    
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke<string>('import_config', { configContent: content, filename });
      
      const newConfig: Config = {
        id: `config-${Date.now()}`,
        name: filename.replace(/\.(yaml|yml)$/, ''),
        filename,
      };
      
      setConfigs(prev => [...prev, newConfig]);
      setActiveConfig(newConfig.id);
      
      return newConfig;
    } catch (e) {
      console.error('Failed to import config:', e);
      return null;
    }
  }, [setConfigs, setActiveConfig]);

  // Delete config
  const deleteActiveConfig = useCallback(async () => {
    if (!activeConfig || !isTauri()) return;
    
    const config = configs.find(c => c.id === activeConfig);
    if (!config) return;

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_config', { filename: config.filename });
      
      const newConfigs = configs.filter(c => c.id !== activeConfig);
      setConfigs(newConfigs);
      setActiveConfig(newConfigs[0]?.id || '');
    } catch (e) {
      console.error('Failed to delete config:', e);
    }
  }, [activeConfig, configs, setConfigs, setActiveConfig]);

  return {
    activeConfigContent,
    parsedConfig,
    importConfig,
    deleteActiveConfig,
  };
}
