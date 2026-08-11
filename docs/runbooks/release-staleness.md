# Release staleness alert

Contract: the canonical release receipt age must remain at or below `86400` seconds in the five-minute evaluation window; missing data fails closed.

1. Verify the immutable receipt path/digest, deployment operation, and candidate/runtime identities.
2. Confirm deployment, runtime, backup, and disk observations are not future-dated or stale relative to the evaluation anchor.
3. Stop promotion on stale or contradictory evidence. A cutover or rollback requires separate authorization and exact receipt binding.
