export function normalizeUserPath(input: string): string {
  if (input == null) return "";
  const trimmed = String(input).trim();
  return trimmed.replace(/^["']+/, "").replace(/["']+$/, "");
}
