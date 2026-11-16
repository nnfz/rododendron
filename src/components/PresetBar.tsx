import { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { RULE_TEMPLATES, type RulePreset } from '../utils/rulePresets';
import CustomSelect from './CustomSelect';

interface PresetBarProps {
  presets: RulePreset[];
  activePresetId: string;
  canDelete: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddTemplate: (templateId: string) => void;
}

const TEMPLATE_LABEL = {
  browsers: 'templateBrowsers',
  messengers: 'templateMessengers',
  launchers: 'templateLaunchers',
} as const;

function PresetBar({
  presets,
  activePresetId,
  canDelete,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onAddTemplate,
}: PresetBarProps) {
  const { t } = useI18n();
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const templatesRef = useRef<HTMLDivElement | null>(null);
  const active = presets.find(preset => preset.id === activePresetId);

  useEffect(() => {
    setDeleteArmed(false);
    setRenaming(false);
  }, [activePresetId]);

  useEffect(() => {
    if (!deleteArmed) return;
    const timer = window.setTimeout(() => setDeleteArmed(false), 2500);
    return () => window.clearTimeout(timer);
  }, [deleteArmed]);

  useEffect(() => {
    if (!templatesOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (templatesRef.current?.contains(event.target as Node)) return;
      setTemplatesOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTemplatesOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [templatesOpen]);

  const commitRename = () => {
    const next = renameDraft.trim();
    if (next && active && next !== active.name) onRename(next);
    setRenaming(false);
  };

  return (
    <div className="panel">
      <div className="rules-preset-panel">
        <div>
          <div className="setting-label">{t.rules.preset}</div>
          <div className="rules-preset-help">{t.rules.presetsHelp}</div>
        </div>
        <div className="rules-preset-controls">
          {renaming ? (
            <input
              type="text"
              className="input rules-preset-name"
              value={renameDraft}
              aria-label={t.rules.presetName}
              autoFocus
              onChange={event => setRenameDraft(event.target.value)}
              onBlur={commitRename}
              onKeyDown={event => {
                if (event.key === 'Enter') commitRename();
                if (event.key === 'Escape') setRenaming(false);
              }}
            />
          ) : (
            <CustomSelect
              value={activePresetId}
              onChange={onSelect}
              options={presets.map(preset => ({ value: preset.id, label: preset.name }))}
              className="rules-preset-select"
            />
          )}
          <button type="button" className="btn btn-ghost-dark" onClick={onCreate}>{t.rules.newPreset}</button>
          <button
            type="button"
            className="btn btn-ghost-dark"
            onClick={() => {
              setRenameDraft(active?.name ?? '');
              setRenaming(true);
            }}
          >
            {t.rules.renamePreset}
          </button>
          <button
            type="button"
            className={`btn btn-ghost-dark${deleteArmed ? ' btn-confirm-delete' : ''}`}
            disabled={!canDelete}
            onClick={() => {
              if (!canDelete) return;
              if (!deleteArmed) {
                setDeleteArmed(true);
                return;
              }
              setDeleteArmed(false);
              onDelete();
            }}
          >
            {deleteArmed ? t.rules.confirmDeletePreset : t.rules.deletePreset}
          </button>
          <div className="preset-menu" ref={templatesRef}>
            <button type="button" className="btn btn-ghost-dark" onClick={() => setTemplatesOpen(open => !open)}>
              {t.rules.templates}
            </button>
            {templatesOpen ? (
              <div className="preset-menu-popover" role="menu">
                {RULE_TEMPLATES.map(template => {
                  const labelKey = TEMPLATE_LABEL[template.id as keyof typeof TEMPLATE_LABEL];
                  return (
                    <button
                      key={template.id}
                      type="button"
                      className="preset-menu-item"
                      role="menuitem"
                      onClick={() => {
                        setTemplatesOpen(false);
                        onAddTemplate(template.id);
                      }}
                    >
                      {t.rules[labelKey]}
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

export default PresetBar;
