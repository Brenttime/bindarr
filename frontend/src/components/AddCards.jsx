import { useState } from 'react';
import { Camera, PackageOpen } from 'lucide-react';
import CameraScanner from './CameraScanner';
import SecretLairPanel from './SecretLairPanel';
import { useT } from '../utils/i18n';

// The "Add Cards" tab. It now holds two independent ways to put cards in the
// collection, so it opens on a choice between them rather than assuming the
// camera: scan a physical card, or bring in a whole Secret Lair drop.
//
// The scanner is the default because it is the reason this tab exists and the
// path nearly everyone takes. The segmented control stays mounted across the
// switch so the search box does not lose what you typed, and each view is
// unmounted when hidden — a half-finished Secret Lair preview costs nothing to
// throw away, and neither view has state worth keeping alive across the other.
export default function AddCards({ onAddSuccess, showToast, setActiveTab }) {
  const { t } = useT();
  const [mode, setMode] = useState('scan');

  // Demo build has no backend: neither the camera scanner nor the Secret Lair
  // importer can work, so show a notice instead of two controls that would fail.
  if (import.meta.env.VITE_DEMO) {
    return (
      <div className='glass-panel' style={{ maxWidth: '520px', margin: '2rem auto', padding: '2rem', textAlign: 'center' }}>
        <Camera size={40} style={{ color: 'var(--accent-yellow)', marginBottom: '1rem' }} />
        <h2 style={{ fontSize: '1.2rem', color: 'var(--text-strong)', marginBottom: '0.75rem' }}>{t('demo.unavailableTitle')}</h2>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.9rem', lineHeight: 1.5 }}>
          {t('demo.unavailableBody')}
        </p>
      </div>
    );
  }

  const MODES = [
    { key: 'scan', icon: Camera, label: t('addcards.tabScan') },
    { key: 'secretlair', icon: PackageOpen, label: t('addcards.tabSecretLair') },
  ];

  return (
    <div>
      {/* Segmented control: the house `.sub-nav-tabs` treatment (index.css),
          as on the public collection page. Reusing it rather than hand-rolling
          keeps it on-theme for free — the glass pill track, the gradient-filled
          active state, and the (hover:hover) touch guard all come from there.
          `.sl-mode-tabs` centres it; the width is set per mode so it matches the
          pane underneath it (each pane centres itself at its own measure). */}
      <div
        className="sub-nav-tabs sl-mode-tabs"
        role="tablist"
        aria-label={t('addcards.modePickerAria')}
      >
        {MODES.map(({ key, icon: Icon, label }, i) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={mode === key}
            tabIndex={mode === key ? 0 : -1}
            className={`sub-nav-tab ${mode === key ? 'active' : ''}`}
            onClick={() => setMode(key)}
            onKeyDown={(e) => {
              const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : null;
              if (step === null) return;
              e.preventDefault();
              const nextIdx = (i + step + MODES.length) % MODES.length;
              setMode(MODES[nextIdx].key);
              e.currentTarget.parentElement?.querySelectorAll('[role="tab"]')[nextIdx]?.focus();
            }}
          >
            <Icon size={16} aria-hidden="true" /> {label}
          </button>
        ))}
      </div>

      {mode === 'scan'
        ? <CameraScanner onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />
        : <SecretLairPanel onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />}
    </div>
  );
}
