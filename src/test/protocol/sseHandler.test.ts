import * as assert from 'assert';
import { handleSseBlock, SseStreamParser, type SseCallbacks } from '../../protocol/sseHandler';

function makeCallbacks(): SseCallbacks & { calls: Record<string, unknown[]> } {
	const calls: Record<string, unknown[]> = {
		content: [],
		thought: [],
		tool_start: [],
		tool_end: [],
		tool_call: [],
		plan: [],
		progress: [],
		error: [],
	};
	return {
		calls,
		onContent: (t) => calls.content.push(t),
		onThought: (t) => calls.thought.push(t),
		onToolStart: (t) => calls.tool_start.push(t),
		onToolEnd: (t) => calls.tool_end.push(t),
		onToolCall: (e) => calls.tool_call.push(e),
		onPlan: (e) => calls.plan.push(e),
		onProgress: (e) => calls.progress.push(e),
		onError: (e) => calls.error.push(e),
	};
}

describe('handleSseBlock', () => {
	it('parses content event', () => {
		const cbs = makeCallbacks();
		handleSseBlock('data: {"type":"content","data":"hello"}', cbs);
		assert.deepStrictEqual(cbs.calls.content, ['hello']);
	});

	it('parses thought / tool_start / tool_end events (object format)', () => {
		const cbs = makeCallbacks();
		handleSseBlock(
			'data: {"type":"thought","data":"thinking"}\n' +
			'data: {"type":"tool_start","data":{"run_id":"r1","name":"skills_list","input":{},"tool_call_id":"c1"}}\n' +
			'data: {"type":"tool_end","data":{"run_id":"r1","name":"skills_list","output":"{\\"success\\":true}","tool_call_id":"c1"}}',
			cbs
		);
		assert.deepStrictEqual(cbs.calls.thought, ['thinking']);
		assert.strictEqual(cbs.calls.tool_start.length, 1);
		const startEvt = cbs.calls.tool_start[0] as { run_id: string; name: string; input: Record<string, unknown>; tool_call_id: string };
		assert.strictEqual(startEvt.run_id, 'r1');
		assert.strictEqual(startEvt.name, 'skills_list');
		assert.deepStrictEqual(startEvt.input, {});
		assert.strictEqual(startEvt.tool_call_id, 'c1');
		assert.strictEqual(cbs.calls.tool_end.length, 1);
		const endEvt = cbs.calls.tool_end[0] as { run_id: string; name: string; output: string; tool_call_id: string };
		assert.strictEqual(endEvt.run_id, 'r1');
		assert.strictEqual(endEvt.name, 'skills_list');
		assert.strictEqual(endEvt.output, '{"success":true}');
		assert.strictEqual(endEvt.tool_call_id, 'c1');
	});

	it('parses tool_start / tool_end with null tool_call_id and input args', () => {
		const cbs = makeCallbacks();
		handleSseBlock(
			'data: {"type":"tool_start","data":{"run_id":"r2","name":"skill_view","input":{"name":"frontend-design"},"tool_call_id":null}}\n' +
			'data: {"type":"tool_end","data":{"run_id":"r2","name":"skill_view","output":"skill content"}}',
			cbs
		);
		assert.strictEqual(cbs.calls.tool_start.length, 1);
		const startEvt = cbs.calls.tool_start[0] as { run_id: string; name: string; input: Record<string, unknown>; tool_call_id: string | null };
		assert.strictEqual(startEvt.run_id, 'r2');
		assert.strictEqual(startEvt.name, 'skill_view');
		assert.strictEqual(startEvt.input.name, 'frontend-design');
		assert.strictEqual(startEvt.tool_call_id, null);
		assert.strictEqual(cbs.calls.tool_end.length, 1);
		const endEvt = cbs.calls.tool_end[0] as { run_id: string; name: string; output: string; tool_call_id: string | null };
		assert.strictEqual(endEvt.run_id, 'r2');
		assert.strictEqual(endEvt.tool_call_id, null);
	});

	it('parses tool_call event with single-element data array', () => {
		const cbs = makeCallbacks();
		handleSseBlock(
			'data: {"type":"tool_call","data":[{"call_id":"c1","tool":"fs.read_file","args":{"path":"a.ts"},"site":"local","require_approval":false}]}',
			cbs
		);
		assert.strictEqual(cbs.calls.tool_call.length, 1);
		const evt = cbs.calls.tool_call[0] as { call_id: string; tool: string; site: string };
		assert.strictEqual(evt.call_id, 'c1');
		assert.strictEqual(evt.tool, 'fs.read_file');
		assert.strictEqual(evt.site, 'local');
	});

	it('parses tool_call event with multiple-element data array', () => {
		const cbs = makeCallbacks();
		handleSseBlock(
			'data: {"type":"tool_call","data":[{"call_id":"c1","tool":"fs.read_file","args":{"path":"a.ts"},"site":"local"},{"call_id":"c2","tool":"code.get_diagnostics","args":{"file":"a.ts"},"site":"local"}]}',
			cbs
		);
		assert.strictEqual(cbs.calls.tool_call.length, 2);
		assert.strictEqual((cbs.calls.tool_call[0] as { call_id: string }).call_id, 'c1');
		assert.strictEqual((cbs.calls.tool_call[1] as { call_id: string }).call_id, 'c2');
	});

	it('parses plan and progress events', () => {
		const cbs = makeCallbacks();
		handleSseBlock(
			'data: {"type":"plan","data":{"steps":["a","b"]}}\ndata: {"type":"progress","data":{"message":"working","current":1,"total":3}}',
			cbs
		);
		assert.strictEqual(cbs.calls.plan.length, 1);
		assert.strictEqual(cbs.calls.progress.length, 1);
		assert.deepStrictEqual(
			(cbs.calls.plan[0] as { steps: string[] }).steps,
			['a', 'b']
		);
	});

	it('invokes onError on {success:false} envelope', () => {
		const cbs = makeCallbacks();
		handleSseBlock('data: {"success":false,"error":"会话不存在"}', cbs);
		assert.strictEqual(cbs.calls.error.length, 1);
		assert.strictEqual((cbs.calls.error[0] as Error).message, '会话不存在');
	});

	it('ignores unknown event types and non-JSON lines', () => {
		const cbs = makeCallbacks();
		handleSseBlock('data: {"type":"unknown","data":"x"}\n: comment\ndata: not-json', cbs);
		// 无任何回调被触发，且不抛错
		assert.strictEqual(cbs.calls.content.length, 0);
	});
});

describe('SseStreamParser', () => {
	it('reassembles an event split across chunks (half-packet)', () => {
		const cbs = makeCallbacks();
		const parser = new SseStreamParser(cbs);
		// 第一块未含 \n\n，应被缓冲
		parser.feed('data: {"type":"content","data":"hel');
		assert.strictEqual(cbs.calls.content.length, 0);
		// 第二块补齐并含 \n\n，触发分发
		parser.feed('lo"}\n\n');
		assert.deepStrictEqual(cbs.calls.content, ['hello']);
	});

	it('dispatches multiple events from one chunk', () => {
		const cbs = makeCallbacks();
		const parser = new SseStreamParser(cbs);
		parser.feed('data: {"type":"content","data":"a"}\n\ndata: {"type":"content","data":"b"}\n\n');
		assert.deepStrictEqual(cbs.calls.content, ['a', 'b']);
	});

	it('flush processes remaining buffered content', () => {
		const cbs = makeCallbacks();
		const parser = new SseStreamParser(cbs);
		parser.feed('data: {"type":"content","data":"tail"}'); // 无结尾 \n\n
		assert.strictEqual(cbs.calls.content.length, 0);
		parser.flush();
		assert.deepStrictEqual(cbs.calls.content, ['tail']);
	});
});
