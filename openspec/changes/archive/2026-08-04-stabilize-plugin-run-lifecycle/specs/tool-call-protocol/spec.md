## ADDED Requirements

### Requirement: Duplicate tool-result acknowledgement handling
The local tool-result client SHALL inspect a successful response's Content-Type before consuming its body. A `text/event-stream` response SHALL be parsed as a continuation stream. An `application/json` response whose success payload contains `duplicate: true` SHALL be delivered through a distinct duplicate-acknowledgement outcome and SHALL NOT be passed to the SSE parser or reported through the normal SSE end callback. After a valid duplicate acknowledgement, the plugin MUST NOT resubmit the result or re-execute the tool.

#### Scenario: First result receives SSE continuation
- **WHEN** `/api/agent/invoke/tool_result` returns a successful `text/event-stream` response
- **THEN** the client parses its events and invokes the normal SSE end callback only after the continuation ends cleanly

#### Scenario: Duplicate result receives JSON acknowledgement
- **WHEN** `/api/agent/invoke/tool_result` returns `application/json` with a successful payload containing `duplicate: true`
- **THEN** the client reports the distinct duplicate acknowledgement without invoking the SSE parser, retrying the upload, re-executing the tool, or invoking the normal SSE end callback

#### Scenario: Unknown successful JSON response
- **WHEN** `/api/agent/invoke/tool_result` returns successful JSON that is not a valid duplicate acknowledgement
- **THEN** the client reports a protocol error instead of treating the response as a completed continuation
