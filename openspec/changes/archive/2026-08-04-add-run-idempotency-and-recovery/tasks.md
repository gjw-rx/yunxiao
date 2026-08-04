## 1. Durable Run Metadata

- [x] 1.1 Add minimal persisted admission input, lease, and tool-result receipt metadata plus additive database migration coverage.
- [ ] 1.2 Implement repository/service operations for atomic receipt admission, hash conflict detection, lease claim/renew/release, and recovery candidate scanning.

## 2. Compute and API Integration

- [ ] 2.1 Route v1/v2 run admission and tool-result continuation through durable receipts and leases without changing public payload compatibility.
- [x] 2.2 Add bounded startup recovery scheduling and safe shutdown of recovery/compute tasks.

## 3. Verification

- [ ] 3.1 Add focused tests for duplicate/conflicting results, competing leases, expired lease takeover, and startup recovery safety.
- [ ] 3.2 Run focused tests, lint, compile validation, and strict OpenSpec validation; record completed tasks.
