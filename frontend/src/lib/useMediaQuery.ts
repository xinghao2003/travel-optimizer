import { useCallback, useSyncExternalStore } from "react";

/** Whether the media query matches. The component renders again when the result changes. */
export function useMediaQuery(query: string) {
  const subscribe = useCallback((onChange: () => void) => {
    const media = matchMedia(query);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => matchMedia(query).matches);
}
