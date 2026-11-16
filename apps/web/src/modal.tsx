// The app's one dialog: a real <dialog>, so the browser handles focus, Escape and the backdrop.
// Shared, because a destructive confirm has to look and behave the same wherever it is asked.
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';

export function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
    return () => ref.current?.close();
  }, []);
  return (
    <dialog
      ref={ref}
      className="access-dialog"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <div className="modal-title">
        <h2>{title}</h2>
        <button type="button" className="text-button" aria-label="Close form" onClick={onClose}>
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}
