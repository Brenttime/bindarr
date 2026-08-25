import { useState, useEffect, lazy, Suspense } from 'react';
import { ShieldAlert, Share2, Clipboard, RefreshCw, KeyRound, Check, Database, Download, Upload, SlidersHorizontal, Info, Bug, Lightbulb, MessagesSquare, ScrollText, Github, Languages, Globe } from 'lucide-react';
import { LOCALES, localeName, useT } from '../utils/i18n';
import { buildCardListText } from '../utils/cardList';
import { REPO_URL } from '../utils/repo';
import MoxfieldPanel from './MoxfieldPanel';

// Admin-only surface, code-split like the view components so its heavy deps
// (catalog management, backups) only load for admins on the Settings tab.
const AdminPanel = lazy(() => import('./AdminPanel'));

function Settings({ user, onUpdateUser, showToast, target }) {
  const { locale, setLocale, t } = useT();
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  
  const [shareEnabled, setShareEnabled] = useState(user?.share_enabled === 1);
  const [shareLoading, setShareLoading] = useState(false);

  const [publicBaseUrl, setPublicBaseUrl] = useState('');

  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');

  const [versionInfo, setVersionInfo] = useState(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [backendReachable, setBackendReachable] = useState(true);

  // Deep link: a jump from another tab (e.g. the deck list's Moxfield Sync
  // button) asks us to scroll to a panel once we have rendered.
  useEffect(() => {
    if (!target) return;
    const id = target === 'moxfield' ? 'moxfield-panel' : null;
    if (!id) return;
    const timer = setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
    return () => clearTimeout(timer);
  }, [target]);

  useEffect(() => {
    fetch('/api/settings')
      .then(res => res.ok ? res.json() : null)
      .then(data => {
        if (data) setPublicBaseUrl(data.public_base_url || '');
      })
      .catch(() => {});
  }, []);

  // The build stamps its own version in, so Settings can always state what it
  // is even with the backend down. The call below only adds the SERVER's
  // version (to catch a stale backend behind a fresh frontend) and powers the
  // update check — it is never what makes the version appear.
  const appVersion = import.meta.env.VITE_APP_VERSION || null;
  const isDemo = !!import.meta.env.VITE_DEMO;

  useEffect(() => {
    fetch('/api/settings/version')
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then(data => { setVersionInfo(data); setBackendReachable(true); })
      .catch(() => setBackendReachable(false));
  }, []);

  const handleCheckUpdate = async () => {
    setCheckingUpdate(true);
    try {
      const res = await fetch('/api/settings/version?check=1');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setVersionInfo(data);
      setBackendReachable(true);
      if (data.check_failed) showToast(t('settings.updateNoGithub'));
      else if (data.update_available) showToast(t('settings.updateAvailable', { version: data.latest }));
      else showToast(t('settings.updateLatest'));
    } catch (err) {
      console.error(err);
      setBackendReachable(false);
      showToast(t('settings.updateNoServer'));
    } finally {
      setCheckingUpdate(false);
    }
  };

  // The version shown: the build's own stamp, falling back to whatever the
  // server reports if an older bundle has no stamp baked in.
  const shownVersion = appVersion || versionInfo?.version || null;
  // A frontend newer than the backend usually means a half-finished update —
  // worth surfacing, since it produces confusing bugs that look like app bugs.
  const versionSkew = appVersion && versionInfo?.version && appVersion !== versionInfo.version
    ? versionInfo.version
    : null;

  // Prefill a bug report with the details that otherwise take three round trips
  // to obtain. Environment only — nothing about the user's collection.
  const bugReportUrl = () => {
    const body = [
      '### What happened?',
      '',
      '',
      '### What did you expect?',
      '',
      '',
      '### Steps to reproduce',
      '1. ',
      '2. ',
      '',
      '### Environment',
      `- Bindarr (app): ${shownVersion || 'unknown'}`,
      `- Bindarr (server): ${versionInfo?.version || (backendReachable ? 'unknown' : 'unreachable')}`,
      `- Platform: ${navigator.platform || 'unknown'}`,
      `- Browser: ${navigator.userAgent}`,
      `- Screen: ${window.screen?.width}x${window.screen?.height}`,
      '',
      '<!-- Screenshots help a lot. Please remove anything you would rather not share. -->',
    ].join('\n');
    return `${REPO_URL}/issues/new?labels=bug&title=${encodeURIComponent('[Bug] ')}&body=${encodeURIComponent(body)}`;
  };

  const featureRequestUrl = () => {
    const body = [
      '### What would you like Bindarr to do?',
      '',
      '',
      '### Why would that help?',
      '',
      '',
      `<!-- Bindarr ${shownVersion || 'unknown'} -->`,
    ].join('\n');
    return `${REPO_URL}/issues/new?labels=enhancement&title=${encodeURIComponent('[Feature] ')}&body=${encodeURIComponent(body)}`;
  };

  const handleImportFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (!window.confirm(t('settings.confirmImport', { file: file.name }))) {
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    const isJson = file.name.endsWith('.json');
    const format = isJson ? 'json' : 'csv';

    reader.onload = async (event) => {
      try {
        const fileData = event.target.result;
        showToast(t('settings.importing'));
        const response = await fetch('/api/import', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            format,
            data: fileData
          })
        });

        const result = await response.json();
        if (response.ok) {
          showToast(result.message || t('settings.importOk'));
        } else {
          showToast(t('settings.importFailed', { error: result.error || t('settings.unknownError') }));
        }
      } catch (err) {
        console.error(err);
        showToast(t('settings.importFailed', { error: err.message }));
      }
    };

    reader.onerror = () => {
      showToast(t('settings.errReadFile'));
    };

    reader.readAsText(file);
    e.target.value = null;
  };

  useEffect(() => {
    if (user) {
      setShareEnabled(user.share_enabled === 1 || user.share_enabled === true);
    }
  }, [user]);

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (!currentPassword) {
      showToast(t('settings.errCurrentPassword'));
      return;
    }
    if (password.length < 8) {
      showToast(t('login.errPasswordShort', { count: 8 }));
      return;
    }
    if (password !== confirmPassword) {
      showToast(t('login.errPasswordMismatch'));
      return;
    }

    setPasswordLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, password })
      });

      if (response.ok) {
        showToast(t('settings.passwordUpdated'));
        setCurrentPassword('');
        setPassword('');
        setConfirmPassword('');
      } else {
        const data = await response.json();
        showToast(data.error || t('settings.errPasswordUpdate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('settings.errPasswordUpdateGeneric'));
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleExport = async (format) => {
    try {
      const response = await fetch(`/api/export?format=${format}`);
      if (!response.ok) {
        showToast(t('settings.errExport'));
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bindarr_collection.${format === 'json' ? 'json' : 'csv'}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showToast(t('settings.errExportGeneric'));
    }
  };

  // Text card list of the whole collection, "qty Name" or "qty Name (SET) num".
  // Formatted in the browser from the same /api/collection data the UI shows —
  // the server keeps an identical endpoint (/api/collection/cardlist) for
  // scripts, and cardList.test.js proves the two copies agree.
  const handleExportCardList = async (style) => {
    try {
      const response = await fetch('/api/collection');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const cards = await response.json();
      const text = buildCardListText(cards, style);
      if (!text) { showToast(t('settings.cardlistEmpty')); return; }
      await navigator.clipboard.writeText(text);
      showToast(t('settings.cardlistCopied'));
    } catch (err) {
      console.error(err);
      showToast(t('settings.errCardlist'));
    }
  };

  const handleShareToggle = async (checked) => {
    setShareEnabled(checked);
    setShareLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_enabled: checked })
      });

      if (response.ok) {
        const data = await response.json();
        onUpdateUser(data.user);
        showToast(t(checked ? 'settings.sharingOn' : 'settings.sharingOff'));
      } else {
        setShareEnabled(!checked); // Revert
        showToast(t('settings.errSharing'));
      }
    } catch (err) {
      console.error(err);
      setShareEnabled(!checked);
      showToast(t('settings.errSharingGeneric'));
    } finally {
      setShareLoading(false);
    }
  };

  const handleRegenerateToken = async () => {
    if (!window.confirm(t('settings.confirmRegenerate'))) {
      return;
    }

    setShareLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ regenerate_share_token: true })
      });

      if (response.ok) {
        const data = await response.json();
        onUpdateUser(data.user);
        showToast(t('settings.tokenRegenerated'));
      } else {
        showToast(t('settings.errRegenerate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('settings.errRegenerateGeneric'));
    } finally {
      setShareLoading(false);
    }
  };

  const origin = publicBaseUrl || `${window.location.protocol}//${window.location.host}`;
  const activeTheme = theme || localStorage.getItem('theme') || 'dark';
  const themeQuery = activeTheme !== 'dark' ? `&theme=${encodeURIComponent(activeTheme)}` : '';
  const shareUrl = `${origin}/share/${user?.share_token}${activeTheme !== 'dark' ? `?theme=${encodeURIComponent(activeTheme)}` : ''}`;
  const tradeUrl = `${origin}/share/${user?.share_token}?list=trade${themeQuery}`;

  const [copiedType, setCopiedType] = useState(''); // 'collection', 'trade'

  const copyToClipboard = (url, type) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedType(type);
      showToast(t(`settings.copied.${type}`));
      setTimeout(() => setCopiedType(''), 2000);
    }).catch(() => {
      showToast(t('settings.errCopy'));
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Title Panel */}
      <div className="glass-panel">
        <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)' }}>{t('settings.title')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('settings.subtitle')}</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }} className="settings-grid">
        {/* Sharing Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <Share2 size={20} style={{ color: 'var(--accent-red)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('settings.sharingTitle')}</h3>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem' }}>{t('settings.shareLibrary')}</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{t('settings.shareLibraryHint')}</div>
            </div>
            <label className="switch-control" style={{ position: 'relative', display: 'inline-block', width: '46px', height: '24px' }}>
              <input 
                type="checkbox" 
                checked={shareEnabled} 
                onChange={(e) => handleShareToggle(e.target.checked)}
                disabled={shareLoading}
                style={{ opacity: 0, width: 0, height: 0 }}
              />
              <span className={`switch-slider ${shareEnabled ? 'active' : ''}`} style={{
                position: 'absolute',
                cursor: 'pointer',
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: shareEnabled ? 'var(--success)' : '#334155',
                transition: '0.3s',
                borderRadius: '24px'
              }}>
                <span style={{
                  position: 'absolute',
                  height: '18px', width: '18px',
                  left: shareEnabled ? '24px' : '4px',
                  bottom: '3px',
                  backgroundColor: '#fff',
                  transition: '0.3s',
                  borderRadius: '50%',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
                }}></span>
              </span>
            </label>
          </div>

          {shareEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: '0.5rem' }}>
              
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>{t('settings.linkCollection')}</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="input-control" 
                    value={shareUrl} 
                    readOnly 
                    style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(shareUrl, 'collection')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'collection' ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Clipboard size={14} />}
                    <span>{t('settings.copy')}</span>
                  </button>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>{t('settings.linkTrade')}</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="input-control" 
                    value={tradeUrl} 
                    readOnly 
                    style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(tradeUrl, 'trade')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'trade' ? <Check size={14} style={{ color: 'var(--success)' }} /> : <Clipboard size={14} />}
                    <span>{t('settings.copy')}</span>
                  </button>
                </div>
              </div>

              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                {/* The three query strings go in as placeholders rather than as
                    <code> elements: that keeps the sentence one translatable unit
                    and stops a translator from accidentally localising a URL. */}
                💡 <strong>{t('settings.tipLabel')}</strong> {t('settings.themeTip', {
                  theme: activeTheme,
                  lcars: '?theme=lcars',
                  light: '?theme=light',
                  dark: '?theme=dark',
                })}
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button
                  className="btn btn-secondary"
                  onClick={handleRegenerateToken}
                  disabled={shareLoading}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
                >
                  <RefreshCw size={12} className={shareLoading ? 'spin-animation' : ''} />
                  <span>{t('settings.regenerateLink')}</span>
                </button>
              </div>
            </div>
          )}

          {!shareEnabled && (
            <div style={{ display: 'flex', gap: '0.5rem', background: 'rgba(255, 71, 71, 0.05)', border: '1px solid rgba(255,71,71,0.1)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              <ShieldAlert size={16} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
              <span>{t('settings.privateNotice')}</span>
            </div>
          )}
        </div>

        {/* Change Password Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <KeyRound size={20} style={{ color: 'var(--accent-yellow)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('settings.securityTitle')}</h3>
          </div>

          <form onSubmit={handlePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="current-password">{t('settings.currentPassword')}</label>
              <input
                id="current-password"
                type="password"
                name="current-password"
                autoComplete="current-password"
                className="input-control"
                placeholder={t('settings.currentPasswordPlaceholder')}
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-new-password">{t('settings.newPassword')}</label>
              <input
                id="settings-new-password"
                type="password"
                name="new-password"
                autoComplete="new-password"
                className="input-control"
                placeholder={t('settings.newPasswordPlaceholder', { count: 8 })}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-confirm-password">{t('login.confirmPassword')}</label>
              <input
                id="settings-confirm-password"
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                className="input-control"
                placeholder={t('login.confirmPasswordPlaceholder')}
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <button 
              type="submit" 
              className="btn btn-primary" 
              disabled={passwordLoading}
              style={{ padding: '0.6rem 1.2rem', alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            >
              {passwordLoading ? (
                <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>
              ) : t('settings.updatePassword')}
            </button>
          </form>
        </div>

        {/* Moxfield Sync Panel */}
        <div id="moxfield-panel" className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', scrollMarginTop: '1rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <Globe size={20} style={{ color: 'var(--success, #4ade80)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('mfx.title')}</h3>
          </div>

          <MoxfieldPanel user={user} showToast={showToast} />
        </div>

        {/* Collection Backup & Data Options Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <Database size={20} style={{ color: 'var(--accent-red)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('settings.backupTitle')}</h3>
          </div>

          <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
            {t('settings.backupHint')}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={() => handleExport('csv')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <Download size={14} />
              <span>{t('settings.exportCsv')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('json')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <Download size={14} />
              <span>{t('settings.exportJson')}</span>
            </button>

            <div style={{ width: '100%', height: '0.75rem' }} />

            <button
              type="button"
              onClick={() => handleExportCardList('plain')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
              title={t('settings.cardlistHint')}
            >
              <Clipboard size={14} />
              <span>{t('settings.exportCardlistPlain')}</span>
            </button>
            <button
              type="button"
              onClick={() => handleExportCardList('detailed')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
              title={t('settings.cardlistHint')}
            >
              <Clipboard size={14} />
              <span>{t('settings.exportCardlistDetailed')}</span>
            </button>

            <label 
              className="btn btn-primary" 
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', cursor: 'pointer', margin: 0 }}
            >
              <Upload size={14} />
              <span>{t('settings.importBackup')}</span>
              <input
                type="file"
                accept=".json,.csv"
                onChange={handleImportFile}
                style={{ display: 'none' }}
              />
            </label>
          </div>
        </div>

        {/* Preferences Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <SlidersHorizontal size={20} style={{ color: 'var(--accent-yellow)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('prefs.title')}</h3>
          </div>

          {/* Interface language. The picker only appears once a second locale file
              exists to switch to — dropping one into src/locales is what makes it
              appear — but the call for translators shows either way, since with
              English alone there is nothing else to advertise it.
              This is not the card language: that is picked per card on entry. */}
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor={LOCALES.length > 1 ? 'settings-ui-lang' : undefined}>{t('prefs.language')}</label>
            {LOCALES.length > 1 ? (
              <>
                <select
                  id="settings-ui-lang"
                  className="select-control"
                  value={locale}
                  onChange={(e) => setLocale(e.target.value)}
                >
                  {LOCALES.map(code => (
                    <option key={code} value={code}>{localeName(code)}</option>
                  ))}
                </select>
                <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
                  {t('prefs.languageHint')}
                </div>
              </>
            ) : (
              <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
                {t('prefs.languageOnlyEnglish')}
              </div>
            )}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.75rem', marginTop: '0.5rem' }}>
              <Languages size={13} style={{ color: 'var(--accent-yellow)', flexShrink: 0 }} />
              <span style={{ color: 'var(--text-secondary)' }}>
                {t('prefs.translateCta')}{' '}
                <a
                  href={`${REPO_URL}/blob/main/docs/TRANSLATING.md`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent-yellow)', fontWeight: 600 }}
                >
                  {t('prefs.translateCtaLink')}
                </a>
              </span>
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="settings-theme">{t('prefs.theme')}</label>
            <select
              id="settings-theme"
              className="select-control"
              value={theme}
              onChange={(e) => {
                const val = e.target.value;
                setTheme(val);
                localStorage.setItem('theme', val);
                document.documentElement.setAttribute('data-theme', val);
                showToast(t('prefs.themeSet', { theme: t(`theme.${val}`) }));
              }}
            >
              <option value="dark">{t('theme.dark')}</option>
              <option value="light">{t('theme.light')}</option>
              <option value="lcars">{t('theme.lcars')}</option>
            </select>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
              {t('prefs.themeHint')}
            </div>
          </div>
        </div>

        {/* About / version */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <Info size={20} style={{ color: 'var(--accent-yellow)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('settings.aboutTitle')}</h3>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span>{shownVersion ? `Bindarr v${shownVersion}` : t('settings.versionUnknown')}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  title={t('settings.copyVersionHint')}
                  onClick={() => {
                    const text = `Bindarr app v${shownVersion || 'unknown'} | server v${versionInfo?.version || (backendReachable ? 'unknown' : 'unreachable')} | ${navigator.platform || 'unknown'} | ${navigator.userAgent}`;
                    navigator.clipboard?.writeText(text)
                      .then(() => showToast(t('settings.versionCopied')))
                      .catch(() => showToast(t('settings.errCopyShort')));
                  }}
                  style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
                >
                  <Clipboard size={12} /> {t('settings.copy')}
                </button>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {isDemo
                  ? t('settings.updateDemo')
                  : !backendReachable
                  ? t('settings.updateUnreachable')
                  : versionInfo?.check_failed
                    ? t('settings.updateGithubFailed')
                    : versionInfo?.update_available
                      ? t('settings.updateAvailable', { version: versionInfo.latest })
                      : versionInfo?.latest
                        ? t('settings.updateRunningLatest')
                        : t('settings.updateOnDemand')}
              </div>
              {versionSkew && (
                <div style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)', marginTop: '0.25rem' }}>
                  {t('settings.versionSkew', { version: versionSkew })}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {/* The demo answers /api from static fixtures, so a "check" would
                  report "you're up to date" without having checked anything. */}
              <button type="button" className="btn btn-secondary" onClick={handleCheckUpdate} disabled={checkingUpdate || isDemo}>
                <RefreshCw size={16} className={checkingUpdate ? 'spin-animation' : ''} />
                {t(checkingUpdate ? 'settings.checking' : 'settings.checkForUpdates')}
              </button>
              {versionInfo?.update_available && (
                <a
                  className="btn btn-primary"
                  href={versionInfo.release_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ textDecoration: 'none' }}
                >
                  <Download size={16} />
                  {t('settings.getVersion', { version: versionInfo.latest })}
                </a>
              )}
            </div>
          </div>

          {/* Support links. Each opens GitHub's own compose page in a new tab —
              prefilled, never submitted, so nothing is posted without the user
              reading it and pressing the button on GitHub. */}
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '0.5rem' }}>
              {t('settings.getInvolvedTitle')}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <a className="btn btn-secondary" href={bugReportUrl()} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Bug size={16} /> {t('settings.reportBug')}
              </a>
              <a className="btn btn-secondary" href={featureRequestUrl()} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Lightbulb size={16} /> {t('settings.requestFeature')}
              </a>
              <a className="btn btn-secondary" href={`${REPO_URL}/blob/main/docs/TRANSLATING.md`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Languages size={16} /> {t('settings.helpTranslate')}
              </a>
              <a className="btn btn-secondary" href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <MessagesSquare size={16} /> {t('settings.browseIssues')}
              </a>
              <a className="btn btn-secondary" href={`${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <ScrollText size={16} /> {t('settings.changelog')}
              </a>
              <a className="btn btn-secondary" href={REPO_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Github size={16} /> {t('settings.source')}
              </a>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem', lineHeight: 1.4 }}>
              {t('settings.reportNote')}
            </div>
          </div>

          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {t('settings.updateChecksNote')}{' '}
            <a href={versionInfo?.releases_url || `${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-yellow)' }}>
              Brenttime/bindarr
            </a>
          </div>
        </div>

        {/* Admin section: lives inside Settings (no separate tab). Rendered only
            for admin users; the panel itself is code-split behind Suspense. */}
        {user?.role === 'admin' && (
          <Suspense fallback={null}>
            <AdminPanel showToast={showToast} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

export default Settings;
