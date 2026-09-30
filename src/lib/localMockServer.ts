import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import * as library from "./library";
import {
  answerMockRequest,
  DEFAULT_MOCK_OPTIONS,
  type InvalidRequests,
  type MockOptions,
  type MockRequest,
  type MockResponse,
} from "./localMock";
import { inTauri } from "./request";
import { parseSpec, type ParsedSpec } from "./spec";
import { readStore, writeStore } from "./store";

/**
 * Starting and stopping local mocks, and answering the requests Rust forwards.
 *
 * A local mock serves one API from the library on `127.0.0.1`, on a port of its
 * own. Nothing starts by itself: a mock runs from the moment the user starts it
 * until they stop it or quit Studio. The socket and its checks are in
 * `src-tauri/src/local_mock.rs`; the answers come from `localMock.ts`.
 */

export const LOCAL_MOCK_STORE = "local-mocks.json";
/** The ports tried, in order, for an API that hasn't had one before. */
export const FIRST_LOCAL_MOCK_PORT = 4010;
export const LAST_LOCAL_MOCK_PORT = 4099;

export interface LocalMockPrefs {
  /** The port each API last used, so a restarted mock keeps its address. */
  ports: Record<string, number>;
  invalid: InvalidRequests;
}

export const DEFAULT_LOCAL_MOCK_PREFS: LocalMockPrefs = { ports: {}, invalid: "warn" };

export interface LocalMockStatus {
  /** The library entry's id. */
  id: string;
  port: number;
}

export function localMockUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export function localMockLabel(port: number): string {
  return `Local mock · 127.0.0.1:${port}`;
}

const validPort = (port: unknown): port is number =>
  typeof port === "number" && Number.isInteger(port) && port >= 1024 && port <= 65535;

export async function loadLocalMockPrefs(): Promise<LocalMockPrefs> {
  const stored = await readStore<Partial<LocalMockPrefs>>(LOCAL_MOCK_STORE, {});
  const ports: Record<string, number> = {};
  for (const [id, port] of Object.entries(stored.ports ?? {})) if (validPort(port)) ports[id] = port;
  return { ports, invalid: stored.invalid === "reject" ? "reject" : "warn" };
}

export async function saveLocalMockPrefs(prefs: LocalMockPrefs): Promise<void> {
  await writeStore(LOCAL_MOCK_STORE, prefs);
}

export async function listLocalMocks(): Promise<LocalMockStatus[]> {
  if (!inTauri) return [];
  try {
    return await invoke<LocalMockStatus[]>("local_mock_list");
  } catch {
    return [];
  }
}

/** Start serving one API. Throws with a readable reason (for example, every port taken). */
export async function startLocalMock(id: string, port?: number): Promise<LocalMockStatus> {
  if (!inTauri) throw new Error("A local mock needs the desktop app.");
  await ensureLocalMockBridge();
  return invoke<LocalMockStatus>("local_mock_start", { id, port: port ?? null });
}

export async function stopLocalMock(id: string): Promise<void> {
  if (!inTauri) return;
  await invoke("local_mock_stop", { id });
}

// ── answering requests ───────────────────────────────────────────────────────

interface RequestPayload extends MockRequest {
  call: number;
  mock: string;
}

/**
 * Parsed specs by library id. Filled on the first request after a mock starts
 * and dropped whenever the library changes, so a mock always answers from the
 * document the library holds now.
 */
const specs = new Map<string, Promise<ParsedSpec | null>>();
let options: MockOptions = DEFAULT_MOCK_OPTIONS;

export function forgetLocalMockSpecs(): void {
  specs.clear();
}

export function setLocalMockOptions(next: MockOptions): void {
  options = next;
}

async function loadSpec(id: string): Promise<ParsedSpec | null> {
  const entry = (await library.loadLibrary()).find((candidate) => candidate.id === id);
  if (!entry) return null;
  const text = await library.readSpecText(id);
  if (!text) return null;
  return parseSpec(text, entry.title, library.documentUrlOf(entry.source));
}

function specFor(id: string): Promise<ParsedSpec | null> {
  let found = specs.get(id);
  if (!found) {
    found = loadSpec(id).catch(() => null);
    specs.set(id, found);
  }
  return found;
}

/** The answer to one forwarded request. Never throws: a failure is a 500 the caller can read. */
export async function answerForwarded(payload: MockRequest & { mock: string }): Promise<MockResponse> {
  try {
    const spec = await specFor(payload.mock);
    if (!spec) {
      return {
        status: 503,
        headers: [["Content-Type", "application/json"]],
        body: JSON.stringify({ error: "This API is no longer in Studio's library. Stop the mock in Studio." }),
      };
    }
    return answerMockRequest(spec, payload, options);
  } catch (error) {
    return {
      status: 500,
      headers: [["Content-Type", "application/json"]],
      body: JSON.stringify({ error: `Studio couldn't build a response: ${error instanceof Error ? error.message : String(error)}` }),
    };
  }
}

let bridge: Promise<UnlistenFn> | null = null;

/** Answer `studio://local-mock-request` events. Registered once per page load. */
export function ensureLocalMockBridge(): Promise<UnlistenFn> {
  if (!inTauri) return Promise.resolve(() => {});
  bridge ??= listen<RequestPayload>("studio://local-mock-request", (event) => {
    const { call, ...request } = event.payload;
    void answerForwarded(request).then((response) => invoke("local_mock_respond", { call, response }));
  });
  return bridge;
}
