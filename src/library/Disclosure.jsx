import { useState } from "react";
import { ChevronIcon } from "./icons";

/**
 * A collapsible section (Advanced metadata, Technical details, Version
 * history). The content mounts only while open; form values live in the
 * parent, so collapsing never resets or drops them.
 */
export function Disclosure({ label, hint = "", defaultOpen = false, className = "", children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`lib-disclosure ${open ? "is-open" : ""} ${className}`.trim()}>
      <button type="button" className="lib-disclosure__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <ChevronIcon direction={open ? "down" : "right"} size={14} />
        <span className="lib-disclosure__label">{label}</span>
        {hint && <span className="lib-disclosure__hint">{hint}</span>}
      </button>
      {open && <div className="lib-disclosure__body">{children}</div>}
    </div>
  );
}
