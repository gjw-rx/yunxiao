## 1. Extend session creation request

- [x] 1.1 Update `AIClient.createSession` to accept an optional workspace root and serialize it as `workspace_root` without changing calls that omit it.
- [x] 1.2 Add AI client tests covering `workspace_root` with local tools and omission when no workspace root is available.

## 2. Create sessions on Agent changes

- [x] 2.1 Obtain the first VS Code workspace folder path in the panel host and pass it to every session-creation request.
- [x] 2.2 Change the Agent selection flow so selecting a different Agent creates a new session, while selecting the active Agent does not.
- [x] 2.3 Preserve the current session if the replacement session fails, and clear old local session state only after a successful replacement.
- [x] 2.4 Add or update panel tests for successful Agent switching, repeated selection, and failed session creation.

## 3. Verify API contract

- [x] 3.1 Review `docs/云端服务对接api/createSessionApi.md` against the implemented request and response contract.
- [x] 3.2 Run the focused TypeScript test suite and project validation command; resolve failures caused by this change.
