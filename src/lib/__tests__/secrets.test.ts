import { describe, expect, it } from "vitest";
import {
  createSecrets,
  describeSecretStorage,
  parseSecretKey,
  secretKey,
  type SecretError,
  type SecretFile,
  type SecretKey,
  type SecretMap,
  type Vault,
} from "../secrets";
import type { Environment } from "../env";

/** An in-memory credential store standing in for the Rust commands. */
class FakeVault implements Vault {
  values = new Map<string, string>();
  /** Every account written, like Rust's index. */
  index = new Set<string>();
  available = true;
  /** Fail (not "unavailable") when storing a value longer than this. */
  maxLength = Infinity;
  /** Fail as "unavailable" after this many successful sets. */
  dropAfterSets = Infinity;
  /** Return something else on read, to exercise the verification step. */
  corruptReads = false;
  sets = 0;

  private down(): SecretError {
    return { unavailable: true, message: "no Secret Service on the session bus" };
  }
  private account({ envId, name }: SecretKey) {
    return `${envId}/${name}`;
  }

  async backend() {
    return this.available
      ? { available: true, store: "macOS Keychain" }
      : { available: false, store: "system keyring (Secret Service)", reason: this.down().message };
  }
  async get(key: SecretKey) {
    if (!this.available) throw this.down();
    const value = this.values.get(this.account(key)) ?? null;
    return this.corruptReads && value ? `${value}!` : value;
  }
  async set(key: SecretKey, value: string) {
    if (!this.available || this.sets >= this.dropAfterSets) throw this.down();
    if (value.length > this.maxLength) {
      throw { unavailable: false, message: "the password is longer than this credential store allows (8)" };
    }
    this.index.add(this.account(key));
    this.values.set(this.account(key), value);
    this.sets += 1;
  }
  async delete(key: SecretKey) {
    if (!this.available) throw this.down();
    this.values.delete(this.account(key));
    this.index.delete(this.account(key));
  }
  async list() {
    if (!this.available) throw this.down();
    return [...this.index].map((account) => {
      const [envId, ...rest] = account.split("/");
      return { envId, name: rest.join("/") };
    });
  }
}

/** The plaintext file, recording every write so an interruption can be replayed. */
class FakeFile implements SecretFile {
  map: SecretMap | null;
  writes: Array<SecretMap | null> = [];
  constructor(initial: SecretMap | null = null) {
    this.map = initial;
  }
  async read() {
    return { ...(this.map ?? {}) };
  }
  async write(map: SecretMap) {
    this.map = { ...map };
    this.writes.push(this.map);
  }
  async remove() {
    this.map = null;
    this.writes.push(null);
  }
}

const envs = (): Environment[] => [
  {
    id: "env_a",
    name: "Staging",
    variables: [
      { name: "baseUrl", value: "https://staging.example.com", secret: false },
      { name: "token", value: "", secret: true },
      { name: "password", value: "", secret: true },
    ],
  },
  { id: "env_b", name: "Prod", variables: [{ name: "token", value: "", secret: true }] },
];

const legacy: SecretMap = {
  "env_a:token": "sk_test_a",
  "env_a:password": "hunter2",
  "env_b:token": "sk_live_b",
};

function withValues(environments: Environment[], values: Map<string, string>): Environment[] {
  return environments.map((env) => ({
    ...env,
    variables: env.variables.map((v) =>
      v.secret ? { ...v, value: values.get(secretKey(env.id, v.name)) ?? "" } : v,
    ),
  }));
}

describe("secret keys", () => {
  it("round-trips, splitting on the first colon only", () => {
    expect(parseSecretKey(secretKey("env_a", "token"))).toEqual({ envId: "env_a", name: "token" });
    expect(parseSecretKey("env_a:a:b")).toEqual({ envId: "env_a", name: "a:b" });
    expect(parseSecretKey("nocolon")).toBeNull();
    expect(parseSecretKey(":x")).toBeNull();
  });
});

describe("migrating from the plaintext file", () => {
  it("moves every value into the store, verifies it, then removes the file", async () => {
    const vault = new FakeVault();
    const file = new FakeFile({ ...legacy });
    const secrets = createSecrets(vault, file);

    const values = await secrets.load(envs());

    expect(values.get("env_a:token")).toBe("sk_test_a");
    expect(values.get("env_b:token")).toBe("sk_live_b");
    expect(vault.values.get("env_a/password")).toBe("hunter2");
    expect(file.map).toBeNull();
    expect(secrets.status()).toEqual({ mode: "store", store: "macOS Keychain", inFile: 0 });
  });

  it("removes each value from the file as it goes, so stopping halfway loses nothing", async () => {
    const vault = new FakeVault();
    const file = new FakeFile({ ...legacy });
    await createSecrets(vault, file).load(envs());

    // After every intermediate write, each value is in the file or the store.
    for (const snapshot of file.writes) {
      for (const [key, value] of Object.entries(legacy)) {
        const inFile = snapshot?.[key] === value;
        const inStore = vault.values.get(key.replace(":", "/")) === value;
        expect(inFile || inStore).toBe(true);
      }
    }
  });

  it("finishes the job when run again after an interruption", async () => {
    const vault = new FakeVault();
    vault.dropAfterSets = 1; // the store goes away after the first value
    const file = new FakeFile({ ...legacy });
    const first = createSecrets(vault, file);
    const during = await first.load(envs());

    // Nothing lost: the session still has every value, and falls back to the file.
    expect(during.get("env_a:password")).toBe("hunter2");
    expect(first.status().mode).toBe("file");
    expect(Object.keys(file.map ?? {})).toHaveLength(2);

    vault.dropAfterSets = Infinity;
    const second = createSecrets(vault, file);
    const after = await second.load(envs());
    expect([...after.values()].sort()).toEqual(["hunter2", "sk_live_b", "sk_test_a"]);
    expect(file.map).toBeNull();
  });

  it("is idempotent: a second run over a finished migration changes nothing", async () => {
    const vault = new FakeVault();
    const file = new FakeFile({ ...legacy });
    await createSecrets(vault, file).load(envs());
    const writes = file.writes.length;
    const again = await createSecrets(vault, file).load(envs());
    expect(again.get("env_a:token")).toBe("sk_test_a");
    expect(file.writes.length).toBe(writes);
  });

  it("keeps a value in the file when it doesn't read back the same", async () => {
    const vault = new FakeVault();
    vault.corruptReads = true;
    const file = new FakeFile({ "env_b:token": "sk_live_b" });
    const secrets = createSecrets(vault, file);
    const values = await secrets.load(envs());
    expect(file.map).toEqual({ "env_b:token": "sk_live_b" });
    expect(values.get("env_b:token")).toBe("sk_live_b");
    expect(secrets.status()).toMatchObject({ mode: "store", inFile: 1 });
  });

  it("drops file entries no secret variable refers to", async () => {
    const vault = new FakeVault();
    const file = new FakeFile({ "env_gone:token": "old" });
    await createSecrets(vault, file).load(envs());
    expect(file.map).toBeNull();
    expect(vault.values.size).toBe(0);
  });
});

describe("when the credential store is unavailable", () => {
  it("uses the file for the session and says why", async () => {
    const vault = new FakeVault();
    vault.available = false;
    const file = new FakeFile({ ...legacy });
    const secrets = createSecrets(vault, file);

    const values = await secrets.load(envs());
    expect(values.get("env_a:token")).toBe("sk_test_a");
    expect(file.map).toEqual(legacy); // untouched
    expect(secrets.status()).toEqual({
      mode: "file",
      store: "system keyring (Secret Service)",
      reason: "no Secret Service on the session bus",
    });
  });

  it("saves to the file and leaves the store alone", async () => {
    const vault = new FakeVault();
    vault.available = false;
    const file = new FakeFile();
    const secrets = createSecrets(vault, file);
    await secrets.load(envs());

    const values = new Map([["env_a:token", "new_token"]]);
    await secrets.save(withValues(envs(), values));
    expect(file.map).toEqual({ "env_a:token": "new_token" });
    expect(vault.values.size).toBe(0);
  });

  it("falls back mid-save without losing a value", async () => {
    const vault = new FakeVault();
    const file = new FakeFile();
    const secrets = createSecrets(vault, file);
    await secrets.load(envs());

    vault.dropAfterSets = 1;
    const values = new Map([
      ["env_a:token", "t1"],
      ["env_b:token", "t2"],
    ]);
    await secrets.save(withValues(envs(), values));
    expect(secrets.status().mode).toBe("file");
    expect(file.map).toEqual({ "env_a:token": "t1", "env_b:token": "t2" });
  });

  it("moves values written during a fallback session into the store once it's back", async () => {
    const vault = new FakeVault();
    vault.available = false;
    const file = new FakeFile();
    const offline = createSecrets(vault, file);
    await offline.load(envs());
    await offline.save(withValues(envs(), new Map([["env_a:token", "while-offline"]])));

    vault.available = true;
    const online = createSecrets(vault, file);
    const values = await online.load(envs());
    expect(values.get("env_a:token")).toBe("while-offline");
    expect(vault.values.get("env_a/token")).toBe("while-offline");
    expect(file.map).toBeNull();
  });

  it("keeps a value the store refuses in the file, and only that one", async () => {
    const vault = new FakeVault();
    vault.maxLength = 8;
    const file = new FakeFile();
    const secrets = createSecrets(vault, file);
    await secrets.load(envs());

    const values = new Map([
      ["env_a:token", "short"],
      ["env_b:token", "a-very-long-jwt-value"],
    ]);
    await secrets.save(withValues(envs(), values));
    expect(vault.values.get("env_a/token")).toBe("short");
    expect(file.map).toEqual({ "env_b:token": "a-very-long-jwt-value" });
    expect(secrets.status()).toMatchObject({ mode: "store", inFile: 1 });

    // And it reads back from the file next time.
    const reloaded = await createSecrets(vault, file).load(envs());
    expect(reloaded.get("env_b:token")).toBe("a-very-long-jwt-value");
  });
});

describe("keeping the store tidy", () => {
  async function seeded() {
    const vault = new FakeVault();
    const file = new FakeFile({ ...legacy });
    const secrets = createSecrets(vault, file);
    const values = await secrets.load(envs());
    return { vault, file, secrets, loaded: withValues(envs(), values) };
  }

  it("moves the entry when a variable is renamed", async () => {
    const { vault, secrets, loaded } = await seeded();
    loaded[0].variables[1].name = "apiToken";
    await secrets.save(loaded);
    expect(vault.values.has("env_a/token")).toBe(false);
    expect(vault.values.get("env_a/apiToken")).toBe("sk_test_a");
  });

  it("removes every entry of a deleted environment", async () => {
    const { vault, secrets, loaded } = await seeded();
    await secrets.save(loaded.filter((env) => env.id !== "env_a"));
    expect([...vault.index]).toEqual(["env_b/token"]);
  });

  it("removes the entry when a variable is deleted, un-marked secret, or cleared", async () => {
    const { vault, secrets, loaded } = await seeded();
    loaded[0].variables = loaded[0].variables.filter((v) => v.name !== "password");
    loaded[0].variables[1].secret = false;
    loaded[1].variables[0].value = "";
    await secrets.save(loaded);
    expect(vault.index.size).toBe(0);
    expect(vault.values.size).toBe(0);
  });

  it("doesn't rewrite values that haven't changed", async () => {
    const { vault, secrets, loaded } = await seeded();
    const before = vault.sets;
    await secrets.save(loaded);
    expect(vault.sets).toBe(before);
    loaded[1].variables[0].value = "rotated";
    await secrets.save(loaded);
    expect(vault.sets).toBe(before + 1);
    expect(vault.values.get("env_b/token")).toBe("rotated");
  });

  it("writes no plaintext file while the store takes everything", async () => {
    const { file, secrets, loaded } = await seeded();
    await secrets.save(loaded);
    expect(file.map).toBeNull();
  });
});

describe("the browser preview", () => {
  it("keeps using local storage, as before", async () => {
    const file = new FakeFile({ "env_a:token": "t" });
    const secrets = createSecrets(null, file);
    expect((await secrets.load(envs())).get("env_a:token")).toBe("t");
    await secrets.save(withValues(envs(), new Map([["env_b:token", "u"]])));
    expect(file.map).toEqual({ "env_b:token": "u" });
    expect(secrets.status()).toEqual({ mode: "browser" });
  });
});

describe("what the dialog says", () => {
  it("names the store when it's in use", () => {
    const note = describeSecretStorage({ mode: "store", store: "Windows Credential Manager", inFile: 0 });
    expect(note.where).toBe("Secret values are kept in the Windows Credential Manager, not in a file.");
    expect(note.notice).toBeUndefined();
  });

  it("explains the fallback calmly, with a Linux fix", () => {
    const note = describeSecretStorage({
      mode: "file",
      store: "system keyring (Secret Service)",
      reason: "no Secret Service on the session bus",
    });
    expect(note.where).toMatch(/local file .* not encrypted/);
    expect(note.notice?.text).toMatch(/Nothing is lost/);
    expect(note.notice?.fix).toMatch(/GNOME Keyring or KWallet/);
    expect(note.notice?.details).toBe("no Secret Service on the session bus");
  });

  it("says when some values couldn't go to the store", () => {
    const note = describeSecretStorage({
      mode: "store",
      store: "Windows Credential Manager",
      inFile: 2,
      fileReason: "too long",
    });
    expect(note.notice?.text).toMatch(/^2 secret values couldn't be saved/);
  });
});
