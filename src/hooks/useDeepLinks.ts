import { useCallback, useEffect, useRef, useState } from "react";
import {
  confirmOpen,
  existingEntry,
  onDeepLink,
  parseDeepLink,
  takeDeepLinks,
  type OpenRequest,
} from "../lib/deepLink";
import type { LibraryEntry } from "../lib/library";
import { inTauri } from "../lib/request";

/** How long a notice about an ignored or refused link stays up. */
const NOTICE_MS = 8000;

/**
 * `spec0://` links: the confirmation dialog's state and the quiet notice for
 * links Studio won't act on.
 *
 * Links are taken from Rust once at start (a link that launched Studio) and
 * again whenever Rust says one arrived. The newest acceptable link replaces one
 * still waiting for an answer: the last button the user clicked is the one they
 * mean. Nothing is fetched until `confirm`.
 */
export function useDeepLinks({
  entries,
  openEntry,
  addFromUrl,
  showLibrary,
}: {
  entries: LibraryEntry[];
  openEntry: (entry: LibraryEntry) => Promise<void>;
  addFromUrl: (url: string) => Promise<void>;
  /** Show the library, where adding an API reports progress and errors. */
  showLibrary: () => void;
}) {
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);

  const receive = useCallback(
    (links: string[]) => {
      for (const raw of links) {
        const link = parseDeepLink(raw);
        if (link.kind === "open") setRequest(link.request);
        else showNotice(`Studio didn't open a spec0:// link. ${link.reason}`);
      }
    },
    [showNotice],
  );

  useEffect(() => {
    if (!inTauri) return;
    let stopped = false;
    let unlisten: (() => void) | null = null;
    const take = () =>
      void takeDeepLinks().then((links) => {
        if (!stopped && links.length) receive(links);
      });
    // Listen first, then take, so a link arriving in between isn't missed.
    void onDeepLink(take).then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
      take();
    });
    return () => {
      stopped = true;
      unlisten?.();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [receive]);

  const existing = request ? existingEntry(request, entries) : null;

  const confirm = useCallback(async () => {
    if (!request) return;
    const confirmed = request;
    setRequest(null);
    if (!existingEntry(confirmed, entries)) showLibrary();
    await confirmOpen(confirmed, entries, { openEntry, addFromUrl });
  }, [request, entries, openEntry, addFromUrl, showLibrary]);

  const cancel = useCallback(() => setRequest(null), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  return { request, existing, notice, confirm, cancel, dismissNotice };
}

export type DeepLinks = ReturnType<typeof useDeepLinks>;
