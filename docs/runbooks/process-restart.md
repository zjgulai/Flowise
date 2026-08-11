# Process restart alert

Contract: Prometheus evaluates the canonical five-minute `changes(process_start_time_seconds[5m])` query and alerts above `0`; missing data alerts.

1. Bind the observation to the active candidate revision and runtime instance.
2. Correlate the restart window with health and deployment receipts.
3. Treat an unexplained restart as promotion-blocking. Do not restart the service from this runbook without separate authorization.
