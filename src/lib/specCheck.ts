import { parseSpec, resolveRef, type Json, type ParsedSpec } from "./spec";

/**
 * Two things an agent editing a spec wants to know: does it still load and
 * make sense, and what changed since Studio last read it. No React, no IO.
 *
 * This is not a style guide or a linter. It reports what stops Studio (or any
 * client) from using an operation: a reference that points nowhere, a path
 * parameter nobody declared, two operations with the same id.
 */

export interface SpecProblem {
  /** `error`: something can't work. `warning`: it works, but is likely a mistake. */
  level: "error" | "warning";
  /** Where: `GET /orders/{id}`, `components.schemas.Order`, or `document`. */
  where: string;
  message: string;
}

/** At most this many of one kind, so a broken spec doesn't produce a wall of text. */
const MAX_PER_KIND = 25;

function walkRefs(node: unknown, path: string[], found: Array<{ ref: string; at: string }>, seen = new Set<unknown>()) {
  if (!node || typeof node !== "object" || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node)) {
    node.forEach((item, index) => walkRefs(item, [...path, String(index)], found, seen));
    return;
  }
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "$ref" && typeof value === "string") found.push({ ref: value, at: path.join(".") || "document" });
    else walkRefs(value, [...path, key], found, seen);
  }
}

/** Problems in a spec's text. An unparseable document is one problem, saying why. */
export function specProblems(text: string, title: string, documentUrl?: string): SpecProblem[] {
  let spec: ParsedSpec;
  try {
    spec = parseSpec(text, title, documentUrl);
  } catch (error) {
    return [{ level: "error", where: "document", message: `It doesn't load: ${error instanceof Error ? error.message : String(error)}` }];
  }
  return problemsIn(spec);
}

export function problemsIn(spec: ParsedSpec): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const doc = spec.doc;
  const add = (kind: string, problem: SpecProblem, counts: Map<string, number>) => {
    const n = (counts.get(kind) ?? 0) + 1;
    counts.set(kind, n);
    if (n <= MAX_PER_KIND) problems.push(problem);
  };
  const counts = new Map<string, number>();

  if (!doc.info?.title) add("info", { level: "warning", where: "info", message: "info.title is missing." }, counts);
  if (!doc.info?.version) add("info", { level: "warning", where: "info", message: "info.version is missing." }, counts);
  if (!spec.servers.length) {
    add("servers", { level: "warning", where: "servers", message: "No servers are declared, so requests have no default address." }, counts);
  }

  const refs: Array<{ ref: string; at: string }> = [];
  walkRefs(doc, [], refs);
  for (const { ref, at } of refs) {
    if (!ref.startsWith("#/")) {
      add("ref", { level: "warning", where: at, message: `${ref} points outside this document, which Studio doesn't follow.` }, counts);
    } else if (resolveRef(doc, ref) === undefined) {
      add("ref", { level: "error", where: at, message: `${ref} doesn't point to anything in the document.` }, counts);
    }
  }

  const ids = new Map<string, string[]>();
  for (const op of spec.operations) {
    const where = `${op.method} ${op.path}`;
    if (op.operationId) ids.set(op.operationId, [...(ids.get(op.operationId) ?? []), where]);
    else add("id", { level: "warning", where, message: "No operationId, so collections refer to it by method and path." }, counts);

    const inPath = [...op.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
    const declared = op.parameters.filter((param) => param.in === "path").map((param) => param.name);
    for (const name of inPath) {
      if (!declared.includes(name)) {
        add("param", { level: "error", where, message: `The path has {${name}}, but no path parameter called ${name} is declared.` }, counts);
      }
    }
    for (const name of declared) {
      if (!inPath.includes(name)) {
        add("param", { level: "error", where, message: `Path parameter ${name} is declared, but the path has no {${name}}.` }, counts);
      }
    }
    if (!op.responses.length) add("responses", { level: "error", where, message: "No responses are declared." }, counts);
  }
  for (const [id, places] of ids) {
    if (places.length > 1) {
      add("dupe", { level: "error", where: places.join(", "), message: `operationId ${id} is used ${places.length} times; each must be unique.` }, counts);
    }
  }

  for (const [kind, n] of counts) {
    if (n > MAX_PER_KIND) {
      problems.push({ level: "warning", where: "document", message: `${n - MAX_PER_KIND} more like the above (${kind}) not listed.` });
    }
  }
  return problems;
}

export interface SpecChanges {
  version: { before: string; after: string } | null;
  operationsAdded: string[];
  operationsRemoved: string[];
  /** Operations whose definition changed in any way. */
  operationsChanged: string[];
  schemasAdded: string[];
  schemasRemoved: string[];
  schemasChanged: string[];
  serversBefore: string[] | null;
  serversAfter: string[] | null;
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** What changed between two readings of a spec, by name. */
export function specChanges(before: ParsedSpec, after: ParsedSpec): SpecChanges {
  const operation = (spec: ParsedSpec, method: string, path: string) =>
    spec.doc.paths?.[path]?.[method.toLowerCase()] as unknown;
  const beforeOps = new Map(before.operations.map((op) => [op.id, op]));
  const afterOps = new Map(after.operations.map((op) => [op.id, op]));
  const operationsAdded = [...afterOps.keys()].filter((id) => !beforeOps.has(id));
  const operationsRemoved = [...beforeOps.keys()].filter((id) => !afterOps.has(id));
  const operationsChanged = [...afterOps.values()]
    .filter((op) => beforeOps.has(op.id))
    .filter((op) => {
      const old = beforeOps.get(op.id)!;
      return (
        !same(operation(before, old.method, old.path), operation(after, op.method, op.path)) ||
        !same(before.doc.paths?.[old.path]?.parameters, after.doc.paths?.[op.path]?.parameters)
      );
    })
    .map((op) => op.id);

  const beforeSchemas = new Map(before.schemas.map((entry) => [entry.name, entry.schema]));
  const afterSchemas = new Map(after.schemas.map((entry) => [entry.name, entry.schema]));
  const schemasAdded = [...afterSchemas.keys()].filter((name) => !beforeSchemas.has(name));
  const schemasRemoved = [...beforeSchemas.keys()].filter((name) => !afterSchemas.has(name));
  const schemasChanged = [...afterSchemas.keys()].filter(
    (name) => beforeSchemas.has(name) && !same(beforeSchemas.get(name), afterSchemas.get(name)),
  );
  const serversChanged = !same(before.servers, after.servers);
  return {
    version: before.version === after.version ? null : { before: before.version, after: after.version },
    operationsAdded: operationsAdded.sort(),
    operationsRemoved: operationsRemoved.sort(),
    operationsChanged: operationsChanged.sort(),
    schemasAdded: schemasAdded.sort(),
    schemasRemoved: schemasRemoved.sort(),
    schemasChanged: schemasChanged.sort(),
    serversBefore: serversChanged ? before.servers : null,
    serversAfter: serversChanged ? after.servers : null,
  };
}

/** True when nothing an agent would care about changed. */
export function noChanges(changes: SpecChanges): boolean {
  return (
    !changes.version &&
    !changes.serversAfter &&
    [
      changes.operationsAdded,
      changes.operationsRemoved,
      changes.operationsChanged,
      changes.schemasAdded,
      changes.schemasRemoved,
      changes.schemasChanged,
    ].every((list) => list.length === 0)
  );
}
