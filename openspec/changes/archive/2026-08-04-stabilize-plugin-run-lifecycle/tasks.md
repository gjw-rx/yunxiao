## 1. Restore the engineering gate

- [x] 1.1 Update `tsconfig.json` to include only `src/**/*.ts` and exclude vendored OpenCode, documentation, coverage, generated output, and packaging artifacts.
- [x] 1.2 Run `npm run check-types` and fix only plugin-source type errors exposed by the corrected compilation scope.
- [x] 1.3 Run the existing lint and test commands to record a green pre-change behavioral baseline.

## 2. Isolate local runs by generation

- [x] 2.1 Add SessionManager regression tests proving callbacks from a replaced or reset run cannot emit content, start tools, post results, or finalize the current run.
- [x] 2.2 Add regression tests for exactly one `completed`, `cancelled`, `failed`, or `disconnected` terminal outcome and for legacy `stream_end` compatibility.
- [x] 2.3 Introduce a manager-lifetime monotonic generation and central current-run guard, then apply it to message streams, continuation streams, tool execution, timeout, cancellation, and error paths.
- [x] 2.4 Add structured run-state events and map clean completion, explicit cancellation, server/protocol failure, and unexpected transport loss to their specified terminal outcomes.

## 3. Handle duplicate tool-result acknowledgements

- [x] 3.1 Add protocol tests for SSE continuation, valid `application/json` duplicate acknowledgement, and unknown successful JSON response.
- [x] 3.2 Dispatch tool-result responses by Content-Type and expose a distinct duplicate-acknowledgement callback without invoking SSE `onEnd`.
- [x] 3.3 Integrate duplicate acknowledgement with SessionManager so the result is not retried or re-executed and the current local run becomes `disconnected`.

## 4. Revalidate code edits after approval

- [x] 4.1 Add a `code.edit` regression test that pauses approval, modifies the target file, approves the stale preview, and verifies the newer file is preserved with a non-retryable conflict.
- [x] 4.2 Capture the preview baseline version from the content used to build the diff and compare it again after approval immediately before apply.
- [x] 4.3 Ensure denial, version conflict, preview cleanup, successful apply, and existing `expectedVersion` behavior remain covered.

## 5. Verify the stabilized lifecycle

- [x] 5.1 Run `npm run check-types`, `npm run lint`, and the complete existing test suite with all new regression tests.
- [x] 5.2 Review the diff to confirm no cloud API, persistent Run model, Webview redesign, or vendored OpenCode source was changed.
