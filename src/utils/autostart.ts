import { isTauri } from './isTauri';

export async function isAutostartEnabled(): Promise<boolean> {
  const { isEnabled } = await import('@tauri-apps/plugin-autostart');
  return isEnabled();
}

export async function enableAutostart(): Promise<void> {
  const { enable } = await import('@tauri-apps/plugin-autostart');
  await enable();
}

export async function disableAutostart(): Promise<void> {
  const { disable } = await import('@tauri-apps/plugin-autostart');
  await disable();
}

export async function syncAutostart(desired: boolean): Promise<void> {
  if (!isTauri()) return;

  const enabled = await isAutostartEnabled();
  if (desired && !enabled) {
    await enableAutostart();
  } else if (!desired && enabled) {
    await disableAutostart();
  }
}