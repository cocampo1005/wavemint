import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronIcon } from "./icons";

/**
 * A small context menu at (x, y). `items` are { label, icon, onSelect,
 * danger, disabled, hint }, "separator", or { label, submenu: () => items }
 * (shown in place, with a way back). Closes on a choice, Escape, a click
 * elsewhere, scrolling or resizing.
 */
export function TrackMenu({ x, y, title, items, onClose }) {
  const ref = useRef(null);
  const [page, setPage] = useState(null); // { label, items }
  const [position, setPosition] = useState({ left: x, top: y });
  const shown = page ? page.items : items;

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const rect = element.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(x, window.innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - rect.height - 8)),
    });
    element.querySelector("[role=menuitem]:not(:disabled)")?.focus();
  }, [x, y, page]);

  useEffect(() => {
    // Opening the menu can scroll the list (bringing a half-visible ⋯ into
    // view); only scrolling after that closes it.
    const openedAt = performance.now();
    const close = (event) => {
      if (event.type === "mousedown" && ref.current?.contains(event.target)) return;
      if (event.type === "scroll" && (performance.now() - openedAt < 300 || ref.current?.contains(event.target))) return;
      onClose();
    };
    const onKey = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        if (page) setPage(null);
        else onClose();
        return;
      }
      if (!["ArrowDown", "ArrowUp"].includes(event.key)) return;
      event.preventDefault();
      const buttons = [...ref.current.querySelectorAll("[role=menuitem]:not(:disabled)")];
      const index = buttons.indexOf(document.activeElement);
      buttons[(index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    document.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
      document.removeEventListener("scroll", close, true);
    };
  }, [onClose, page]);

  return (
    <div className="lib-menu" role="menu" aria-label={title || "Song actions"} ref={ref} style={position} onContextMenu={(event) => event.preventDefault()}>
      {title && !page && <div className="lib-menu__title">{title}</div>}
      {page && (
        <button type="button" role="menuitem" className="lib-menu__item lib-menu__back" onClick={() => setPage(null)}>
          <ChevronIcon size={14} direction="left" /> {page.label}
        </button>
      )}
      {shown.map((item, index) =>
        item === "separator" ? (
          <div key={`s${index}`} className="lib-menu__separator" role="separator" />
        ) : (
          <button
            key={`${index}-${item.label}`}
            type="button"
            role="menuitem"
            className={`lib-menu__item ${item.danger ? "is-danger" : ""}`}
            disabled={item.disabled}
            onClick={async () => {
              if (item.submenu) {
                setPage({ label: item.label, items: await item.submenu() });
                return;
              }
              onClose();
              item.onSelect?.();
            }}
          >
            <span className="lib-menu__icon">{item.icon}</span>
            <span className="lib-menu__label">{item.label}</span>
            {item.hint && <span className="lib-menu__hint">{item.hint}</span>}
            {item.submenu && <ChevronIcon size={14} />}
          </button>
        ),
      )}
    </div>
  );
}
