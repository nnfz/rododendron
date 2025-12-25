export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    (('__TAURI__' in window) || ('__TAURI_INTERNALS__' in window))
  );
}
