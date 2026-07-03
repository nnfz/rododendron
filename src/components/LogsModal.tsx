import { memo, useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { LuDownload, LuX, LuLoader2, LuTrash2} from 'react-icons/lu';
import { useI18n } from '../i18n';
import CustomSelect from './CustomSelect';
import type { Log, LogLevel } from '../types';
import type { Dispatch, SetStateAction } from 'react';
import { isTauri } from '../utils/isTauri';

interface LogsModalProps {
  showLogsModal: boolean;
  setShowLogsModal: (show: boolean) => void;
  logs: Log[];
  setLogs: Dispatch<SetStateAction<Log[]>>;
  vpnEnabled: boolean;
}

const LOG_LEVEL_CLASSES: Record<LogLevel, string> = {
  ERROR: 'error',
  WARNING: 'warn',
  DEBUG: 'debug',
  INFO: 'info',
};

const LOG_LEVEL_OPTIONS = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'error', label: 'Error' },
];

interface MihomoLog {
  time: string;
  level: string;
  message: string;
}

function LogsModal({ 
  showLogsModal, 
  setShowLogsModal, 
  logs, 
  setLogs,
  vpnEnabled 
}: LogsModalProps) {
  const { t } = useI18n();
  const [logFilterLevel, setLogFilterLevel] = useState('info');
  const [isExporting, setIsExporting] = useState(false);
  const [mihomoLogs, setMihomoLogs] = useState<MihomoLog[]>([]);
  const [query, setQuery] = useState('');
  const mihomoIdCounterRef = useRef<number>(Date.now());
  const mihomoIdByKeyRef = useRef<Map<string, number>>(new Map());

  const loadMihomoLogs = useCallback(async () => {
    if (!isTauri() || !vpnEnabled) return;
    
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const logs = await invoke('get_mihomo_logs') as MihomoLog[];
      setMihomoLogs(logs);
    } catch (e) {
      console.error('Failed to load mihomo logs:', e);
    }
  }, [vpnEnabled]);

  useEffect(() => {
    if (showLogsModal) {
      loadMihomoLogs();
    }
  }, [showLogsModal, loadMihomoLogs]);

  useEffect(() => {
    if (!showLogsModal || !vpnEnabled) return;
    
    const interval = setInterval(() => {
      loadMihomoLogs();
    }, 2000);

    return () => clearInterval(interval);
  }, [showLogsModal, vpnEnabled, loadMihomoLogs]);

  const normalizeLogLevel = (level: string): LogLevel => {
    const match = level.match(/(?:LEVEL=|level=)?(.+)/i);
    const extractedLevel = match ? match[1] : level;

    switch (extractedLevel.toUpperCase()) {
      case 'ERROR':
      case 'ERR':
        return 'ERROR';
      case 'WARNING':
      case 'WARN':
        return 'WARNING';
      case 'INFO':
        return 'INFO';
      case 'DEBUG':
      case 'DBG':
        return 'DEBUG';
      default:
        return 'INFO';
    }
  };

  const levelRank = (level: LogLevel): number => {
    switch (level) {
      case 'DEBUG':
        return 10;
      case 'INFO':
        return 20;
      case 'WARNING':
        return 30;
      case 'ERROR':
        return 40;
      default:
        return 20;
    }
  };

  const minLevelRank = useMemo(() => {
    const v = (logFilterLevel || 'info').toLowerCase();
    switch (v) {
      case 'debug':
        return levelRank('DEBUG');
      case 'info':
        return levelRank('INFO');
      case 'warning':
        return levelRank('WARNING');
      case 'error':
        return levelRank('ERROR');
      default:
        return levelRank('INFO');
    }
  }, [logFilterLevel]);

  // Объединяем все логи и сортируем по ID в ОБРАТНОМ порядке (новые сверху)
  const allLogs = useMemo(() => {
    const mihomoMapped: Log[] = [];
    for (const log of [...mihomoLogs].slice().reverse()) {
      const time = log.time.split('T')[1]?.split('.')[0] || log.time;
      const level = normalizeLogLevel(log.level);
      const message = `[mihomo] ${log.message}`;
      const key = `${time}|${level}|${message}`;
      let id = mihomoIdByKeyRef.current.get(key);
      if (!id) {
        const next = Math.max(Date.now(), mihomoIdCounterRef.current + 1);
        mihomoIdCounterRef.current = next;
        id = next;
        mihomoIdByKeyRef.current.set(key, id);
      }

      mihomoMapped.push({
        id,
        time,
        level,
        message,
      });
    }

    const merged = [...logs, ...mihomoMapped];
    const seen = new Set<string>();
    const deduped: Log[] = [];
    for (const l of merged) {
      const key = `${l.time}|${l.level}|${l.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(l);
    }

    return deduped.sort((a, b) => b.id - a.id);
  }, [logs, mihomoLogs]);

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return allLogs.filter((l) => {
      if (levelRank(l.level) < minLevelRank) return false;
      if (!q) return true;
      return l.message.toLowerCase().includes(q);
    });
  }, [allLogs, minLevelRank, query]);

  const clearLogs = useCallback(async () => {
    setLogs([]);
    setMihomoLogs([]);
    setQuery('');
    mihomoIdByKeyRef.current.clear();
    mihomoIdCounterRef.current = Date.now();

    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('clear_mihomo_logs');
    } catch (e) {
      console.error('Failed to clear mihomo logs:', e);
    }
  }, [setLogs]);

  const exportLogs = useCallback(async () => {
    const logsForExport = [...filteredLogs].sort((a, b) => a.id - b.id);
    const logText = logsForExport.map(log => `[${log.time}] ${log.level}: ${log.message}`).join('\n');
    const defaultName = `vpn-logs-${new Date().toISOString().split('T')[0]}.txt`;

    if (isTauri()) {
      setIsExporting(true);
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { writeTextFile } = await import('@tauri-apps/plugin-fs');
        
        const filePath = await save({
          defaultPath: defaultName,
          filters: [{ name: 'Text Files', extensions: ['txt', 'log'] }],
        });

        if (!filePath) return;

        await writeTextFile(
          filePath,
          logText,
          {
            baseDir: undefined,
          }
        );
      } catch (err) {
        console.error('Failed to export logs:', err);
      } finally {
        setIsExporting(false);
      }
    } else {
      const blob = new Blob([logText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = defaultName;
      a.click();
      URL.revokeObjectURL(url);
    }
  }, [filteredLogs]);

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
                value={logFilterLevel} 
                onChange={val => setLogFilterLevel(val)} 
                options={LOG_LEVEL_OPTIONS}
                className="input-logs"
              />
            </div>
            <input
              className="input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter logs..."
              style={{ width: '10rem' }}
            />
            <button onClick={clearLogs} className="btn btn-secondary-dark" disabled={isExporting}>
              <LuTrash2 size={16}/>
              {t.logs.clear}
            </button>
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
          {filteredLogs.length === 0 && (
            <div style={{ textAlign: 'center', padding: '20px', color: '#666' }}>
              No logs yet
            </div>
          )}
          {filteredLogs.map(log => (
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

export default memo(LogsModal);