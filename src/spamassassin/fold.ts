import { DEFAULT_SPAM_THRESHOLD, verdictForScore, type SpamAssessment } from "../rules.js";
import { SPAMASSASSIN_CORE_CAP, SPAMASSASSIN_THRESHOLD } from "./limits.js";

const LIST_REASONS = new Set(["allow_sender", "block_sender", "allow_domain", "block_domain"]);

export interface FoldSpamAssassinOptions {
  /** Max core points to add. Default {@link SPAMASSASSIN_CORE_CAP} (52). */
  cap?: number;
  /**
   * Threshold used to recompute the verdict after the points are added.
   * Pass the same threshold that produced `assessment`. Default 60.
   */
  threshold?: number;
}

/**
 * Core points for a native SpamAssassin score.
 *
 * Returns 0 when `nativeScore` is below {@link SPAMASSASSIN_THRESHOLD} (5),
 * or when the native score is negative. Otherwise returns
 * `min(round(cap), round(nativeScore))`. The default cap is 52, under the
 * core default threshold of 60, so this signal stays ham on its own.
 * A native score below 5 does not subtract points. Ham rules cannot hide a core hit.
 */
export function spamAssassinCorePoints(nativeScore: number, cap: number = SPAMASSASSIN_CORE_CAP): number {
  if (!Number.isFinite(nativeScore) || nativeScore < SPAMASSASSIN_THRESHOLD) return 0;
  if (!Number.isFinite(cap) || cap <= 0) return 0;
  return Math.min(Math.round(cap), Math.round(nativeScore));
}

/**
 * Add a capped SpamAssassin contribution to a core assessment.
 *
 * Allow and block decisions are left as they are. The reason string is
 * `spamassassin` when points were added. Callers that want SpamAssassin's own
 * threshold to apply the full cap can pass `{ score: sa.score >= 5 ? cap : 0 }`.
 */
export function foldSpamAssassin(
  assessment: SpamAssessment,
  sa: { score: number },
  options: FoldSpamAssassinOptions = {},
): SpamAssessment {
  if (assessment.reasons.some((reason) => LIST_REASONS.has(reason))) return assessment;
  const points = spamAssassinCorePoints(sa.score, options.cap ?? SPAMASSASSIN_CORE_CAP);
  if (points <= 0) return assessment;
  const score = Math.min(100, assessment.score + points);
  const threshold = options.threshold ?? DEFAULT_SPAM_THRESHOLD;
  const reasons = assessment.reasons.includes("spamassassin") ? assessment.reasons : [...assessment.reasons, "spamassassin"];
  return { score, reasons, verdict: verdictForScore(score, threshold) };
}
