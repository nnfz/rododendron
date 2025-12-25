import { memo, useCallback, useEffect, useState } from 'react';
import { LuMenu, LuMinus, LuSquare, LuX } from 'react-icons/lu';
import { useI18n } from '../i18n';
import { isTauri } from '../utils/isTauri';

interface TitlebarProps {
  showSidebarToggle?: boolean;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
  closeBehavior?: 'tray' | 'exit';
}

function Titlebar({ showSidebarToggle, sidebarOpen, onToggleSidebar, closeBehavior = 'tray' }: TitlebarProps) {
  const { t } = useI18n();
  const [appWindow, setAppWindow] = useState<Awaited<ReturnType<typeof import('@tauri-apps/api/window').getCurrentWindow>> | null>(null);

  useEffect(() => {
    if (isTauri()) {
      import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
        setAppWindow(getCurrentWindow());
      });
    }
  }, []);

  const handleMinimize = useCallback(async () => {
    await appWindow?.minimize();
  }, [appWindow]);

  const handleMaximize = useCallback(async () => {
    if (!appWindow) return;
    const isMaximized = await appWindow.isMaximized();
    isMaximized ? await appWindow.unmaximize() : await appWindow.maximize();
  }, [appWindow]);

  const handleClose = useCallback(async () => {
    if (!appWindow) return;
    if (closeBehavior === 'exit') {
      await appWindow.close();
      return;
    }
    await appWindow.hide();
  }, [appWindow, closeBehavior]);

  return (
    <div data-tauri-drag-region className="titlebar">
      <div className="titlebar-left">
        {showSidebarToggle && (
          <button
            type="button"
            className={`titlebar-btn sidebar-toggle ${sidebarOpen ? 'active' : ''}`}
            onClick={onToggleSidebar}
            aria-label="Toggle sidebar"
          >
            <LuMenu size={16} />
          </button>
        )}
      </div>
      <div className="titlebar-title">Rododendron</div>
      <div className="titlebar-controls">
        <button className="titlebar-btn" onClick={handleMinimize} aria-label={t.common.minimize}>
          <LuMinus size={14} />
        </button>
        <button className="titlebar-btn" onClick={handleMaximize} aria-label={t.common.maximize}>
          <LuSquare size={12} />
        </button>
        <button className="titlebar-btn close" onClick={handleClose} aria-label={t.common.close}>
          <LuX size={16} />
        </button>
      </div>
    </div>
  );
}

export default memo(Titlebar);
