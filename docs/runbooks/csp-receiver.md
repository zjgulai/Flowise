# CSP receiver health alert

Contract: the canonical CSP receipt must report receiver health `1` within five minutes; missing data fails closed.

1. Verify receipt schema, candidate revision, canonical receiver path, and observation age.
2. Confirm malformed reports fail closed and no raw report payload is copied into readiness evidence.
3. Stop promotion if the receiver is unhealthy or evidence is missing. Endpoint or policy changes require a separate gate.
