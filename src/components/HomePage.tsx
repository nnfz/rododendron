import { memo, useMemo } from 'react';
import { useI18n } from '../i18n';
import { LuLoader2 } from 'react-icons/lu';
import type { VpnStatus } from '../types';
import { useVPNStats } from '../hooks/useVPNStat';

interface HomePageProps {
  vpnEnabled: boolean;
  vpnStatus: VpnStatus | null;
  parsedConfig: any | null;
  connectedConfigSnapshot?: {
    proxy_name: string | null;
    server_address: string | null;
    mixed_port: number | null;
  } | null;
  homeDisplaySnapshot?: {
    proxyName: string;
    serverName: string;
    port: number;
  } | null;
  activeConfigName?: string | null;
  pollingEnabled?: boolean;
  isConnecting: boolean;
  error: string | null;
  toggleVPN: () => Promise<void>;
  hasConfig: boolean;
}

function HomePage({ 
  vpnEnabled, 
  vpnStatus, 
  parsedConfig,
  connectedConfigSnapshot,
  homeDisplaySnapshot,
  activeConfigName,
  pollingEnabled = true,
  isConnecting,
  error,
  toggleVPN, 
  hasConfig,
}: HomePageProps) {
  const { t } = useI18n();
  const { traffic, latency, formatUptime, formatTraffic } = useVPNStats(vpnEnabled, pollingEnabled);
  
  const uptime = useMemo(() => formatUptime(), [formatUptime]);
  const trafficUp = useMemo(() => formatTraffic(traffic.up), [formatTraffic, traffic.up]);
  const trafficDown = useMemo(() => formatTraffic(traffic.down), [formatTraffic, traffic.down]);
  
  const displayInfo = useMemo(() => {
    const serverName = homeDisplaySnapshot?.serverName ??
      (vpnEnabled
        ? (vpnStatus?.server || connectedConfigSnapshot?.server_address || 'Not configured')
        : (parsedConfig?.server_address || 'Not configured'));
    
    const proxyName = homeDisplaySnapshot?.proxyName ??
      (vpnEnabled
        ? (vpnStatus?.proxy_name || connectedConfigSnapshot?.proxy_name || activeConfigName || 'Unknown')
        : (parsedConfig?.proxy_name || activeConfigName || 'Unknown'));
    
    const port = homeDisplaySnapshot?.port ??
      (vpnEnabled
        ? (vpnStatus?.port || connectedConfigSnapshot?.mixed_port || 7890)
        : (parsedConfig?.mixed_port || 7890));

    return { serverName, proxyName, port };
  }, [
    homeDisplaySnapshot,
    vpnEnabled,
    vpnStatus,
    connectedConfigSnapshot,
    parsedConfig,
    activeConfigName,
  ]);

  const handleClick = () => {
    if (!isConnecting) {
      toggleVPN();
    }
  };

  const subtitle = useMemo(() => {
    if (error) return error;
    if (isConnecting) return 'Connecting...';
    if (vpnEnabled) return t.home.connectionEstablished;
    if (!hasConfig) return 'Import a config to connect';
    return t.home.notConnected;
  }, [error, isConnecting, vpnEnabled, hasConfig, t.home]);

  return (
    <div className="hero animate-fadeIn">
      <div className="hero-inner">
        <div className="relative">
          <button
            onClick={handleClick}
            disabled={!hasConfig && !vpnEnabled}
            className={`hero-circle ${vpnEnabled ? 'connected' : 'disconnected'} ${isConnecting ? 'connecting' : ''} ${!hasConfig && !vpnEnabled ? 'disabled' : ''}`}
            aria-pressed={vpnEnabled}
            aria-label={vpnEnabled ? 'Disconnect VPN' : 'Connect VPN'}
          >
            {isConnecting ? (
              <LuLoader2 size={80} className="spin hero-load" strokeWidth={1} />
            ) : (
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1578.88 1876.72" className={vpnEnabled ? 'hero-icon-connected hero-icon' : 'hero-icon-disconnected hero-icon'}>
                <path d="M455.59,1205.4l61.69,32.9s-53-217.73,273.93-480.01c324.88,254.06,274.16,480.01,274.16,480.01l63.06-33.13s30.39-240.12-336.42-521.82c-399.71,304.32-336.42,522.05-336.42,522.05Z"/>
                <path d="M539.67,301.58l45.34,69.43s24.57-136.59,206.13-292.64c173.48,138.22,207.75,293.13,207.75,293.13l43.89-56.8S1016.71,174.09,790.49,0c-180.9,126.8-250.82,301.58-250.82,301.58Z"/>
                <path d="M875.06,705.05l52.78,52.78s-1.37-160.39,135.71-304.32c32.91-35.37,65.5-102.81,65.5-102.81,0,0,123.67,126.34,105.85,352.53l59.4-35.64s16.19-249.43-181.2-435.86c-46.77,124.26-107.41,202.13-133.44,231.97-19.92,22.84-37.8,47.4-52.94,73.65-25.26,43.81-52.89,106.14-51.66,167.71Z"/>
                <path d="M708.52,705.05l-55.34,52.78s1.44-160.39-142.3-304.32c-34.5-35.37-68.68-102.81-68.68-102.81,0,0-129.68,126.34-110.99,352.53l-62.29-35.64s-16.98-249.43,190.01-435.86c49.04,124.26,112.63,202.13,139.92,231.97,20.89,22.84,39.64,47.4,55.51,73.65,26.49,43.81,55.46,106.14,54.17,167.71Z"/>
                <path d="M865.78,1496.07s316.31-278.27,650.79-331.28c-10.05,210.88-60.32,634-414.9,643.14-354.58,9.14-326.02-294.5-928.5-516.57,6.17,135.71,86.13,544.67,466.3,392.05l-45.5-43.78s-283.27,101.24-338.79-249.23c414.67,166.1,535.29,514.28,846.48,480.01,0,0,487.32,23.99,477.04-782.05-451,80.88-758.74,362.58-758.74,362.58l45.81,45.12Z"/>
                <path d="M763.8,1787.94C334.02,2049.08-17.6,1709.8.68,1088.37c852.65,208.59,789.81,572.09,1128.36,564.77,4.61-.1,155.86-14.62,197.9-265.02-191,74.02-336.99,206.88-336.99,206.88l-50.61-37.01s178.21-178.21,470.19-262.05c-53.46,475.67-367.38,526.39-645.74,242.63-290.58-296.21-697.2-371.26-697.2-371.26-4.57,616.64,369.66,742.75,650.65,579.17l46.55,41.47Z"/>
                <path d="M1074.26,926.84l38.38,63.74s55.52-150.1,241.26-242.63c58.94,182.32,19.19,353.67,19.19,353.67l64.43-13.25s48.21-215.22-47.75-429.06c-260.73,126.11-315.52,267.54-315.52,267.54Z"/>
                <path d="M504.25,926.84l-38.38,63.74s-55.52-150.1-241.26-242.63c-58.94,182.32-19.19,353.67-19.19,353.67l-64.43-13.25s-48.21-215.22,47.75-429.06c260.73,126.11,315.52,267.54,315.52,267.54Z"/>
              </svg>
            )}
          </button>
          <div className={`status-dot ${vpnEnabled ? 'active' : ''}`} aria-hidden="true" />
        </div>

        <div className="hero-meta">
          <div>
            <h1 className="hero-title">{displayInfo.proxyName}</h1>
            <p className={`hero-subtitle ${vpnEnabled ? '' : 'disconnected'} ${error ? 'error' : ''}`}>
              {subtitle}
            </p>
          </div>

          <div className={`meta-list collapsible ${vpnEnabled ? 'open animate-fadeIn' : ''}`}>
            <div className="meta-row">
              <span className="meta-label">{t.home.server}:</span>
              <span className="meta-value ip">{displayInfo.serverName}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">Port:</span>
              <span className="meta-value">{displayInfo.port}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">{t.home.latency}:</span>
              <span className="meta-value accent">
                {latency !== null ? `${latency}ms` : 'N/A'}
              </span>
            </div>
            <div className="meta-row">
              <span className="meta-label">{t.home.uptime}:</span>
              <span className="meta-value">{uptime}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">{t.home.upload}:</span>
              <span className="meta-value muted">{trafficUp}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">{t.home.download}:</span>
              <span className="meta-value muted">{trafficDown}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default memo(HomePage);