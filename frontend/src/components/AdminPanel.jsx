import React, { useState, useEffect, useRef } from 'react';
import { Shield, UserPlus, Key, Trash2, ToggleLeft, ToggleRight, Search, Users, Globe, Database, Play, RefreshCw, AlertTriangle, HardDriveDownload, Download, BookOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { useBackGuard } from '../utils/useBackGuard';
import { LANGUAGES, langName } from '../utils/languages';
import { defaultGame, gameOptions, showGamePicker, gameLabel, enabledGames } from '../utils/games';
import SetBrowserModal from './SetBrowserModal';
import { useT } from '../utils/i18n';

const formatBytes = (n) => {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const isActive = (p) => p && (p.status === 'fetching' || p.status === 'indexing');
const isGlobalActive = (p) => p && p.status === 'running';

function AdminPanel({ showToast }) {
  const { t, locale } = useT();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filterText, setFilterText] = useState('');

  // Add User Form States
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('member');
  const [addLoading, setAddLoading] = useState(false);

  // Change Password Modal States
  const [targetUser, setTargetUser] = useState(null);
  useBackGuard(!!targetUser, () => setTargetUser(null));
  const [updatePassword, setUpdatePassword] = useState('');
  const [pwdLoading, setPwdLoading] = useState(false);

  // Instance Settings States
  const [publicBaseUrl, setPublicBaseUrl] = useState('');
  const [settingsLoading, setSettingsLoading] = useState(false);

  // Set-index build states
  const [builds, setBuilds] = useState([]);
  const [buildProgress, setBuildProgress] = useState({});
  const [buildGame, setBuildGame] = useState(() => defaultGame());
  // A set index is per language — the art differs, so an English index cannot
  // match a Japanese card.
  const [buildLang, setBuildLang] = useState('en');
  const [buildSetCode, setBuildSetCode] = useState('');
  const [preview, setPreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showSetBrowser, setShowSetBrowser] = useState(false);
  useBackGuard(showSetBrowser, () => setShowSetBrowser(false));
  const [setNameMap, setSetNameMap] = useState({});
  const [expandedGames, setExpandedGames] = useState(() => new Set(enabledGames()));
  const pollRef = useRef(null);
  const mountedRef = useRef(true);

  // Global scan index states
  const [globals, setGlobals] = useState([]);
  const [globalProgress, setGlobalProgress] = useState({});

  // Database backup states
  const [backups, setBackups] = useState([]);
  const [backupLoading, setBackupLoading] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    fetchUsers();
    fetchSettings();
    fetchBackups();
    Promise.all([fetchBuilds(), fetchGlobals()]).then(([a, b]) => { if (a || b) startPolling(); });
    fetchSetNames();
    return () => {
      mountedRef.current = false;
      stopPolling();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build a lookup map: "game|setCode" → set name. MTG set ids are prefixed
  // "mtg-" in the sets table (e.g. "mtg-mh3") but the build keys use the bare
  // code ("mh3"), so we strip the prefix when building the lookup.
  const fetchSetNames = async () => {
    try {
      const res = await fetch('/api/sets');
      if (!res.ok) return;
      const allSets = await res.json();
      if (!mountedRef.current) return;
      const map = {};
      for (const s of allSets) {
        const code = s.game === 'mtg' && s.id.startsWith('mtg-') ? s.id.slice(4) : s.id;
        map[`${s.game}|${code}`] = s.name;
      }
      setSetNameMap(map);
    } catch { /* non-critical */ }
  };

  const toggleGameExpand = (game) => {
    setExpandedGames(prev => {
      const next = new Set(prev);
      if (next.has(game)) next.delete(game); else next.add(game);
      return next;
    });
  };

  const stopPolling = () => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  };
  const startPolling = () => {
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      const [a, b] = await Promise.all([fetchBuilds(), fetchGlobals()]);
      if (!a && !b) stopPolling();
    }, 1500);
  };

  // Returns whether a global build is in flight (drives polling).
  const fetchGlobals = async () => {
    try {
      const res = await fetch('/api/admin/global-indexes');
      if (!res.ok) return false;
      const data = await res.json();
      if (!mountedRef.current) return false;
      setGlobals(data.games || []);
      setGlobalProgress(data.progress || {});
      return Object.values(data.progress || {}).some(isGlobalActive);
    } catch (err) {
      console.error(err);
      return false;
    }
  };

  const handleBuildGlobal = async (game) => {
    if (!window.confirm(t('admin.confirmGlobalBuild', { game: game.toUpperCase() }))) return;
    try {
      const res = await fetch('/api/admin/global-indexes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game }),
      });
      const data = await res.json();
      if (res.ok) { showToast(data.message); await fetchGlobals(); startPolling(); }
      else showToast(data.error || t('admin.errGlobalBuild'));
    } catch (err) {
      console.error(err);
      showToast(t('admin.errGlobalBuildGeneric'));
    }
  };

  const handleStopGlobal = async (game) => {
    if (!window.confirm(t('admin.confirmStopGlobal', { game: game.toUpperCase() }))) return;
    try {
      const res = await fetch(`/api/admin/global-indexes/${game}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) { showToast(data.message); fetchGlobals(); }
      else showToast(data.error || t('admin.errStopBuild'));
    } catch (err) {
      console.error(err);
      showToast(t('admin.errStopBuildGeneric'));
    }
  };

  // Returns whether any build is currently in flight (drives polling).
  const fetchBuilds = async () => {
    try {
      const res = await fetch('/api/admin/set-indexes');
      if (!res.ok) return false;
      const data = await res.json();
      if (!mountedRef.current) return false;
      setBuilds(data.builds || []);
      setBuildProgress(data.progress || {});
      return Object.values(data.progress || {}).some(isActive);
    } catch (err) {
      console.error(err);
      return false;
    }
  };

  const handlePreview = async () => {
    const set = buildSetCode.trim();
    if (!set) return;
    setPreviewLoading(true);
    setPreview(null);
    try {
      const res = await fetch(`/api/admin/set-indexes/preview?game=${buildGame}&set=${encodeURIComponent(set)}&lang=${buildLang}`);
      const data = await res.json();
      if (res.ok) setPreview(data);
      else showToast(data.error || t('admin.errPreview'));
    } catch (err) {
      console.error(err);
      showToast(t('admin.errLookupSet'));
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleBuild = async (game, set, cardCount, lang = buildLang) => {
    const inLang = `${langName(lang)} ${game}`;
    const warn = cardCount
      ? t('admin.confirmBuild', { lang: inLang, set, count: cardCount, size: formatBytes(cardCount * 20 * 1024) })
      : t('admin.confirmRebuild', { lang: inLang, set });
    if (!window.confirm(warn)) return;
    try {
      const res = await fetch('/api/admin/set-indexes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, set, lang }),
      });
      const data = await res.json();
      if (res.ok) {
        showToast(data.message);
        setPreview(null);
        setBuildSetCode('');
        await fetchBuilds();
        startPolling();
      } else {
        showToast(data.error || t('admin.errStartBuild'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errStartBuildGeneric'));
    }
  };

  // Silent build — no confirm dialog, doesn't close preview/manual input.
  // Used by the Set Browser modal so users can queue multiple sets quickly.
  const handleBuildSilent = async (game, set, lang = buildLang) => {
    try {
      const res = await fetch('/api/admin/set-indexes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, set, lang }),
      });
      const data = await res.json();
      if (!mountedRef.current) return;
      if (res.ok) {
        showToast(data.message);
        await fetchBuilds();
        startPolling();
      } else {
        showToast(data.error || t('admin.errStartBuild'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errStartBuildGeneric'));
    }
  };

  const handleDeleteBuild = async (game, set, lang = 'en') => {
    if (!window.confirm(t('admin.confirmRemoveIndex', { lang: langName(lang), game, set }))) return;
    try {
      const res = await fetch(`/api/admin/set-indexes/${game}/${encodeURIComponent(set)}?lang=${encodeURIComponent(lang)}`, { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) { showToast(data.message); fetchBuilds(); }
      else showToast(data.error || t('admin.errRemoveIndex'));
    } catch (err) {
      console.error(err);
      showToast(t('admin.errRemoveIndexGeneric'));
    }
  };

  const handleSeedDatabase = async () => {
    if (!window.confirm(t('admin.confirmSeed'))) {
      return;
    }
    try {
      const res = await fetch('/api/admin/seed-cards', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        showToast(data.message);
        fetchUsers(); // Refresh stats
      } else {
        showToast(t('admin.errSeed'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errSeedGeneric'));
    }
  };

  const fetchBackups = async () => {
    try {
      const res = await fetch('/api/admin/backups');
      if (res.ok) {
        const data = await res.json();
        if (!mountedRef.current) return;
        setBackups(data.backups || []);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleDownloadBackup = async (file) => {
    try {
      const res = await fetch(`/api/admin/backups/${encodeURIComponent(file)}/download`);
      if (!res.ok) { showToast(t('admin.errDownload')); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = file;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error(err);
      showToast(t('admin.errDownloadGeneric'));
    }
  };

  const handleBackup = async () => {
    setBackupLoading(true);
    try {
      const res = await fetch('/api/admin/backups', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        showToast(t('admin.backupCreated', { file: data.file, size: formatBytes(data.size) }));
        fetchBackups();
      } else {
        showToast(data.error || t('admin.errBackup'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errBackupGeneric'));
    } finally {
      setBackupLoading(false);
    }
  };

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/admin/users');
      if (response.ok) {
        const data = await response.json();
        if (!mountedRef.current) return;
        setUsers(data);
      } else {
        showToast(t('admin.errUserList'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('common.errBackend'));
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  };

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/settings');
      if (response.ok) {
        const data = await response.json();
        if (!mountedRef.current) return;
        setPublicBaseUrl(data.public_base_url || '');
      }
    } catch (err) {
      console.error(err);
    }
  };

  const handleSaveSettings = async (e) => {
    e.preventDefault();
    setSettingsLoading(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ public_base_url: publicBaseUrl })
      });

      if (response.ok) {
        const data = await response.json();
        setPublicBaseUrl(data.public_base_url || '');
        showToast(t('admin.settingsUpdated'));
      } else {
        const data = await response.json();
        showToast(data.error || t('admin.errSettings'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errSettingsGeneric'));
    } finally {
      setSettingsLoading(false);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    if (newUsername.length < 3) {
      showToast(t('admin.errUsernameShort', { count: 3 }));
      return;
    }
    if (newPassword.length < 8) {
      showToast(t('login.errPasswordShort', { count: 8 }));
      return;
    }

    setAddLoading(true);
    try {
      const response = await fetch('/api/admin/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: newUsername, password: newPassword, role: newRole })
      });

      if (response.ok) {
        showToast(t('admin.userCreated', { name: newUsername }));
        setNewUsername('');
        setNewPassword('');
        setNewRole('member');
        fetchUsers();
      } else {
        const data = await response.json();
        showToast(data.error || t('admin.errCreateUser'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errCreateUserGeneric'));
    } finally {
      setAddLoading(false);
    }
  };

  const handleToggleRole = async (user) => {
    const nextRole = user.role === 'admin' ? 'member' : 'admin';
    if (user.username === 'admin') {
      showToast(t('admin.errDemoteRoot'));
      return;
    }

    if (!window.confirm(t('admin.confirmRoleChange', { name: user.username, role: nextRole }))) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: nextRole })
      });

      if (response.ok) {
        showToast(t('admin.roleUpdated', { role: nextRole, name: user.username }));
        fetchUsers();
      } else {
        const data = await response.json();
        showToast(data.error || t('admin.errRoleChange'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errRoleChangeGeneric'));
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!targetUser) return;
    if (updatePassword.length < 8) {
      showToast(t('login.errPasswordShort', { count: 8 }));
      return;
    }

    setPwdLoading(true);
    try {
      const response = await fetch(`/api/admin/users/${targetUser.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: updatePassword })
      });

      if (response.ok) {
        showToast(t('admin.passwordUpdated', { name: targetUser.username }));
        setUpdatePassword('');
        setTargetUser(null);
      } else {
        const data = await response.json();
        showToast(data.error || t('settings.errPasswordUpdate'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('settings.errPasswordUpdateGeneric'));
    } finally {
      setPwdLoading(false);
    }
  };

  const handleDeleteUser = async (user) => {
    if (user.username === 'admin') {
      showToast(t('admin.errDeleteRoot'));
      return;
    }

    if (!window.confirm(t('admin.confirmDeleteUser', { name: user.username }))) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: 'DELETE'
      });

      if (response.ok) {
        showToast(t('admin.userDeleted', { name: user.username }));
        fetchUsers();
      } else {
        const data = await response.json();
        showToast(data.error || t('admin.errDeleteUser'));
      }
    } catch (err) {
      console.error(err);
      showToast(t('admin.errDeleteUserGeneric'));
    }
  };

  const filteredUsers = users.filter(u =>
    (u.username || '').toLowerCase().includes(filterText.toLowerCase()) ||
    (u.role || '').toLowerCase().includes(filterText.toLowerCase())
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Header Info */}
      <div className="glass-panel" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 style={{ fontSize: '1.25rem', color: 'var(--text-strong)' }}>{t('admin.title')}</h2>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem' }}>{t('admin.subtitle')}</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button 
            type="button" 
            className="btn btn-secondary btn-sm" 
            onClick={handleSeedDatabase}
            style={{ padding: '0.5rem 1rem', height: '34px', fontSize: '0.8rem', border: '1px solid var(--border-glass)' }}
          >
            🧪 {t('admin.generateTestCards')}
          </button>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', background: 'rgba(255,255,255,0.02)', padding: '0.5rem 1rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border-glass)', height: '34px' }}>
            <Users size={16} style={{ color: 'var(--accent-red)' }} />
            <span style={{ fontSize: '0.85rem', fontWeight: 600 }}>{t('admin.totalTrainers', { count: users.length })}</span>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: '1.5rem' }} className="admin-grid-layout">
        {/* Registration Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <UserPlus size={18} style={{ color: 'var(--accent-red)' }} />
            {t('admin.registerTitle')}
          </h3>
          <form onSubmit={handleAddUser} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-new-username">{t('admin.newUsername')}</label>
              <input
                id="admin-new-username"
                type="text"
                name="new-username"
                autoComplete="off"
                className="input-control"
                placeholder={t('login.usernamePlaceholder')}
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                required
                disabled={addLoading}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-new-password">{t('admin.initialPassword')}</label>
              <input
                id="admin-new-password"
                type="password"
                name="new-user-password"
                autoComplete="new-password"
                className="input-control"
                placeholder={t('settings.newPasswordPlaceholder', { count: 8 })}
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                required
                disabled={addLoading}
              />
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-new-role">{t('admin.role')}</label>
              <select id="admin-new-role" className="select-control" value={newRole} onChange={(e) => setNewRole(e.target.value)} disabled={addLoading}>
                <option value="member">{t('admin.roleMember')}</option>
                <option value="admin">{t('admin.roleAdministrator')}</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary" style={{ padding: '0.6rem', fontWeight: 700 }} disabled={addLoading}>
              {addLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : t('admin.createAccount')}
            </button>
          </form>
        </div>

        {/* Instance Settings Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Globe size={18} style={{ color: 'var(--accent-red)' }} />
            {t('admin.instanceTitle')}
          </h3>
          <form onSubmit={handleSaveSettings} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={{ background: 'rgba(255, 71, 71, 0.03)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.8rem', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
              {t('admin.instanceHint', { envVar: 'PUBLIC_BASE_URL' })}
            </div>
            <div className="form-group" style={{ marginBottom: 0 }}>
              <label htmlFor="admin-public-base-url">{t('admin.publicBaseUrl')}</label>
              <input
                id="admin-public-base-url"
                type="text"
                name="public-base-url"
                autoComplete="off"
                className="input-control"
                placeholder="https://cards.example.com"
                value={publicBaseUrl}
                onChange={(e) => setPublicBaseUrl(e.target.value)}
                disabled={settingsLoading}
              />
            </div>
            <button type="submit" className="btn btn-primary" style={{ padding: '0.6rem', fontWeight: 700, alignSelf: 'flex-start' }} disabled={settingsLoading}>
              {settingsLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : t('admin.saveSettings')}
            </button>
          </form>
        </div>

        {/* Set Index Builds Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Database size={18} style={{ color: 'var(--accent-red)' }} />
            {t('admin.setIndexTitle')}
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.4 }}>
            {t('admin.setIndexHint')}
          </p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'flex-end' }}>
            {showGamePicker() && (
              <div className="form-group" style={{ marginBottom: 0, width: '120px' }}>
                <label htmlFor="build-game">{t('collection.fGame')}</label>
                <select id="build-game" className="select-control" value={buildGame} onChange={(e) => { setBuildGame(e.target.value); setPreview(null); }}>
                  {gameOptions().map(g => <option key={g.value} value={g.value}>{g.short}</option>)}
                </select>
              </div>
            )}
            <div className="form-group" style={{ marginBottom: 0, width: '150px' }}>
              <label htmlFor="build-lang">{t('card.language')}</label>
              <select id="build-lang" className="select-control" value={buildLang} onChange={(e) => { setBuildLang(e.target.value); setPreview(null); }}>
                {LANGUAGES.map(l => <option key={l.code} value={l.code}>{l.name}</option>)}
              </select>
            </div>
            <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: '140px' }}>
              <label htmlFor="build-set">{t('admin.setCode')}</label>
              <input
                id="build-set"
                type="text"
                className="input-control"
                placeholder="mh3 / sv1"
                value={buildSetCode}
                onChange={(e) => { setBuildSetCode(e.target.value); setPreview(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handlePreview(); } }}
              />
            </div>
            <button type="button" className="btn btn-secondary" style={{ height: '42px' }} onClick={handlePreview} disabled={previewLoading || !buildSetCode.trim()}>
              {previewLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : t('admin.preview')}
            </button>
            <button type="button" className="btn btn-secondary" style={{ height: '42px', display: 'flex', alignItems: 'center', gap: '0.35rem' }} onClick={() => setShowSetBrowser(true)}>
              <BookOpen size={14} /> {t('sets.browseTitle')}
            </button>
          </div>

          {preview && (
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.75rem', background: 'rgba(255,193,71,0.05)', border: '1px solid var(--border-glass)', padding: '0.75rem 1rem', borderRadius: 'var(--radius-sm)', fontSize: '0.85rem' }}>
              <AlertTriangle size={16} style={{ color: 'var(--accent-yellow)', flexShrink: 0 }} />
              <span style={{ flex: 1, minWidth: '180px', color: 'var(--text-secondary)' }}>
                {t('admin.previewSummary', { count: preview.cardCount, size: formatBytes(preview.estBytes) })}
              </span>
              <button type="button" className="btn btn-primary" onClick={() => handleBuild(preview.game, preview.set, preview.cardCount, preview.lang || buildLang)} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                <Play size={14} /> {t('admin.buildSet')}
              </button>
            </div>
          )}

          {builds.length === 0 && !Object.values(buildProgress).some(isActive) ? (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              {t('admin.noSetIndexes')}
            </div>
          ) : (
            <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th style={{ width: '28px' }}></th>
                    <th>{t('sets.colSet')}</th>
                    <th>{t('admin.colName')}</th>
                    <th>{t('sets.colCards')}</th>
                    <th>{t('admin.colSize')}</th>
                    <th>{t('admin.colStatus')}</th>
                    <th>{t('admin.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const builtKeys = new Set(builds.map(b => b.key));
                    // Progress keys are "game|set|lang" — same shape listBuilds
                    // returns, so a pending row lines up with its finished one.
                    // FAILED builds are listed too: they write nothing to disk, so
                    // without this a build that could never succeed (a set the
                    // provider has no cards for) was invisible everywhere, which
                    // read as "the build silently did nothing".
                    const pending = Object.entries(buildProgress)
                      .filter(([key, p]) => (isActive(p) || p.status === 'error') && !builtKeys.has(key))
                      .map(([key]) => {
                        const [game, set, lang] = key.split('|');
                        return { key, game, set, lang: lang || 'en', cardCount: 0, sizeBytes: 0, builtAt: 0 };
                      });
                    const all = [...pending, ...builds];

                    // Group by game — only the games Settings is showing.
                    return enabledGames().map(g => {
                      const group = all.filter(b => b.game === g);
                      if (group.length === 0) return null;
                      const expanded = expandedGames.has(g);
                      const totalCards = group.reduce((sum, b) => sum + (b.cardCount || 0), 0);
                      const totalSize = group.reduce((sum, b) => sum + (b.sizeBytes || 0), 0);
                      return (
                        <React.Fragment key={g}>
                          {/* Game header row */}
                          <tr
                            style={{ cursor: 'pointer', background: 'rgba(255,255,255,0.03)' }}
                            onClick={() => toggleGameExpand(g)}
                          >
                            <td style={{ padding: '0.35rem 0.5rem' }}>
                              {expanded ? <ChevronDown size={14} style={{ color: 'var(--text-muted)' }} /> : <ChevronRight size={14} style={{ color: 'var(--text-muted)' }} />}
                            </td>
                            <td colSpan={2} style={{ fontWeight: 700, textTransform: 'uppercase', fontSize: '0.8rem', color: 'var(--text-strong)' }}>
                              {gameLabel(g)}
                              <span style={{ marginLeft: '0.5rem', fontWeight: 400, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                                {t('admin.setCount', { count: group.length })}
                              </span>
                            </td>
                            <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{totalCards || '-'}</td>
                            <td style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{totalSize ? formatBytes(totalSize) : '-'}</td>
                            <td colSpan={2}></td>
                          </tr>
                          {/* Detail rows */}
                          {expanded && group.map((b) => {
                            const p = buildProgress[b.key];
                            const active = isActive(p);
                            const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
                            // setNameMap is keyed "game|set" (English names from the
                            // sets table); a build key now carries its language too.
                            const setName = setNameMap[`${b.game}|${b.set}`] || '';
                            const lang = b.lang || 'en';
                            return (
                              <tr key={b.key}>
                                <td></td>
                                <td style={{ fontWeight: 700, color: 'var(--text-strong)', fontFamily: 'monospace', fontSize: '0.8rem' }}>
                                  {b.set}
                                  {lang !== 'en' && (
                                    <span style={{ marginLeft: '0.35rem', fontFamily: 'inherit', fontWeight: 600, fontSize: '0.65rem', color: 'var(--accent-yellow)', border: '1px solid var(--border-glass)', borderRadius: '3px', padding: '0 4px' }} title={langName(lang)}>
                                      {lang.toUpperCase()}
                                    </span>
                                  )}
                                </td>
                                <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', maxWidth: '180px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={setName}>{setName || '-'}</td>
                                <td>{b.cardCount || (p && p.total) || '-'}</td>
                                <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{b.sizeBytes ? formatBytes(b.sizeBytes) : '-'}</td>
                                <td style={{ minWidth: '160px' }}>
                                  {active ? (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                                      <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                                        <div style={{ height: '100%', width: p.status === 'fetching' ? '15%' : `${pct}%`, background: 'var(--accent-red)', transition: 'width 0.4s ease' }}></div>
                                      </div>
                                      <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                                        {p.status === 'fetching' ? t('admin.fetchingList') : t('admin.indexingProgress', { done: p.done, total: p.total, pct })}
                                      </span>
                                    </div>
                                  ) : p && p.status === 'error' ? (
                                    // Reason inline, not just a tooltip: "no card
                                    // data for this set in Korean" is the whole
                                    // answer, and a hover hint hides it.
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.15rem', maxWidth: '260px' }}>
                                      <span style={{ fontSize: '0.75rem', color: 'var(--accent-red)', fontWeight: 700 }}>{t('admin.statusFailed')}</span>
                                      <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', lineHeight: 1.3 }} title={p.error}>{p.error}</span>
                                    </div>
                                  ) : (
                                    <span style={{ fontSize: '0.75rem', color: 'var(--accent-green, #4ade80)' }}>{t('admin.statusReady')}</span>
                                  )}
                                </td>
                                <td>
                                  <div style={{ display: 'flex', gap: '0.35rem' }}>
                                    <button
                                      className="btn btn-secondary btn-icon-only"
                                      title={t('admin.rebuild')}
                                      onClick={() => handleBuild(b.game, b.set, 0, lang)}
                                      disabled={active}
                                    >
                                      <RefreshCw size={14} />
                                    </button>
                                    <button
                                      className="btn btn-danger btn-icon-only"
                                      title={t('admin.removeIndex')}
                                      onClick={() => handleDeleteBuild(b.game, b.set, lang)}
                                      disabled={active}
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </React.Fragment>
                      );
                    });
                  })()}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Global Scan Index Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', borderBottom: '1px solid var(--border-glass)', paddingBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Globe size={18} style={{ color: 'var(--accent-red)' }} />
            {t('admin.globalTitle')}
          </h3>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.4 }}>
            {t('admin.globalHint')}
          </p>
          <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
            <table className="collection-table">
              <thead>
                <tr>
                  <th>{t('collection.fGame')}</th>
                  <th>{t('sets.colCards')}</th>
                  <th>{t('admin.colSize')}</th>
                  <th>{t('admin.colStatus')}</th>
                  <th>{t('admin.colActions')}</th>
                </tr>
              </thead>
              <tbody>
                {/* Global indexes are English-only by design (see scanMatch) and
                    only listed for the games Settings is showing. */}
                {globals.filter(g => enabledGames().includes(g.game)).map((g) => {
                  const p = globalProgress[g.game];
                  const active = isGlobalActive(p);
                  const pct = p && p.total ? Math.round((p.done / p.total) * 100) : 0;
                  const cards = g.embed.cards || g.orb.cards || 0;
                  const bytes = (g.embed.bytes || 0) + (g.orb.bytes || 0);
                  return (
                    <tr key={g.game}>
                      <td style={{ textTransform: 'uppercase', fontWeight: 700, color: 'var(--text-strong)' }}>{g.game}</td>
                      <td>{cards ? cards.toLocaleString() : '-'}</td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{bytes ? formatBytes(bytes) : '-'}</td>
                      <td style={{ minWidth: '180px' }}>
                        {active ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
                            <div style={{ height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' }}>
                              <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent-red)', transition: 'width 0.4s ease' }}></div>
                            </div>
                            <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)' }}>
                              {t('admin.globalProgress', { phase: p.phase === 'orb' ? 'ORB' : t('admin.phaseEmbeddings'), done: p.done, total: p.total || '?', pct })}
                            </span>
                          </div>
                        ) : p && p.status === 'error' ? (
                          <span style={{ fontSize: '0.75rem', color: 'var(--accent-red)' }} title={p.error}>{t('admin.statusFailed')}</span>
                        ) : p && p.status === 'stopped' ? (
                          <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>{t('admin.statusStopped')}</span>
                        ) : g.embed.present && g.orb.present ? (
                          <span style={{ fontSize: '0.75rem', color: 'var(--accent-green, #4ade80)' }}>{t('admin.statusReady')}</span>
                        ) : (
                          <span style={{ fontSize: '0.75rem', color: 'var(--accent-yellow)' }}>{t('admin.statusNotBuilt')}</span>
                        )}
                      </td>
                      <td>
                        {active ? (
                          <button className="btn btn-danger btn-icon-only" title={t('admin.stopBuild')} onClick={() => handleStopGlobal(g.game)}>
                            <AlertTriangle size={14} />
                          </button>
                        ) : (
                          <button className="btn btn-secondary btn-icon-only" title={t('admin.rebuildGlobal')} onClick={() => handleBuildGlobal(g.game)}>
                            <RefreshCw size={14} />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Database Backup Panel */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <HardDriveDownload size={18} style={{ color: 'var(--accent-red)' }} />
              {t('admin.backupTitle')}
            </h3>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={handleBackup}
              disabled={backupLoading}
              style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', height: '34px' }}
            >
              {backupLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : <><HardDriveDownload size={14} /> {t('admin.backUpNow')}</>}
            </button>
          </div>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', margin: 0, lineHeight: 1.4 }}>
            {t('admin.backupHint', { keep: 10, dbFile: 'bindarr.db' })}
          </p>

          {backups.length === 0 ? (
            <div style={{ padding: '1.5rem', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '0.85rem' }}>
              {t('admin.noBackups')}
            </div>
          ) : (
            <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>{t('admin.colFile')}</th>
                    <th>{t('admin.colCreated')}</th>
                    <th>{t('admin.colSize')}</th>
                    <th>{t('admin.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {backups.map(b => (
                    <tr key={b.file}>
                      <td style={{ fontWeight: 600, color: 'var(--text-strong)', fontFamily: 'monospace', fontSize: '0.78rem' }}>{b.file}</td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{new Date(b.created_at).toLocaleString(locale)}</td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>{formatBytes(b.size)}</td>
                      <td>
                        <button
                          type="button"
                          className="btn btn-secondary btn-icon-only"
                          title={t('admin.downloadBackup')}
                          onClick={() => handleDownloadBackup(b.file)}
                        >
                          <Download size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* User Maintenance Table */}
        <div className="glass-panel" style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem' }}>
            <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Shield size={18} style={{ color: 'var(--accent-yellow)' }} />
              {t('admin.manageUsers')}
            </h3>
            <div style={{ position: 'relative', width: '100%', maxWidth: '220px' }}>
              <input
                type="text"
                className="input-control"
                placeholder={t('admin.filterTrainers')}
                aria-label={t('admin.filterTrainers')}
                value={filterText}
                onChange={(e) => setFilterText(e.target.value)}
                style={{ width: '100%', paddingLeft: '2rem', paddingVertical: '0.35rem', fontSize: '0.85rem' }}
              />
              <Search size={14} style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            </div>
          </div>

          {loading ? (
            <div className="spinner"></div>
          ) : filteredUsers.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary)' }}>
              {t('admin.noTrainerMatch')}
            </div>
          ) : (
            <div className="collection-table-wrapper" style={{ overflowX: 'auto' }}>
              <table className="collection-table">
                <thead>
                  <tr>
                    <th>{t('login.username')}</th>
                    <th>{t('admin.role')}</th>
                    <th>{t('admin.colCreatedAt')}</th>
                    <th>{t('sets.colCards')}</th>
                    <th>{t('admin.colPortfolio')}</th>
                    <th>{t('admin.colActions')}</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredUsers.map(user => (
                    <tr key={user.id}>
                      <td style={{ fontWeight: 700, color: 'var(--text-strong)' }}>{user.username}</td>
                      <td>
                        <span style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          padding: '0.2rem 0.5rem',
                          borderRadius: '12px',
                          backgroundColor: user.role === 'admin' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                          color: user.role === 'admin' ? 'var(--accent-red)' : 'var(--accent-blue)',
                          border: user.role === 'admin' ? '1px solid rgba(239,68,68,0.2)' : '1px solid rgba(59,130,246,0.2)'
                        }}>
                          {t(user.role === 'admin' ? 'admin.roleAdmin' : 'admin.roleMember')}
                        </span>
                      </td>
                      <td style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>
                        {new Date(user.created_at).toLocaleDateString(locale)}
                      </td>
                      <td style={{ fontWeight: 600 }}>{t('admin.userCards', { count: user.total_cards })}</td>
                      <td style={{ fontWeight: 700, color: 'var(--accent-yellow)' }}>
                        ${(user.total_value || 0).toLocaleString(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: '0.35rem' }}>
                          <button 
                            className="btn btn-secondary btn-icon-only" 
                            title={t('admin.toggleRole')}
                            onClick={() => handleToggleRole(user)}
                            disabled={user.username === 'admin'}
                          >
                            {user.role === 'admin' ? <ToggleRight size={14} style={{ color: 'var(--accent-red)' }} /> : <ToggleLeft size={14} />}
                          </button>
                          <button 
                            className="btn btn-secondary btn-icon-only" 
                            title={t('admin.resetPassword')}
                            onClick={() => setTargetUser(user)}
                          >
                            <Key size={14} style={{ color: 'var(--accent-yellow)' }} />
                          </button>
                          <button 
                            className="btn btn-danger btn-icon-only" 
                            title={t('admin.deleteAccount')}
                            onClick={() => handleDeleteUser(user)}
                            disabled={user.username === 'admin'}
                          >
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Change Password Dialog Overlay */}
      {targetUser && (
        <div className="modal-overlay" style={{
          position: 'fixed',
          top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.6)',
          backdropFilter: 'blur(4px)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 999
        }}>
          <div className="glass-panel" style={{ maxWidth: '380px', width: '100%', maxHeight: '90vh', overflowY: 'auto', overscrollBehavior: 'contain', padding: '2rem', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
            <div>
              <h3 style={{ color: 'var(--text-strong)', fontSize: '1.1rem' }}>{t('admin.resetPassword')}</h3>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem' }}>{t('admin.resetPasswordFor')} <strong>{targetUser.username}</strong></p>
            </div>
            <form onSubmit={handleChangePassword} style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label htmlFor="admin-reset-password">{t('settings.newPassword')}</label>
                <input
                  id="admin-reset-password"
                  type="password"
                  name="reset-password"
                  autoComplete="new-password"
                  className="input-control"
                  placeholder={t('settings.newPasswordPlaceholder', { count: 8 })}
                  value={updatePassword}
                  onChange={(e) => setUpdatePassword(e.target.value)}
                  required
                  autoFocus
                  disabled={pwdLoading}
                />
              </div>
              <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                <button type="button" className="btn btn-secondary" onClick={() => { setTargetUser(null); setUpdatePassword(''); }} disabled={pwdLoading}>
                  {t('common.cancel')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={pwdLoading}>
                  {pwdLoading ? <div className="spinner" style={{ width: '14px', height: '14px', margin: 0, borderWidth: '2px' }}></div> : t('admin.savePassword')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Set Browser Modal */}
      {showSetBrowser && (
        <SetBrowserModal
          game={buildGame}
          lang={buildLang}
          onClose={() => setShowSetBrowser(false)}
          onStartBuild={handleBuildSilent}
          existingKeys={builds.map(b => b.key)}
          progress={buildProgress}
        />
      )}
    </div>
  );
}

export default AdminPanel;
