import { useEffect, useRef } from "react";
import { CloseIcon } from "./icons";

/** Modal dialog in WaveMint's style (same frame as Settings). */
export function Dialog({ title, onClose, children, footer, wide = false, labelledBy = "lib-dialog-title" }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    ref.current?.focus();
    const handleKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current?.();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      previouslyFocused?.focus?.();
    };
  }, []);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div
        className={`modal lib-dialog ${wide ? "lib-dialog--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal__header">
          <h2 id={labelledBy} className="heading-md">
            {title}
          </h2>
          <button type="button" className="btn btn--ghost btn--icon" onClick={onClose} aria-label="Close">
            <CloseIcon size={16} />
          </button>
        </div>
        <div className="modal__body lib-dialog__body">{children}</div>
        {footer && <div className="lib-dialog__footer">{footer}</div>}
      </div>
    </div>
  );
}
