import { useCallback, useState } from "react";
import { DEFAULT_CONNECTION, saveConnection, type ConnectionSettings } from "../lib/connection";

/** Certificates, proxy, timeout: how requests leave the machine. Saved on every change. */
export function useConnectionSettings() {
  const [connection, setConnection] = useState<ConnectionSettings>(DEFAULT_CONNECTION);

  const saveConnectionSettings = useCallback((next: ConnectionSettings) => {
    setConnection(next);
    void saveConnection(next);
  }, []);

  return { connection, setConnection, saveConnectionSettings };
}
