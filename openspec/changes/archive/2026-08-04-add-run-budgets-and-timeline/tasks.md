## 1. Protocol and persistent projection

- [x] 1.1 Define plugin-side budget and timeline payload types for persisted Run events.
- [x] 1.2 Extend RunStore normalization and contiguous append handling to retain a bounded timeline and latest budget snapshot, including legacy snapshots.
- [x] 1.3 Add RunStore tests for budget projection, content-batch timeline entries, retention, and legacy snapshot normalization.

## 2. Restored event delivery

- [x] 2.1 Add supported budget and content-batch Run event types to the SessionManager replay dispatch path.
- [x] 2.2 Add SessionManager coverage proving accepted replay events reach the EventBus without client-side lifecycle inference.

## 3. Webview timeline

- [x] 3.1 Forward budget and content-batch EventBus events from the extension host to the ChatPanel.
- [x] 3.2 Render budget updates and exhaustion entries in the existing timeline and render content batches as assistant output.
- [x] 3.3 Add focused tests and run type checking, linting, unit tests, and strict OpenSpec validation.
