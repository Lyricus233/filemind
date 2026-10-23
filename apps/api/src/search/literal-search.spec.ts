import { splitText } from '../processing/text-processing.js';
import { escapeLikeLiteral, findLiteralMatches } from './literal-search.js';

describe('escapeLikeLiteral', () => {
  it('preserves ordinary text', () => {
    expect(escapeLikeLiteral('向量搜索')).toBe('向量搜索');
  });

  it('escapes percent, underscore, and backslash for a literal LIKE query', () => {
    expect(escapeLikeLiteral('100% foo_bar C:\\notes')).toBe(
      '100\\% foo\\_bar C:\\\\notes',
    );
  });
});

describe('findLiteralMatches', () => {
  it('finds multiple Chinese matches', () => {
    expect(findLiteralMatches('向量搜索与向量索引', '向量')).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ]);
  });

  it('uses Unicode code points rather than UTF-16 code units', () => {
    expect(findLiteralMatches('🙂向量搜索与向量索引', '向量')).toEqual([
      { start: 1, end: 3 },
      { start: 6, end: 8 },
    ]);
    expect(findLiteralMatches('a🙂b🙂', '🙂')).toEqual([
      { start: 1, end: 2 },
      { start: 3, end: 4 },
    ]);
  });

  it('preserves case sensitivity', () => {
    expect(findLiteralMatches('FileMind filemind', 'FileMind')).toEqual([
      { start: 0, end: 8 },
    ]);
  });

  it('treats SQL and regular-expression symbols as ordinary characters', () => {
    expect(findLiteralMatches('x%_.*\\y', '%_.*\\')).toEqual([
      { start: 1, end: 6 },
    ]);
  });

  it('returns non-overlapping occurrences', () => {
    expect(findLiteralMatches('aaaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('does not normalize accents or remove punctuation', () => {
    expect(findLiteralMatches('café', 'cafe')).toEqual([]);
    expect(findLiteralMatches('vector-search', 'vector search')).toEqual([]);
  });

  it.each([
    ['', '向量'],
    ['向量', ''],
    ['索引', '向量'],
    ['a', 'aa'],
  ])('returns no matches for content %j and query %j', (content, query) => {
    expect(findLiteralMatches(content, query)).toEqual([]);
  });

  it('can recover each literal match from its code point range', () => {
    const content = '🙂使用向量搜索，也支持向量索引。';
    const characters = Array.from(content);
    const matches = findLiteralMatches(content, '向量');
    expect(matches).toHaveLength(2);
    for (const match of matches) {
      expect(characters.slice(match.start, match.end).join('')).toBe('向量');
    }
  });

  it('finds a maximum-length query crossing a chunk boundary through the overlap', () => {
    const query = '向'.repeat(100);
    const chunks = splitText('a'.repeat(499) + query + 'b'.repeat(100));
    const fileMatches = chunks.flatMap((chunk) =>
      findLiteralMatches(chunk.content, query).map((match) => ({
        start: chunk.startOffset + match.start,
        end: chunk.startOffset + match.end,
      })),
    );
    expect(fileMatches).toEqual([{ start: 499, end: 599 }]);
  });
});
