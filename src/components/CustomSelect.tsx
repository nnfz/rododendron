import { useState, useRef, useEffect, useCallback } from 'react';
import { LuChevronDown } from 'react-icons/lu';
import { useI18n } from '../i18n';

interface Option {
  value: string;
  label: string;
}

interface CustomSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  className?: string;
  style?: React.CSSProperties;
  disabled?: boolean;
}

export default function CustomSelect({ value, onChange, options, className = '', style, disabled = false }: CustomSelectProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedOption = options.find(opt => opt.value === value);
  const selectedIndex = options.findIndex(opt => opt.value === value);

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
        <span>{selectedOption?.label || (disabled ? t.select.none : '')}</span>
        <LuChevronDown size={14} className="custom-select-icon" style={{ transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)', transition: 'transform 0.2s' }} />
      </button>
      {isOpen && (
        <div className="custom-select-dropdown animate-slideDown" role="listbox" tabIndex={-1}>
          {options.map(option => (
            <button key={option.value} type="button" className={`custom-select-option ${value === option.value ? 'selected' : ''}`} onClick={() => handleSelect(option.value)} role="option" aria-selected={value === option.value}>
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
