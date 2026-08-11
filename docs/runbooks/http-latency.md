# HTTP p95 latency alert

Contract: Prometheus evaluates the canonical five-minute request-duration histogram and alerts above `1000` milliseconds; missing data alerts.

1. Verify the histogram bucket and build-info series belong to the same candidate revision.
2. Compare route-templated p95 latency with request volume and error ratio.
3. Stop promotion when latency is sustained. Any rollback, scaling, or production mutation requires its own authorized gate.
