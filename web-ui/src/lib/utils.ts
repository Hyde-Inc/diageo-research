import { clsx, type ClassValue } from "clsx"
import { useCallback, useSyncExternalStore } from "react"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Read a string from `localStorage` reactively (SSR-safe).
 *
 * Returns `[value, setValue]`. During SSR (and on the very first
 * client render) `value` equals `fallback`; once the component mounts,
 * `useSyncExternalStore` rehydrates with the persisted value without
 * triggering a setState-in-effect lint violation. Writes both update
 * storage and dispatch a `storage` event so other tabs / hook
 * instances refresh.
 */
export function useLocalStorageString(
  key: string,
  fallback: string,
): [string, (next: string) => void] {
  const subscribe = useCallback(
    (cb: () => void) => {
      const handler = (e: StorageEvent) => {
        if (e.key === null || e.key === key) cb();
      };
      window.addEventListener("storage", handler);
      return () => window.removeEventListener("storage", handler);
    },
    [key],
  );
  const getSnapshot = useCallback(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }, [key, fallback]);
  const getServerSnapshot = useCallback(() => fallback, [fallback]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const setValue = useCallback(
    (next: string) => {
      try {
        window.localStorage.setItem(key, next);
      } catch {
        // best-effort persistence — in-memory consumers update via the
        // dispatched event below
      }
      window.dispatchEvent(
        new StorageEvent("storage", { key, newValue: next }),
      );
    },
    [key],
  );
  return [value, setValue];
}
