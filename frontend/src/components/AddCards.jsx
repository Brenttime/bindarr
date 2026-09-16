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
      <div style={{ display: 'flex', gap: '0.4rem', marginBottom: '1rem' }}>
        {MODES.map(({ key, icon: Icon, label }) => (
          <button
            key={key}
            className='glass-btn'
            onClick={() => setMode(key)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              fontWeight: mode === key ? 700 : 400,
              color: mode === key ? 'var(--accent-yellow)' : 'var(--text-secondary)',
              border: `1px solid ${mode === key ? 'var(--accent-yellow)' : 'var(--border)'}`,
            }}
          >
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>
      {mode === 'scan'
        ? <CameraScanner onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />
        : <SecretLairPanel onAddSuccess={onAddSuccess} showToast={showToast} setActiveTab={setActiveTab} />}
    </div>
  );
}
