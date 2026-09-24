import { useEffect, useRef, useState } from 'react';
import { Loader2, Upload, Check, Download, AlertTriangle, RefreshCw } from 'lucide-react';
import { useT } from '../utils/i18n';

// Settings -> Sync from ManaBox.
//
// Pick a ManaBox "Export collection" CSV, see exactly what will change, then
// apply. The server re-plans on apply and refuses if the collection moved since
// the preview, so the numbers shown are the numbers written. Every run keeps a
// markdown record (removed / added / lists / rejected) you can download later.
export default function ManaboxSyncPanel({ showToast }) {
  const { t } = useT();
  const fileRef = useRef(null);
  const [file, setFile] = useState(null);
  const [csv, setCsv] = useState('');
  const [includeLists, setIncludeLists] = useState(true);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [runs, setRuns] = useState([]);

  const loadRuns = () => fetch('/api/manabox-sync/runs').then(r => (r.ok ? r.json() : [])).then(setRuns).catch(() => {});
  useEffect(() => { loadRuns(); }, []);

  const post = async (path, extra = {}) => {
    const res = await fetch(`/api/manabox-sync/${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ csv, includeLists, fileName: file?.name, ...extra }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || t('mbsync.failed'));
    return j;
  };

  const pick = async (f) => {
    setPreview(null); setError('');
    if (!f) return;
    setFile(f);
    const text = await f.text();
    setCsv(text);
    setBusy('preview');
    try {
      const res = await fetch('/api/manabox-sync/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: text, includeLists, fileName: f.name }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || t('mbsync.failed'));
      setPreview(j);
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const repreview = async (lists) => {
    setIncludeLists(lists);
    if (!csv) return;
    setBusy('preview');
    try { setPreview(await post('preview', { includeLists: lists })); } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const apply = async () => {
    setBusy('apply'); setError('');
    try {
      const j = await post('apply', { expectBefore: preview.summary.before });
      showToast?.(t('mbsync.done', { before: j.summary.before, after: j.summary.after }), 'success');
      setPreview(null); setFile(null); setCsv('');
      if (fileRef.current) fileRef.current.value = '';
      loadRuns();
    } catch (e) { setError(e.message); } finally { setBusy(''); }
  };

  const download = (name, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    a.click(); URL.revokeObjectURL(url);
  };

  const s = preview?.summary;
  const nothing = s && !s.add && !s.remove && !s.redate && !s.listsCreate && !s.listsUpdate;

  return (
    <div className="mbsync">
      <p className="mbsync-lead">{t('mbsync.lead')}</p>
      <ol className="mbsync-steps">
        <li>{t('mbsync.step1')}</li>
        <li>{t('mbsync.step2')}</li>
        <li>{t('mbsync.step3')}</li>
      </ol>

      <div className="mbsync-pick">
        <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={e => pick(e.target.files?.[0])} />
        <button type="button" className="btn-primary" disabled={!!busy} onClick={() => fileRef.current?.click()}>
          {busy === 'preview' ? <Loader2 size={16} className="spin" /> : <Upload size={16} />}
          {file ? t('mbsync.pickAnother') : t('mbsync.pick')}
        </button>
        {file && <span className="mbsync-file">{file.name}</span>}
        <label className="mbsync-toggle">
          <input type="checkbox" checked={includeLists} disabled={!!busy} onChange={e => repreview(e.target.checked)} />
          {t('mbsync.includeLists')}
        </label>
      </div>

      {error && <div className="mbsync-error"><AlertTriangle size={16} /> {error}</div>}

      {s && (
        <div className="mbsync-preview">
          <div className="mbsync-stats">
            <div><span>{t('mbsync.collection')}</span><strong>{s.before.toLocaleString()} → {s.after.toLocaleString()}</strong></div>
            <div className="add"><span>{t('mbsync.add')}</span><strong>+{s.add.toLocaleString()}</strong></div>
            <div className="remove"><span>{t('mbsync.remove')}</span><strong>−{s.remove.toLocaleString()}</strong></div>
            <div><span>{t('mbsync.redate')}</span><strong>{s.redate.toLocaleString()}</strong></div>
            {includeLists && <div><span>{t('mbsync.lists')}</span><strong>{s.listsCreate + s.listsUpdate}</strong></div>}
          </div>
          <ul className="mbsync-notes">
            <li>{t('mbsync.keptHand', { n: s.handAdded.toLocaleString() })}</li>
            {s.listsSkipped?.length > 0 && <li>{t('mbsync.listsSkipped', { names: s.listsSkipped.join(', ') })}</li>}
            {s.rejected > 0 && <li className="warn">{t('mbsync.rejected', { n: s.rejected })}</li>}
          </ul>
          <div className="mbsync-actions">
            <button type="button" className="btn-secondary" onClick={() => download('manabox-sync-preview.md', preview.report)}>
              <Download size={16} /> {t('mbsync.review')}
            </button>
            <button type="button" className="btn-primary" disabled={!!busy || nothing} onClick={apply}>
              {busy === 'apply' ? <Loader2 size={16} className="spin" /> : nothing ? <Check size={16} /> : <RefreshCw size={16} />}
              {nothing ? t('mbsync.upToDate') : t('mbsync.apply')}
            </button>
          </div>
        </div>
      )}

      {runs.length > 0 && (
        <div className="mbsync-runs">
          <h4>{t('mbsync.history')}</h4>
          {runs.map(r => (
            <div key={r.id} className="mbsync-run">
              <span>{new Date(`${r.created_at.replace(' ', 'T')}Z`).toLocaleString()}</span>
              <span>+{r.summary.add} / −{r.summary.remove}</span>
              <a href={`/api/manabox-sync/runs/${r.id}/report`}>{t('mbsync.record')}</a>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
