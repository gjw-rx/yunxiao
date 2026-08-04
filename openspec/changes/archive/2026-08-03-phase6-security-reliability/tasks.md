## 1. Security boundary

- [x] 1.1 Implement `src/core/securityAudit.ts` with path, sensitive-resource, dangerous-command, permission, and expected-version checks
- [x] 1.2 Integrate the audit into the tool router before execution and return stable `error`/`cancelled` results
- [x] 1.3 Implement the common `BaseTool` result-governance hook for binary skipping, bounded output, secret redaction, and metadata markers
- [x] 1.4 Complete the default permission matrix and destructive-operation second confirmation
- [x] 1.5 Add unit tests for traversal, dangerous commands, sensitive data, oversized output, and permission bypass attempts

## 2. Reliability and session lifecycle

- [x] 2.1 Extend `sessionManager` state with finalized call ids, retry counters, cancellation, and timeout cleanup
- [x] 2.2 Ensure cancellation and late tool completion produce at most one result per call
- [x] 2.3 Add retry classification and bounded connect-time continuation retry without replaying non-idempotent tools
- [x] 2.4 Add expected-version conflict checks to mutating file tools
- [x] 2.5 Add unit and integration tests for timeout, cancellation, network retry, stale edits, and multi-round continuation

## 3. Protocol and cloud coordination

- [x] 3.1 Extend tool-result metadata types and serializers with `retryable`, `truncated`, and `redacted`
- [ ] 3.2 Add cloud `/tool_result` idempotency for `(session_id, call_id)` and preserve existing SSE continuation behavior
- [ ] 3.3 Add cloud session-level result-budget enforcement and structured logging for truncation/redaction/retry decisions
- [ ] 3.4 Update cloud Agent system prompts to handle cancelled, bounded, redacted, timeout, and conflict results without unsafe retries
- [ ] 3.5 Add cloud tests for duplicate results, cancelled results, bounded results, retryable errors, and backward-compatible old clients

## 4. Verification and rollout

- [ ] 4.1 Run the full local unit/integration suite and verify no Phase 1-5 regression
- [ ] 4.2 Run cloud API regression tests and mixed-version compatibility tests
- [x] 4.3 Exercise the Phase 6 validation matrix: path escape, dangerous command, large/binary/secret result, disconnect, cancellation, timeout, and concurrent modification
- [ ] 4.4 Record security audit and reliability metrics, then enable optional parallel execution only after sequential mode is stable
