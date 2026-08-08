// Turning a human question into FTS5 queries.
//
// WHY THIS FILE EXISTS
// ====================
// FTS5 joins bare terms with an implicit AND. So the query a person actually
// types — a sentence — asks the index for a single lesson containing *every*
// word in it, and gets nothing. Measured on 2026-08-08 against the live base of
// 301 lessons, the exact question an agent asked and gave up on:
//
//     "wp eval koszty zamówień backfill lipiec"
//        AND (what brain_recall sent) →   0 rows
//        OR  (what it should have sent) → 100 rows
//
// The knowledge was there the whole time. The query language ate it, silently,
// and the agent reasonably concluded the knowledge base was empty. Worse than
// empty: two zero-result recalls teach a caller to stop calling.
//
// The same file also has to survive punctuation. `brain_recall` used to pass
// most of it straight through to SQLite, so an ordinary question threw:
//     "how do I fix (kamar) orders?"  → fts5: syntax error near "fix"
//     "co z kosztami: zamówienia?"    → no such column: kosztami
//
// WHAT IT DOES
// ============
// One tokenizer, three queries over the same terms, from precise to forgiving:
//
//   all     every term must appear          — precision
//   any     any term may appear             — recall
//   prefix  stems, so Polish inflection and — morphology
//           English suffixes still match
//
// The caller runs all three and fuses them by reciprocal rank, weighted so a
// document matching every term cannot be outranked by one that merely shares a
// stem. Nothing here talks to the database; it is all pure string work, which
// is what makes the failure above testable rather than anecdotal.
//
// The tokenizer is deliberately the same one the hooks use
// (`hooks/_brain_db.py:fts_query`). Two descriptions of "what counts as a search
// term" would drift, and drift here means the hook and the tool disagree about
// what the knowledge base contains. A test asserts the two agree.

/** Terms shorter than this match everything and rank nothing. */
export const FTS_MIN_TERM_LEN = 3;

/** Upper bound on terms per query — a pasted stack trace is not a search. */
export const FTS_MAX_TERMS = 24;

/**
 * Words common enough that including them drags in unrelated lessons.
 * Mirrors `STOPWORDS` in hooks/_brain_db.py — keep the two in step.
 */
export const STOPWORDS: ReadonlySet<string> = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "are",
  "was", "were", "not", "but", "you", "your", "can", "will", "would", "should",
  "make", "made", "please", "just", "how", "what", "why", "when", "where",
  "jest", "nie", "tak", "sie", "się", "czy", "jak", "dla", "aby",
  "oraz", "ale", "tego", "tym", "przy", "moze", "może", "bylo", "było",
]);

// Unicode-aware: \w in a JavaScript regex is ASCII-only, so splitting a Polish
// prompt on it would cut "zamówień" into "zam" and "wie" and search for words
// nobody wrote. \p{L} is the whole point of this pattern.
const NON_WORD = /[^\p{L}\p{N}_]+/u;

/**
 * Split a prompt into search terms: lowercased, de-duplicated, stopwords and
 * one/two-letter tokens dropped, capped at FTS_MAX_TERMS.
 *
 * Falls back rather than returning nothing: a query that is *entirely*
 * stopwords or short tokens ("wp", "how to") still deserves a search, so the
 * filters are relaxed one step at a time instead of yielding an empty result
 * the caller would report as "no matching lessons".
 */
export function tokenizeQuery(text: string): string[] {
  if (!text) return [];
  const raw = String(text)
    .split(NON_WORD)
    .filter(Boolean)
    .map((w) => w.toLowerCase());

  const pick = (minLen: number, dropStopwords: boolean): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const w of raw) {
      if (w.length < minLen) continue;
      if (dropStopwords && STOPWORDS.has(w)) continue;
      if (seen.has(w)) continue;
      seen.add(w);
      out.push(w);
      if (out.length >= FTS_MAX_TERMS) break;
    }
    return out;
  };

  return (
    pick(FTS_MIN_TERM_LEN, true).length
      ? pick(FTS_MIN_TERM_LEN, true)
      : pick(2, false).length
        ? pick(2, false)
        : pick(1, false)
  );
}

/** Terms this long or longer are cut down to STEM_CAP characters. */
export const STEM_MIN_LEN = 6;

/** How much of a long term survives stemming. */
export const STEM_CAP = 5;

/**
 * The prefix a term is searched by when exact matching is too strict.
 *
 * Polish inflects the end of the word — zamówień / zamówienia / zamówieniach
 * are one concept and three tokens — and English suffixes behave the same way.
 *
 * A FIXED CAP, NOT A FIXED TRIM. Trimming a couple of characters is the obvious
 * design and it does not work, because the endings differ in length: the query
 * `zamówieniach` trimmed by two is `zamówienia`, which still does not match a
 * lesson that says `zamówień`. Two inflections only meet at the stem they
 * share, and `kosztach`/`koszty` share just five characters. So anything long
 * enough to be inflected is cut to that shared root, in both directions —
 * asymmetric stemming would find a lesson from a question but not the reverse.
 *
 * This is aggressive on purpose, and affordable because of where it sits: the
 * prefix retriever carries the lowest weight in the fusion (see
 * RETRIEVER_WEIGHTS), so it rescues an inflected word without being able to
 * outrank an exact match. tests/eval.test.ts is what holds that claim to
 * account — precision@1 and the true-negative rate are measured, not assumed.
 */
export function stemForPrefix(token: string): string {
  return token.length >= STEM_MIN_LEN ? token.slice(0, STEM_CAP) : token;
}

/**
 * Quote a term so FTS5 reads it as text, never as syntax. Covers the operators
 * (AND/OR/NOT/NEAR), the punctuation that made the old sanitizer throw, and the
 * quote character itself.
 */
function quote(term: string): string {
  return `"${term.replace(/"/g, "")}"`;
}

export interface FtsPlan {
  /** The terms actually searched for — surfaced to the caller on a miss. */
  terms: string[];
  /** Every term required. null when there are fewer than two terms. */
  all: string | null;
  /** Any term may match. null when there are no terms at all. */
  any: string | null;
  /** Any stem may match. null when it would be identical to `any`. */
  prefix: string | null;
}

/**
 * Build the three FTS5 queries for a prompt. Pure, total, and never produces a
 * string SQLite can reject: every term is quoted, so the result is always
 * syntactically valid regardless of what the user typed.
 */
export function planFtsQuery(text: string): FtsPlan {
  const terms = tokenizeQuery(text);
  if (!terms.length) {
    return { terms, all: null, any: null, prefix: null };
  }

  const quoted = terms.map(quote);
  const all = terms.length >= 2 ? quoted.join(" AND ") : null;
  const any = quoted.join(" OR ");

  const stems = terms.map(stemForPrefix);
  // When nothing was long enough to stem, the prefix query would repeat `any`
  // and only add noise to the fusion. Say so with null instead of running it.
  const prefix = stems.some((s, i) => s !== terms[i])
    ? stems.map((s) => `${quote(s)}*`).join(" OR ")
    : null;

  return { terms, all, any, prefix };
}

/**
 * Make an arbitrary string safe to pass to FTS5 MATCH as a conjunction.
 *
 * Retained for callers that want the old all-terms behaviour explicitly; it is
 * no longer what `brain_recall` sends. Unlike the version it replaces, it quotes
 * every token rather than only those containing `-` or `.`, because `(`, `:`,
 * `?` and `^` are syntax to FTS5 too and used to raise straight out of the tool.
 */
export function sanitizeFTS5Query(query: string): string {
  return String(query ?? "")
    .split(NON_WORD)
    .filter(Boolean)
    .map(quote)
    .join(" ");
}
