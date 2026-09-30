import { useCallback, useState } from "react";

export type OpenTab = "file" | "url" | "spec0";

/** The Add an API dialog, or the same dialog used only to sign in. */
export type OpenMode = "add" | "signin";

/** Which dialogs are open. Publishing and OAuth keep extra state and have their own hooks too. */
export function useDialogs() {
  const [showOpen, setShowOpen] = useState(false);
  /** Null: the dialog picks, Spec0 when signed in and Local file when not. */
  const [openTab, setOpenTab] = useState<OpenTab | null>(null);
  const [openMode, setOpenMode] = useState<OpenMode>("add");
  const [showEnvs, setShowEnvs] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const [showOAuth, setShowOAuth] = useState<{ prefill?: string } | null>(null);
  const [showSwitcher, setShowSwitcher] = useState(false);

  /** Open the sign-in dialog: the Spec0 choices only, titled for signing in. */
  const openSignIn = useCallback(() => {
    setOpenMode("signin");
    setOpenTab("spec0");
    setShowOpen(true);
  }, []);

  /** Open Add an API on its Spec0 tab: the organisation's catalog. */
  const openCatalog = useCallback(() => {
    setOpenMode("add");
    setOpenTab("spec0");
    setShowOpen(true);
  }, []);

  /** Close the dialog and reset it, so it next opens on the tab that fits. */
  const closeOpen = useCallback(() => {
    setShowOpen(false);
    setOpenTab(null);
    setOpenMode("add");
  }, []);

  /** What Escape closes. */
  const closeOnEscape = useCallback(() => {
    setShowOpen(false);
    setOpenTab(null);
    setOpenMode("add");
    setShowEnvs(false);
    setShowSwitcher(false);
  }, []);

  return {
    showOpen,
    setShowOpen,
    openTab,
    openMode,
    setOpenMode,
    showEnvs,
    setShowEnvs,
    showRun,
    setShowRun,
    showOAuth,
    setShowOAuth,
    showSwitcher,
    setShowSwitcher,
    openSignIn,
    openCatalog,
    closeOpen,
    closeOnEscape,
  };
}
