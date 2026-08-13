# full-access-approval-mode Specification

## Purpose
TBD - created by archiving change add-full-access-approval-mode. Update Purpose after archive.
## Requirements
### Requirement: Approval mode selector in the message composer
The chat message composer SHALL display an approval mode selector immediately to the right of the “+” file-reference button. The selector SHALL offer exactly `request` and `full-access` modes, show the active mode in its trigger, and provide an accessible menu that users can close with Escape or an outside click.

#### Scenario: User opens the approval mode menu
- **WHEN** the user clicks the selector next to the “+” button
- **THEN** the Webview displays both modes with their descriptions and identifies the active mode

#### Scenario: User selects full access
- **WHEN** the user selects `full-access`
- **THEN** the Webview sends the selected mode to the extension host and updates its visible active state after host confirmation

### Requirement: Workspace-scoped approval mode persistence
The extension SHALL persist the selected approval mode for the current workspace, SHALL default a missing or invalid value to `request`, and SHALL send the host-held value to the Webview on every Webview-ready handshake.

#### Scenario: Mode survives panel recreation
- **WHEN** a user selected `full-access`, closes the chat panel, and opens it again in the same workspace
- **THEN** the selector displays `full-access` without requiring a new user choice

#### Scenario: User returns to request approval
- **WHEN** the user selects `request` after `full-access` was active
- **THEN** the host persists `request` and subsequent non-read operations use the normal approval flow

### Requirement: Full access meaning is visible and bounded
The `full-access` option SHALL state that non-deletion operations are automatically approved and that deletion operations still require confirmation. It SHALL NOT claim to bypass independent safety controls.

#### Scenario: User reviews full access description
- **WHEN** the approval menu is open
- **THEN** the `full-access` option explains automatic approval for non-deletion actions and retained confirmation for deletion actions

