## Context

`ApprovalGateway` currently persists an unscoped tool-name array and remembers an entire tool for a session. This permits a grant made for one file or workspace to be reused for unrelated resources. `code.edit` already checks its in-memory preview content after approval, but its successful result does not expose a version token and its approval request cannot be constrained to the edited resource.

The extension is the local enforcement point: cloud-provided approval flags or tool arguments cannot widen a locally stored grant. The design must remain compatible with non-file tools and existing settings.

## Goals / Non-Goals

**Goals:**

- Persist and match grants by canonical workspace identity, tool name, normalized resource pattern, optional command pattern, expiry, and policy version.
- Limit one-time approval to the same session and the same normalized resource.
- Preserve legacy `alwaysAllowTools` only as a read-compatible migration source; newly persisted grants use scoped records.
- Carry a deterministic content hash through `code.edit` preview and final application, expose the applied version, and fail closed on a changed target.

**Non-Goals:**

- No cloud-side authorization, multi-user policy service, lease, or filesystem-wide transaction.
- No new approval UI for users to select arbitrary glob or duration; the initial persisted scope is the exact resource (or workspace command pattern) with a 24-hour expiry.
- No version history, patch reversion, or changes to unrelated file tools.

## Decisions

### Scope is an explicit value object

`ApprovalScope` contains `workspaceId`, `toolName`, `resourcePattern`, optional `commandPattern`, `expiresAt`, and `policyVersion`. Workspace roots are normalized (resolved, slash-normalized, case-normalized on Windows) and combined deterministically. File resources use their normalized workspace-relative path; command resources use a normalized command prefix. A grant matches only its exact workspace and tool, a non-expired policy version, and a matching resource/command pattern. This is stricter than tool-only matching and avoids cloud-controlled scope.

Alternative: store only a tool-to-path map. Rejected because it cannot represent expiry or terminal command limits, and lacks a policy-version migration boundary.

### Existing grants migrate conservatively

The gateway reads legacy `alwaysAllowTools`; when no scoped record matches, it creates a scoped grant only after a newly approved call. It does not silently translate a legacy global tool grant into every workspace. Legacy entries therefore retain prior behavior during the compatibility window but no new broad grants are written. The compatibility path is isolated for later removal.

Alternative: eagerly convert to `**` scopes. Rejected because it would silently retain the overbroad permission this change is intended to eliminate.

### Router and self-approving tools construct scopes locally

The router derives a resource from the tool arguments (`path`, `from`, `to`, `cwd`) and workspace roots. `code.edit` passes its resolved relative path. `terminal.exec` passes its normalized command. Missing resource data produces a workspace-local wildcard that expires, never a cross-workspace grant. Tool calls do not supply an authority-bearing scope.

### File version is SHA-256 of exact UTF-8 content

`code.edit` captures the token from the content read to create the preview, validates optional `expectedVersion` against it, and after approval re-reads and compares the token before rename. The success metadata includes `base_version` and `applied_version`; conflicts include the expected and current tokens where safe. Hashing content avoids timestamp resolution and works with the existing `fileVersion` helper.

Alternative: use mtime/size. Rejected because rapid edits can retain those attributes and do not identify the actual preview base.

## Risks / Trade-offs

- [Legacy settings remain broad during compatibility] → Document and isolate the fallback; do not write new legacy entries.
- [Resource extraction is incomplete for a future tool] → use an expiring workspace-only scope and require each new tool to provide a local resource extractor.
- [Check-then-rename is not filesystem CAS] → perform the re-read immediately before rename and retain the existing fail-closed conflict result.

## Migration Plan

1. Add the new scoped-grant setting and matching implementation while retaining read-only legacy compatibility.
2. Release with exact-resource, 24-hour persistent grants; session grants are memory-only.
3. Remove `alwaysAllowTools` fallback in a later breaking configuration migration after users have adopted scoped grants.
4. Roll back by ignoring the new setting; no source files are changed by migration.

## Open Questions

- None for the initial local implementation; user-configurable durations and scope-selection UI remain a later UX change.
