import { invoke } from "@tauri-apps/api/core";
import { deleteStore, readStore, writeStore, STORE } from "./store";
import type { Environment } from "./env";

/**
 * Where secret variable values live.
 *
 * **The OS credential store, when there is one.** macOS Keychain, Windows
 * Credential Manager, or the Secret Service on Linux, reached through narrow Rust
 * commands in `src-tauri/src/secrets.rs`. Each value is stored under the
 * environment id and variable name; `environments.json` only records that a
 * variable is secret.
 *
 * **A local file when there isn't.** `secrets.json` is what older versions used
 * for every secret. It stays as the fallback, never as a second home:
 *
 *  - If the credential store can't be reached at all (Linux with no keyring
 *    running, a locked keyring, a headless session), the whole session uses the
 *    file and the Environments dialog says so. Nothing touches the credential
 *    store until it's reachable again, and then the file's values move in.
 *  - If the store is fine but refuses one value (Windows limits how long a
 *    credential can be), only that value stays in the file.
 *
 * Migration from the file is per value: store it, read it back, compare, and
 * only then drop it from the file, rewriting the file after each one. Stopping
 * halfway leaves every value in at least one place, and running it again just
 * finishes the job.
 *
 * The file is not encrypted, and that is stated in the UI rather than hidden.
 */

export interface SecretKey {
  envId: string;
  name: string;
}

export interface SecretBackend {
  available: boolean;
  /** Where secrets go on this OS, in words: "macOS Keychain". */
  store: string;
  reason?: string | null;
}

/** The shape Rust rejects with. `unavailable` means the store itself is down. */
export interface SecretError {
  unavailable: boolean;
  message: string;
}

/** The credential store, as the Rust commands expose it. */
export interface Vault {
  backend(): Promise<SecretBackend>;
  get(key: SecretKey): Promise<string | null>;
  set(key: SecretKey, value: string): Promise<void>;
  delete(key: SecretKey): Promise<void>;
  /** What Studio has stored. Names only. */
  list(): Promise<SecretKey[]>;
}

/** Values keyed `<envId>:<varName>` — the format older versions wrote. */
export type SecretMap = Record<string, string>;

export interface SecretFile {
  read(): Promise<SecretMap>;
  write(map: SecretMap): Promise<void>;
  remove(): Promise<void>;
}

export type SecretStatus =
  /** Browser preview: localStorage, and nothing to say about it. */
  | { mode: "browser" }
  /** The credential store is in use. `inFile` values couldn't go there. */
  | { mode: "store"; store: string; inFile: number; fileReason?: string }
  /** The credential store can't be reached, so this session uses the file. */
  | { mode: "file"; store: string; reason: string };

const FALLBACK_STORE_NAME = "system credential store";

export function secretKey(envId: string, name: string): string {
  return `${envId}:${name}`;
}

/** Environment ids never contain `:`, so the first one splits the key. */
export function parseSecretKey(key: string): SecretKey | null {
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  return { envId: key.slice(0, at), name: key.slice(at + 1) };
}

/** Every variable marked secret, whether or not it has a value. */
export function secretKeys(environments: Environment[]): Set<string> {
  const keys = new Set<string>();
  for (const env of environments) {
    for (const variable of env.variables) {
      if (variable.secret && variable.name) keys.add(secretKey(env.id, variable.name));
    }
  }
  return keys;
}

/** Secret variables that have a value — what should be stored. */
export function secretValues(environments: Environment[]): Map<string, string> {
  const values = new Map<string, string>();
  for (const env of environments) {
    for (const variable of env.variables) {
      if (variable.secret && variable.name && variable.value) {
        values.set(secretKey(env.id, variable.name), variable.value);
      }
    }
  }
  return values;
}

function asSecretError(error: unknown): SecretError {
  if (error && typeof error === "object" && "message" in error) {
    const { unavailable, message } = error as Partial<SecretError>;
    return { unavailable: Boolean(unavailable), message: String(message) };
  }
  return { unavailable: false, message: String(error) };
}

export interface Secrets {
  /** Read every secret value the environments declare. Runs the migration. */
  load(environments: Environment[]): Promise<Map<string, string>>;
  /** Store what the environments hold now, and remove what they no longer do. */
  save(environments: Environment[]): Promise<void>;
  status(): SecretStatus;
}

/**
 * The secret store, with its two boundaries injected so the logic can be tested
 * without Tauri. `vault` is null in the browser preview.
 */
export function createSecrets(vault: Vault | null, file: SecretFile): Secrets {
  let status: SecretStatus = vault ? { mode: "file", store: FALLBACK_STORE_NAME, reason: "not loaded yet" } : { mode: "browser" };
  /** Values known to be in the credential store, so an unchanged one isn't rewritten on every save. */
  const synced = new Map<string, string>();
  /** Saves run one at a time; two interleaved syncs could each prune the other's work. */
  let queue: Promise<void> = Promise.resolve();

  const persist = async (map: SecretMap) => {
    if (Object.keys(map).length) await file.write(map);
    else await file.remove();
  };

  const fallBack = (store: string, reason: string) => {
    status = { mode: "file", store, reason };
    synced.clear();
  };

  async function load(environments: Environment[]): Promise<Map<string, string>> {
    const wanted = secretKeys(environments);
    const original = await file.read();
    const fromFile = () => {
      const values = new Map<string, string>();
      for (const key of wanted) values.set(key, original[key] ?? "");
      return values;
    };

    if (!vault) {
      status = { mode: "browser" };
      return fromFile();
    }

    let backend: SecretBackend;
    try {
      backend = await vault.backend();
    } catch (error) {
      backend = { available: false, store: FALLBACK_STORE_NAME, reason: asSecretError(error).message };
    }
    if (!backend.available) {
      fallBack(backend.store, backend.reason || "it didn't respond");
      return fromFile();
    }

    // Migrate whatever the file holds, one verified value at a time.
    const remaining: SecretMap = { ...original };
    let fileReason: string | undefined;
    for (const [key, value] of Object.entries(original)) {
      const parsed = parseSecretKey(key);
      if (!parsed || !wanted.has(key) || !value) {
        // No secret variable refers to this any more — older versions rewrote
        // the whole file on every save, so nothing could ever read it again.
        delete remaining[key];
        await persist(remaining);
        continue;
      }
      try {
        await vault.set(parsed, value);
        const readBack = await vault.get(parsed);
        if (readBack !== value) throw { unavailable: false, message: "a stored value didn't read back the same" };
        delete remaining[key];
        synced.set(key, value);
        await persist(remaining);
      } catch (error) {
        const problem = asSecretError(error);
        if (problem.unavailable) {
          // The store went away mid-migration. Everything is still in memory, and
          // the next save writes the file in full, so nothing is lost.
          fallBack(backend.store, problem.message);
          return fromFile();
        }
        fileReason = problem.message;
      }
    }

    const values = new Map<string, string>();
    for (const key of wanted) {
      if (key in remaining) {
        // Still in the file because the store refused it — the file is current.
        values.set(key, remaining[key]);
        continue;
      }
      const parsed = parseSecretKey(key);
      if (!parsed) continue;
      try {
        const value = (await vault.get(parsed)) ?? "";
        if (value) synced.set(key, value);
        values.set(key, value);
      } catch (error) {
        const problem = asSecretError(error);
        if (problem.unavailable) {
          fallBack(backend.store, problem.message);
          return fromFile();
        }
        values.set(key, "");
      }
    }

    status = {
      mode: "store",
      store: backend.store,
      inFile: Object.keys(remaining).length,
      ...(fileReason ? { fileReason } : {}),
    };
    return values;
  }

  async function sync(environments: Environment[]): Promise<void> {
    const desired = secretValues(environments);
    if (!vault || status.mode !== "store") {
      // Browser preview, or the store is down: the file is the whole truth. The
      // credential store isn't touched, so what's in it survives until it's back.
      await persist(Object.fromEntries(desired));
      return;
    }

    const store = status.store;
    const inFile: SecretMap = {};
    let fileReason: string | undefined;
    for (const [key, value] of desired) {
      if (synced.get(key) === value) continue;
      const parsed = parseSecretKey(key);
      if (!parsed) continue;
      try {
        await vault.set(parsed, value);
        synced.set(key, value);
      } catch (error) {
        const problem = asSecretError(error);
        if (problem.unavailable) {
          fallBack(store, problem.message);
          await persist(Object.fromEntries(desired));
          return;
        }
        synced.delete(key);
        inFile[key] = value;
        fileReason = problem.message;
      }
    }

    // Remove what no secret variable holds any more: a renamed or deleted
    // variable, a deleted environment, an unticked "secret" box, a cleared
    // value — and anything a value in the file now supersedes.
    try {
      for (const stored of await vault.list()) {
        const key = secretKey(stored.envId, stored.name);
        if (desired.has(key) && !(key in inFile)) continue;
        try {
          await vault.delete(stored);
          synced.delete(key);
        } catch {
          // Left in the index, so the next save tries again.
        }
      }
    } catch {
      // Listing failed; the next save prunes.
    }

    await persist(inFile);
    status = {
      mode: "store",
      store,
      inFile: Object.keys(inFile).length,
      ...(fileReason ? { fileReason } : {}),
    };
  }

  return {
    load,
    save(environments) {
      const run = queue.then(() => sync(environments));
      queue = run.catch(() => undefined);
      return run;
    },
    status: () => status,
  };
}

// ── the real boundaries ──────────────────────────────────────────────────────

export const tauriVault: Vault = {
  backend: () => invoke<SecretBackend>("secret_backend"),
  get: ({ envId, name }) => invoke<string | null>("secret_get", { envId, name }),
  set: ({ envId, name }, value) => invoke("secret_set", { envId, name, value }),
  delete: ({ envId, name }) => invoke("secret_delete", { envId, name }),
  list: () => invoke<SecretKey[]>("secret_list"),
};

export const secretFile: SecretFile = {
  read: () => readStore<SecretMap>(STORE.secrets, {}),
  write: (map) => writeStore(STORE.secrets, map),
  remove: () => deleteStore(STORE.secrets),
};

// Not imported from request.ts: that module imports redaction, and a cycle
// would leave this undefined while the module initialises.
const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const secrets = createSecrets(inTauri ? tauriVault : null, secretFile);

export interface SecretStorageNote {
  /** One sentence: where secret values are kept right now. */
  where: string;
  /** Present when something is off. Calm, plain, and says how to fix it. */
  notice?: { text: string; fix?: string; details?: string };
}

/** What the Environments dialog says about secrets, in plain words. */
export function describeSecretStorage(status: SecretStatus): SecretStorageNote {
  if (status.mode === "browser") {
    return { where: "In the browser preview, secret values are kept in this browser's local storage." };
  }
  if (status.mode === "store") {
    const where = `Secret values are kept in the ${status.store}, not in a file.`;
    if (!status.inFile) return { where };
    const count = status.inFile === 1 ? "One secret value" : `${status.inFile} secret values`;
    return {
      where,
      notice: {
        text:
          `${count} couldn't be saved to the ${status.store}, so ${status.inFile === 1 ? "it is" : "they are"} ` +
          "kept in a local file (secrets.json) instead. That file is not encrypted.",
        details: status.fileReason,
      },
    };
  }
  const linux = /keyring|secret service/i.test(status.store);
  return {
    where: "For now, secret values are kept in a local file (secrets.json). That file is not encrypted.",
    notice: {
      text:
        `Studio can't reach the ${status.store} right now, so this session keeps secret values in a ` +
        "local file instead. Nothing is lost. Next time Studio starts and the store is available, " +
        "it moves them in.",
      fix: linux
        ? "On Linux this usually means no keyring is running, or it is locked. Install one (for " +
          "example GNOME Keyring or KWallet), make sure it is unlocked, then restart Studio."
        : `Check that the ${status.store} is unlocked, then restart Studio.`,
      details: status.reason,
    },
  };
}
