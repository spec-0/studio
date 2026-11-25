import { readStore, writeStore, STORE } from "./store";
import { secrets } from "./secrets";
import { setKnownSecrets } from "./redact";

/**
 * Environments and variables.
 *
 * An environment is a named bag of variables that interpolate into the URL,
 * headers, and body as `{{name}}`. A variable can be marked secret: the
 * environment file then records that the variable exists and is secret, but not
 * its value, so the file is safe to commit. Secret values live in the OS
 * credential store (see `secrets.ts`).
 *
 * **An environment supplies values, never destinations.** Where a request goes is
 * a *target*: a server from the spec, a hosted mock, or a URL you typed. Those
 * belong to the API, and the platform's own environments are runtime
 * environments describing where a version is deployed. A client environment is a
 * testing scenario: ids, tokens, per-case data.
 *
 * So there is no `baseUrl` field and environments are not targets. A `baseUrl`
 * *variable* is still good practice: it's just a variable, with no privileged
 * field and no privileged UI.
 *
 * **Shared variables** apply in every environment, and with no environment
 * chosen. Most values are the same everywhere, so they're set once there; an
 * environment holds only what differs, and its value wins over a shared one with
 * the same name.
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
  /** Variables used in every environment. Missing in files written before they existed. */
  shared?: Variable[];
}

const EMPTY: EnvironmentFile = { environments: [], activeId: null, shared: [] };

/**
 * The id shared variables are kept under where an environment's id would be: in
 * the secret store (`shared:<name>`) and in the Environments dialog. Real
 * environment ids start with `env_`, so it can't clash.
 */
export const SHARED_ID = "shared";

/** Shared variables, as an environment, so secrets and redaction treat them like any other. */
export function sharedEnvironment(file: EnvironmentFile): Environment {
  return { id: SHARED_ID, name: "Shared", variables: file.shared ?? [] };
}

/** Every set of variables in the file: the shared ones, then each environment's. */
export function variableSets(file: EnvironmentFile): Environment[] {
  return [sharedEnvironment(file), ...file.environments];
}

const withSecretValues = (env: Environment, values: Map<string, string>): Environment => ({
  ...env,
  variables: env.variables.map((variable) =>
    variable.secret ? { ...variable, value: values.get(`${env.id}:${variable.name}`) ?? "" } : variable,
  ),
});

export async function loadEnvironments(): Promise<EnvironmentFile> {
  const file = await readStore<EnvironmentFile>(STORE.environments, EMPTY);
  const read: EnvironmentFile = { ...file, environments: file.environments.map(migrateBaseUrl), shared: file.shared ?? [] };
  const values = await secrets.load(variableSets(read));
  const loaded: EnvironmentFile = {
    ...read,
    environments: read.environments.map((env) => withSecretValues(env, values)),
    shared: withSecretValues(sharedEnvironment(read), values).variables,
  };
  setKnownSecrets(variableSets(loaded));
  return loaded;
}

const withoutSecretValues = (variables: Variable[]): Variable[] =>
  variables.map((variable) => (variable.secret ? { ...variable, value: "" } : variable));

/** The committable file: secret variables are recorded, their values are not. */
export function redactedFile(file: EnvironmentFile): EnvironmentFile {
  return {
    activeId: file.activeId,
    shared: withoutSecretValues(file.shared ?? []),
    environments: file.environments.map((env) => ({ ...env, variables: withoutSecretValues(env.variables) })),
  };
}

export async function saveEnvironments(file: EnvironmentFile): Promise<void> {
  setKnownSecrets(variableSets(file));
  // The committable file first: if the secret store then fails, the worst case
  // is a value that didn't save, never a value written into environments.json.
  await writeStore(STORE.environments, redactedFile(file));
  await secrets.save(variableSets(file));
}

export function newEnvironment(name: string): Environment {
  return {
    // Date.now is fine here: this is a local id, not a reproducibility concern.
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
  return Object.fromEntries(env.variables.filter((variable) => variable.name).map((variable) => [variable.name, variable.value]));
}

/** The active environment, or null when none is chosen. */
export function activeEnvironment(file: EnvironmentFile): Environment | null {
  return file.environments.find((env) => env.id === file.activeId) ?? null;
}

/**
 * The values `{{name}}` resolves to: the shared variables, with the active
 * environment's on top. With no environment chosen, just the shared ones.
 */
export function effectiveVariables(file: EnvironmentFile): Record<string, string> {
  return { ...variableMap(sharedEnvironment(file)), ...variableMap(activeEnvironment(file)) };
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

/**
 * Keep an ad-hoc base URL as a `baseUrl` variable: in the active environment, or
 * with the shared variables when no environment is chosen.
 *
 * Typing a URL stays the zero-setup path; this is only for wanting it back
 * tomorrow. It writes a plain variable rather than a special field, so there is
 * exactly one notion of environment.
 */
export function withBaseUrl(file: EnvironmentFile, url: string): EnvironmentFile {
  const active = activeEnvironment(file);
  if (!active) return { ...file, shared: withVariable(sharedEnvironment(file), "baseUrl", url).variables };
  const updated = withVariable(active, "baseUrl", url);
  return { ...file, environments: file.environments.map((env) => (env.id === updated.id ? updated : env)) };
}

/**
 * Add an environment made elsewhere (an imported collection's variables) and
 * make it the active one. Its name gets a number if another environment has it.
 */
export function withNewEnvironment(file: EnvironmentFile, draft: { name: string; variables: Variable[] }): EnvironmentFile {
  const names = new Set(file.environments.map((env) => env.name));
  let name = draft.name.trim() || "Imported";
  for (let n = 2; names.has(name); n += 1) name = `${draft.name.trim() || "Imported"} ${n}`;
  const env: Environment = {
    ...newEnvironment(name),
    id: `env_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    variables: draft.variables.map((v) => ({ ...v })),
  };
  return { ...file, activeId: env.id, environments: [...file.environments, env] };
}
