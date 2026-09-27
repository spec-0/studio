import { readStore, writeStore, STORE } from "./store";
import { secrets } from "./secrets";
import { setKnownSecrets } from "./redact";

/**
 * Environments and variables.
 *
 * An environment is a named bag of variables that interpolate into the URL,
 * headers, and body as `{{name}}`. A variable can be marked secret: the
 * environment file then records that the variable exists and is secret, but not
 * its value — so the file is safe to commit. Secret values live in the OS
 * credential store (see `secrets.ts`).
 *
 * **An environment supplies values, never destinations.** Where a request goes is
 * a *target*: a server from the spec, a hosted mock, or a URL you typed — those
 * belong to the API, and the platform's own environments are runtime
 * environments describing where a version is deployed. A client environment is a
 * testing scenario: ids, tokens, per-case data.
 *
 * This type used to carry a `baseUrl` alongside its variables and appear in the
 * target list, which fused the two. It didn't survive contact with real cloud
 * environments arriving as targets. A `baseUrl` *variable* is still good practice
 * — it's just a variable, with no privileged field and no privileged UI.
 */

export interface Variable {
  name: string;
  value: string;
  secret: boolean;
}

export interface Environment {
  id: string;
  name: string;
  variables: Variable[];
}

/** Shape of environments written before `baseUrl` became an ordinary variable. */
export interface LegacyEnvironment extends Environment {
  baseUrl?: string;
}

/**
 * Fold a legacy `baseUrl` field into a `baseUrl` variable.
 *
 * Runs on every load and is idempotent. Dropping the field without this would
 * silently lose a URL the user had set, which is the one outcome a model change
 * isn't allowed to cause.
 */
export function migrateBaseUrl(env: LegacyEnvironment): Environment {
  const { baseUrl, ...rest } = env;
  if (!baseUrl) return rest;
  const already = rest.variables.some((v) => v.name === "baseUrl");
  return already
    ? rest
    : { ...rest, variables: [...rest.variables, { name: "baseUrl", value: baseUrl, secret: false }] };
}

export interface EnvironmentFile {
  environments: Environment[];
  activeId: string | null;
}

const EMPTY: EnvironmentFile = { environments: [], activeId: null };

export async function loadEnvironments(): Promise<EnvironmentFile> {
  const file = await readStore<EnvironmentFile>(STORE.environments, EMPTY);
  const environments = file.environments.map(migrateBaseUrl);
  const values = await secrets.load(environments);
  const loaded: EnvironmentFile = {
    ...file,
    environments: environments.map((env) => ({
      ...env,
      variables: env.variables.map((variable) =>
        variable.secret
          ? { ...variable, value: values.get(`${env.id}:${variable.name}`) ?? "" }
          : variable,
      ),
    })),
  };
  setKnownSecrets(loaded.environments);
  return loaded;
}

/** The committable file: secret variables are recorded, their values are not. */
export function redactedFile(file: EnvironmentFile): EnvironmentFile {
  return {
    activeId: file.activeId,
    environments: file.environments.map((env) => ({
      ...env,
      variables: env.variables.map((variable) =>
        variable.secret ? { ...variable, value: "" } : variable,
      ),
    })),
  };
}

export async function saveEnvironments(file: EnvironmentFile): Promise<void> {
  setKnownSecrets(file.environments);
  // The committable file first: if the secret store then fails, the worst case
  // is a value that didn't save, never a value written into environments.json.
  await writeStore(STORE.environments, redactedFile(file));
  await secrets.save(file.environments);
}

export function newEnvironment(name: string): Environment {
  return {
    // Date.now is fine here — this is a local id, not a reproducibility concern.
    id: `env_${Date.now().toString(36)}`,
    name,
    variables: [],
  };
}

/** Set a variable, replacing it if present. Used by "save this URL as a variable". */
export function withVariable(env: Environment, name: string, value: string): Environment {
  const exists = env.variables.some((v) => v.name === name);
  return {
    ...env,
    variables: exists
      ? env.variables.map((v) => (v.name === name ? { ...v, value } : v))
      : [...env.variables, { name, value, secret: false }],
  };
}

export function variableMap(env: Environment | null): Record<string, string> {
  if (!env) return {};
  return Object.fromEntries(env.variables.map((variable) => [variable.name, variable.value]));
}

const TOKEN = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Substitute `{{name}}`. Unknown names are left verbatim so they're visible, not silently blank. */
export function interpolate(input: string, vars: Record<string, string>): string {
  if (!input.includes("{{")) return input;
  return input.replace(TOKEN, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : whole,
  );
}

/** Names referenced in the text that the active environment doesn't define. */
export function unresolved(input: string, vars: Record<string, string>): string[] {
  const missing = new Set<string>();
  for (const match of input.matchAll(TOKEN)) {
    if (!Object.prototype.hasOwnProperty.call(vars, match[1])) missing.add(match[1]);
  }
  return [...missing];
}
