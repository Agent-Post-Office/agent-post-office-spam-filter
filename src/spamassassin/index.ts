/**
 * Optional SpamAssassin rule scorer.
 *
 * Import this module only when you want the add-on. The package root does not
 * import it, so core-only bundles stay free of the rule table, postal-mime,
 * and htmlparser2.
 */

export { SpamAssassinError } from "./errors.js";

export {
  SPAMASSASSIN_CORE_CAP,
  SPAMASSASSIN_GTUBE_RULE,
  SPAMASSASSIN_RAW_BYTE_LIMIT,
  SPAMASSASSIN_STANDALONE_SPAM_SCORE,
  SPAMASSASSIN_THRESHOLD,
} from "./limits.js";

export {
  scoreSpamAssassin,
  type RawMessage,
  type ScoreSpamAssassinOptions,
  type SpamAssassinHit,
  type SpamAssassinScore,
} from "./score.js";

export {
  foldSpamAssassin,
  spamAssassinCorePoints,
  type FoldSpamAssassinOptions,
} from "./fold.js";
