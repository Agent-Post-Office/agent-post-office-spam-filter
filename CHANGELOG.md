# Changelog

## 0.1.1

- `normalizeAddress` now accepts single-label domains (for example `invalid-sender@invalid`), matching the APO Worker's mailbox normalizer, so block and allow lists can hold the inbound placeholder sender. Parity reference updated to the Worker's real pattern.

## 0.1.0

- First release: content rules, Authentication-Results scoring, allow and block lists, and Bayes from operator marks, at parity with APO main `8ccceaf`.
