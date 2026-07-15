# Gemini Cloud Monitoring usage and quota enrichment

## Outcome

The Google AI adapter can now use its existing encrypted Google service-account
credential plus the exact Gemini project ID to read project-level Gemini API
request and quota metadata from Cloud Monitoring. This is independent from both
the API-key control-plane check and the Cloud Billing BigQuery export:

- API-key validation still lists models without inference.
- Cloud Monitoring supplies request counts and request/token quota metadata.
- The standard BigQuery export remains the only direct cash-cost source.
- A Monitoring failure cannot replace, clear, or fabricate BigQuery cash cost.

## Required Google access

Grant the configured service account `roles/monitoring.viewer` on the exact
Gemini project and set `googleProjectId` to that project ID. The OAuth assertion
for this channel requests only:

`https://www.googleapis.com/auth/monitoring.read`

No IAM policy or secret is created or changed by this app. The billing channel
continues to request its separate BigQuery read-only scope only when a billing
export dataset is configured.

## Official metrics queried

All time-series filters are restricted to
`resource.labels.service = "generativelanguage.googleapis.com"` and use only
documented Service Runtime metrics:

- `serviceruntime.googleapis.com/api/request_count`
- `serviceruntime.googleapis.com/quota/rate/net_usage`
- `serviceruntime.googleapis.com/quota/limit`

The adapter retains only request/token quota dimensions. Method and credential
identifiers returned in monitored-resource labels are discarded. Request and
quota usage are month-to-date; quota limits use the latest returned sample.

Google documents up to 1,800 seconds of visibility delay for request counts,
up to 240 seconds for rate-quota usage, and daily sampling for quota limits.
Consequently, successful empty results remain unknown (`null`), never false
zero. Successful empty queries can authoritatively clear only their own stale
metadata source. A failed query preserves that source's prior records.

## Safety bounds

- 15-second HTTP timeout per Monitoring request
- 512 KiB response limit
- 1,000 points per page
- five pages / 5,000 points per metric query
- 100 retained request/token quota dimensions per usage or limit source
- repeated page tokens and out-of-scope/malformed series are rejected

Monitoring-derived records are metadata-only and cannot enter recurring or cash
cost rollups.

## References

- [Google Cloud metrics: Service Runtime](https://cloud.google.com/monitoring/api/metrics_gcp_p_z)
- [Google Cloud monitored resources](https://cloud.google.com/monitoring/api/resources)
- [Cloud Monitoring `projects.timeSeries.list`](https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list)

## Verification

Focused adapter and UI tests cover OAuth scope, exact project/service filters,
request/token parsing, empty results, permission denial, partial-query survival,
bounded pagination, cash-cost isolation, and token quota labels. Run the full
repository gate with `npm run verify` before landing.
