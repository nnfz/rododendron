import { memo, useCallback, useEffect, useState, type KeyboardEvent } from 'react';
import { LuSave, LuX } from 'react-icons/lu';
import { useI18n } from '../i18n';
import type { ParsedConfig } from '../types';
import { isTauri } from '../utils/isTauri';

interface ConfigEditorModalProps {
  open: boolean;
  onClose: () => void;
  configName: string;
  filename: string;
  onSaved: (content: string, parsed: ParsedConfig) => void;
  vpnEnabled: boolean;
  onNeedsRestart: () => void;
}

function ConfigEditorModal({
  open,
  onClose,
  configName,
  filename,
  onSaved,
  vpnEnabled,
  onNeedsRestart,
}: ConfigEditorModalProps) {
  const { t } = useI18n();
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (!open || !filename || !isTauri()) return;
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);
      setContent('');
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const next = await invoke<string>('read_config', { filename });
        if (!cancelled) setContent(next);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, [open, filename]);

  const handleSave = useCallback(async () => {
    if (!filename || !isTauri() || isLoading) return;

    setIsSaving(true);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const parsed = await invoke<ParsedConfig>('parse_config', { configContent: content });
      await invoke('import_config', {
        configContent: content,
        filename,
        applyDefaults: false,
      });
      onSaved(content, parsed);
      if (vpnEnabled) onNeedsRestart();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSaving(false);
    }
  }, [content, filename, isLoading, onClose, onNeedsRestart, onSaved, vpnEnabled]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key !== 'Tab') return;
      event.preventDefault();
      const el = event.currentTarget;
      const start = el.selectionStart;
      const end = el.selectionEnd;
      const next = `${content.slice(0, start)}  ${content.slice(end)}`;
      setContent(next);
      requestAnimationFrame(() => {
        el.selectionStart = start + 2;
        el.selectionEnd = start + 2;
      });
    },
    [content],
  );

  if (!open) return null;

  return (
    <div
      className="modal-backdrop animate-fadeIn"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="modal config-editor-modal animate-scaleIn"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header config-editor-header">
          <h3 className="modal-title config-editor-title">
            {t.settings.editConfig}
            <span className="config-editor-subtitle">{configName}</span>
          </h3>
          <div className="modal-actions">
            <button
              type="button"
              onClick={() => void handleSave()}
              className="btn btn-primary-dark"
              disabled={isSaving || isLoading}
            >
              <LuSave size={16} />
              <span>{t.common.save}</span>
            </button>
            <button type="button" onClick={onClose} className="btn btn-icon" aria-label={t.common.close}>
              <LuX size={20} />
            </button>
          </div>
        </div>

        <div className="modal-body config-editor-body">
          {error && <div className="config-editor-error">{error}</div>}
          {isLoading ? (
            <div className="config-editor-loading">{t.settings.configEditor.loading}</div>
          ) : (
            <textarea
              className="config-editor-text"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              wrap="off"
              disabled={isSaving}
              aria-label={configName}
            />
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(ConfigEditorModal);
