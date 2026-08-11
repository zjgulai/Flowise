# Disk free alert

Contract: Prometheus evaluates the canonical five-minute available-filesystem signal and alerts below the managed `10737418240`-byte threshold; missing data alerts.

1. Confirm the series is from the candidate host and expected filesystem scope.
2. Verify the observation is fresh and compare it with the release receipt without listing sensitive filenames.
3. Stop promotion on low capacity. Cleanup or deletion is destructive and requires a separately authorized, exact-target maintenance gate.
