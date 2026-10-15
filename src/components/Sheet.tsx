// A dialog that slides up as a sheet on phones and zooms in on wider screens (styles: .modal).
// Escape or tapping outside closes it, and the page behind doesn't scroll while it's open.
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  /** Buttons along the bottom. */
  foot?: ReactNode;
  /** Extra class on the card, e.g. for a wider layout. */
  className?: string;
}

export function Sheet({ title, onClose, children, foot, className = '' }: Props) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only the top-most dialog closes (a place picker opened from a sheet sits on top of it).
    const onKey = (e: KeyboardEvent) => {
      const modals = document.querySelectorAll('.modal');
      if (e.key === 'Escape' && modals[modals.length - 1] === root.current) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('modal-open');
    return () => {
      document.removeEventListener('keydown', onKey);
      // Another dialog may still be open underneath.
      if (!document.querySelector('.modal')) document.body.classList.remove('modal-open');
    };
  }, []);
  return createPortal(
    // React passes a portal's events up to its React parents: a form submitted in here must not
    // also submit a form around the component that opened the sheet.
    <div ref={root} className="modal" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }} onSubmit={(e) => e.stopPropagation()}>
      <div className={`modal-card sheet ${className}`.trim()} role="dialog" aria-modal="true">
        <div className="modal-h"><strong>{title}</strong><button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>✕</button></div>
        <div className="sheet-body">{children}</div>
        {foot ? <div className="modal-foot">{foot}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
