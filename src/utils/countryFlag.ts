const REGIONAL_A = 0x1f1e6;
const REGIONAL_Z = 0x1f1ff;

export interface ParsedServerName {
  /** ISO 3166-1 alpha-2 code in upper case, or null when the name has no flag emoji. */
  code: string | null;
  /** The name without the flag emoji. */
  text: string;
}

function regionalLetter(codePoint: number | undefined): string | null {
  if (codePoint === undefined || codePoint < REGIONAL_A || codePoint > REGIONAL_Z) return null;
  return String.fromCharCode(65 + codePoint - REGIONAL_A);
}

/**
 * Splits a leading flag emoji (a pair of regional indicator symbols) off a server name.
 * Windows has no colour flag glyphs and draws the pair as letters (DE, FR, NL, US).
 */
export function parseServerName(name: string): ParsedServerName {
  const chars = Array.from(name.trimStart());
  const first = regionalLetter(chars[0]?.codePointAt(0));
  const second = regionalLetter(chars[1]?.codePointAt(0));
  if (!first || !second) return { code: null, text: name };
  return { code: first + second, text: chars.slice(2).join('').trimStart() };
}
