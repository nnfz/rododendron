import { useState, useCallback, useEffect } from 'react';
import type { VpnStatus, Rule } from '../types';
import { isTauri } from '../utils/isTauri';

type StartVPNFn = (
  configContent: string,
  configFilename: string,
  rules: Rule[],
  logLevel: string,
  enableTun?: boolean,
  mtu?: string,
  killSwitch?: boolean,
  tunStack?: string,
  fakeIpFilter?: string[]
) => Promise<void>;

type StopVPNFn = () => Promise<void>;

type ToggleVPNFn = (
  configContent?: string,
  configFilename?: string,
  rules?: Rule[],
  logLevel?: string,
  enableTun?: boolean,
  mtu?: string,
  killSwitch?: boolean,
  tunStack?: string,
  fakeIpFilter?: string[]
) => Promise<void>;

export interface VPNState {
  vpnEnabled: boolean;
  vpnStatus: VpnStatus | null;
  isConnecting: boolean;
  error: string | null;
  toggleVPN: ToggleVPNFn;
  startVPN: StartVPNFn;
  stopVPN: StopVPNFn;
}

export function useVPNState(): VPNState {
  const [vpnEnabled, setVpnEnabled] = useState(false);
  const [vpnStatus, setVpnStatus] = useState<VpnStatus | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    const checkStatus = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const status = await invoke('get_vpn_status') as VpnStatus;
        setVpnEnabled(status.running);
        setVpnStatus(status);
      } catch (e) {
        console.error('Failed to get VPN status:', e);
      }
    };
    checkStatus();
  }, []);

  const startVPN: StartVPNFn = useCallback(async (
    configContent: string, 
    configFilename: string, 
    rules: Rule[], 
    logLevel: string, 
    enableTun: boolean = true,
    mtu?: string,
    killSwitch: boolean = false,
    tunStack?: string,
    fakeIpFilter?: string[]
  ) => {
    if (!isTauri()) {
      setVpnEnabled(true);
      return;
    }

    setIsConnecting(true);
    setError(null);

    try {
      const { invoke } = await import('@tauri-apps/api/core');

      const userRules = rules.map(r => ({
        id: r.id,
        app: r.app,
        rule: r.rule,
        active: r.active,
        rule_type: r.ruleType || 'process',
      }));

      // Парсим MTU в число
      const mtuValue = mtu ? parseInt(mtu, 10) : 1500;

      const finalConfig = await invoke('generate_config', {
        baseConfig: configContent,
        userRules,
        logLevel,
        enableTun,
        mtu: mtuValue,
        killSwitch,
        tunStack: tunStack || null,
        fakeIpFilter: fakeIpFilter || null,
      }) as string;

      const status = await invoke('start_vpn', {
        configContent: finalConfig,
        configFilename,
        enableTun,
      }) as VpnStatus;

      await new Promise(resolve => setTimeout(resolve, 1200));
      try {
        const verified = await invoke('get_vpn_status') as VpnStatus;
        setVpnEnabled(verified.running);
        setVpnStatus(verified);
      } catch {
        setVpnEnabled(status.running);
        setVpnStatus(status);
      }
    } catch (e: any) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setError(errMsg);
      console.error('Failed to start VPN:', e);
      throw new Error(errMsg);
    } finally {
      setIsConnecting(false);
    }
  }, []);

  const stopVPN: StopVPNFn = useCallback(async () => {
    if (!isTauri()) {
      setVpnEnabled(false);
      return;
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const status = await invoke('stop_vpn') as VpnStatus;
      setVpnEnabled(status.running);
      setVpnStatus(status);
      setError(null);
    } catch (e) {
      console.error('Failed to stop VPN:', e);
    }
  }, []);

  const toggleVPN: ToggleVPNFn = useCallback(async (
    configContent?: string, 
    configFilename?: string, 
    rules?: Rule[], 
    logLevel?: string,
    enableTun?: boolean,
    mtu?: string,
    killSwitch?: boolean,
    tunStack?: string,
    fakeIpFilter?: string[]
  ) => {
    if (vpnEnabled) {
      await stopVPN();
    } else if (configContent && configFilename && rules && logLevel !== undefined) {
      await startVPN(configContent, configFilename, rules, logLevel, enableTun, mtu, killSwitch, tunStack, fakeIpFilter);
    }
  }, [vpnEnabled, startVPN, stopVPN]);

  return {
    vpnEnabled,
    vpnStatus,
    isConnecting,
    error,
    toggleVPN,
    startVPN,
    stopVPN,
  };
}