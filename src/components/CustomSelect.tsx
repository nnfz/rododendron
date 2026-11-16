import { memo, useState, useRef, useEffect, useCallback, type ReactNode } from 'react';
import { LuChevronDown } from 'react-icons/lu';
import { useI18n } from '../i18n';

export interface SelectOptionTrailing {
  key: string;
  icon: ReactNode;
  label: string;
  disabled?: boolean;
  danger?: boolean;
  /** Keep the menu open after the click. Used for a confirm step. */
  keepOpen?: boolean;
  onClick?: () => void;
}

export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
  trailing?: SelectOptionTrailing[];
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}

function CustomSelect({ value, onChange, options, className = '', style, disabled = false, onOpenChange }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  const selectedOption = options.find(opt => opt.value === value);
  const selectedIndex = options.findIndex(opt => opt.value === value);

  useEffect(() => {
    onOpenChangeRef.current?.(isOpen);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.custom-select-option-action')) return;
      switch (event.key) {
        case 'Escape': setIsOpen(false); break;
        case 'ArrowDown':
          event.preventDefault();
          if (selectedIndex < options.length - 1) onChange(options[selectedIndex + 1].value);
          break;
        case 'ArrowUp':
          event.preventDefault();
          if (selectedIndex > 0) onChange(options[selectedIndex - 1].value);
          break;
        case 'Enter':
        case ' ':
          event.preventDefault();
          setIsOpen(false);
          break;
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, selectedIndex, options, onChange]);

  const handleSelect = useCallback((optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  }, [onChange]);

  return (
    <div className={`custom-select-container ${className}`} ref={containerRef} style={style}>
      <button
        type="button"
        className={`custom-select-trigger ${isOpen ? 'open' : ''} ${disabled ? 'disabled' : ''}`}
        onClick={() => !disabled && setIsOpen(prev => !prev)}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        disabled={disabled}
      >
        <span className="custom-select-trigger-label">
          {selectedOption?.icon ? <span className="custom-select-option-icon">{selectedOption.icon}</span> : null}
          <span>{selectedOption?.label || (disabled ? t.select.none : '')}</span>
        </span>
        <LuChevronDown size={14} className="custom-select-icon" style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
      </button>
      {isOpen && (
        <div className="custom-select-dropdown animate-slideDown" role="listbox" tabIndex={-1}>
          {options.map(option => (
            <div
              key={option.value}
              className={`custom-select-option ${value === option.value ? 'selected' : ''} ${option.trailing?.length ? 'has-trailing' : ''}`}
              role="option"
              aria-selected={value === option.value}
              onClick={() => handleSelect(option.value)}
            >
              <span className="custom-select-option-main">
                {option.icon ? <span className="custom-select-option-icon">{option.icon}</span> : null}
                <span className="custom-select-option-label">{option.label}</span>
              </span>
              {option.trailing?.length ? (
                <span className="custom-select-option-actions">
                  {option.trailing.map(item => item.onClick ? (
                    <button
                      key={item.key}
                      type="button"
                      className={`custom-select-option-action ${item.danger ? 'danger' : ''}`}
                      aria-label={item.label}
                      title={item.label}
                      disabled={item.disabled}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (item.disabled) return;
                        item.onClick?.();
                        if (!item.keepOpen) setIsOpen(false);
                      }}
                    >
                      {item.icon}
                    </button>
                  ) : (
                    <span key={item.key} className="custom-select-option-icon" title={item.label} aria-hidden="true">
                      {item.icon}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default memo(CustomSelect);
