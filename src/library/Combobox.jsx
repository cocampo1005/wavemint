import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { findName, nameKey, rankSuggestions } from "./suggest";

/** `name` with the part matching `query` emphasized. */
function Highlight({ name, query }) {
  const key = nameKey(query);
  const at = key ? name.toLocaleLowerCase().indexOf(key) : -1;
  if (at < 0) return name;
  return (
    <>
      {name.slice(0, at)}
      <mark>{name.slice(at, at + key.length)}</mark>
      {name.slice(at + key.length)}
    </>
  );
}

/**
 * A text field with a suggestions list (the ARIA combobox pattern), used by
 * the Artist, Album and Genre fields. Typing is never restricted: the value
 * is whatever is typed, and a suggestion only replaces it when chosen.
 *
 * - `options`: the suggestions, already free of duplicates (suggest.js).
 * - `browse`: focusing the field lists every option before anything is
 *   typed; otherwise the list only appears once typing matches something.
 * - `createLabel(name)`: offers a typed value that isn't an option as a
 *   choice of its own ("Use “X” as a new genre"); choosing it just keeps it.
 *
 * The list is portaled to the body with fixed positioning, so dialogs and
 * scrolling panels never clip it.
 */
export function Combobox({ value, onChange, options, label, placeholder, browse = false, createLabel, emptyText, hint, disabled, ariaLabel, limit = 200 }) {
  const id = useId();
  const input = useRef(null);
  const panel = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [position, setPosition] = useState({});

  const typed = query.trim();
  // Ranked only while the list is open, and again only when the typing or the options change.
  const matches = useMemo(() => (!open ? [] : typed ? rankSuggestions(options, typed, limit) : browse ? options.slice(0, limit) : []), [open, typed, options, browse, limit]);
  const create = createLabel && typed && !findName(options, typed) ? typed : "";
  const items = create ? [...matches, create] : matches;
  const visible = open && (items.length > 0 || (browse && !!emptyText));

  useLayoutEffect(() => {
    if (!visible) return undefined;
    const place = () => {
      const rect = input.current.getBoundingClientRect();
      const below = window.innerHeight - rect.bottom - 16;
      const above = rect.top - 16;
      const upwards = below < 240 && above > below;
      const width = Math.min(Math.max(rect.width, 280), window.innerWidth - 24);
      setPosition({
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        ...(upwards ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
        width,
        maxHeight: Math.min(340, Math.max(0, upwards ? above : below)),
      });
    };
    const onScroll = (event) => {
      if (!panel.current?.contains(event.target)) place();
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    const observer = new ResizeObserver(place);
    observer.observe(input.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      observer.disconnect();
    };
  }, [visible]);

  useLayoutEffect(() => {
    if (visible && active >= 0) panel.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, visible]);

  const show = (text) => {
    setQuery(text);
    setActive(-1);
    setOpen(true);
  };
  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const choose = (index) => {
    const name = items[index];
    if (name === undefined) return;
    onChange(name);
    close();
  };

  return (
    <span className="lib-combo">
      <input
        ref={input}
        className="field"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={ariaLabel}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? id : undefined}
        aria-activedescendant={visible && items[active] !== undefined ? `${id}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        onFocus={(event) => {
          if (!browse) return;
          show("");
          event.target.select();
        }}
        onClick={() => {
          if (browse && !open) show("");
        }}
        onBlur={close}
        onChange={(event) => {
          onChange(event.target.value);
          show(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Escape" && visible) {
            // Only the list closes, not a dialog the field is in.
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (!visible) {
              show(browse ? "" : String(value ?? ""));
              return;
            }
            const step = event.key === "ArrowDown" ? 1 : -1;
            setActive((index) => (items.length ? (index < 0 && step < 0 ? items.length - 1 : (index + step + items.length) % items.length) : -1));
          } else if (event.key === "Enter" && visible) {
            event.preventDefault();
            if (active >= 0) choose(active);
            else close();
          } else if (event.key === "Tab") close();
        }}
      />
      {visible &&
        createPortal(
          <div ref={panel} className="lib-combo__panel" style={position} onMouseDown={(event) => event.preventDefault()}>
            {label && (
              <div className="lib-combo__header">
                <strong>{label}</strong>
                <span role="status">{typed ? `${matches.length} ${matches.length === 1 ? "match" : "matches"}` : `${matches.length} available`}</span>
              </div>
            )}
            <div id={id} role="listbox" aria-label={label || ariaLabel} className="lib-combo__list">
              {matches.map((name, index) => {
                const selected = nameKey(value) === nameKey(name);
                return (
                  <div
                    key={name}
                    id={`${id}-${index}`}
                    role="option"
                    aria-selected={selected}
                    data-index={index}
                    className={`lib-combo__option ${index === active ? "is-active" : ""}`}
                    onMouseEnter={() => setActive(index)}
                    onClick={() => choose(index)}
                  >
                    <span>
                      <Highlight name={name} query={typed} />
                    </span>
                    {selected && <span aria-hidden="true">✓</span>}
                  </div>
                );
              })}
              {create && (
                <div
                  id={`${id}-${matches.length}`}
                  role="option"
                  aria-selected={false}
                  data-index={matches.length}
                  className={`lib-combo__option lib-combo__create ${active === matches.length ? "is-active" : ""}`}
                  onMouseEnter={() => setActive(matches.length)}
                  onClick={() => choose(matches.length)}
                >
                  <span>{createLabel(create)}</span>
                  <span aria-hidden="true">+</span>
                </div>
              )}
              {!items.length && <div className="lib-combo__empty">{emptyText}</div>}
            </div>
            {hint && <div className="lib-combo__hint">{hint}</div>}
          </div>,
          document.body,
        )}
    </span>
  );
}
