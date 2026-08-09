# security-boundary Delta Specification

## Purpose
修改统一结果治理需求:截断从"字符级裁剪"升级为"行数 + 字节双限(可配置)",截断提示附续读指引;保持二进制跳过与敏感信息脱敏不变。

## MODIFIED Requirements

### Requirement: Unified tool result governance
The local plugin SHALL apply a common result-governance step before sending any tool result to the cloud. It SHALL skip binary payloads, truncate oversized text, redact high-confidence secrets, and attach metadata indicating truncation or redaction. Truncation SHALL be bounded by both a line cap and a byte cap (both configurable; defaults 2000 lines and 50 KB), applied to the tool result before upload. Truncated results SHALL include a marker and, where the tool supports paged reads, a continuation hint so the cloud/model can fetch the remaining content instead of receiving the full payload. The original sensitive or oversized content SHALL NOT be sent to the cloud.

#### Scenario: Secret is redacted before upload
- **WHEN** a tool result contains a high-confidence API key or password assignment
- **THEN** the uploaded result contains a redacted placeholder and `metadata.redacted` is true

#### Scenario: Oversized result is truncated by byte budget
- **WHEN** a tool result exceeds the configured byte cap (default 50 KB)
- **THEN** the uploaded result is bounded by the byte budget, includes a truncation marker, and the cloud can continue without receiving the full payload

#### Scenario: Oversized result is truncated by line budget
- **WHEN** a tool result exceeds the configured line cap (default 2000 lines) but is within the byte budget
- **THEN** the uploaded result is bounded by the line budget and includes a truncation marker

#### Scenario: Truncated result carries continuation hint
- **WHEN** a truncated result corresponds to a paged tool (e.g. `fs.read_file`)
- **THEN** the result includes a hint (`Use offset=<next> to continue`) enabling the model to fetch the remainder
