#!/usr/bin/env node
// Fails when a pull request's title or body credits an AI model as an author.
//
// Pull requests are squash-merged, so the title and body become the commit on
// `main`. CI runs this with PR_TITLE and PR_BODY set (see
// .github/workflows/attribution.yml). Run it locally the same way:
//
//   PR_TITLE="…" PR_BODY="$(cat body.md)" node scripts/check-attribution.mjs

const MODEL =
  /claude|anthropic|chatgpt|openai|\bgpt\b|gpt-\d|copilot|gemini|codex|cursor|devin|\bllm\b|\bai\b/i;

/** Every line of `text` that credits a model, with why. */
export function findAttribution(text) {
  const found = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const coAuthor = /^co-authored-by:(.*)$/i.exec(trimmed);
    if (coAuthor && MODEL.test(coAuthor[1])) {
      found.push({ line: trimmed, reason: "a Co-Authored-By line naming a model" });
      continue;
    }
    // A "Generated with …" footer: at the start of a line (after an emoji or a
    // bullet, if any), or anywhere when it names a model. "The client was
    // generated with openapi-typescript" is fine.
    const footer = /^[^\p{L}\p{N}]*generated with\b/iu.test(trimmed);
    const naming = /generated with\W+(?:\[)?\s*(?:claude|chatgpt|copilot|gemini|cursor|codex|an? ai\b|ai\b)/i.test(trimmed);
    if (footer || naming) found.push({ line: trimmed, reason: 'a "Generated with" line' });
  }
  return found;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = `${process.env.PR_TITLE ?? ""}\n${process.env.PR_BODY ?? ""}`;
  const found = findAttribution(text);
  if (found.length) {
    console.error("This pull request's title or body credits an AI model. It becomes the commit message");
    console.error("on main when the pull request is squash-merged, so please remove these lines:\n");
    for (const f of found) console.error(`  ${f.line}\n    (${f.reason})`);
    process.exit(1);
  }
  console.log("No AI attribution in the title or body.");
}
