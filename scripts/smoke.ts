/**
 * Smoke test for Studio's spec pipeline — parse, example-generate, validate,
 * and answer every operation the way a local mock would.
 *
 * Run against real specs, not fixtures: the point is to find out whether the
 * parser survives Stripe-scale input and whether drift detection actually fires.
 * Swagger 2.0 specs (Kubernetes', Docker Engine's) go through the converter
 * first, so they exercise it at the same scale.
 *
 *   npx esbuild scripts/smoke.ts --bundle --platform=node --format=esm --outfile=/tmp/smoke.mjs
 *   node /tmp/smoke.mjs <spec-file>…
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parseSpec } from "../src/lib/spec";
import { exampleFor } from "../src/lib/example";
import { validateResponse } from "../src/lib/validate";
import { answerMockRequest, OPERATION_HEADER } from "../src/lib/localMock";

function ms(start: number): string {
  return `${Math.round(performance.now() - start)}ms`;
}

let failures = 0;

for (const file of process.argv.slice(2)) {
  const name = basename(file);
  console.log(`\n━━━ ${name} ━━━`);
  try {
    const text = readFileSync(file, "utf-8");
    console.log(`  size            ${(text.length / 1024 / 1024).toFixed(2)}MB`);

    const t0 = performance.now();
    const spec = parseSpec(text, name);
    console.log(`  parse           ${ms(t0)}`);
    console.log(`  title           ${spec.title} ${spec.version}`);
    if (spec.converted) {
      // Swagger 2.0 is converted on the way in; everything below runs on the conversion.
      console.log(`  converted       from ${spec.converted.from}${spec.converted.notes.length ? ` (${spec.converted.notes.join(" ")})` : ""}`);
    }
    console.log(`  operations      ${spec.operations.length}`);
    console.log(`  schemas         ${spec.schemas.length}`);
    console.log(`  tags            ${spec.tags.length}`);
    console.log(`  servers         ${spec.servers.join(", ") || "(none)"}`);
    console.log(`  security        ${spec.securitySchemes.map((s) => s.name).join(", ") || "(none)"}`);

    // Example generation over every operation that declares a body — the place a
    // naive generator either stack-overflows on recursion or emits `"string"`.
    const t1 = performance.now();
    let bodies = 0;
    let placeholders = 0;
    for (const op of spec.operations) {
      if (!op.requestBody?.schema) continue;
      const value = exampleFor(spec.doc, op.requestBody.schema, "body");
      bodies += 1;
      if (JSON.stringify(value ?? "").includes('"string"')) placeholders += 1;
    }
    console.log(`  bodies built    ${bodies} in ${ms(t1)}`);
    console.log(
      `  with untyped placeholders  ${placeholders} (${bodies ? Math.round((placeholders / bodies) * 100) : 0}%)`,
    );

    // Example generation over every named schema — the recursion stress test.
    const t2 = performance.now();
    for (const entry of spec.schemas) exampleFor(spec.doc, entry.schema, entry.name);
    console.log(`  ${spec.schemas.length} schema examples  ${ms(t2)}`);

    // Round-trip: a generated example must validate against its own schema.
    // Where it doesn't, either the generator or the validator is wrong.
    const sample = spec.schemas.slice(0, 60);
    let clean = 0;
    const t3 = performance.now();
    for (const entry of sample) {
      const value = exampleFor(spec.doc, entry.schema, entry.name);
      const result = validateResponse(spec.doc, entry.schema, value);
      if (result.status === "ok" || result.status === "no_schema") clean += 1;
    }
    console.log(`  self-validation ${clean}/${sample.length} clean in ${ms(t3)}`);

    // A local mock must find every operation by its own path and answer it.
    const t4 = performance.now();
    let misrouted = 0;
    for (const op of spec.operations) {
      const path = op.path.replace(/\{[^}]+\}/g, "x1");
      const response = answerMockRequest(spec, { method: op.method, path, query: "", headers: {}, body: "" });
      // A spec may declare its own 404 or 405, so go by which operation answered.
      const answeredBy = response.headers.find(([name]) => name === OPERATION_HEADER)?.[1];
      if (answeredBy !== `${op.method} ${op.path}`) misrouted += 1;
    }
    console.log(`  mock answers    ${spec.operations.length - misrouted}/${spec.operations.length} routed in ${ms(t4)}`);
    if (misrouted) failures += 1;

    // Drift detection must actually fire on a mutated payload.
    const target = spec.schemas.find((s) => {
      const props = s.schema?.properties;
      return props && Object.keys(props).length >= 2;
    });
    if (target) {
      const good = exampleFor(spec.doc, target.schema, target.name) as Record<string, unknown>;
      const drifted = { ...good, totally_undeclared_field: "surprise" };
      const verdict = validateResponse(spec.doc, target.schema, drifted);
      const caught = verdict.findings.some((f) => f.kind === "extra_field");
      console.log(
        `  drift on ${target.name}: ${caught ? "✓ caught undeclared field" : "✗ MISSED"}`,
      );
      if (!caught) failures += 1;
    }
  } catch (error) {
    console.log(`  ✗ FAILED: ${error instanceof Error ? error.message : String(error)}`);
    failures += 1;
  }
}

console.log(`\n${failures === 0 ? "✓ all specs handled" : `✗ ${failures} failure(s)`}`);
process.exit(failures === 0 ? 0 : 1);
