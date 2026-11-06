/** SpamAssassin's own spam threshold. Native points, not the core 0-100 scale. */
export const SPAMASSASSIN_THRESHOLD = 5;

/**
 * Max points {@link foldSpamAssassin} adds to a core score.
 * 52 is the default core threshold (60) minus the smallest other positive
 * weight (8). A full contribution stays ham on its own. One more content or
 * authentication signal can reach 60. Same cap as Bayes.
 */
export const SPAMASSASSIN_CORE_CAP = 52;

/** Raw messages larger than this are refused before parsing or regex matching. */
export const SPAMASSASSIN_RAW_BYTE_LIMIT = 2_000_000;

/** Visible text kept from each MIME part, in characters, before paragraph splitting. */
export const TEXT_PART_CHAR_LIMIT = 50_000;

/** Decoded characters kept from each MIME part before rawbody chunking. */
export const RAWBODY_CHAR_LIMIT = 500_000;

/** Paragraph and rawbody chunk caps, in bytes of the Latin-1 view of the text. */
export const PARAGRAPH_LIMIT = 2_048;
export const RAWBODY_CHUNK_LIMIT = 4_096;

export const MIME_MAX_NESTING_DEPTH = 30;
export const MIME_MAX_HEADERS_SIZE = 100_000;
