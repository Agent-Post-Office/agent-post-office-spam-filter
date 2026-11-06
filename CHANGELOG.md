# Changelog

## Unreleased

## 0.2.0

- Optional SpamAssassin add-on at `@agent-post-office/spam-filter/spamassassin`. Rules are pinned to update channel r1939780. A GTUBE hit is always spam. A native score of 10 or more flags on its own. `postal-mime` 2.7.4 and `htmlparser2` 10.0.0 are optional peer dependencies. Core scoring is unchanged.
- Labeled synthetic corpus in `test/corpus`. `npm run eval` runs in CI.
- GitHub Actions workflow `sa-verify.yml` runs `npm run sa:verify` weekly and when dispatched.
- `mimeheader` rules from that snapshot are not translated. That is left for a later change.

## 0.1.1

- `normalizeAddress` now accepts single-label domains (for example `invalid-sender@invalid`), matching the APO Worker's mailbox normalizer, so block and allow lists can hold the inbound placeholder sender. Parity reference updated to the Worker's real pattern.

## 0.1.0

- First release: content rules, Authentication-Results scoring, allow and block lists, and Bayes from operator marks, at parity with APO main `8ccceaf`.
