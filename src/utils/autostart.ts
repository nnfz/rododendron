import { isTauri } from './isTauri';
import { invoke } from '@tauri-apps/api/core';

export async function isAutostartEnabled(): Promise<boolean> {
  try {
    // Проверяем Task Scheduler (для Windows с правами админа)
    const taskSchedulerEnabled = await invoke<boolean>('is_task_scheduler_enabled');
    console.log('[Autostart] Task Scheduler state:', taskSchedulerEnabled);
    return taskSchedulerEnabled;
  } catch (error) {
    console.error('[Autostart] Failed to check Task Scheduler:', error);

    // Fallback на стандартный плагин
    try {
      const { isEnabled } = await import('@tauri-apps/plugin-autostart');
      const enabled = await isEnabled();
      console.log('[Autostart] Plugin state:', enabled);
      return enabled;
    } catch (pluginError) {
      console.error('[Autostart] Failed to check plugin state:', pluginError);
      return false;
    }
  }
}

export async function enableAutostart(): Promise<void> {
  try {
    // Используем Task Scheduler для запуска с правами админа
    await invoke('enable_task_scheduler');
    console.log('[Autostart] Enabled via Task Scheduler');
  } catch (error) {
    console.error('[Autostart] Failed to enable via Task Scheduler:', error);

    // Fallback на стандартный плагин
    try {
      const { enable } = await import('@tauri-apps/plugin-autostart');
      await enable();
      console.log('[Autostart] Enabled via plugin (fallback)');
    } catch (pluginError) {
      console.error('[Autostart] Failed to enable via plugin:', pluginError);
      throw pluginError;
    }
  }
}

export async function disableAutostart(): Promise<void> {
  try {
    // Отключаем Task Scheduler
    await invoke('disable_task_scheduler');
    console.log('[Autostart] Disabled via Task Scheduler');
  } catch (error) {
    console.error('[Autostart] Failed to disable via Task Scheduler:', error);
  }

  // Также отключаем стандартный плагин на всякий случай
  try {
    const { disable } = await import('@tauri-apps/plugin-autostart');
    await disable();
    console.log('[Autostart] Disabled via plugin');
  } catch (pluginError) {
    console.error('[Autostart] Failed to disable via plugin:', pluginError);
  }
}

export async function syncAutostart(desired: boolean): Promise<void> {
  if (!isTauri()) return;

  console.log('[Autostart] Syncing autostart, desired:', desired);
  const enabled = await isAutostartEnabled();
  if (desired && !enabled) {
    console.log('[Autostart] Enabling autostart');
    await enableAutostart();
  } else if (!desired && enabled) {
    console.log('[Autostart] Disabling autostart');
    await disableAutostart();
  } else {
    console.log('[Autostart] Already in desired state');
  }
}
