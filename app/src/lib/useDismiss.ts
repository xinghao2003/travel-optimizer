import { useEffect, useRef, type FocusEvent, type KeyboardEvent } from "react";

/** Closes a <details> menu or tip and returns focus to its summary. */
export function closeDetails(details: HTMLDetailsElement) {
  details.open = false;
  details.querySelector<HTMLElement>(":scope > summary")?.focus();
}

/**
 * Closes a <details> menu or tip on Esc, with focus back on its summary, on a click outside it, and when
 * focus moves out of it, so it never covers the next focused control. Spread the result on the <details> element.
 */
export function useDismiss() {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const details = ref.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  function onKeyDown(event: KeyboardEvent<HTMLDetailsElement>) {
    if (event.key !== "Escape" || !event.currentTarget.open) return;
    // An open tip inside a menu closes first.
    event.stopPropagation();
    closeDetails(event.currentTarget);
  }
  // No related target (a click on text, or a switch to another window) keeps it open.
  function onBlur(event: FocusEvent<HTMLDetailsElement>) {
    const next = event.relatedTarget;
    if (next && !event.currentTarget.contains(next)) event.currentTarget.open = false;
  }
  return { ref, onKeyDown, onBlur };
}
