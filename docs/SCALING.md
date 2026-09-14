# Scale foundation and its limits

Implemented: server-side capped page sizes (maximum 100); cursor pagination for users/audit; `(tenant_id,id)` indexes; parameterised SQL; RLS with transaction-local tenant context; bounded connection pools; query timeout; transactional event outbox; bounded worker batches and concurrency; retries plus processed-event deduplication; small static frontend assets.

100,000 audit rows are inserted in a rolled-back test transaction to check the indexed recent-record path. This is not a crore-record concurrency benchmark. There is no claim that a single VPS supports arbitrary users or data volumes.

Before large traffic: agree active tenants/sites/concurrent users, audit retention, largest import/export and planning horizon. Test representative data and skew, p95/p99 latency, queue age, DB I/O and memory. Add partitioning/retention to high-volume append-only tables when real volume justifies it. Do not partition every small master table.

Future orders/inventory imports must be streamed and staged in bounded batches; exports asynchronous; dashboards should use versioned projections. Search needs query-specific indexes and bounded results. No unbounded full-table JSON response, offset scans at huge depth or exact total count on every audit page.

Current worker only consumes `foundation.seeded` for an explicit pilot tenant. It proves outbox connectivity, not scheduling/AI implementation. Before multiple tenants or scale, introduce a reviewed tenant registry/dispatch strategy, processing metrics, dead-letter/replay UI and queue recovery reconciliation.

The roles endpoint is currently a capped catalog (100); add pagination before allowing more than 100 roles. Permissions are a finite catalog. Dashboard site results are capped at 100 until full site-selection UI lands.
