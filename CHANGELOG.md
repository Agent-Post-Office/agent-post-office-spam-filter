# Changelog

## Unreleased

- Optional `@agent-post-office/spam-filter/spamassassin` subpath. `scoreSpamAssassin` scores a raw message with the pinned SpamAssassin rule subset (update channel r1939780) and returns native points plus the rule hits. `foldSpamAssassin` can add a capped contribution to a core assessment. The core entry point does not load the add-on, and the default threshold stays 60. `postal-mime` 2.7.4 and `htmlparser2` 10.0.0 are optional peer dependencies of that subpath. `npm run sa:verify` checks the snapshot sha256 and rebuilds `src/spamassassin/generated.ts`.

## 0.1.1

- `normalizeAddress` now accepts single-label domains (for example `invalid-sender@invalid`), matching the APO Worker's mailbox normalizer, so block and allow lists can hold the inbound placeholder sender. Parity reference updated to the Worker's real pattern.

## 0.1.0

- First release: content rules, Authentication-Results scoring, allow and block lists, and Bayes from operator marks, at parity with APO main `8ccceaf`.
