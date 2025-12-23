import { useCallback, useState } from 'react';
import { LuDownload, LuX, LuLoader2 } from 'react-icons/lu';
import { useI18n } from '../i18n';
import CustomSelect from './CustomSelect';
import type { Log, LogLevel, Settings } from '../types';
import type { Dispatch, SetStateAction } from 'react';

interface LogsModalProps {
  showLogsModal: boolean;
  setShowLogsModal: (show: boolean) => void;
  logs: Log[];
  settings: Settings;
  setSettings: Dispatch<SetStateAction<Settings>>;
}

const LOG_LEVEL_CLASSES: Record<LogLevel, string> = {
  ERROR: 'error',
  WARN: 'warn',
  DEBUG: 'debug',
  INFO: 'info',
};

const LOG_LEVEL_OPTIONS = [
  { value: 'Debug', label: 'Debug' },
  { value: 'Info', label: 'Info' },
  { value: 'Warning', label: 'Warning' },
  { value: 'Error', label: 'Error' },
];

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

export default function LogsModal({ showLogsModal, setShowLogsModal, logs, settings, setSettings }: LogsModalProps) {
  const { t } = useI18n();
  const [isExporting, setIsExporting] = useState(false);

  const exportLogs = useCallback(async () => {
    const logText = logs.map(log => `[${log.time}] ${log.level}: ${log.message}`).join('\n');
    const defaultName = `vpn-logs-${new Date().toISOString().split('T')[0]}.txt`;

    if (isTauri) {
      setIsExporting(true);
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        
        const filePath = await save({
          defaultPath: defaultName,
          filters: [{ name: 'Text Files', extensions: ['txt', 'log'] }],
        });

        if (filePath) {
          await writeTextFile(filePath, logText);
        }
      } catch (err) {
        console.error('Failed to export logs:', err);
      } finally {
        setIsExporting(false);
      }
    } else {
      // Fallback for browser
      const blob = new Blob([logText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [logs]);

  if (!showLogsModal) return null;

  return (
    <div className="modal-backdrop animate-fadeIn" onClick={() => setShowLogsModal(false)} role="dialog" aria-modal="true">
      <div className="modal animate-scaleIn" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h3 className="modal-title">{t.logs.title}</h3>
          <div className="modal-actions">
            <div className="log-level-select">
              <span className="log-level-label">{t.settings.logLevel}:</span>
              <CustomSelect 
                value={settings.logLevel} 
                onChange={val => setSettings(prev => ({ ...prev, logLevel: val }))} 
                options={LOG_LEVEL_OPTIONS} 
              />
            </div>
            <button onClick={exportLogs} className="btn btn-primary-dark" disabled={isExporting}>
              {isExporting ? <LuLoader2 size={16} className="spin" /> : <LuDownload size={16} />}
              {t.logs.export}
            </button>
            <button onClick={() => setShowLogsModal(false)} className="btn btn-icon" aria-label={t.common.close}>
              <LuX size={20} />
            </button>
          </div>
        </div>
        <div className="modal-body">
          {logs.map(log => (
            <div key={log.id} className="log-row">
              <span className="log-time">[{log.time}]</span>
              <span className={`log-level ${LOG_LEVEL_CLASSES[log.level]}`}>{log.level}</span>
              <span className="log-message">{log.message}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
