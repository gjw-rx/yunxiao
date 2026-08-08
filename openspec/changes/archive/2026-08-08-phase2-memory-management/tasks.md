## 1. 消息类型定义

- [X] 1.1 创建 `src/memory/types.ts`，定义 `Attachment` 类型（path/content/mimeType）
- [X] 1.2 定义 `ToolCall` 类型（id/name/arguments）
- [X] 1.3 定义 `SystemMessage`（role: "system", content, seq）
- [X] 1.4 定义 `UserMessage`（role: "user", content, seq, attachments?）
- [X] 1.5 定义 `AssistantMessage`（role: "assistant", content, toolCalls?, seq）
- [X] 1.6 定义 `ToolMessage`（role: "tool", toolCallId, content, seq）
- [X] 1.7 定义 `CompactionMessage`（role: "compaction", summary, recentContext: Message[], seq）
- [X] 1.8 定义 `Message` 联合类型（以上五种消息的 union）
- [X] 1.9 验证：类型文件可编译，无类型错误

## 2. MessageStore 实现

- [X] 2.1 创建 `src/memory/messageStore.ts`，定义 `MessageStore` 类，构造函数接收 `vscode.Memento` 参数
- [X] 2.2 实现内存存储 `Map<sessionId, Message[]>`，构造时从 Memento 恢复数据
- [X] 2.3 实现 `append(sessionId, message)`：分配递增 seq，追加消息，超过 1000 条时移除最旧消息，自动持久化
- [X] 2.4 实现 `loadHistory(sessionId)`：返回全部消息（seq 升序），无 session 返回空数组
- [X] 2.5 实现 `getCompactionPoint(sessionId)`：返回最新 CompactionMessage 或 null
- [X] 2.6 实现 `clear(sessionId)`：清空 session 消息并持久化
- [X] 2.7 实现 `deleteMessagesAfter(sessionId, seq)`：删除 seq 之后的消息并持久化
- [X] 2.8 实现持久化方法 `persist()`：序列化 Map 为 JSON 写入 workspaceState（key: `yunxiaoAgent.messages`），失败时降级为纯内存并记录日志
- [X] 2.9 验证：能正确存储和检索消息

## 3. 历史加载器实现

- [X] 3.1 创建 `src/memory/historyLoader.ts`，实现 `loadHistoryForLLM(sessionId, messageStore)`
- [X] 3.2 查找最新 compaction 检查点，有则从检查点开始加载，无则加载全部消息
- [X] 3.3 实现 `convertToLLMMessages(messages: Message[]): LLMMessage[]`：剥离 seq，转换各消息类型
- [X] 3.4 实现 CompactionMessage 转换：summary -> system 消息，recentContext 展开为 LLMMessage[]
- [X] 3.5 实现 UserMessage attachments 内联：将 attachment content 拼入消息文本
- [X] 3.6 验证：历史加载逻辑正确，compaction 检查点生效，输出 LLMMessage[] 格式正确

## 4. 集成测试

- [X] 4.1 编写测试：MessageStore 存储/加载消息（含 seq 分配）
- [X] 4.2 编写测试：MessageStore 持久化与恢复（mock Memento）
- [X] 4.3 编写测试：MessageStore 1000 条上限
- [X] 4.4 编写测试：MessageStore compaction 检查点
- [X] 4.5 编写测试：MessageStore deleteMessagesAfter
- [X] 4.6 编写测试：HistoryLoader 无 compaction 时加载全部
- [X] 4.7 编写测试：HistoryLoader 有 compaction 时从检查点加载
- [X] 4.8 编写测试：HistoryLoader 消息类型转换（含 attachments 内联）
- [X] 4.9 验证：所有测试通过
