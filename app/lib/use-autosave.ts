import { useEffect, useRef, useCallback } from "react";
import { useFetcher } from "react-router";
import type { BoundaryState, BoundaryAction } from "./boundary-types";

/**
 * Autosave hook: debounces boundary state changes and persists to D1 via useFetcher.
 *
 * - 1.5s debounce after state.version changes while state.isDirty
 * - Dispatches MARK_SAVING on submit, MARK_SAVED on success
 * - Retries after 3s on error
 * - Adds/removes beforeunload handler based on isDirty
 */
export function useAutosave(
  state: BoundaryState,
  dispatch: React.Dispatch<BoundaryAction>,
  volumeId: string
) {
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savedVersionRef = useRef(state.version);
  const versionAtSaveRef = useRef(state.version);

  // Debounced save trigger
  useEffect(() => {
    if (!state.isDirty) return;

    // Clear any pending debounce
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    debounceRef.current = setTimeout(() => {
      dispatch({ type: "MARK_SAVING" });
      versionAtSaveRef.current = state.version;

      const formData = new FormData();
      formData.set("volumeId", volumeId);
      formData.set("entries", JSON.stringify(state.entries));

      fetcher.submit(formData, {
        method: "POST",
        action: "/api/entries/save",
      });
    }, 1500);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [state.version, state.isDirty]);

  // Handle fetcher completion
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data) return;

    if (fetcher.data.success) {
      // Only mark saved if no new changes occurred during the save
      if (state.version === versionAtSaveRef.current) {
        savedVersionRef.current = state.version;
        dispatch({ type: "MARK_SAVED" });
      }
    } else if (fetcher.data.error) {
      console.error("Autosave error:", fetcher.data.error);
      // Retry after 3 seconds
      if (retryRef.current) clearTimeout(retryRef.current);
      retryRef.current = setTimeout(() => {
        dispatch({ type: "MARK_DIRTY" });
      }, 3000);
    }
  }, [fetcher.state, fetcher.data]);

  // beforeunload handler
  useEffect(() => {
    if (!state.isDirty) return;

    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };

    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [state.isDirty]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, []);

  return { saveStatus: state.saveStatus };
}
