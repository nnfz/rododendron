import { useCallback, useEffect, useState } from 'react';
import { LuMinus, LuSquare, LuX } from 'react-icons/lu';
import { useI18n } from '../i18n';

export default function Titlebar() {
  const { t } = useI18n();
  const [appWindow, setAppWindow] = useState<Awaited<ReturnType<typeof import('@tauri-apps/api/window').getCurrentWindow>> | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && '__TAURI__' in window) {
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
    await appWindow?.close();
  }, [appWindow]);

  return (
    <div data-tauri-drag-region className="titlebar">
      <div className="titlebar-title" data-tauri-drag-region>Rododendron</div>
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
