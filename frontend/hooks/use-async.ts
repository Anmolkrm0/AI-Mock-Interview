"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { ApiError } from "@/lib/api";

export interface AsyncState<T> {
  data: T | null;
  error: ApiError | Error | null;
  loading: boolean;
  /** True when a request has been pending long enough that the server is probably cold-starting. */
  slow: boolean;
  reload: () => void;
}

/** Load data on mount with loading, error and "server is waking up" states. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [nonce, setNonce] = useState(0);
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    setSlow(false);
    const slowTimer = setTimeout(() => active && setSlow(true), 4000);
    Promise.resolve(fnRef.current())
      .then((value) => active && setData(value))
      .catch((e: unknown) => active && setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => {
        clearTimeout(slowTimer);
        if (active) {
          setLoading(false);
          setSlow(false);
        }
      });
    return () => {
      active = false;
      clearTimeout(slowTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, slow, reload };
}
