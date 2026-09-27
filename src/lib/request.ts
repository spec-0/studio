import { invoke } from "@tauri-apps/api/core";
import type { OperationSpec } from "./spec";
import { interpolate } from "./env";
import { redact } from "./redact";

/**
 * Request execution.
 *
 * Inside Tauri this goes through our own reqwest command (`src-tauri/src/http.rs`),
 * which sends no `Origin` — the hard advantage over every browser-based client.
 * Running `npm run dev` in a plain browser falls back to `window.fetch` so the UI
 * can be iterated on without a native rebuild; requests to third-party APIs will
 * hit CORS there, which is expected.
 */

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * `fetch`-style bodies are strings here; a structured body arrives already
 * shaped. Anything else is not something we send.
 */
function toPlanBody(body: unknown): PlanBody | undefined {
  if (typeof body === "string") return { kind: "text", text: body };
  if (body && typeof body === "object" && "kind" in body) return body as PlanBody;
  return undefined;
}

interface RustResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  binary?: boolean;
  contentType?: string;
  byteLength?: number;
  bodyPath?: string | null;
  previewBase64?: string | null;
  ms: number;
  redirects?: string[];
}

/** Set on responses whose payload isn't text. */
export const BINARY = Symbol("binary");

/**
 * Transport options for one request — certificate trust, proxy, timeout,
 * redirects, and which cookie jar to use.
 *
 * Threaded through `appFetch` rather than set globally because trust is
 * per-host: the same session talks to a private-CA internal service and to
 * spec0's public API, and only one of those should have relaxed rules.
 */
export interface Transport {
  timeoutMs?: number;
  followRedirects?: boolean;
  tls?: { insecure?: boolean; caBundlePem?: string };
  proxy?: { url?: string; noProxy?: string; disabled?: boolean };
  /** Cookie jar key — the library entry id. Omitted means no cookies at all. */
  jar?: string;
}

/** The redirect chain the last response followed, when there was one. */
export const REDIRECTS = Symbol("redirects");

/** Server timing, in ms, measured in Rust — attached to responses it produced. */
export const SERVER_MS = Symbol("serverMs");

/**
 * The one fetch everything goes through — platform calls and user API calls alike.
 *
 * Inside Tauri this is `reqwest` via our own command, **not** `tauri-plugin-http`.
 * The plugin attaches the webview's `Origin` to every request, which makes any
 * CORS-configured server reject a desktop client (spec0's own API answered
 * `403 Invalid CORS request`). We send exactly the headers asked for and no
 * origin, the same as the CLI does — that is what "no CORS" actually requires.
 *
 * The result is wrapped in a real `Response` so callers use the standard API.
 */
export const appFetch = (async (
  input: RequestInfo | URL,
  init?: RequestInit & { transport?: Transport },
) => {
  if (!inTauri) return window.fetch(input as never, init as never);

  const url = typeof input === "string" ? input : input.toString();
  const headers: Record<string, string> = {};
  if (init?.headers) {
    if (init.headers instanceof Headers) init.headers.forEach((v, k) => (headers[k] = v));
    else if (Array.isArray(init.headers)) for (const [k, v] of init.headers) headers[k] = v;
    else Object.assign(headers, init.headers);
  }

  const transport = init?.transport ?? {};
  const result = await invoke<RustResponse>("http_send", {
    request: {
      method: init?.method ?? "GET",
      url,
      headers,
      body: toPlanBody(init?.body),
      timeoutMs: transport.timeoutMs ?? 30_000,
      followRedirects: transport.followRedirects ?? true,
      tls: transport.tls,
      proxy: transport.proxy,
      jar: transport.jar,
    },
  });

  // 204/205/304 must not carry a body, or the Response constructor throws.
  const bodyless = [204, 205, 304].includes(result.status);
  const response = new Response(bodyless ? null : result.body, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  Object.defineProperty(response, SERVER_MS, { value: result.ms });
  Object.defineProperty(response, REDIRECTS, { value: result.redirects ?? [] });
  Object.defineProperty(response, BINARY, {
    value: result.binary
      ? {
          contentType: result.contentType ?? "",
          byteLength: result.byteLength ?? 0,
          path: result.bodyPath ?? null,
          previewBase64: result.previewBase64 ?? null,
        }
      : null,
  });
  return response;
}) as AppFetch;

/**
 * `fetch`, plus the transport options only a desktop client can honour.
 *
 * Typed explicitly rather than `as typeof fetch` so `transport` survives — the
 * cast was erasing it, which is how a per-host trust decision would have
 * silently stopped reaching Rust.
 */
type AppFetch = (
  input: RequestInfo | URL,
  init?: Omit<RequestInit, "body"> & { body?: BodyInit | PlanBody | null; transport?: Transport },
) => Promise<Response>;

export interface AuthState {
  schemeName: string | null;
  value: string;
  /** For `apiKey` schemes: which header/query parameter carries the value. */
  paramName?: string;
  in?: string;
  type?: string;
  httpScheme?: string;
}

/**
 * One part of a multipart body.
 *
 * A file is referenced by **path**, not content. Base64 over the IPC bridge
 * would inflate every upload by a third and hold the whole file in the webview's
 * heap; Rust reads it instead, and the file dialog was already the consent step.
 */
export interface MultipartPart {
  name: string;
  value?: string;
  path?: string;
  fileName?: string;
  contentType?: string;
}

/**
 * What to send.
 *
 * A union rather than a string because `multipart/form-data` can't be one: it
 * needs real bytes and a boundary the HTTP client generates.
 */
export type PlanBody =
  | { kind: "text"; text: string }
  | { kind: "form"; fields: Array<[string, string]> }
  | { kind: "multipart"; parts: MultipartPart[] };

export interface RequestPlan {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: PlanBody;
}

export interface ResponseResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  bodyText: string;
  json?: unknown;
  ms: number;
  bytes: number;
  /** URLs followed to get here. Empty when the request went straight there. */
  redirects?: string[];
  /**
   * Present when the payload isn't text.
   *
   * `bodyText` is empty in that case rather than holding mangled bytes — an
   * image rendered as replacement characters is worse than saying "this is an
   * image".
   */
  binary?: {
    contentType: string;
    byteLength: number;
    path: string | null;
    previewBase64: string | null;
  } | null;
}

export function buildPlan(
  op: OperationSpec,
  server: string,
  pathParams: Record<string, string>,
  queryParams: Record<string, string>,
  headerParams: Record<string, string>,
  auth: AuthState | null,
  body: BodyInput,
  vars: Record<string, string> = {},
  mock?: { url: string; key?: string; bearer?: string } | null,
): RequestPlan {
  const fill = (value: string) => interpolate(value, vars);

  let path = op.path;
  for (const [key, value] of Object.entries(pathParams)) {
    if (value) path = path.replaceAll(`{${key}}`, encodeURIComponent(fill(value)));
  }

  const base = fill(server).replace(/\/$/, "");
  if (!/^https?:\/\//i.test(base)) {
    throw new Error(`Base URL must start with http:// or https:// — got "${base || "(empty)"}"`);
  }
  const url = new URL(base + path);
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== "") url.searchParams.set(key, fill(value));
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headerParams)) {
    if (value !== "") headers[key] = fill(value);
  }
  const planBody = buildBody(op, body, fill);
  // Multipart's content type carries a generated boundary, so the HTTP client
  // writes it — a value set here would be wrong. Form encoding likewise.
  if (planBody?.kind === "text") {
    headers["Content-Type"] = op.requestBody?.contentType ?? "application/json";
  }
  headers["Accept"] = "application/json, */*";

  if (auth?.value) {
    // Auth values interpolate too — `{{apiKey}}` from the active environment is
    // the whole point of marking a variable secret.
    const secret = fill(auth.value);
    if (auth.type === "oauth2") {
      // The value here is the acquired access token, filled in at send time.
      headers["Authorization"] = `Bearer ${secret}`;
    } else if (auth.type === "http" && auth.httpScheme === "bearer") {
      headers["Authorization"] = `Bearer ${secret}`;
    } else if (auth.type === "http" && auth.httpScheme === "basic") {
      headers["Authorization"] = `Basic ${btoa(secret)}`;
    } else if (auth.type === "apiKey" && auth.paramName) {
      if (auth.in === "query") url.searchParams.set(auth.paramName, secret);
      else if (auth.in === "header") headers[auth.paramName] = secret;
      else if (auth.in === "cookie") headers["Cookie"] = `${auth.paramName}=${secret}`;
    } else {
      headers["Authorization"] = secret;
    }
  }

  // Hitting the hosted mock authenticates as itself, not with the API's own scheme.
  // Done here rather than at send time so the curl export carries it too.
  if (mock && url.toString().startsWith(mock.url.replace(/\/$/, ""))) {
    if (mock.key) {
      headers["X-Mock-API-Key"] = mock.key;
    } else if (mock.bearer) {
      // The mock's key is only ever returned at creation, so for a pre-existing
      // mock we have nothing to send. Falling back to the platform session token
      // costs nothing if the backend doesn't accept it (401 either way) and works
      // the day it does. The caller is responsible for only setting `bearer` when
      // the mock lives on the platform's own origin — see App.tsx.
      headers["Authorization"] = `Bearer ${mock.bearer}`;
    }
  }

  return { method: op.method, url: url.toString(), headers, body: planBody };
}

export async function send(
  plan: RequestPlan,
  transport: Transport = {},
): Promise<ResponseResult> {
  const timeoutMs = transport.timeoutMs ?? 30_000;
  const doFetch = appFetch;
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await doFetch(plan.url, {
      method: plan.method,
      headers: plan.headers,
      body: plan.body,
      signal: controller.signal,
      transport,
    });

    const bodyText = await response.text();
    // Prefer the timing Rust measured — it's the network round-trip without the
    // IPC and JSON-parsing overhead sitting on either side of it.
    const measured = (response as unknown as Record<symbol, number>)[SERVER_MS];
    const ms = typeof measured === "number" ? measured : Math.round(performance.now() - started);

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });

    let json: unknown;
    try {
      json = bodyText ? JSON.parse(bodyText) : undefined;
    } catch {
      json = undefined;
    }

    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      bodyText,
      json,
      ms,
      bytes: new TextEncoder().encode(bodyText).length,
      redirects: (response as unknown as Record<symbol, string[]>)[REDIRECTS] ?? [],
      binary: (response as unknown as Record<symbol, ResponseResult["binary"]>)[BINARY] ?? null,
    };
  } catch (error) {
    // Transport errors often quote the URL, and an API key can sit in its query.
    // The message is shown on screen and can end up in a run report.
    if (error instanceof Error) {
      const message = redact(error.message);
      if (message !== error.message) {
        const hidden = new Error(message);
        hidden.name = error.name;
        throw hidden;
      }
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/** What the editor holds, before it becomes a plan. */
export type BodyInput =
  | string
  | { kind: "form"; fields: Array<{ key: string; value: string }> }
  | { kind: "multipart"; parts: MultipartPart[] };

/**
 * Turn the editor's contents into a body, interpolating variables everywhere a
 * user could reasonably put one — field values and text parts included.
 */
function buildBody(
  op: OperationSpec,
  body: BodyInput,
  fill: (value: string) => string,
): PlanBody | undefined {
  if (["GET", "HEAD"].includes(op.method)) return undefined;

  if (typeof body === "string") {
    const text = fill(body);
    return text.trim() === "" ? undefined : { kind: "text", text };
  }

  if (body.kind === "form") {
    const fields = body.fields
      .filter((row) => row.key.trim() !== "")
      .map((row) => [row.key.trim(), fill(row.value)] as [string, string]);
    return fields.length ? { kind: "form", fields } : undefined;
  }

  const parts = body.parts
    .filter((part) => part.name.trim() !== "" && (part.path || part.value !== undefined))
    .map((part) => ({
      ...part,
      name: part.name.trim(),
      value: part.value === undefined ? undefined : fill(part.value),
    }));
  return parts.length ? { kind: "multipart", parts } : undefined;
}

/**
 * A readable rendering of a body, for history.
 *
 * File contents are never recorded — a 40MB upload must not end up in
 * `history.json`, and a summary that says which file it was is more use on a
 * replay than bytes we'd have to re-read anyway.
 */
export function describeBody(body: PlanBody | undefined): string | undefined {
  if (!body) return undefined;
  if (body.kind === "text") return body.text;
  if (body.kind === "form") {
    return body.fields.map(([key, value]) => `${key}=${value}`).join("&");
  }
  return body.parts
    .map((part) => (part.path ? `${part.name}=@${part.fileName ?? part.path}` : `${part.name}=${part.value ?? ""}`))
    .join(", ");
}

export function toCurl(plan: RequestPlan): string {
  const parts = [`curl -X ${plan.method} '${plan.url}'`];
  for (const [key, value] of Object.entries(plan.headers)) {
    parts.push(`  -H '${key}: ${value}'`);
  }
  const quote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;
  if (plan.body?.kind === "text") {
    parts.push(`  -d ${quote(plan.body.text)}`);
  } else if (plan.body?.kind === "form") {
    // --data-urlencode, so curl does the escaping rather than us guessing.
    for (const [key, value] of plan.body.fields) {
      parts.push(`  --data-urlencode ${quote(`${key}=${value}`)}`);
    }
  } else if (plan.body?.kind === "multipart") {
    for (const part of plan.body.parts) {
      const suffix = part.contentType ? `;type=${part.contentType}` : "";
      parts.push(
        part.path
          ? `  -F ${quote(`${part.name}=@${part.path}${suffix}`)}`
          : `  -F ${quote(`${part.name}=${part.value ?? ""}${suffix}`)}`,
      );
    }
  }
  return parts.join(" \\\n");
}

/**
 * A file extension for a content type, for the Save-as default name.
 *
 * A short table rather than a mime database: this only has to produce a
 * plausible default that the user can change, and a wrong guess costs a
 * keystroke. Empty when unknown — better no extension than a misleading one.
 */
export function extensionFor(contentType: string): string {
  const base = contentType.split(";")[0].trim().toLowerCase();
  const known: Record<string, string> = {
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/gzip": ".gz",
    "application/octet-stream": ".bin",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "audio/mpeg": ".mp3",
    "video/mp4": ".mp4",
  };
  return known[base] ?? "";
}
