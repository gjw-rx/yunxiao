## 1. Run storage

- [x] 1.1 Define stored Run and sequenced event contracts and implement the workspace-state-backed RunStore.
- [x] 1.2 Add RunStore unit tests for persistence, deduplication, gap detection, bounded retention, and reset.

## 2. Cloud Run transport

- [x] 2.1 Add v2 Run create, tool-result command, and exclusive-cursor event subscription support to AIClient without changing v1 behavior.
- [x] 2.2 Add focused AIClient tests for v2 request payloads and replay cursor URLs.

## 3. Orchestration recovery

- [x] 3.1 Integrate RunStore with session orchestration so v2 events persist before UI delivery and gap/disconnect replay uses the stored cursor.
- [x] 3.2 Restore non-terminal Runs at activation without automatically replaying local tools.

## 4. Verification

- [x] 4.1 Run TypeScript checks, focused unit tests, and strict OpenSpec validation.
