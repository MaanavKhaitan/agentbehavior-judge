/** Collapse whitespace runs to single spaces and trim. */
export function flattenWhitespace(text: string): string {
  return text.replaceAll(/\s+/g, " ").trim();
}

/** Whitespace-flattened text clipped to `max` characters with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = flattenWhitespace(text);
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
