# HTTP 5xx ratio alert

Contract: Prometheus evaluates the canonical five-minute 5xx/request ratio and alerts above `0.05`; missing data alerts.

1. Confirm the alert revision and protected scrape identity match the active candidate.
2. Inspect route-templated 5xx rates and recent application logs without recording credentials, prompts, query strings, or raw paths.
3. If the ratio is sustained, stop promotion and follow the authorized rollback gate. Do not restart or deploy from this runbook without separate authorization.
