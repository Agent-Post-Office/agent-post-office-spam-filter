# Changelog

## Unreleased

- Optional `@agent-post-office/spam-filter/spamassassin` subpath. `scoreSpamAssassin` scores a raw message with the pinned SpamAssassin rule subset (update channel r1939780) and returns native points plus the rule hits. `foldSpamAssassin` adds a capped contribution to a core assessment. A GTUBE hit flags (`gtubeAlwaysSpam`, default true), including over an allow decision. A native score of 10 or more flags on its own (`standaloneSpamScore`, default 10). Below 10 the fold adds `min(52, round(native))` only when the native score is at least 5, which stays under the core threshold of 60. The core entry point does not load the add-on. `postal-mime` 2.7.4 and `htmlparser2` 10.0.0 are optional peer dependencies of that subpath. `npm run sa:verify` checks the snapshot sha256 and rebuilds `src/spamassassin/generated.ts`.
- `mimeheader` rules from that snapshot are not translated. That is left for a later change.
- `test/corpus` is a synthetic ham and spam fixture set. `npm run eval` scores it with the core scorer and the default SpamAssassin fold, prints a confusion matrix, and fails if a verdict or the expected false-positive and false-negative counts change. `npm run eval:public` scores the pinned public corpora without committing those messages.
- GitHub Actions workflow `sa-verify.yml` runs `npm run sa:verify` weekly and when dispatched. Pull-request CI does not download the snapshot.

## 0.1.1

- `normalizeAddress` now accepts single-label domains (for example `invalid-sender@invalid`), matching the APO Worker's mailbox normalizer, so block and allow lists can hold the inbound placeholder sender. Parity reference updated to the Worker's real pattern.

## 0.1.0

- First release: content rules, Authentication-Results scoring, allow and block lists, and Bayes from operator marks, at parity with APO main `8ccceaf`.
