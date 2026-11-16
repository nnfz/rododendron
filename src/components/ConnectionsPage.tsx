import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { LuCheck, LuMoreVertical, LuPlus, LuX } from 'react-icons/lu';
import { useI18n } from '../i18n';
import type { Config, ParsedConfig, ProxyConfig, RenamedConfig, SubscriptionInfo } from '../types';
import { parseProxyLink } from '../utils/configImport';
import { isTauri } from '../utils/isTauri';
import ConfigEditorModal from './ConfigEditorModal';
import ServerName from './CountryFlag';

interface ConnectionsPageProps {
  configs: Config[];
  activeConfigId: string;
  activeConfigFilename: string | null;
  setActiveConfigId: Dispatch<SetStateAction<string>>;
  subscriptionInfo: SubscriptionInfo | null;
  onSubscriptionAdded: (info: SubscriptionInfo) => void;
  onSubscriptionUpdated: (info: SubscriptionInfo) => void;
  onSelectServer: (filename: string, serverId: string) => Promise<void>;
  onRenamed: (previous: Config, renamed: RenamedConfig) => void;
  onDeleted: (config: Config) => void;
  onImported: (filename: string) => void;
  setActiveConfigContent: Dispatch<SetStateAction<string | null>>;
  setParsedConfig: Dispatch<SetStateAction<ParsedConfig | null>>;
  vpnEnabled: boolean;
  onNeedsRestart: () => void;
}

interface CatalogEntry {
  subscription: SubscriptionInfo | null;
  proxies: ProxyConfig[] | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serverCount(entry: CatalogEntry | undefined): number | null {
  if (!entry) return null;
  if (entry.subscription) return entry.subscription.nodes.length;
  if (entry.proxies) return entry.proxies.length;
  return null;
}

function displayName(config: Config, entry: CatalogEntry | undefined): string {
  const title = entry?.subscription?.title.trim();
  return title || config.name || config.filename;
}

function proxyTypeLabel(proxy: ProxyConfig): string {
  const wire = proxy as ProxyConfig & { type?: string };
  return wire.type || wire.proxy_type || '';
}

function ConnectionsPage({
  configs,
  activeConfigId,
  activeConfigFilename,
  setActiveConfigId,
  subscriptionInfo,
  onSubscriptionAdded,
  onSubscriptionUpdated,
  onSelectServer,
  onRenamed,
  onDeleted,
  onImported,
  setActiveConfigContent,
  setParsedConfig,
  vpnEnabled,
  onNeedsRestart,
}: ConnectionsPageProps) {
  const { t } = useI18n();
  const [entries, setEntries] = useState<Record<string, CatalogEntry>>({});
  const [menuId, setMenuId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloadTick, setReloadTick] = useState(0);
  const [showAddSubscription, setShowAddSubscription] = useState(false);
  const [subscriptionUrl, setSubscriptionUrl] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Config | null>(null);
  const [infoTarget, setInfoTarget] = useState<Config | null>(null);
  const [editorTarget, setEditorTarget] = useState<Config | null>(null);
  const [settingsTarget, setSettingsTarget] = useState<Config | null>(null);
  const [settingsName, setSettingsName] = useState('');
  const [settingsUrl, setSettingsUrl] = useState('');
  const [settingsInterval, setSettingsInterval] = useState('');

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const filenamesKey = configs.map(config => `${config.id}\0${config.filename}`).join('\n');

  useEffect(() => {
    if (!isTauri()) return;
    let cancelled = false;
    const load = async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      const next: Record<string, CatalogEntry> = {};
      await Promise.all(configs.map(async (config) => {
        let subscription: SubscriptionInfo | null = null;
        let proxies: ProxyConfig[] | null = null;
        try {
          subscription = await invoke<SubscriptionInfo | null>('subscription_meta', { filename: config.filename });
        } catch {
          subscription = null;
        }
        if (!subscription) {
          try {
            const content = await invoke<string>('read_config', { filename: config.filename });
            const parsed = await invoke<ParsedConfig>('parse_config', { configContent: content });
            proxies = parsed.proxies ?? [];
          } catch {
            proxies = null;
          }
        }
        next[config.filename] = { subscription, proxies };
      }));
      if (!cancelled) setEntries(next);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [filenamesKey, reloadTick, configs]);

  useEffect(() => {
    if (!subscriptionInfo) return;
    setEntries(prev => {
      const current = prev[subscriptionInfo.filename];
      if (!current) return prev;
      return {
        ...prev,
        [subscriptionInfo.filename]: { ...current, subscription: subscriptionInfo },
      };
    });
  }, [subscriptionInfo]);

  useEffect(() => {
    if (!menuId) return;
    const close = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('[data-connection-menu]')) return;
      setMenuId(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuId(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuId]);

  const rows = useMemo(() => {
    return [...configs].sort((left, right) => (
      displayName(left, entries[left.filename]).localeCompare(
        displayName(right, entries[right.filename]),
        undefined,
        { sensitivity: 'base' },
      )
    ));
  }, [configs, entries]);

  const toggleExpand = useCallback((configId: string) => {
    setExpandedId(current => current === configId ? null : configId);
    setMenuId(null);
  }, []);

  const openConnection = useCallback((config: Config) => {
    if (config.id !== activeConfigId) setActiveConfigId(config.id);
    setMenuId(null);
  }, [activeConfigId, setActiveConfigId]);

  const chooseServer = useCallback(async (filename: string, serverId: string, currentId: string | null) => {
    if (!serverId || serverId === currentId) return;
    setError(null);
    setBusy(true);
    try {
      await onSelectServer(filename, serverId);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [onSelectServer]);

  const importFile = useCallback(async (file: File) => {
    if (!isTauri()) return;
    setError(null);
    setBusy(true);
    try {
      const content = await file.text();
      const originalFilename = file.name;
      const lowerName = originalFilename.toLowerCase();
      const { invoke } = await import('@tauri-apps/api/core');
      let importContent = content;
      let importFilename = originalFilename;
      if (lowerName.endsWith('.conf')) {
        importContent = await invoke<string>('import_amnezia_wg_as_config', {
          configContent: content,
          proxyName: originalFilename.replace(/\.conf$/i, ''),
        });
        importFilename = originalFilename.replace(/\.conf$/i, '.yaml');
      }
      await invoke('import_config', {
        configContent: importContent,
        filename: importFilename,
        applyDefaults: true,
      });
      onImported(importFilename);
      setReloadTick(tick => tick + 1);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [onImported]);

  const addConnection = useCallback(async () => {
    const input = subscriptionUrl.trim();
    if (!input || busy || !isTauri()) return;
    setError(null);
    setBusy(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (/^https?:\/\//i.test(input)) {
        // Subscription, direct YAML or link list: the Rust loader detects the format.
        const info = await invoke<SubscriptionInfo>('add_subscription', { url: input });
        setSubscriptionUrl('');
        setShowAddSubscription(false);
        onSubscriptionAdded(info);
      } else {
        // Single server link or WireGuard/AmneziaWG text: the existing parser and importer.
        const imported = parseProxyLink(input);
        await invoke('import_config', {
          configContent: imported.yaml,
          filename: imported.filename,
          applyDefaults: true,
        });
        setSubscriptionUrl('');
        setShowAddSubscription(false);
        onImported(imported.filename);
      }
      setReloadTick(tick => tick + 1);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [busy, onImported, onSubscriptionAdded, subscriptionUrl]);

  const updateSubscription = useCallback(async (filename: string) => {
    if (!isTauri()) return;
    setMenuId(null);
    setError(null);
    setBusy(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      setNotice(null);
      const info = await invoke<SubscriptionInfo>('update_subscription', { filename });
      onSubscriptionUpdated(info);
      setNotice(t.connections.subscriptionUpdatedNotice.replace('{name}', info.title.trim() || info.filename));
      setEntries(prev => ({
        ...prev,
        [info.filename]: { subscription: info, proxies: null },
      }));
    } catch (error) {
      setError(errorText(error));
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const info = await invoke<SubscriptionInfo | null>('subscription_meta', { filename });
        if (info) {
          onSubscriptionUpdated(info);
          setEntries(prev => ({
            ...prev,
            [info.filename]: { subscription: info, proxies: null },
          }));
        }
      } catch {
        // The profile may already be committed. The request error stays visible.
      }
    } finally {
      setBusy(false);
    }
  }, [onSubscriptionUpdated, t]);

  const exportConfig = useCallback(async (config: Config) => {
    if (!isTauri()) return;
    setMenuId(null);
    setError(null);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const { save } = await import('@tauri-apps/plugin-dialog');
      const filePath = await save({
        defaultPath: config.filename,
        filters: [{ name: 'YAML', extensions: ['yaml', 'yml'] }],
      });
      if (!filePath) return;
      await invoke('export_config_to_path', { filename: config.filename, path: filePath });
    } catch (error) {
      setError(errorText(error));
    }
  }, []);

  const settingsSubscription = settingsTarget ? entries[settingsTarget.filename]?.subscription ?? null : null;
  const settingsIsSubscription = settingsSubscription !== null;

  useEffect(() => {
    if (!settingsTarget) return;
    const subscription = entries[settingsTarget.filename]?.subscription ?? null;
    setSettingsName(displayName(settingsTarget, entries[settingsTarget.filename]));
    setSettingsUrl(subscription?.url ?? '');
    setSettingsInterval(subscription?.customIntervalHours ? String(subscription.customIntervalHours) : '');
    // Fill the form once per opened dialog, not on every catalog refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsTarget]);

  const submitSettings = useCallback(async () => {
    if (!settingsTarget || !isTauri()) return;
    const name = settingsName.trim();
    if (!name) return;
    const subscription = entries[settingsTarget.filename]?.subscription ?? null;
    setError(null);
    setBusy(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      if (subscription) {
        const intervalText = settingsInterval.trim();
        const interval = intervalText === '' ? null : Number(intervalText);
        if (interval !== null && (!Number.isInteger(interval) || interval < 1 || interval > 2160)) {
          throw new Error(t.connections.intervalInvalid);
        }
        const info = await invoke<SubscriptionInfo>('save_subscription_settings', {
          filename: settingsTarget.filename,
          url: settingsUrl.trim(),
          customIntervalHours: interval,
        });
        onSubscriptionUpdated(info);
      }
      if (name !== displayName(settingsTarget, entries[settingsTarget.filename])) {
        const renamed = await invoke<RenamedConfig>('rename_config', {
          filename: settingsTarget.filename,
          name,
        });
        onRenamed(settingsTarget, renamed);
      }
      setSettingsTarget(null);
      setReloadTick(tick => tick + 1);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [entries, onRenamed, onSubscriptionUpdated, settingsInterval, settingsName, settingsTarget, settingsUrl, t]);

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget || !isTauri()) return;
    setError(null);
    setBusy(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('delete_config', { filename: deleteTarget.filename });
      onDeleted(deleteTarget);
      setDeleteTarget(null);
      setReloadTick(tick => tick + 1);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setBusy(false);
    }
  }, [deleteTarget, onDeleted]);

  return (
    <div className="page-content">
      <div className="connections-header">
        <div className='page-header'>
          <h2 className="page-title">{t.connections.title}</h2>
        </div>
        <div className="connections-add">
          <button
            type="button"
            className="btn btn-ghost-dark btn-icon"
            aria-label={t.connections.add}
            onClick={() => {
              setMenuId(null);
              setError(null);
              setShowAddSubscription(true);
            }}
          >
            <LuPlus size={18} />
          </button>
        </div>
      </div>
      <input
        id="connection-file-input"
        type="file"
        accept=".yaml,.yml,.conf"
        style={{ display: 'none' }}
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (file) void importFile(file);
        }}
      />

      {error && <div className="connection-error">{error}</div>}
      {notice && !error && <div className="connection-notice" role="status">{notice}</div>}

      {rows.length === 0 ? (
        <div className="connection-empty">
          <div className="connection-name">{t.connections.emptyTitle}</div>
          <div className="connection-meta">{t.connections.emptyHint}</div>
        </div>
      ) : (
        <div className="connection-list">
          {rows.map(config => {
            const entry = entries[config.filename];
            const selected = config.id === activeConfigId;
            const expanded = expandedId === config.id;
            const count = serverCount(entry);
            const subscription = entry?.subscription ?? null;
            const name = displayName(config, entry);
            const singleName = subscription?.nodes.length === 1 ? subscription.nodes[0].name : null;
            const canExpand = count !== null && count > 1;
            return (
              <div key={config.id} className={`connection-row ${selected ? 'selected' : ''} ${expanded ? 'expanded' : ''}`}>
                <div className="connection-header">
                  <button
                    type="button"
                    className="connection-main"
                    onClick={() => openConnection(config)}
                  >
                    <span className="connection-name-row">
                      <span className="connection-name">{name}</span>
                      {selected ? (
                        <span className="connection-selected">
                          <LuCheck size={14} />
                          {t.connections.selected}
                        </span>
                      ) : null}
                    </span>
                    <span className="connection-meta">
                      {entry ? (
                        <span>{subscription ? t.connections.typeSubscription : t.connections.typeLocal}</span>
                      ) : null}
                      {subscription && count !== null ? <span>{t.connections.serverCount.replace('{count}', String(count))}</span> : null}
                      {singleName ? <ServerName name={singleName} /> : null}
                      {subscription?.maskedUrl ? <span>{subscription.maskedUrl}</span> : null}
                      {subscription?.updatedAt ? <span>{subscription.updatedAt}</span> : null}
                    </span>
                  </button>
                  <div className="connection-actions">
                    {canExpand && (
                      <button
                        type="button"
                        className={`btn btn-icon connection-expand ${expanded ? 'expanded' : ''}`}
                        aria-label={expanded ? t.connections.collapse : t.connections.expand}
                        aria-expanded={expanded}
                        onClick={() => toggleExpand(config.id)}
                      >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                      </button>
                    )}
                    <div className="connection-menu-wrap" data-connection-menu>
                      <button
                        type="button"
                        className="btn btn-icon"
                        aria-label={t.connections.actions}
                        aria-expanded={menuId === config.id}
                        onClick={() => {
                          setMenuId(current => current === config.id ? null : config.id);
                        }}
                      >
                        <LuMoreVertical size={18} />
                      </button>
                      {menuId === config.id && (
                        <>
                          <div className="connection-popover-backdrop" onClick={() => setMenuId(null)} />
                          <div className="connection-popover animate-slideDown" role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenuId(null);
                                setSettingsTarget(config);
                              }}
                            >
                              {t.connections.settings}
                            </button>
                            {entry?.subscription && (
                              <button
                                type="button"
                                role="menuitem"
                                disabled={busy}
                                onClick={() => { void updateSubscription(config.filename); }}
                              >
                                {t.connections.updateSubscription}
                              </button>
                            )}
                            {entry && !entry.subscription && (
                              <button
                                type="button"
                                role="menuitem"
                                onClick={() => {
                                  setMenuId(null);
                                  setEditorTarget(config);
                                }}
                              >
                                {t.settings.editConfig}
                              </button>
                            )}
                            <button type="button" role="menuitem" onClick={() => { void exportConfig(config); }}>
                              {t.settings.exportConfig}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenuId(null);
                                setInfoTarget(config);
                              }}
                            >
                              {t.connections.information}
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              className="danger"
                              onClick={() => {
                                setMenuId(null);
                                setDeleteTarget(config);
                              }}
                            >
                              {t.common.delete}
                            </button>
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                </div>
                {expanded && canExpand && (
                  <div className="connection-servers">
                    {subscription
                      ? subscription.nodes.map(node => {
                          const nodeSelected = node.id === subscription.selectedServerId;
                          return (
                            <button
                              key={node.id}
                              type="button"
                              className={`connection-server ${nodeSelected ? 'selected' : ''}`}
                              aria-pressed={nodeSelected}
                              disabled={busy}
                              onClick={() => {
                                void chooseServer(
                                  config.filename,
                                  node.id,
                                  subscription.selectedServerId ?? null,
                                );
                              }}
                            >
                              <span>
                                <ServerName className="connection-name" name={node.name} />
                                <span className="connection-meta">
                                  <span>{node.proxyType}</span>
                                  <span>{node.server}:{node.port}</span>
                                </span>
                              </span>
                              {nodeSelected ? <LuCheck size={16} /> : null}
                            </button>
                          );
                        })
                      : (entry?.proxies ?? []).map(proxy => (
                          <div key={`${proxy.name}-${proxy.server}-${proxy.port}`} className="connection-server info">
                            <span>
                              <ServerName className="connection-name" name={proxy.name} />
                              <span className="connection-meta">
                                <span>{proxyTypeLabel(proxy)}</span>
                                <span>{proxy.server}:{proxy.port}</span>
                              </span>
                            </span>
                          </div>
                        ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {showAddSubscription && (
        <div className="modal-backdrop" onClick={() => setShowAddSubscription(false)} role="presentation">
          <div
            className="modal connection-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t.connections.addTitle}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">{t.connections.addTitle}</h3>
              <button type="button" className="btn btn-icon" aria-label={t.common.close} onClick={() => setShowAddSubscription(false)}>
                <LuX size={18} />
              </button>
            </div>
            <form
              className="modal-body connection-fields"
              onSubmit={(event) => {
                event.preventDefault();
                void addConnection();
              }}
            >
              <input
                className="input"
                type="text"
                value={subscriptionUrl}
                placeholder={t.connections.addPlaceholder}
                onChange={(event) => setSubscriptionUrl(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoFocus
              />
              <div className="connection-dialog-actions">
                <button
                  type="button"
                  className="btn btn-ghost-dark connection-file-link"
                  disabled={busy}
                  onClick={() => {
                    setShowAddSubscription(false);
                    document.getElementById('connection-file-input')?.click();
                  }}
                >
                  {t.settings.importConfig}
                </button>
                <button type="button" className="btn btn-ghost-dark" onClick={() => setShowAddSubscription(false)}>
                  {t.rules.cancel}
                </button>
                <button type="submit" className="btn btn-primary-dark" disabled={busy || subscriptionUrl.trim() === ''}>
                  {busy ? '…' : t.connections.add}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {settingsTarget && (
        <div className="modal-backdrop" onClick={() => setSettingsTarget(null)} role="presentation">
          <div
            className="modal connection-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t.connections.settings}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">{t.connections.settings}</h3>
              <button type="button" className="btn btn-icon" aria-label={t.common.close} onClick={() => setSettingsTarget(null)}>
                <LuX size={18} />
              </button>
            </div>
            <form
              className="modal-body connection-fields"
              onSubmit={(event) => {
                event.preventDefault();
                void submitSettings();
              }}
            >
              <label className="connection-field">
                <span className="connection-field-label">{t.connections.fieldName}</span>
                <input
                  className="input"
                  type="text"
                  value={settingsName}
                  onChange={(event) => setSettingsName(event.target.value)}
                  autoFocus
                />
              </label>
              {settingsIsSubscription && (
                <>
                  <label className="connection-field">
                    <span className="connection-field-label">{t.connections.fieldLink}</span>
                    <input
                      className="input"
                      type="text"
                      value={settingsUrl}
                      onChange={(event) => setSettingsUrl(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <label className="connection-field">
                    <span className="connection-field-label">{t.connections.fieldInterval}</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      max={2160}
                      value={settingsInterval}
                      placeholder={t.connections.intervalPlaceholder}
                      onChange={(event) => setSettingsInterval(event.target.value)}
                    />
                    <span className="connection-field-hint">{t.connections.intervalHint}</span>
                  </label>
                </>
              )}
              <div className="connection-dialog-actions">
                <button type="button" className="btn btn-ghost-dark" onClick={() => setSettingsTarget(null)}>
                  {t.rules.cancel}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary-dark"
                  disabled={busy || settingsName.trim() === '' || (settingsIsSubscription && settingsUrl.trim() === '')}
                >
                  {t.common.save}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div className="modal-backdrop" onClick={() => setDeleteTarget(null)} role="presentation">
          <div
            className="modal connection-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t.connections.deleteTitle}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">{t.connections.deleteTitle}</h3>
              <button type="button" className="btn btn-icon" aria-label={t.common.close} onClick={() => setDeleteTarget(null)}>
                <LuX size={18} />
              </button>
            </div>
            <div className="modal-body connection-fields">
              <p>{t.connections.deleteBody.replace('{name}', displayName(deleteTarget, entries[deleteTarget.filename]))}</p>
              <div className="connection-dialog-actions">
                <button type="button" className="btn btn-ghost-dark" onClick={() => setDeleteTarget(null)}>
                  {t.rules.cancel}
                </button>
                <button type="button" className="btn btn-primary-dark" disabled={busy} onClick={() => { void confirmDelete(); }}>
                  {t.common.delete}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {infoTarget && (
        <div className="modal-backdrop" onClick={() => setInfoTarget(null)} role="presentation">
          <div
            className="modal connection-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={t.connections.information}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-header">
              <h3 className="modal-title">{t.connections.information}</h3>
              <button type="button" className="btn btn-icon" aria-label={t.common.close} onClick={() => setInfoTarget(null)}>
                <LuX size={18} />
              </button>
            </div>
            <div className="modal-body connection-info">
              <InfoRow label={t.connections.renameTitle} value={displayName(infoTarget, entries[infoTarget.filename])} />
              <InfoRow
                label={t.rules.type}
                value={entries[infoTarget.filename]?.subscription ? t.connections.typeSubscription : t.connections.typeLocal}
              />
              <InfoRow label={t.connections.filename} value={infoTarget.filename} />
              {serverCount(entries[infoTarget.filename]) !== null && (
                <InfoRow
                  label={t.connections.servers}
                  value={String(serverCount(entries[infoTarget.filename]))}
                />
              )}
              {entries[infoTarget.filename]?.subscription && (
                <>
                  <InfoRow label={t.settings.subscription} value={entries[infoTarget.filename]?.subscription?.maskedUrl || ''} />
                  <InfoRow
                    label={t.settings.subscriptionUpdated}
                    value={entries[infoTarget.filename]?.subscription?.updatedAt || ''}
                  />
                  {entries[infoTarget.filename]?.subscription?.userinfo && (
                    <InfoRow
                      label={t.settings.subscriptionUserinfo}
                      value={entries[infoTarget.filename]?.subscription?.userinfo || ''}
                    />
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      <ConfigEditorModal
        open={editorTarget !== null}
        onClose={() => setEditorTarget(null)}
        configName={editorTarget ? displayName(editorTarget, entries[editorTarget.filename]) : ''}
        filename={editorTarget?.filename || ''}
        onSaved={(content, parsed) => {
          if (editorTarget && editorTarget.filename === activeConfigFilename) {
            setActiveConfigContent(content);
            setParsedConfig(parsed);
          }
          setReloadTick(tick => tick + 1);
        }}
        vpnEnabled={vpnEnabled && editorTarget?.id === activeConfigId}
        onNeedsRestart={onNeedsRestart}
      />
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="connection-info-row">
      <span className="setting-label">{label}</span>
      <span>{value}</span>
    </div>
  );
}

export default memo(ConnectionsPage);
