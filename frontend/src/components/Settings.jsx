import { useState, useEffect } from 'react';
import { ShieldAlert, Share2, Clipboard, RefreshCw, KeyRound, Check, Database, Download, Upload, Eye, EyeOff, SlidersHorizontal, Info, Bug, Lightbulb, MessagesSquare, ScrollText, Github } from 'lucide-react';

function Settings({ user, onUpdateUser, showToast }) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);
  
  const [shareEnabled, setShareEnabled] = useState(user?.share_enabled === 1);
  const [shareLocations, setShareLocations] = useState(user?.share_locations === 1);
  const [shareLoading, setShareLoading] = useState(false);

  const [tcgApiKey, setTcgApiKey] = useState(user?.tcg_api_key || '');
  const [apiKeyLoading, setApiKeyLoading] = useState(false);

  const [publicBaseUrl, setPublicBaseUrl] = useState('');

  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'dark');
  const [defaultGame, setDefaultGame] = useState(() => localStorage.getItem('default_game') || 'pokemon');
  const [autoConfirm, setAutoConfirm] = useState(() => localStorage.getItem('scanner_auto_confirm') === '1');

  const [versionInfo, setVersionInfo] = useState(null);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [backendReachable, setBackendReachable] = useState(true);

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
      if (data.check_failed) showToast('Could not reach GitHub to check for updates.');
      else if (data.update_available) showToast(`Version ${data.latest} is available.`);
      else showToast('You are on the latest version.');
    } catch (err) {
      console.error(err);
      setBackendReachable(false);
      showToast('Could not reach the server to check for updates.');
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

  const REPO_URL = 'https://github.com/thenotoriousJeremy/bindarr';

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

    if (!window.confirm(`Import "${file.name}"? Cards from this file will be merged into your existing collection. This cannot be undone.`)) {
      e.target.value = '';
      return;
    }

    const reader = new FileReader();
    const isJson = file.name.endsWith('.json');
    const format = isJson ? 'json' : 'csv';

    reader.onload = async (event) => {
      try {
        const fileData = event.target.result;
        showToast('Importing collection...');
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
          showToast(result.message || 'Import successful!');
        } else {
          showToast(`Import failed: ${result.error || 'Unknown error'}`);
        }
      } catch (err) {
        console.error(err);
        showToast(`Import failed: ${err.message}`);
      }
    };

    reader.onerror = () => {
      showToast('Failed to read the selected file.');
    };

    reader.readAsText(file);
    e.target.value = null;
  };

  useEffect(() => {
    if (user) {
      setShareEnabled(user.share_enabled === 1 || user.share_enabled === true);
      setShareLocations(user.share_locations === 1 || user.share_locations === true);
      setTcgApiKey(user.tcg_api_key || '');
    }
  }, [user]);

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    if (!currentPassword) {
      showToast('Please enter your current password.');
      return;
    }
    if (password.length < 8) {
      showToast('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirmPassword) {
      showToast('Passwords do not match.');
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
        showToast('Password updated successfully.');
        setCurrentPassword('');
        setPassword('');
        setConfirmPassword('');
      } else {
        const data = await response.json();
        showToast(data.error || 'Failed to update password.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating password.');
    } finally {
      setPasswordLoading(false);
    }
  };

  const handleExport = async (format) => {
    try {
      const response = await fetch(`/api/export?format=${format}`);
      if (!response.ok) {
        showToast('Export failed.');
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
      showToast('Error exporting collection.');
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
        showToast(checked ? 'Collection sharing enabled.' : 'Collection sharing disabled.');
      } else {
        setShareEnabled(!checked); // Revert
        showToast('Failed to update sharing settings.');
      }
    } catch (err) {
      console.error(err);
      setShareEnabled(!checked);
      showToast('Error updating sharing settings.');
    } finally {
      setShareLoading(false);
    }
  };

  const handleLocationsToggle = async (checked) => {
    setShareLocations(checked);
    setShareLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ share_locations: checked })
      });
      if (response.ok) {
        const data = await response.json();
        onUpdateUser(data.user);
        showToast(checked ? 'Card locations now visible on your share page.' : 'Card locations hidden from your share page.');
      } else {
        setShareLocations(!checked);
        showToast('Failed to update location sharing.');
      }
    } catch (err) {
      console.error(err);
      setShareLocations(!checked);
      showToast('Error updating location sharing.');
    } finally {
      setShareLoading(false);
    }
  };

  const handleRegenerateToken = async () => {
    if (!window.confirm('Are you sure you want to regenerate your share token? Any existing links you shared will stop working.')) {
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
        showToast('New share link generated.');
      } else {
        showToast('Failed to regenerate token.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error regenerating token.');
    } finally {
      setShareLoading(false);
    }
  };

  const handleApiKeyChange = async (e) => {
    e.preventDefault();
    setApiKeyLoading(true);
    try {
      const response = await fetch('/api/auth/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tcg_api_key: tcgApiKey })
      });

      if (response.ok) {
        const data = await response.json();
        onUpdateUser(data.user);
        showToast('TCG API Key updated successfully.');
      } else {
        const data = await response.json();
        showToast(data.error || 'Failed to update API Key.');
      }
    } catch (err) {
      console.error(err);
      showToast('Error updating API Key.');
    } finally {
      setApiKeyLoading(false);
    }
  };

  const origin = publicBaseUrl || `${window.location.protocol}//${window.location.host}`;
  const activeTheme = theme || localStorage.getItem('theme') || 'dark';
  const themeQuery = activeTheme !== 'dark' ? `&theme=${encodeURIComponent(activeTheme)}` : '';
  const shareUrl = `${origin}/share/${user?.share_token}${activeTheme !== 'dark' ? `?theme=${encodeURIComponent(activeTheme)}` : ''}`;
  const tradeUrl = `${origin}/share/${user?.share_token}?list=trade${themeQuery}`;
  const wishlistUrl = `${origin}/share/${user?.share_token}?list=wishlist${themeQuery}`;

  const [copiedType, setCopiedType] = useState(''); // 'collection', 'trade', 'wishlist'

  const copyToClipboard = (url, type) => {
    navigator.clipboard.writeText(url).then(() => {
      setCopiedType(type);
      showToast(`Copied public ${type} link to clipboard.`);
      setTimeout(() => setCopiedType(''), 2000);
    }).catch(() => {
      showToast('Could not copy to clipboard. Copy the link manually.');
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Title Panel */}
      <div className="glass-panel">
        <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)' }}>Trainer Settings</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>Manage your account security and collection sharing options.</p>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: '1.5rem' }} className="settings-grid">
        {/* Sharing Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <Share2 size={20} style={{ color: 'var(--accent-red)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>Collection Sharing</h3>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem' }}>Share My Library</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Allow anyone with your link to view your collection.</div>
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
                backgroundColor: shareEnabled ? 'var(--type-grass)' : '#334155',
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
                <label>Standard Collection Share Link</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="input-control" 
                    value={shareUrl} 
                    readOnly 
                    style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(shareUrl, 'collection')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'collection' ? <Check size={14} style={{ color: 'var(--type-grass)' }} /> : <Clipboard size={14} />}
                    <span>Copy</span>
                  </button>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Trade Binder Share Link</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="input-control" 
                    value={tradeUrl} 
                    readOnly 
                    style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(tradeUrl, 'trade')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'trade' ? <Check size={14} style={{ color: 'var(--type-grass)' }} /> : <Clipboard size={14} />}
                    <span>Copy</span>
                  </button>
                </div>
              </div>

              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Wishlist Share Link</label>
                <div style={{ display: 'flex', gap: '0.5rem' }}>
                  <input 
                    type="text" 
                    className="input-control" 
                    value={wishlistUrl} 
                    readOnly 
                    style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.2)', color: 'var(--text-secondary)', cursor: 'default' }}
                  />
                  <button className="btn btn-secondary" onClick={() => copyToClipboard(wishlistUrl, 'wishlist')} style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', whiteSpace: 'nowrap' }}>
                    {copiedType === 'wishlist' ? <Check size={14} style={{ color: 'var(--type-grass)' }} /> : <Clipboard size={14} />}
                    <span>Copy</span>
                  </button>
                </div>
              </div>

              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem' }}>
                💡 <strong>Tip:</strong> Share links automatically use your current active theme ({activeTheme}). You can also force a specific theme for visitors by adding <code>?theme=lcars</code>, <code>?theme=light</code>, or <code>?theme=dark</code> to the end of any share link.
              </div>

              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
                <div>
                  <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem' }}>Show Card Locations</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Reveal which binder or box each card is stored in.</div>
                </div>
                <label className="switch-control" style={{ position: 'relative', display: 'inline-block', width: '46px', height: '24px' }}>
                  <input
                    type="checkbox"
                    checked={shareLocations}
                    onChange={(e) => handleLocationsToggle(e.target.checked)}
                    disabled={shareLoading}
                    style={{ opacity: 0, width: 0, height: 0 }}
                  />
                  <span className={`switch-slider ${shareLocations ? 'active' : ''}`} style={{
                    position: 'absolute',
                    cursor: 'pointer',
                    top: 0, left: 0, right: 0, bottom: 0,
                    backgroundColor: shareLocations ? 'var(--type-grass)' : '#334155',
                    transition: '0.3s',
                    borderRadius: '24px'
                  }}>
                    <span style={{
                      position: 'absolute',
                      height: '18px', width: '18px',
                      left: shareLocations ? '24px' : '4px',
                      bottom: '3px',
                      backgroundColor: '#fff',
                      transition: '0.3s',
                      borderRadius: '50%',
                      boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
                    }}></span>
                  </span>
                </label>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button
                  className="btn btn-secondary"
                  onClick={handleRegenerateToken}
                  disabled={shareLoading}
                  style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8rem', padding: '0.4rem 0.8rem' }}
                >
                  <RefreshCw size={12} className={shareLoading ? 'spin-animation' : ''} />
                  <span>Regenerate Link</span>
                </button>
              </div>
            </div>
          )}

          {!shareEnabled && (
            <div style={{ display: 'flex', gap: '0.5rem', background: 'rgba(255, 71, 71, 0.05)', border: '1px solid rgba(255,71,71,0.1)', padding: '0.75rem', borderRadius: 'var(--radius-sm)', color: 'var(--text-secondary)', fontSize: '0.8rem' }}>
              <ShieldAlert size={16} style={{ color: 'var(--accent-red)', flexShrink: 0 }} />
              <span>Your library is currently private. People visiting your share link will not be able to view your cards.</span>
            </div>
          )}
        </div>

        {/* Change Password Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <KeyRound size={20} style={{ color: 'var(--accent-yellow)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>Security</h3>
          </div>

          <form onSubmit={handlePasswordChange} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="current-password">Current Password</label>
              <input
                id="current-password"
                type="password"
                name="current-password"
                autoComplete="current-password"
                className="input-control"
                placeholder="Your current password"
                value={currentPassword}
                onChange={(e) => setCurrentPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-new-password">New Password</label>
              <input
                id="settings-new-password"
                type="password"
                name="new-password"
                autoComplete="new-password"
                className="input-control"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={passwordLoading}
              />
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-confirm-password">Confirm Password</label>
              <input
                id="settings-confirm-password"
                type="password"
                name="confirm-password"
                autoComplete="new-password"
                className="input-control"
                placeholder="Re-enter password"
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
              ) : 'Update Password'}
            </button>
          </form>
        </div>

        {/* Pokémon TCG API Key Settings */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <KeyRound size={20} style={{ color: 'var(--accent-red)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>Pokémon TCG API Key</h3>
          </div>

          <form onSubmit={handleApiKeyChange} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ background: 'rgba(255, 71, 71, 0.03)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              Card searches use the free Pokémon TCG API. Adding your own key raises your rate limit so searches stay fast during bulk scanning. Grab a free key at <a href="https://dev.pokemontcg.io" target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-yellow)', fontWeight: 600 }}>dev.pokemontcg.io</a> and paste it below. It&apos;s optional.
            </div>

            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="settings-tcg-api-key">API Key</label>
              <div style={{ position: 'relative' }}>
                <input
                  id="settings-tcg-api-key"
                  type={showApiKey ? 'text' : 'password'}
                  name="tcg-api-key"
                  autoComplete="off"
                  className="input-control"
                  placeholder="e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                  value={tcgApiKey}
                  onChange={(e) => setTcgApiKey(e.target.value)}
                  disabled={apiKeyLoading}
                  style={{ fontFamily: 'monospace', paddingRight: '2.4rem', width: '100%' }}
                />
                <button
                  type="button"
                  onClick={() => setShowApiKey((v) => !v)}
                  aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
                  title={showApiKey ? 'Hide API key' : 'Show API key'}
                  style={{ position: 'absolute', right: '0.5rem', top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', padding: 0 }}
                >
                  {showApiKey ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            <button 
              type="submit" 
              className="btn btn-primary" 
              disabled={apiKeyLoading}
              style={{ padding: '0.6rem 1.2rem', alignSelf: 'flex-start', display: 'flex', alignItems: 'center', gap: '0.5rem' }}
            >
              {apiKeyLoading ? (
                <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div>
              ) : 'Save API Key'}
            </button>
          </form>
        </div>

        {/* Collection Backup & Data Options Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <Database size={20} style={{ color: 'var(--accent-red)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>Collection Backup & Data</h3>
          </div>

          <div style={{ background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
            Export your card collection as a CSV or JSON backup, or import a previously exported database. Importing will merge cards into your collection.
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.75rem' }}>
            <button
              type="button"
              onClick={() => handleExport('csv')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <Download size={14} />
              <span>Export CSV</span>
            </button>
            <button
              type="button"
              onClick={() => handleExport('json')}
              className="btn btn-secondary"
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem' }}
            >
              <Download size={14} />
              <span>Export JSON</span>
            </button>

            <label 
              className="btn btn-primary" 
              style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', fontSize: '0.85rem', cursor: 'pointer', margin: 0 }}
            >
              <Upload size={14} />
              <span>Import Backup</span>
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
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>Preferences</h3>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="settings-theme">Theme</label>
            <select
              id="settings-theme"
              className="select-control"
              value={theme}
              onChange={(e) => {
                const val = e.target.value;
                setTheme(val);
                localStorage.setItem('theme', val);
                document.documentElement.setAttribute('data-theme', val);
                showToast(`Theme set to ${val === 'lcars' ? 'LCARS' : val.charAt(0).toUpperCase() + val.slice(1)}.`);
              }}
            >
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="lcars">LCARS</option>
            </select>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
              Changes the app&apos;s color scheme instantly.
            </div>
          </div>

          <div className="form-group" style={{ marginBottom: 0 }}>
            <label htmlFor="settings-default-game">Default Game</label>
            <select
              id="settings-default-game"
              className="select-control"
              value={defaultGame}
              onChange={(e) => {
                const val = e.target.value;
                setDefaultGame(val);
                localStorage.setItem('default_game', val);
                showToast(`Default game set to ${val === 'mtg' ? 'Magic: The Gathering' : 'Pokémon'}.`);
              }}
            >
              <option value="pokemon">Pokémon</option>
              <option value="mtg">Magic: The Gathering</option>
            </select>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.4rem' }}>
              The scanner and collection open scoped to this game.
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem' }}>Scanner Auto-Confirm</div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Add high-confidence single matches automatically, skipping the confirm dialog.</div>
            </div>
            <label className="switch-control" style={{ position: 'relative', display: 'inline-block', width: '46px', height: '24px', flexShrink: 0 }}>
              <input
                type="checkbox"
                checked={autoConfirm}
                onChange={(e) => {
                  const checked = e.target.checked;
                  setAutoConfirm(checked);
                  localStorage.setItem('scanner_auto_confirm', checked ? '1' : '0');
                  showToast(checked ? 'Scanner auto-confirm enabled.' : 'Scanner auto-confirm disabled.');
                }}
                style={{ opacity: 0, width: 0, height: 0 }}
              />
              <span className={`switch-slider ${autoConfirm ? 'active' : ''}`} style={{
                position: 'absolute',
                cursor: 'pointer',
                top: 0, left: 0, right: 0, bottom: 0,
                backgroundColor: autoConfirm ? 'var(--type-grass)' : '#334155',
                transition: '0.3s',
                borderRadius: '24px'
              }}>
                <span style={{
                  position: 'absolute',
                  height: '18px', width: '18px',
                  left: autoConfirm ? '24px' : '4px',
                  bottom: '3px',
                  backgroundColor: '#fff',
                  transition: '0.3s',
                  borderRadius: '50%',
                  boxShadow: '0 2px 4px rgba(0,0,0,0.3)'
                }}></span>
              </span>
            </label>
          </div>
        </div>

        {/* About / version */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.75rem' }}>
            <Info size={20} style={{ color: 'var(--accent-yellow)' }} />
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>About Bindarr</h3>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem', background: 'rgba(255,255,255,0.01)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)' }}>
            <div>
              <div style={{ fontWeight: 700, color: 'var(--text-strong)', fontSize: '0.95rem', display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                <span>Bindarr {shownVersion ? `v${shownVersion}` : '(version unknown)'}</span>
                <button
                  type="button"
                  className="btn btn-secondary"
                  title="Copy version and environment details for a bug report"
                  onClick={() => {
                    const text = `Bindarr app v${shownVersion || 'unknown'} | server v${versionInfo?.version || (backendReachable ? 'unknown' : 'unreachable')} | ${navigator.platform || 'unknown'} | ${navigator.userAgent}`;
                    navigator.clipboard?.writeText(text)
                      .then(() => showToast('Version details copied.'))
                      .catch(() => showToast('Could not copy to clipboard.'));
                  }}
                  style={{ padding: '0.15rem 0.45rem', fontSize: '0.7rem' }}
                >
                  <Clipboard size={12} /> Copy
                </button>
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                {isDemo
                  ? 'Update checks need the Bindarr backend — this is a static demo.'
                  : !backendReachable
                  ? 'Server unreachable — update checks are unavailable right now.'
                  : versionInfo?.check_failed
                    ? 'Could not reach GitHub. Check your connection and try again.'
                    : versionInfo?.update_available
                      ? `Version ${versionInfo.latest} is available.`
                      : versionInfo?.latest
                        ? 'You are running the latest version.'
                        : 'Updates are only checked when you ask.'}
              </div>
              {versionSkew && (
                <div style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)', marginTop: '0.25rem' }}>
                  Server is running v{versionSkew}. Restart it to finish updating.
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              {/* The demo answers /api from static fixtures, so a "check" would
                  report "you're up to date" without having checked anything. */}
              <button type="button" className="btn btn-secondary" onClick={handleCheckUpdate} disabled={checkingUpdate || isDemo}>
                <RefreshCw size={16} className={checkingUpdate ? 'spin-animation' : ''} />
                {checkingUpdate ? 'Checking…' : 'Check for updates'}
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
                  Get {versionInfo.latest}
                </a>
              )}
            </div>
          </div>

          {/* Support links. Each opens GitHub's own compose page in a new tab —
              prefilled, never submitted, so nothing is posted without the user
              reading it and pressing the button on GitHub. */}
          <div>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em', marginBottom: '0.5rem' }}>
              Report a problem
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
              <a className="btn btn-secondary" href={bugReportUrl()} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Bug size={16} /> Report a bug
              </a>
              <a className="btn btn-secondary" href={featureRequestUrl()} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Lightbulb size={16} /> Request a feature
              </a>
              <a className="btn btn-secondary" href={`${REPO_URL}/issues`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <MessagesSquare size={16} /> Browse issues
              </a>
              <a className="btn btn-secondary" href={`${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <ScrollText size={16} /> Changelog
              </a>
              <a className="btn btn-secondary" href={REPO_URL} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
                <Github size={16} /> Source
              </a>
            </div>
            <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginTop: '0.5rem', lineHeight: 1.4 }}>
              Bug reports open a prefilled GitHub issue with your version and browser
              filled in — nothing is sent until you review it and submit on GitHub, and
              nothing about your collection is included.
            </div>
          </div>

          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            Update checks contact the public GitHub releases API for{' '}
            <a href={versionInfo?.releases_url || `${REPO_URL}/releases`} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent-yellow)' }}>
              thenotoriousJeremy/bindarr
            </a>. Nothing about your collection is sent.
          </div>
        </div>
      </div>
    </div>
  );
}

export default Settings;
