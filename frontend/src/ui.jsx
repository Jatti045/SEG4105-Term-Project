import { useEffect, useId, useRef } from "react";

// Shown while a page's data loads, or if loading failed.
export function Loading({ error }) {
  return error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>;
}

export function StatusBadge({ kind, children }) {
  return <span className={`status ${kind}`}>{children}</span>;
}

// A modal dialog. Esc, the × button, or a click on the backdrop closes it.
export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null);
  const titleId = useId();
  // Unmounting removes the dialog, which closes it, so there's no cleanup to do.
  // (Calling close() there would fire onClose straight away under StrictMode.)
  useEffect(() => {
    if (!ref.current.open) ref.current.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      className={`dialog${wide ? " wide" : ""}`}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose(); // a click on the backdrop
      }}
    >
      <div className="dialog-body">
        <div className="dialog-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn-icon" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}
