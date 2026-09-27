import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { HistoryEntry } from "../lib/history";
import * as library from "../lib/library";
import { documentUrlOf, type ApiSource, type LibraryEntry } from "../lib/library";
import { LIBRARY_CHANGED_EVENT } from "../lib/mcpServer";
import { fileName } from "../lib/platform";
import { appFetch, inTauri } from "../lib/request";
import { parseSpec, type ParsedSpec } from "../lib/spec";
import {
  apiIdFromRef,
  environmentSyncApiId,
  fetchTeamApiSpec,
  listApiEnvironments,
  refreshMock,
  upstreamVersions,
  type Session,
} from "../lib/spec0";
import { pickSpecFile } from "../lib/store";
import {
  describeImpact,
  describeMockRefresh,
  diffSpecs,
  isNoteworthy,
  updateMarks,
} from "../lib/sync";

/**
 * The library of APIs: adding, opening, refreshing and removing entries,
 * checking spec0 for newer copies, and rebuilding hosted mocks.
 *
 * `loading` and `loadError` are the library screen's busy line and error.
 */
export function useLibrary({
  session,
  requests,
  current,
  setCurrent,
  applySpec,
  closeApi,
}: {
  session: Session | null;
  requests: HistoryEntry[];
  current: LibraryEntry | null;
  setCurrent: Dispatch<SetStateAction<LibraryEntry | null>>;
  /** Show a parsed spec in the workspace. */
  applySpec: (parsed: ParsedSpec, entry: LibraryEntry, text: string) => void;
  closeApi: () => void;
}) {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [syncReport, setSyncReport] = useState<{ title: string; lines: string[] } | null>(null);
  /** The hidden file input the browser preview opens files with. */
  const fileInput = useRef<HTMLInputElement>(null);

  /** Open a spec, clearing any earlier load error. */
  const openSpec = useCallback(
    (parsed: ParsedSpec, entry: LibraryEntry, text: string) => {
      applySpec(parsed, entry, text);
      setLoadError(null);
    },
    [applySpec],
  );

  /**
   * Rebuild the mock against the spec we now hold.
   *
   * The platform keeps the mock's id, URL and API key, so nothing stored here has
   * to change — only the version it serves, which is what clears the skew warning.
   */
  const doRefreshMock = useCallback(async (target?: LibraryEntry) => {
    const entry = target ?? current;
    if (!session || !entry?.mockServerId) return;
    setLoading(`Rebuilding the mock for ${entry.title}…`);
    setLoadError(null);
    try {
      const result = await refreshMock(session, entry.mockServerId);
      const next = await library.setMock(entry.id, {
        mockSpecVersion: result.specVersion ?? entry.version,
        clearStale: true,
      });
      setEntries(next);
      setCurrent((open) => (open?.id === entry.id ? next.find((e) => e.id === entry.id) ?? open : open));

      setSyncReport({ title: `${entry.title} mock`, lines: describeMockRefresh(result) });
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(null);
    }
  }, [session, current]);

  const saveMockKey = useCallback(
    async (key: string) => {
      if (!current) return;
      const next = await library.setMock(current.id, { mockApiKey: key });
      setEntries(next);
      setCurrent(next.find((entry) => entry.id === current.id) ?? current);
    },
    [current],
  );

  // A local MCP tool (creating or rebuilding a mock) wrote the library file.
  useEffect(() => {
    const reload = () =>
      void library.loadLibrary().then((next) => {
        setEntries(next);
        setCurrent((open) => (open ? next.find((entry) => entry.id === open.id) ?? open : open));
      });
    window.addEventListener(LIBRARY_CHANGED_EVENT, reload);
    return () => window.removeEventListener(LIBRARY_CHANGED_EVENT, reload);
  }, [setCurrent]);

  // ── opening ──────────────────────────────────────────────────────────────────

  /** Parse, add to the library, and open it. Every entry point funnels through here. */
  const ingest = useCallback(
    async (
      text: string,
      name: string,
      source: ApiSource,
      mock?: {
        mockUrl?: string | null;
        mockApiKey?: string | null;
        mockServerId?: string | null;
        mockSpecVersion?: string | null;
      } | null,
    ) => {
      try {
        const parsed = parseSpec(text, name, documentUrlOf(source));
        const entry = await library.addToLibrary({
          title: parsed.title || name,
          version: parsed.version,
          source,
          text,
          operations: parsed.operations.length,
          schemas: parsed.schemas.length,
          mockUrl: mock?.mockUrl,
          mockApiKey: mock?.mockApiKey,
          mockServerId: mock?.mockServerId,
          mockSpecVersion: mock?.mockSpecVersion,
        });
        setEntries(await library.loadLibrary());
        openSpec(parsed, entry, text);
      } catch (error) {
        setLoadError(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    [openSpec],
  );

  /**
   * Refresh the cached environment list for a spec0-sourced API.
   *
   * Fire-and-forget on open: the API is already usable without it, so a platform that
   * is slow, unreachable or predates the endpoint must not delay or fail the open. A
   * failure leaves the cached list in place — last known targets beat none.
   *
   * Replaces rather than merges, so an environment retired upstream stops being
   * offered here. That matters more than it sounds: a hostname that was staging last
   * month may belong to something else now.
   */
  const syncEnvironments = useCallback(
    async (entry: LibraryEntry) => {
      const apiId = environmentSyncApiId(session, entry.source);
      if (!session || !apiId) return;
      try {
        const rows = await listApiEnvironments(session, apiId);
        const next = await library.setEnvironments(
          entry.id,
          rows.map((row) => ({
            name: row.name,
            url: row.url,
            currentVersion: row.currentVersion ?? null,
          })),
        );
        setEntries(next);
        setCurrent((open) =>
          open?.id === entry.id ? (next.find((e) => e.id === entry.id) ?? open) : open,
        );
      } catch {
        // Deliberately silent: this enriches an API that opened fine. Surfacing an
        // error here would make a working client look broken over a convenience.
      }
    },
    [session],
  );

  const openEntry = useCallback(
    async (entry: LibraryEntry) => {
      setLoading(`Opening ${entry.title}…`);
      setLoadError(null);
      try {
        const text = await library.readSpecText(entry.id);
        if (!text) {
          setLoadError(`${entry.title}: the stored document is missing. Refresh or re-add it.`);
          return;
        }
        openSpec(parseSpec(text, entry.title, documentUrlOf(entry.source)), entry, text);
        setEntries(await library.touchOpened(entry.id));
        void syncEnvironments(entry);
      } catch (error) {
        setLoadError(`${entry.title}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setLoading(null);
      }
    },
    [openSpec, syncEnvironments],
  );

  // ── updates ──────────────────────────────────────────────────────────────────

  /**
   * Ask the catalog what it holds and mark anything newer than our copy.
   *
   * One `listTeamApis` call covers the whole library — the list already carries
   * `version` and `updatedAt`. Detection is passive: it marks, it never applies.
   * The spec you're testing against must not change under you mid-session.
   */
  const checkForUpdates = useCallback(async () => {
    if (!session) return;
    setChecking(true);
    try {
      const upstream = await upstreamVersions(session);
      const marks = updateMarks(entries, upstream, new Date().toISOString());
      setEntries(await library.setUpdates(marks));
    } catch {
      // A failed check is not worth interrupting anyone for — the badge simply
      // doesn't appear, and Refresh is still there.
    } finally {
      setChecking(false);
    }
  }, [session, entries]);

  /** Pull the newer spec, replace the stored copy, and say what it did locally. */
  const applyUpdate = useCallback(
    async (entry: LibraryEntry) => {
      if (!session || entry.source.kind !== "spec0") return;
      const apiId = apiIdFromRef(entry.source.ref);
      if (!apiId) return;

      setLoading(`Updating ${entry.title}…`);
      setLoadError(null);
      try {
        const text = await fetchTeamApiSpec(session, apiId);
        const after = parseSpec(text, entry.title);

        const previous = await library.readSpecText(entry.id);
        const impact = previous
          ? diffSpecs(parseSpec(previous, entry.title), after, {
              server: entry.state?.server ?? "",
              history: requests,
              specTitle: entry.title,
              hasMock: Boolean(entry.mockUrl),
            })
          : null;

        const next = await library.applyUpdate(entry.id, {
          text,
          title: after.title,
          version: after.version,
          operations: after.operations.length,
          schemas: after.schemas.length,
        });
        setEntries(next);

        // Reflect the new document immediately if this API is the one on screen.
        const updated = next.find((row) => row.id === entry.id);
        if (updated && current?.id === entry.id) openSpec(after, updated, text);

        setSyncReport(
          impact && isNoteworthy(impact)
            ? { title: entry.title, lines: describeImpact(impact) }
            : { title: entry.title, lines: describeImpact(impact ?? ({} as never)) },
        );
      } catch (error) {
        setLoadError(`${entry.title}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setLoading(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session, requests, current, openSpec],
  );

  // Check once when a session is available, then only on demand.
  useEffect(() => {
    if (session && entries.length) void checkForUpdates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  const openFile = useCallback(async () => {
    if (!inTauri) {
      fileInput.current?.click();
      return;
    }
    const picked = await pickSpecFile();
    if (picked) {
      await ingest(picked.text, fileName(picked.path), {
        kind: "file",
        ref: picked.path,
      });
    }
  }, [ingest]);

  /**
   * Fetch a spec from `url` and add it to the library. Not for showing a page to
   * the user — that is `openInBrowser` in `lib/store`.
   */
  const addFromUrl = useCallback(
    async (url: string) => {
      setLoading(`Fetching ${url}…`);
      setLoadError(null);
      try {
        const response = await appFetch(url, {
          headers: { Accept: "application/yaml, application/json, */*" },
        });
        if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
        await ingest(await response.text(), url.split("/").pop() || url, { kind: "url", ref: url });
      } catch (error) {
        setLoadError(
          `${url}: ${error instanceof Error ? error.message : String(error)}${
            inTauri ? "" : " — in the browser preview this is usually CORS."
          }`,
        );
      } finally {
        setLoading(null);
      }
    },
    [ingest],
  );

  const refreshEntry = useCallback(
    async (entry: LibraryEntry) => {
      setLoading(`Refreshing ${entry.title}…`);
      setLoadError(null);
      try {
        if (entry.source.kind === "url") {
          const response = await appFetch(entry.source.ref);
          if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
          await ingest(await response.text(), entry.title, entry.source);
        } else if (entry.source.kind === "file") {
          const text = await library.rereadFile(entry);
          if (!text) throw new Error("the file is no longer readable at its original path");
          await ingest(text, entry.title, entry.source);
        } else if (entry.source.kind === "spec0") {
          setLoadError("Re-pull this one from the spec0 tab in Open.");
        }
        setEntries(await library.loadLibrary());
      } catch (error) {
        setLoadError(`${entry.title}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        setLoading(null);
      }
    },
    [ingest],
  );

  const removeEntry = useCallback(
    async (entry: LibraryEntry) => {
      setEntries(await library.removeEntry(entry.id));
      if (current?.id === entry.id) {
        closeApi();
      }
    },
    [current, closeApi],
  );

  return {
    entries,
    setEntries,
    loading,
    loadError,
    checking,
    syncReport,
    setSyncReport,
    fileInput,
    ingest,
    openEntry,
    openFile,
    addFromUrl,
    refreshEntry,
    removeEntry,
    checkForUpdates,
    applyUpdate,
    doRefreshMock,
    saveMockKey,
  };
}
