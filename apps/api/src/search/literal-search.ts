export interface MatchRange {
  start: number;
  end: number;
}

export function escapeLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function findLiteralMatches(
  content: string,
  query: string,
): MatchRange[] {
  const characters = Array.from(content);
  const needle = Array.from(query);
  const matches: MatchRange[] = [];

  if (needle.length === 0) {
    return matches;
  }

  let start = 0;

  while (start <= characters.length - needle.length) {
    const found = needle.every(
      (character, index) => characters[start + index] === character,
    );

    if (found) {
      matches.push({ start, end: start + needle.length });
      start += needle.length;
    } else {
      start += 1;
    }
  }

  return matches;
}
