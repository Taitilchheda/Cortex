'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link2, RefreshCw, PlugZap, ShieldCheck, Trash2 } from 'lucide-react';
import {
  connectConnector,
  connectorRuns,
  createConnector,
  deleteConnector,
  disconnectConnector,
  fetchConnectors,
  fetchConnectorOAuthServerSetup,
  fetchConnectorProviders,
  listConnectorItems,
  startConnectorOAuth,
  syncConnector,
  testConnector,
  updateConnector,
  updateConnectorOAuthServerSetup,
} from '../lib/api';
import { ConnectorProvider, ConnectorRecord, OAuthServerProviderSetup } from '../lib/types';

export default function ConnectorsPanel() {
  const [providers, setProviders] = useState<ConnectorProvider[]>([]);
  const [connectors, setConnectors] = useState<ConnectorRecord[]>([]);
  const [selectedProvider, setSelectedProvider] = useState('');
  const [connectorName, setConnectorName] = useState('');
  const [mode, setMode] = useState<'read_only' | 'read_write'>('read_only');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [statusMessage, setStatusMessage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [detailsByConnector, setDetailsByConnector] = useState<Record<string, string>>({});
  const [oauthServerSetup, setOauthServerSetup] = useState<Record<string, OAuthServerProviderSetup>>({});
  const [oauthClientId, setOauthClientId] = useState('');
  const [oauthClientSecret, setOauthClientSecret] = useState('');
  const oauthCallbackUrl = 'http://localhost:8000/connectors/oauth/callback';

  const selectedProviderMeta = useMemo(
    () => providers.find((p) => p.key === selectedProvider) || null,
    [providers, selectedProvider]
  );
  const selectedProviderIsOAuth = selectedProviderMeta?.auth_type === 'oauth2';
  const selectedProviderOAuthReady = selectedProviderMeta?.oauth_ready !== false;
  const statusTone = useMemo(() => {
    const text = statusMessage.toLowerCase();
    if (!text) return 'info';
    if (text.includes('failed') || text.includes('error') || text.includes('invalid') || text.includes('not configured')) return 'error';
    if (text.includes('connected') || text.includes('saved') || text.includes('success')) return 'success';
    return 'info';
  }, [statusMessage]);
  const providerByKey = useMemo(() => {
    const out: Record<string, ConnectorProvider> = {};
    for (const provider of providers) {
      out[provider.key] = provider;
    }
    return out;
  }, [providers]);

  const oauthReadiness = useMemo(() => {
    const github = oauthServerSetup.github;
    const google = oauthServerSetup.google_drive;
    return {
      githubReady: !!github?.oauth_ready,
      googleReady: !!google?.oauth_ready,
      githubMsg: github?.oauth_setup_message || 'Ready',
      googleMsg: google?.oauth_setup_message || 'Ready',
    };
  }, [oauthServerSetup]);

  const load = useCallback(async () => {
    const [p, c, oauthSetup] = await Promise.all([
      fetchConnectorProviders(),
      fetchConnectors(),
      fetchConnectorOAuthServerSetup(),
    ]);
    setProviders(p.providers || []);
    setConnectors(c.connectors || []);
    setOauthServerSetup((oauthSetup?.providers as Record<string, OAuthServerProviderSetup>) || {});

    if (!selectedProvider && (p.providers || []).length > 0) {
      const first = p.providers[0].key;
      setSelectedProvider(first);
      setConnectorName((prev) => (prev.trim() ? prev : (p.providers[0].name || first) + ' Connector'));
    }
  }, [selectedProvider]);

  useEffect(() => {
    void load().catch(() => {
      setStatusMessage('Failed to load connectors metadata.');
    });
  }, [load]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const oauthStatus = params.get('connector_oauth');
    if (!oauthStatus) return;

    const provider = params.get('provider') || 'connector';
    const message = params.get('message') || '';
    if (oauthStatus === 'success') {
      setStatusMessage(`Connected ${provider} successfully.`);
    } else {
      setStatusMessage(`OAuth failed for ${provider}: ${message || 'unknown error'}`);
    }

    params.delete('connector_oauth');
    params.delete('provider');
    params.delete('message');
    const next = `${window.location.pathname}${params.toString() ? `?${params.toString()}` : ''}`;
    window.history.replaceState({}, '', next);
    void load();
  }, [load]);

  useEffect(() => {
    const meta = providers.find((p) => p.key === selectedProvider);
    if (!meta) return;
    const next: Record<string, string> = {};
    for (const field of meta.config_fields || []) {
      next[field.key] = '';
    }
    setConfigValues(next);
    setConnectorName(`${meta.name} Connector`);
  }, [selectedProvider, providers]);

  useEffect(() => {
    const setup = oauthServerSetup[selectedProvider];
    if (!setup) {
      setOauthClientId('');
      setOauthClientSecret('');
      return;
    }
    setOauthClientId('');
    setOauthClientSecret('');
  }, [selectedProvider, oauthServerSetup]);

  const updateField = (key: string, value: string) => {
    setConfigValues((prev) => ({ ...prev, [key]: value }));
  };

  const handleCreate = async () => {
    if (!selectedProviderMeta) return;

    const requiredMissing = (selectedProviderMeta.config_fields || []).filter(
      (f) => f.required && !String(configValues[f.key] || '').trim()
    );
    if (requiredMissing.length > 0) {
      setStatusMessage(`Missing required fields: ${requiredMissing.map((f) => f.label).join(', ')}`);
      return;
    }

    const config: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(configValues)) {
      const trimmed = String(value || '').trim();
      if (trimmed) config[key] = trimmed;
    }

    setBusy('create');
    try {
      const defaultName = connectorName.trim() || `${selectedProviderMeta.name} Connector`;
      let connectorId = '';

      if (selectedProviderIsOAuth) {
        const existing = connectors.find((c) => c.type === selectedProviderMeta.key);
        if (existing) {
          connectorId = existing.id;
          if (existing.name !== defaultName || existing.mode !== mode) {
            const updated = await updateConnector(existing.id, {
              name: defaultName,
              mode,
            });
            if (updated?.detail) throw new Error(String(updated.detail));
          }
        }
      }

      if (!connectorId) {
        const resp = await createConnector({
          type: selectedProviderMeta.key,
          name: defaultName,
          mode,
          config,
          scopes: [],
        });
        if (resp?.detail) throw new Error(String(resp.detail));
        connectorId = String((resp?.connector as { id?: string } | undefined)?.id || '').trim();
      }

      if (selectedProviderIsOAuth && connectorId) {
        const returnUrl = typeof window !== 'undefined'
          ? `${window.location.origin}${window.location.pathname}?panel=connectors`
          : undefined;

        const oauthResp = await startConnectorOAuth({
          connector_id: connectorId,
          provider: selectedProviderMeta.key,
          return_url: returnUrl,
        });
        if (oauthResp?.detail) throw new Error(String(oauthResp.detail));

        const authUrl = String(oauthResp?.auth_url || '');
        if (!authUrl) throw new Error('OAuth URL was not returned by the server');

        if (typeof window !== 'undefined') {
          window.location.href = authUrl;
          return;
        }
      }

      setStatusMessage(selectedProviderIsOAuth ? 'Connector ready for login.' : 'Connector created. You can now test/connect it.');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to create connector';
      setStatusMessage(msg);
    } finally {
      setBusy(null);
    }
  };

  const runAction = async (id: string, action: 'connect' | 'disconnect' | 'test' | 'sync' | 'items' | 'runs') => {
    setBusy(`${action}:${id}`);
    try {
      let resp: Record<string, unknown> = {};
      if (action === 'connect') resp = await connectConnector(id);
      if (action === 'disconnect') resp = await disconnectConnector(id);
      if (action === 'test') resp = await testConnector(id);
      if (action === 'sync') resp = await syncConnector(id);
      if (action === 'items') resp = await listConnectorItems(id);
      if (action === 'runs') resp = await connectorRuns(id);

      if (resp?.detail) throw new Error(String(resp.detail));

      if (action === 'items') {
        const items = (resp.result as { data?: { items?: unknown[] } } | undefined)?.data?.items || [];
        setDetailsByConnector((prev) => ({ ...prev, [id]: `${items.length} items fetched` }));
      } else if (action === 'runs') {
        const runs = (resp.runs as unknown[]) || [];
        setDetailsByConnector((prev) => ({ ...prev, [id]: `${runs.length} run logs` }));
      } else {
        const result = resp.result as { status?: string; message?: string; error?: string } | undefined;
        setDetailsByConnector((prev) => ({ ...prev, [id]: result?.message || result?.error || result?.status || action }));
      }

      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : `Failed: ${action}`;
      setDetailsByConnector((prev) => ({ ...prev, [id]: msg }));
    } finally {
      setBusy(null);
    }
  };

  const removeConnector = async (id: string) => {
    setBusy(`delete:${id}`);
    try {
      const resp = await deleteConnector(id);
      if (resp?.detail) throw new Error(String(resp.detail));
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to delete connector';
      setStatusMessage(msg);
    } finally {
      setBusy(null);
    }
  };

  const startOAuthLogin = async (id: string, provider: string) => {
    setBusy(`oauth:${id}`);
    try {
      const meta = providerByKey[provider];
      if (meta && meta.oauth_ready === false) {
        setDetailsByConnector((prev) => ({
          ...prev,
          [id]: meta.oauth_setup_message || `${meta.name} sign-in needs server setup once.`,
        }));
        setBusy(null);
        return;
      }

      const returnUrl = typeof window !== 'undefined'
        ? `${window.location.origin}${window.location.pathname}?panel=connectors`
        : undefined;

      const resp = await startConnectorOAuth({
        connector_id: id,
        provider,
        return_url: returnUrl,
      });

      if (resp?.detail) throw new Error(String(resp.detail));
      const authUrl = String(resp?.auth_url || '');
      if (!authUrl) throw new Error('OAuth URL was not returned by the server');

      if (typeof window !== 'undefined') {
        window.location.href = authUrl;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to start OAuth login';
      setDetailsByConnector((prev) => ({ ...prev, [id]: msg }));
      setBusy(null);
    }
  };

  const saveOAuthServerSetup = async () => {
    if (!selectedProvider || !selectedProviderIsOAuth) return;
    setBusy('oauth-setup');
    try {
      const resp = await updateConnectorOAuthServerSetup({
        provider: selectedProvider,
        enabled: true,
        client_id: oauthClientId,
        client_secret: oauthClientSecret,
      });
      if (resp?.detail) throw new Error(String(resp.detail));
      setStatusMessage(`${selectedProviderMeta?.name || 'Provider'} sign-in setup saved.`);
      setOauthClientId('');
      setOauthClientSecret('');
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to save OAuth setup';
      setStatusMessage(msg);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="connectors-shell">
      <div className="connectors-head">
        <div className="connectors-title"><Link2 size={14} /> Connectors</div>
        <div className="connectors-head-right">
          <span className="connectors-count">{connectors.length} configured</span>
        <button className="git-mini-btn" onClick={() => load()} disabled={!!busy}>
          <RefreshCw size={12} className={busy ? 'spin' : ''} /> Refresh
        </button>
        </div>
      </div>

      <div className="connectors-note">
        Connect accounts with a redirect login flow. No manual token entry.
      </div>

      <div className="pro-card connectors-guide">
        <div className="card__label">How to connect</div>
        <div className="connectors-badge-row">
          <span className={`connectors-badge ${oauthReadiness.githubReady ? 'is-ready' : 'is-missing'}`}>
            GitHub: {oauthReadiness.githubReady ? 'Ready' : 'Needs setup'}
          </span>
          <span className={`connectors-badge ${oauthReadiness.googleReady ? 'is-ready' : 'is-missing'}`}>
            Google Drive: {oauthReadiness.googleReady ? 'Ready' : 'Needs setup'}
          </span>
        </div>
        <div className="connectors-guide-grid">
          <div className="connectors-guide-card">
            <div className="connectors-guide-title">GitHub</div>
            <ul className="connectors-guide-list">
              <li>Use OAuth App Client ID starting with Iv1.</li>
              <li>Do not use username or email as Client ID.</li>
              <li>Callback URL must exactly match below.</li>
            </ul>
          </div>
          <div className="connectors-guide-card">
            <div className="connectors-guide-title">Google Drive</div>
            <ul className="connectors-guide-list">
              <li>Use Google Web Client credentials.</li>
              <li>Client ID must end with .apps.googleusercontent.com.</li>
              <li>You can paste full JSON credentials.</li>
            </ul>
          </div>
        </div>
        <div className="connectors-code">OAuth callback: {oauthCallbackUrl}</div>
      </div>

      {selectedProviderIsOAuth && !selectedProviderOAuthReady ? (
        <div className="pro-card connectors-create">
          <div className="card__label">One-time Server Setup: {selectedProviderMeta?.name}</div>
          <div className="connectors-status">
            {selectedProviderMeta?.oauth_setup_message || 'OAuth sign-in credentials are not configured.'}
          </div>
          <div className="setting-row">
            <span className="setting-label">Client ID</span>
            <input
              className="setting-input"
              value={oauthClientId}
              onChange={(e) => setOauthClientId(e.target.value)}
              placeholder={
                selectedProvider === 'google_drive'
                  ? 'Google Web Client ID or credentials JSON'
                  : (selectedProvider === 'github' ? 'GitHub OAuth App Client ID (for example Iv1....)' : 'Paste OAuth client id')
              }
            />
          </div>
          {selectedProvider === 'google_drive' ? (
            <div className="connectors-item-result">
              Use Google OAuth Web Client credentials. The client ID must end with .apps.googleusercontent.com.
            </div>
          ) : null}
          {selectedProvider === 'github' ? (
            <div className="connectors-item-result">
              Use the GitHub OAuth App Client ID (starts with Iv1.), not your email or username.
            </div>
          ) : null}
          <div className="setting-row">
            <span className="setting-label">Client Secret</span>
            <input
              type="password"
              className="setting-input"
              value={oauthClientSecret}
              onChange={(e) => setOauthClientSecret(e.target.value)}
              placeholder={
                selectedProvider === 'google_drive'
                  ? 'Optional if included in pasted JSON'
                  : (selectedProvider === 'github' ? 'GitHub OAuth App Client Secret' : 'Paste OAuth client secret')
              }
            />
          </div>
          <button
            className="btn--primary btn--sm"
            onClick={saveOAuthServerSetup}
            disabled={busy === 'oauth-setup' || !oauthClientId.trim()}
          >
            {busy === 'oauth-setup' ? 'Saving...' : 'Enable Sign-in'}
          </button>
        </div>
      ) : null}

      <div className="pro-card connectors-create">
        <div className="card__label">Add Connector</div>
        {selectedProviderMeta?.description ? (
          <div className="connectors-subtle">{selectedProviderMeta.description}</div>
        ) : null}

        <div className="setting-row">
          <span className="setting-label">Provider</span>
          <select className="setting-select" value={selectedProvider} onChange={(e) => setSelectedProvider(e.target.value)}>
            {providers.map((p) => (
              <option key={p.key} value={p.key}>{p.name}</option>
            ))}
          </select>
        </div>

        <div className="setting-row">
          <span className="setting-label">Name</span>
          <input className="setting-input" value={connectorName} onChange={(e) => setConnectorName(e.target.value)} />
        </div>

        <div className="setting-row">
          <span className="setting-label">Mode</span>
          <select className="setting-select" value={mode} onChange={(e) => setMode((e.target.value as 'read_only' | 'read_write') || 'read_only')}>
            <option value="read_only">read_only</option>
            <option value="read_write">read_write</option>
          </select>
        </div>

        {(selectedProviderMeta?.config_fields || []).map((field) => (
          <div className="setting-row" key={field.key}>
            <span className="setting-label">{field.label}</span>
            <input
              type={field.type === 'password' ? 'password' : 'text'}
              className="setting-input"
              value={configValues[field.key] || ''}
              onChange={(e) => updateField(field.key, e.target.value)}
              placeholder={field.placeholder || field.key}
            />
          </div>
        ))}

        <button
          className="btn--primary btn--sm"
          onClick={handleCreate}
          disabled={busy === 'create' || !selectedProvider}
        >
          {busy === 'create'
            ? 'Creating...'
            : selectedProviderIsOAuth
              ? `Continue with ${selectedProviderMeta?.name || 'Provider'}`
              : 'Create Connector'}
        </button>
      </div>

      {statusMessage ? <div className={`connectors-status connectors-status--${statusTone}`}>{statusMessage}</div> : null}

      <div className="connectors-list">
        {connectors.length === 0 && <div className="git-empty">No connectors yet.</div>}

        {connectors.map((c) => {
          return (
            <div key={c.id} className="pro-card connectors-item">
              <div className="connectors-item-head">
                <div>
                  <div className="connectors-item-title">{c.name}</div>
                  <div className="connectors-item-meta">{c.type} · {c.mode}</div>
                </div>
                <span className={`connectors-state connectors-state--${String(c.status || 'unknown').toLowerCase()}`}>
                  {c.status}
                </span>
                <button
                  className="git-mini-btn git-mini-btn--danger"
                  onClick={() => removeConnector(c.id)}
                  disabled={busy === `delete:${c.id}`}
                >
                  <Trash2 size={12} /> Delete
                </button>
              </div>

              <div className="connectors-actions">
                {(c.type === 'github' || c.type === 'google_drive') ? (
                  <button
                    className="git-mini-btn"
                    onClick={() => startOAuthLogin(c.id, c.type)}
                    disabled={!!busy}
                  >
                    <PlugZap size={12} /> {c.type === 'github' ? 'Login with GitHub' : 'Login with Google'}
                  </button>
                ) : (
                  <button className="git-mini-btn" onClick={() => runAction(c.id, 'connect')} disabled={!!busy}><PlugZap size={12} /> Connect</button>
                )}
                <button className="git-mini-btn" onClick={() => runAction(c.id, 'disconnect')} disabled={!!busy}>Disconnect</button>
                <button className="git-mini-btn" onClick={() => runAction(c.id, 'test')} disabled={!!busy}><ShieldCheck size={12} /> Test</button>
                <button className="git-mini-btn" onClick={() => runAction(c.id, 'sync')} disabled={!!busy}>Sync</button>
                <button className="git-mini-btn" onClick={() => runAction(c.id, 'items')} disabled={!!busy}>Items</button>
                <button className="git-mini-btn" onClick={() => runAction(c.id, 'runs')} disabled={!!busy}>Runs</button>
              </div>

              {detailsByConnector[c.id] ? <div className="connectors-item-result">{detailsByConnector[c.id]}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
