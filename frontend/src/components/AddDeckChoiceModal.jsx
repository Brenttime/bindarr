import { useEffect, useRef } from 'react';
import { ArrowRight, FolderPlus, Globe, PackageOpen, X } from 'lucide-react';
import { useBackGuard } from '../utils/useBackGuard';
import { useT } from '../utils/i18n';

export default function AddDeckChoiceModal({ open, onClose, onCustom, onPrecon, onMoxfield }) {
  const { t } = useT();
  const customRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useBackGuard(open, onClose);
  useEffect(() => {
    if (!open) return undefined;
    const focusTimer = setTimeout(() => customRef.current?.focus(), 50);
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onCloseRef.current?.();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!open) return null;

  const choices = [
    {
      key: 'custom',
      Icon: FolderPlus,
      title: t('deck.addCustomTitle'),
      body: t('deck.addCustomBody'),
      action: onCustom,
      ref: customRef,
    },
    {
      key: 'precon',
      Icon: PackageOpen,
      title: t('deck.addPreconTitle'),
      body: t('deck.addPreconBody'),
      note: t('deck.addPreconTagHint'),
      badge: t('deck.addPreconBadge'),
      action: onPrecon,
      featured: true,
    },
    {
      key: 'moxfield',
      Icon: Globe,
      title: t('deck.addMoxfieldTitle'),
      body: t('deck.addMoxfieldBody'),
      action: onMoxfield,
    },
  ];

  return (
    <div
      className="modal-overlay"
      style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.82)', backdropFilter: 'blur(7px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 999 }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <section
        className="glass-panel add-deck-chooser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-deck-title"
        aria-describedby="add-deck-description"
      >
        <button
          className="btn btn-secondary btn-icon-only add-deck-chooser-close"
          onClick={onClose}
          aria-label={t('common.close')}
        >
          <X size={16} />
        </button>

        <div className="add-deck-chooser-heading">
          <span className="add-deck-chooser-kicker">{t('deck.addDeck')}</span>
          <h3 id="add-deck-title">{t('deck.addDeckTitle')}</h3>
          <p id="add-deck-description">{t('deck.addDeckSubtitle')}</p>
        </div>

        <div className="add-deck-choice-grid">
          {choices.map(({ key, Icon, title, body, note, badge, action, featured, ref }) => (
            <button
              key={key}
              ref={ref}
              type="button"
              className={`add-deck-choice${featured ? ' add-deck-choice-featured' : ''}`}
              onClick={action}
            >
              <span className="add-deck-choice-icon"><Icon size={21} /></span>
              <span className="add-deck-choice-copy">
                <span className="add-deck-choice-title-row">
                  <strong>{title}</strong>
                  {badge && <span className="add-deck-choice-badge">{badge}</span>}
                </span>
                <span className="add-deck-choice-body">{body}</span>
                {note && <span className="add-deck-choice-note">{note}</span>}
              </span>
              <ArrowRight className="add-deck-choice-arrow" size={18} />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}
