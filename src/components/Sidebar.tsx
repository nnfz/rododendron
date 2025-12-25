import { LuPower, LuShield, LuSettings, LuRefreshCcw } from 'react-icons/lu';
import { useI18n } from '../i18n';
import type { TabType } from '../types';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  vpnEnabled: boolean;
  restartVPN: () => void;
  hasConfig: boolean;
  className?: string;
}

export default function Sidebar({ activeTab, setActiveTab, vpnEnabled, restartVPN, hasConfig, className }: SidebarProps) {
  const { t } = useI18n();

  const handleRestart = () => {
    if (vpnEnabled && hasConfig) {
      restartVPN();
    }
  };

  return (
    <div className={`sidebar ${className || ''}`.trim()}>
      <div className="sidebar-header">
        <h1 className="sidebar-title">{t.sidebar.title}</h1>
        <p className="sidebar-subtitle">{t.sidebar.subtitle}</p>
      </div>

      <nav className="sidebar-nav">
        <button
          onClick={() => setActiveTab('home')}
          className={`nav-button ${activeTab === 'home' ? 'active' : ''}`}
          aria-current={activeTab === 'home' ? 'page' : undefined}
        >
          <LuPower size={18} strokeWidth={1.5} />
          <span>{t.sidebar.home}</span>
        </button>

        <button
          onClick={() => setActiveTab('rules')}
          className={`nav-button ${activeTab === 'rules' ? 'active' : ''}`}
          aria-current={activeTab === 'rules' ? 'page' : undefined}
        >
          <LuShield size={18} strokeWidth={1.5} />
          <span>{t.sidebar.rules}</span>
        </button>

        <button
          onClick={() => setActiveTab('settings')}
          className={`nav-button ${activeTab === 'settings' ? 'active' : ''}`}
          aria-current={activeTab === 'settings' ? 'page' : undefined}
        >
          <LuSettings size={18} strokeWidth={1.5} />
          <span>{t.sidebar.settings}</span>
        </button>
      </nav>

      <div className="sidebar-footer">
        <button 
          className="btn btn-ghost-dark btn-restart" 
          onClick={handleRestart} 
          disabled={!vpnEnabled || !hasConfig}
        >
          <LuRefreshCcw size={16} />
          {t.home.restartvpn}
        </button>
        <div className="status-row">
          <span>{t.sidebar.status}:</span>
          <span className={`status ${vpnEnabled ? '' : 'disconnected'}`}>
            {vpnEnabled ? t.sidebar.connected : t.sidebar.disconnected}
          </span>
        </div>
      </div>
    </div>
  );
}