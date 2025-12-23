import { useState, useCallback, useEffect } from 'react';
import type { VpnStatus, Rule } from '../types';

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export function useVPNState() {
  const [vpnEnabled, setVpnEnabled] = useState(false);
  const [vpnStatus, setVpnStatus] = useState<VpnStatus | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Check status on mount
  useEffect(() => {
    if (!isTauri) return;
    
    const checkStatus = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const status = await invoke<VpnStatus>('get_vpn_status');
        setVpnEnabled(status.running);
        setVpnStatus(status);
      } catch (e) {
        console.error('Failed to get VPN status:', e);
      }
    };
    
    checkStatus();
  }, []);

  const startVPN = useCallback(async (configContent: string, rules: Rule[], logLevel: string) => {
    if (!isTauri) {
      setVpnEnabled(true);
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      
      // Convert rules to backend format
      const userRules = rules.map(r => ({
        id: r.id,
        app: r.app,
        rule: r.rule,
        active: r.active,
        rule_type: r.ruleType || 'process',
      }));

      // Generate final config with merged rules
      const finalConfig = await invoke<string>('generate_config', {
        baseConfig: configContent,
        userRules,
        logLevel,
      });

      // Start VPN
      const status = await invoke<VpnStatus>('start_vpn', {
        configContent: finalConfig,
      });

      setVpnEnabled(status.running);
      setVpnStatus(status);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setError(errMsg);
      console.error('Failed to start VPN:', e);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const stopVPN = useCallback(async () => {
    if (!isTauri) {
      setVpnEnabled(false);
      return;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke<VpnStatus>('stop_vpn');
      setVpnEnabled(status.running);
      setVpnStatus(status);
    } catch (e) {
      console.error('Failed to stop VPN:', e);
    }
  }, []);

  const toggleVPN = useCallback(async (configContent?: string, rules?: Rule[], logLevel?: string) => {
    if (vpnEnabled) {
      await stopVPN();
    } else if (configContent && rules && logLevel) {
      await startVPN(configContent, rules, logLevel);
    }
  }, [vpnEnabled, startVPN, stopVPN]);

  const restartVPN = useCallback(async (configContent: string, rules: Rule[], logLevel: string) => {
    await stopVPN();
    await new Promise(resolve => setTimeout(resolve, 500));
    await startVPN(configContent, rules, logLevel);
  }, [stopVPN, startVPN]);

  return {
    vpnEnabled,
    vpnStatus,
    isConnecting,
    error,
    toggleVPN,
    startVPN,
    stopVPN,
    restartVPN,
  };
}
