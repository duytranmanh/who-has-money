"use client";

import { useId, useRef } from "react";

// Native modal behavior traps focus and supports Escape; XP classes supply the window chrome.
export default function ConfirmDeleteButton({ label, message, disabled, title, onConfirm }: {
  label: string; message: string; disabled: boolean; title?: string; onConfirm: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const id = useId();

  return <>
    <button type="button" className="delete-icon-button" disabled={disabled} aria-label={label} title={title ?? label} onClick={() => {
      dialog.current?.showModal();
      cancelButton.current?.focus();
    }}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" />
      </svg>
    </button>
    <dialog ref={dialog} className="window delete-confirmation" role="alertdialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-message`}>
      <div className="title-bar">
        <div className="title-bar-text" id={`${id}-title`}>Confirm deletion</div>
        <div className="title-bar-controls">
          <button type="button" aria-label="Close" onClick={() => dialog.current?.close()} />
        </div>
      </div>
      <div className="window-body">
        <div className="delete-confirmation-message">
          <span className="delete-confirmation-icon" aria-hidden="true">!</span>
          <p id={`${id}-message`}>{message}</p>
        </div>
        <div className="delete-confirmation-actions">
          <button type="button" className="delete-button" disabled={disabled} onClick={() => {
            dialog.current?.close();
            onConfirm();
          }}>Delete</button>
          <button type="button" ref={cancelButton} onClick={() => dialog.current?.close()}>Cancel</button>
        </div>
      </div>
    </dialog>
  </>;
}
