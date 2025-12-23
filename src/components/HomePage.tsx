import { useState, useEffect, useRef, useCallback } from 'react';
import { LuShield, LuRefreshCcw, LuLoader2 } from 'react-icons/lu';
import { useI18n } from '../i18n';
import type { VpnStatus, ParsedConfig } from '../types';

interface HomePageProps {
  vpnEnabled: boolean;
  vpnStatus: VpnStatus | null;
  parsedConfig: ParsedConfig | null;
  isConnecting: boolean;
  error: string | null;
  toggleVPN: () => void;
  restartVPN: () => void;
  hasConfig: boolean;
}

export default function HomePage({ 
  vpnEnabled, 
  vpnStatus, 
  parsedConfig,
  isConnecting,
  error,
  toggleVPN, 
  restartVPN,
  hasConfig 
}: HomePageProps) {
  const { t } = useI18n();
  const [uptime, setUptime] = useState({ hours: 0, minutes: 0, seconds: 0 });
  const [traffic, setTraffic] = useState({ uploaded: 0, downloaded: 0 });
  const [latency, setLatency] = useState(0);
  const startTimeRef = useRef<number | null>(null);

  // Get display values from config or status
  const serverName = vpnStatus?.server || parsedConfig?.server_address || 'Not configured';
  const proxyName = vpnStatus?.proxy_name || parsedConfig?.proxy_name || 'Unknown';
  const port = vpnStatus?.port || parsedConfig?.mixed_port || 7890;

  useEffect(() => {
    if (!vpnEnabled) {
      setUptime({ hours: 0, minutes: 0, seconds: 0 });
      setTraffic({ uploaded: 0, downloaded: 0 });
      setLatency(0);
      startTimeRef.current = null;
      return;
    }
    startTimeRef.current = Date.now();
  }, [vpnEnabled]);

  useEffect(() => {
    if (!vpnEnabled || !startTimeRef.current) return;
    const interval = setInterval(() => {
      if (!startTimeRef.current) return;
      const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
      setUptime({
        hours: Math.floor(elapsed / 3600),
        minutes: Math.floor((elapsed % 3600) / 60),
        seconds: elapsed % 60,
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [vpnEnabled]);

  // TODO: Get real traffic from mihomo API
  useEffect(() => {
    if (!vpnEnabled) return;
    const interval = setInterval(() => {
      setTraffic(prev => ({
        uploaded: prev.uploaded + Math.random() * 0.5,
        downloaded: prev.downloaded + Math.random() * 2,
      }));
      setLatency(Math.floor(20 + Math.random() * 10));
    }, 1000);
    return () => clearInterval(interval);
  }, [vpnEnabled]);

  const formatUptime = useCallback(() => {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${pad(uptime.hours)}:${pad(uptime.minutes)}:${pad(uptime.seconds)}`;
  }, [uptime]);

  const formatTraffic = useCallback((bytes: number) => {
    if (bytes < 1024) return `${bytes.toFixed(1)} MB`;
    return `${(bytes / 1024).toFixed(2)} GB`;
  }, []);

  const handleClick = () => {
    if (!isConnecting) {
      toggleVPN();
    }
  };

  const getSubtitle = () => {
    if (error) return error;
    if (isConnecting) return 'Connecting...';
    if (vpnEnabled) return t.home.connectionEstablished;
    if (!hasConfig) return 'Import a config to connect';
    return t.home.notConnected;
  };

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
              <LuLoader2 size={80} className="spin" strokeWidth={1} />
            ) : (
              <LuShield size={100} className={vpnEnabled ? 'hero-icon-connected' : 'hero-icon-disconnected'} strokeWidth={1} />
            )}
          </button>
          <div className={`status-dot ${vpnEnabled ? 'active' : ''}`} aria-hidden="true" />
        </div>

        <div className="hero-meta">
          <div>
            <h1 className="hero-title">{proxyName}</h1>
            <p className={`hero-subtitle ${vpnEnabled ? '' : 'disconnected'} ${error ? 'error' : ''}`}>
              {getSubtitle()}
            </p>
          </div>

          <div className={`meta-list collapsible ${vpnEnabled ? 'open animate-fadeIn' : ''}`}>
            {/* Restart button at top */}
            <button className="btn btn-ghost-dark btn-restart" onClick={restartVPN}>
              <LuRefreshCcw size={16} />
              {t.home.restartvpn}
            </button>
            
            <div className="meta-row">
              <span className="meta-label">{t.home.server}:</span>
              <span className="meta-value">{serverName}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">Port:</span>
              <span className="meta-value">{port}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">{t.home.latency}:</span>
              <span className="meta-value accent">{latency}ms</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">{t.home.uptime}:</span>
              <span className="meta-value">{formatUptime()}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">{t.home.upload}:</span>
              <span className="meta-value muted">{formatTraffic(traffic.uploaded)}</span>
            </div>
            <div className="meta-row">
              <span className="meta-label">{t.home.download}:</span>
              <span className="meta-value muted">{formatTraffic(traffic.downloaded)}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}