import { useEffect, useRef, useState } from 'react';
import { LuPencil, LuPlus, LuTrash2 } from 'react-icons/lu';
import { useI18n } from '../i18n';
import { RULE_TEMPLATES, type RulePreset } from '../utils/rulePresets';
import CustomSelect, { type SelectOption } from './CustomSelect';

interface PresetBarProps {
  presets: RulePreset[];
  activePresetId: string;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

const TEMPLATE_LABEL = {
  browsers: 'templateBrowsers',
  messengers: 'templateMessengers',
  launchers: 'templateLaunchers',
} as const;

function PresetBar({
  presets,
  activePresetId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
}: PresetBarProps) {
  const { t } = useI18n();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteArmedId, setDeleteArmedId] = useState<string | null>(null);
  const canDelete = presets.length > 1;

  useEffect(() => {
    setDeleteArmedId(null);
    setRenamingId(null);
  }, [activePresetId]);

  useEffect(() => {
    if (!deleteArmedId) return;
    const timer = window.setTimeout(() => setDeleteArmedId(null), 2500);
    return () => window.clearTimeout(timer);
  }, [deleteArmedId]);

  const commitRename = () => {
    const next = renameDraft.trim();
    const current = presets.find(preset => preset.id === renamingId);
    if (renamingId && next && current && next !== current.name) onRename(renamingId, next);
    setRenamingId(null);
  };

  const options: SelectOption[] = presets.map(preset => {
    const armed = deleteArmedId === preset.id;
    return {
      value: preset.id,
      label: preset.name,
      trailing: [
        {
          key: 'edit',
          label: t.rules.renamePreset,
          icon: <LuPencil size={14} />,
          onClick: () => {
            setDeleteArmedId(null);
            setRenameDraft(preset.name);
            setRenamingId(preset.id);
          },
        },
        {
          key: 'delete',
          label: armed ? t.rules.confirmDeletePreset : t.rules.deletePreset,
          icon: <LuTrash2 size={14} />,
          disabled: !canDelete,
          danger: armed,
          keepOpen: !armed,
          onClick: () => {
            if (!canDelete) return;
            if (!armed) {
              setDeleteArmedId(preset.id);
              return;
            }
            setDeleteArmedId(null);
            onDelete(preset.id);
          },
        },
      ],
    };
  });

  return (
    <>
      {renamingId ? (
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
            if (event.key === 'Escape') setRenamingId(null);
          }}
        />
      ) : (
        <CustomSelect
          value={activePresetId}
          onChange={onSelect}
          options={options}
          className="rules-preset-select"
          onOpenChange={open => {
            if (!open) setDeleteArmedId(null);
          }}
        />
      )}
      <button type="button" className="btn btn-ghost-dark rules-header-add" onClick={onCreate} aria-label={t.rules.newPreset} title={t.rules.newPreset}>
        <LuPlus size={18} />
      </button>
    </>
  );
}

export function RuleTemplatesMenu({ onAddTemplate }: { onAddTemplate: (templateId: string) => void }) {
  const { t } = useI18n();
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const templatesRef = useRef<HTMLDivElement | null>(null);

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

  return (
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
  );
}

export default PresetBar;
