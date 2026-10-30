import { useLayoutEffect, useRef, useState } from "react";

const memory = new Map();

// Retain filters and loaded pages as well as the scroll offset: restoring an
// offset alone cannot work when the user had loaded more than the first page.
export function useCollectionMemory(key, defaults) {
  const [state, setState] = useState(() => memory.get(key)?.state || defaults);
  const ref = useRef(null);
  const set = (field) => (value) => setState((previous) => ({ ...previous, [field]: typeof value === "function" ? value(previous[field]) : value }));
  return { ref, state, set };
}

export function useCollectionScroll(ref, key, state, ready) {
  const restored = useRef(false);
  useLayoutEffect(() => {
    const element = ref.current;
    let scroller = element;
    while (scroller && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!scroller) return;
    if (ready && !restored.current) {
      scroller.scrollTop = memory.get(key)?.top || 0;
      restored.current = true;
    }
    const remember = () => {
      if (restored.current) memory.set(key, { state, top: scroller.scrollTop });
    };
    scroller.addEventListener("scroll", remember);
    return () => { remember(); scroller.removeEventListener("scroll", remember); };
  }, [ref, key, state, ready]);
}
