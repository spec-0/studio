import { useCallback, useState } from "react";

export type OpenTab = "file" | "url" | "spec0";

/** Which dialogs are open. Publishing and OAuth keep extra state and have their own hooks too. */
export function useDialogs() {
  const [showOpen, setShowOpen] = useState(false);
  const [openTab, setOpenTab] = useState<OpenTab>("file");
  const [showEnvs, setShowEnvs] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [showOAuth, setShowOAuth] = useState<{ prefill?: string } | null>(null);
  const [showSwitcher, setShowSwitcher] = useState(false);

  /** Open the Open dialog on its spec0 tab, where signing in happens. */
  const openSignIn = useCallback(() => {
    setOpenTab("spec0");
    setShowOpen(true);
  }, []);

  /** Close the Open dialog and reset it to its first tab. */
  const closeOpen = useCallback(() => {
    setShowOpen(false);
    setOpenTab("file");
  }, []);

  /** What Escape closes. */
  const closeOnEscape = useCallback(() => {
    setShowOpen(false);
    setShowEnvs(false);
    setShowSwitcher(false);
  }, []);

  return {
    showOpen,
    setShowOpen,
    openTab,
    showEnvs,
    setShowEnvs,
    showRun,
    setShowRun,
    showOAuth,
    setShowOAuth,
    showSwitcher,
    setShowSwitcher,
    openSignIn,
    closeOpen,
    closeOnEscape,
  };
}
