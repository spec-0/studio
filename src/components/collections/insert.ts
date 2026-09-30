/**
 * Putting a `{{steps.…}}` reference into a field of the step editor.
 *
 * The editor's fields belong to the operation editor, which keeps its own
 * state; writing through the element's native value setter and firing an
 * `input` event is how a value reaches that state the same way typing does.
 */

export type Insertable = HTMLInputElement | HTMLTextAreaElement;

/** A field a reference can go into: a text input or a text area. */
export function isInsertable(target: EventTarget | null): target is Insertable {
  if (target instanceof HTMLTextAreaElement) return !target.readOnly && !target.disabled;
  return (
    target instanceof HTMLInputElement &&
    ["text", "search", "url", ""].includes(target.type) &&
    !target.readOnly &&
    !target.disabled
  );
}

/**
 * Insert `text`: a single-line field takes it as its whole value (a parameter
 * is one value), a text area takes it at the cursor (a body has other text
 * around it).
 */
export function insertInto(field: Insertable, text: string): void {
  const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  let next = text;
  let caret = text.length;
  if (field instanceof HTMLTextAreaElement) {
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    next = field.value.slice(0, start) + text + field.value.slice(end);
    caret = start + text.length;
  }
  if (setter) setter.call(field, next);
  else field.value = next;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.focus();
  try {
    field.setSelectionRange(caret, caret);
  } catch {
    // Some input types don't have a selection.
  }
}
