## 1. Scoped approval model

- [x] 1.1 Define a persisted scoped-grant shape and canonical matching helpers in `ApprovalGateway`.
- [x] 1.2 Persist expiring scoped grants through VS Code settings while retaining read-compatible legacy settings.
- [x] 1.3 Limit session grants to the normalized workspace, tool, and resource scope.

## 2. Tool integration

- [x] 2.1 Derive local approval scopes in the router and pass exact edit and terminal resources from self-approving tools.
- [x] 2.2 Expose the `scopedApprovals` configuration setting and document its bounded semantics.

## 3. File-version chain

- [x] 3.1 Capture the preview base version from the exact `code.edit` content and pass it to approval.
- [x] 3.2 Return base and applied version tokens after a successful edit while preserving the existing post-approval conflict check.

## 4. Verification

- [x] 4.1 Add unit coverage for workspace/resource/expiry scoped approval matching.
- [x] 4.2 Add unit coverage for the `code.edit` successful version chain.
- [x] 4.3 Run TypeScript checks, lint, targeted tests, and strict OpenSpec validation.
