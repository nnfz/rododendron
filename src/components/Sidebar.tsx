import { LuPower, LuShield, LuSettings } from 'react-icons/lu';
import { useI18n } from '../i18n';
import type { TabType } from '../types';

interface SidebarProps {
  activeTab: TabType;
  setActiveTab: (tab: TabType) => void;
  vpnEnabled: boolean;
}

export default function Sidebar({ activeTab, setActiveTab, vpnEnabled }: SidebarProps) {
  const { t } = useI18n();

  return (
    <div className="sidebar">
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
