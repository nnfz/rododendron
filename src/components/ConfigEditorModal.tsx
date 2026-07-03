import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { LuExternalLink, LuHelpCircle, LuPlus, LuSave, LuX } from 'react-icons/lu';
import CustomSelect from './CustomSelect';
import { useI18n } from '../i18n';
import type { ParsedConfig } from '../types';
import { isTauri } from '../utils/isTauri';
import {
  CONFIG_SECTIONS,
  buildConfigFromEditorState,
  createEmptyCustomField,
  formatFieldLabel,
  parseConfigEditorState,
  type ConfigEditorState,
  type ConfigFieldSection,
  type ConfigFieldState,
} from '../utils/configEditor';

interface ConfigEditorModalProps {
  open: boolean;
  onClose: () => void;
  configName: string;
  filename: string;
  onSaved: (content: string, parsed: ParsedConfig) => void;
  vpnEnabled: boolean;
  onNeedsRestart: () => void;
}

const MTU_MIN = 1280;
const MTU_MAX = 1500;

function StringListEditor({
  value,
  onChange,
  placeholder,
  addLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
  addLabel: string;
}) {
  const [draft, setDraft] = useState('');

  const addItem = useCallback(() => {
    const val = draft.trim();
    if (!val || value.includes(val)) return;
    onChange([...value, val]);
    setDraft('');
  }, [draft, onChange, value]);

  return (
    <div className="config-field-list-editor">
      <div className="fake-ip-filter-list">
        {value.map((item, idx) => (
          <div key={`${item}-${idx}`} className="fake-ip-filter-item">
            <span className="fake-ip-filter-text">{item}</span>
            <button
              type="button"
              className="fake-ip-filter-remove"
              onClick={() => onChange(value.filter((_, i) => i !== idx))}
              aria-label="Remove"
            >
              <LuX size={14} />
            </button>
          </div>
        ))}
      </div>
      <div className="fake-ip-filter-add-row">
        <input
          type="text"
          className="input fake-ip-filter-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addItem();
            }
          }}
          placeholder={placeholder}
        />
        <button type="button" className="btn btn-ghost-dark fake-ip-filter-add-btn" onClick={addItem}>
          <LuPlus size={16} />
          <span>{addLabel}</span>
        </button>
      </div>
    </div>
  );
}

function ConfigFieldRow({
  field,
  onChange,
  helpText,
  listPlaceholder,
  listAddLabel,
}: {
  field: ConfigFieldState;
  onChange: (next: ConfigFieldState) => void;
  helpText?: string;
  listPlaceholder: string;
  listAddLabel: string;
}) {
  const label = formatFieldLabel(field.path);

  const control = (() => {
    if (field.type === 'boolean') {
      return (
        <button
          type="button"
          className={`toggle ${field.value ? 'on' : ''}`}
          onClick={() => onChange({ ...field, value: !field.value })}
          role="switch"
          aria-checked={Boolean(field.value)}
        >
          <div className="toggle-knob" />
        </button>
      );
    }

    if (field.type === 'select' && field.options?.length) {
      return (
        <CustomSelect
          value={String(field.value || field.options[0])}
          onChange={(value) => onChange({ ...field, value })}
          options={field.options.map((opt) => ({ value: opt, label: opt }))}
        />
      );
    }

    if (field.type === 'string-list') {
      return (
        <StringListEditor
          value={Array.isArray(field.value) ? field.value : []}
          onChange={(next) => onChange({ ...field, value: next })}
          placeholder={listPlaceholder}
          addLabel={listAddLabel}
        />
      );
    }

    return (
      <input
        type={field.type === 'number' ? 'text' : 'text'}
        inputMode={field.type === 'number' ? 'numeric' : 'text'}
        className="input config-field-input"
        value={String(field.value ?? '')}
        onChange={(e) => onChange({ ...field, value: e.target.value })}
        placeholder={field.path === 'tun.mtu' ? `${MTU_MIN}–${MTU_MAX}` : undefined}
      />
    );
  })();

  return (
    <div className={`config-field-row ${field.type === 'string-list' ? 'is-multiline' : ''}`}>
      <span className="setting-label setting-label-with-help">
        {field.custom ? (
          <input
            type="text"
            className="input config-custom-key-input"
            value={field.path}
            onChange={(e) => onChange({ ...field, path: e.target.value })}
            placeholder="parameter-name"
          />
        ) : (
          label
        )}
        {helpText ? (
          <button type="button" className="help-tooltip" onClick={(e) => e.stopPropagation()}>
            <LuHelpCircle size={14} className="help-icon" />
            <span className="help-tooltip-content">{helpText}</span>
          </button>
        ) : null}
      </span>
      <div className="config-field-control">{control}</div>
    </div>
  );
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
  const [baseContent, setBaseContent] = useState('');
  const [editorState, setEditorState] = useState<ConfigEditorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const sectionTitle = useCallback(
    (section: ConfigFieldSection | 'custom') => {
      const map = t.settings.configEditor.sections;
      return map[section];
    },
    [t.settings.configEditor.sections],
  );

  const fieldHelp = useCallback(
    (path: string) => {
      const help = t.settings.configEditor.fieldHelp as Record<string, string | undefined>;
      return help[path];
    },
    [t.settings.configEditor.fieldHelp],
  );

  useEffect(() => {
    if (!open || !filename || !isTauri()) return;
    let cancelled = false;

    const load = async () => {
      setIsLoading(true);
      setError(null);
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const content = await invoke<string>('read_config', { filename });
        if (cancelled) return;
        const state = await parseConfigEditorState(content);
        if (cancelled) return;
        setBaseContent(content);
        setEditorState(state);
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

  const fieldsBySection = useMemo(() => {
    if (!editorState) return new Map<ConfigFieldSection, ConfigFieldState[]>();
    const map = new Map<ConfigFieldSection, ConfigFieldState[]>();
    for (const section of CONFIG_SECTIONS) {
      map.set(
        section,
        editorState.fields.filter((field) => field.section === section),
      );
    }
    return map;
  }, [editorState]);

  const updateField = useCallback((path: string, next: ConfigFieldState, custom = false) => {
    setEditorState((prev) => {
      if (!prev) return prev;
      if (custom) {
        return {
          ...prev,
          customFields: prev.customFields.map((field) => (field.path === path ? next : field)),
        };
      }
      return {
        ...prev,
        fields: prev.fields.map((field) => (field.path === path ? next : field)),
      };
    });
  }, []);

  const addCustomField = useCallback(() => {
    setEditorState((prev) => {
      if (!prev) return prev;
      return { ...prev, customFields: [...prev.customFields, createEmptyCustomField()] };
    });
  }, []);

  const removeCustomField = useCallback((index: number) => {
    setEditorState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        customFields: prev.customFields.filter((_, i) => i !== index),
      };
    });
  }, []);

  const handleOpenFile = useCallback(async () => {
    if (!isTauri()) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const path = await invoke<string | null>('resolve_config_path', { filename });
      if (!path) {
        setError(t.settings.configEditor.fileNotFound);
        return;
      }
      const { openPath } = await import('@tauri-apps/plugin-opener');
      await openPath(path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [filename, t.settings.configEditor.fileNotFound]);

  const handleSave = useCallback(async () => {
    if (!editorState || !filename || !isTauri()) return;

    const mtuField = editorState.fields.find((field) => field.path === 'tun.mtu');
    if (mtuField && mtuField.type === 'number') {
      const raw = String(mtuField.value ?? '').trim();
      if (raw) {
        const num = Number(raw);
        if (!Number.isFinite(num) || num < MTU_MIN || num > MTU_MAX) {
          setError(t.settings.mtuHelp);
          return;
        }
      }
    }

    setIsSaving(true);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const nextContent = await buildConfigFromEditorState(baseContent, editorState);
      const parsed = await invoke<ParsedConfig>('parse_config', { configContent: nextContent });
      await invoke('import_config', { configContent: nextContent, filename });
      onSaved(nextContent, parsed);
      onClose();
      if (vpnEnabled) onNeedsRestart();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSaving(false);
    }
  }, [
    baseContent,
    editorState,
    filename,
    onClose,
    onNeedsRestart,
    onSaved,
    t.settings.mtuHelp,
    vpnEnabled,
  ]);

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
          <button
            type="button"
            className="btn btn-ghost-dark config-editor-open-file"
            onClick={() => void handleOpenFile()}
            title={t.settings.configEditor.openFile}
          >
            <LuExternalLink size={16} />
          </button>
          <h3 className="modal-title config-editor-title">
            {t.settings.editConfig}
            <span className="config-editor-subtitle">{configName}</span>
          </h3>
          <div className="modal-actions">
            <button
              type="button"
              onClick={() => void handleSave()}
              className="btn btn-primary-dark"
              disabled={isSaving || isLoading || !editorState}
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
          {isLoading && <div className="config-editor-loading">{t.settings.configEditor.loading}</div>}
          {!isLoading && editorState && (
            <div className="config-editor-sections">
              {CONFIG_SECTIONS.map((section) => {
                const fields = fieldsBySection.get(section) ?? [];
                if (!fields.length) return null;
                return (
                  <section key={section} className="config-editor-section">
                    <h4 className="config-editor-section-title">{sectionTitle(section)}</h4>
                    <div className="panel config-editor-panel">
                      {fields.map((field) => (
                        <ConfigFieldRow
                          key={field.path}
                          field={field}
                          helpText={fieldHelp(field.path)}
                          listPlaceholder={t.settings.fakeIpFilterPlaceholder}
                          listAddLabel={t.settings.fakeIpFilterAdd}
                          onChange={(next) => updateField(field.path, next)}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}

              <section className="config-editor-section">
                <div className="config-editor-section-head">
                  <h4 className="config-editor-section-title">{sectionTitle('custom')}</h4>
                  <button type="button" className="btn btn-ghost-dark" onClick={addCustomField}>
                    <LuPlus size={16} />
                    <span>{t.settings.configEditor.addField}</span>
                  </button>
                </div>
                <div className="panel config-editor-panel">
                  {editorState.customFields.length === 0 ? (
                    <div className="config-editor-empty">{t.settings.configEditor.noCustomFields}</div>
                  ) : (
                    editorState.customFields.map((field, index) => (
                      <div key={`custom-${index}`} className="config-custom-field-wrap">
                        <ConfigFieldRow
                          field={field}
                          listPlaceholder={t.settings.fakeIpFilterPlaceholder}
                          listAddLabel={t.settings.fakeIpFilterAdd}
                          onChange={(next) =>
                            setEditorState((prev) => {
                              if (!prev) return prev;
                              const customFields = [...prev.customFields];
                              customFields[index] = next;
                              return { ...prev, customFields };
                            })
                          }
                        />
                        <button
                          type="button"
                          className="config-custom-field-remove"
                          onClick={() => removeCustomField(index)}
                          aria-label={t.common.delete}
                        >
                          <LuX size={14} />
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(ConfigEditorModal);