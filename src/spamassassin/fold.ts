import { DEFAULT_SPAM_THRESHOLD, verdictForScore, type SpamAssessment } from "../rules.js";
import {
  SPAMASSASSIN_CORE_CAP,
  SPAMASSASSIN_GTUBE_RULE,
  SPAMASSASSIN_STANDALONE_SPAM_SCORE,
  SPAMASSASSIN_THRESHOLD,
} from "./limits.js";

const LIST_REASONS = new Set(["allow_sender", "block_sender", "allow_domain", "block_domain"]);

export interface FoldSpamAssassinOptions {
  /** Max core points to add. Default {@link SPAMASSASSIN_CORE_CAP} (52). */
  cap?: number;
  /**
   * Threshold used to recompute the verdict after the points are added.
   * Pass the same threshold that produced `assessment`. Default 60.
   * A GTUBE hit or a native score at or above `standaloneSpamScore` flags
   * even when the summed score is under this threshold.
   */
  threshold?: number;
  /**
   * When true (default), a GTUBE hit forces verdict spam.
   * That includes an allow-list decision and any core score.
   */
  gtubeAlwaysSpam?: boolean;
  /**
   * Native score at or above this forces verdict spam even when the core
   * score is under `threshold`. Default {@link SPAMASSASSIN_STANDALONE_SPAM_SCORE} (10).
   * Null disables it. Below this value the fold only adds
   * {@link spamAssassinCorePoints}, which cannot flag on its own.
   */
  standaloneSpamScore?: number | null;
}

/**
 * Core points for a native SpamAssassin score.
 *
 * Returns 0 when `nativeScore` is below {@link SPAMASSASSIN_THRESHOLD} (5),
 * or when the native score is negative. Otherwise returns
 * `min(round(cap), round(nativeScore))`. The default cap is 52.
 * A native score below 5 does not subtract points. Ham rules cannot hide a core hit.
 * This function does not decide the verdict. {@link foldSpamAssassin} does.
 */
export function spamAssassinCorePoints(nativeScore: number, cap: number = SPAMASSASSIN_CORE_CAP): number {
  if (!Number.isFinite(nativeScore) || nativeScore < SPAMASSASSIN_THRESHOLD) return 0;
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(Math.round(cap), Math.round(nativeScore));
}

function hasGtube(sa: { hits?: readonly { name: string }[] }): boolean {
  return sa.hits?.some((hit) => hit.name === SPAMASSASSIN_GTUBE_RULE) ?? false;
}

function withSpamAssassinReason(reasons: readonly string[]): string[] {
  return reasons.includes("spamassassin") ? [...reasons] : [...reasons, "spamassassin"];
}

/**
 * Add a capped SpamAssassin contribution to a core assessment.
 *
 * Below `standaloneSpamScore` (default 10), add `min(52, round(native))` only
 * when the native score is at least 5. That contribution stays under the
 * default core threshold, so it does not flag on its own.
 * At or above `standaloneSpamScore`, the verdict is spam even when the core
 * score is under the threshold. A GTUBE hit does the same when
 * `gtubeAlwaysSpam` is true (the default), including over an allow decision.
 * Block decisions stay as they are. The reason string is `spamassassin` when
 * this function changes the assessment.
 */
export function foldSpamAssassin(
  assessment: SpamAssessment,
  sa: { score: number; hits?: readonly { name: string }[] },
  options: FoldSpamAssassinOptions = {},
): SpamAssessment {
  const cap = options.cap ?? SPAMASSASSIN_CORE_CAP;
  const threshold = options.threshold ?? DEFAULT_SPAM_THRESHOLD;
  const gtubeAlwaysSpam = options.gtubeAlwaysSpam ?? true;
  const standalone = options.standaloneSpamScore === undefined
    ? SPAMASSASSIN_STANDALONE_SPAM_SCORE
    : options.standaloneSpamScore;
  const gtube = gtubeAlwaysSpam && hasGtube(sa);
  const listed = assessment.reasons.some((reason) => LIST_REASONS.has(reason));
  if (listed && !(gtube && assessment.verdict !== "spam")) return assessment;

  const points = spamAssassinCorePoints(sa.score, cap);
  const standaloneHit = standalone != null && Number.isFinite(sa.score) && sa.score >= standalone;
  const forceSpam = gtube || standaloneHit;
  if (points <= 0 && !forceSpam) return assessment;

  const score = Math.min(100, (listed ? 0 : assessment.score) + points);
  const reasons = withSpamAssassinReason(listed ? [] : assessment.reasons);
  const crossed = verdictForScore(score, threshold) === "spam";
  return { score, reasons, verdict: forceSpam || crossed ? "spam" : "ham" };
}
