import { useCallback, useEffect, useState } from "react";
import { onStockChanged } from "./live.js";

// Runs `load` on mount, whenever `reload()` is called, and whenever another tab
// (e.g. the fridge simulator) reports a stock change. `load` must be a stable
// function, e.g. one from api.js. Old data stays visible while reloading.
export function useApi(load) {
  const [state, setState] = useState({ data: null, error: null });
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let live = true;
    load().then(
      (data) => live && setState({ data, error: null }),
      (e) => live && setState({ data: null, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [load, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => onStockChanged(reload), [reload]);

  return { ...state, reload };
}
