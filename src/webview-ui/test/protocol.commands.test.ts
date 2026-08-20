/**
 * Command 协议类型测试 - 验证新增的 Command 协议类型结构与判别联合完整性。
 */
import { describe, expect, it } from 'vitest';
import type {
	CommandInfo,
	CommandsListMessage,
	CommandReference,
	HostToWebviewMessage,
	SlashCommand,
	SlashCommandGroup,
	WebviewToHostMessage,
} from '../protocol';

describe('Command 协议类型', () => {
	it('CommandsListMessage 携带双作用域快照与目录、项目可用标记', () => {
		const msg: CommandsListMessage = {
			command: 'commandsList',
			global: [{ name: 'review', description: '审查', scope: 'global', overridden: true, sourcePath: '/ws/review.md' }],
			project: [],
			globalDirectory: '/home/u/.yunForce/command',
			projectDirectory: '/ws/.yunForce/command',
			projectAvailable: true,
		};
		expect(msg.command).toBe('commandsList');
		expect(msg.global[0].overridden).toBe(true);
		expect(msg.projectAvailable).toBe(true);
	});

	it('CommandInfo 不携带正文（仅非敏感元数据）', () => {
		const info: CommandInfo = {
			name: 'review',
			description: '审查',
			scope: 'global',
			overridden: false,
			sourcePath: '/ws/review.md',
		};
		expect(info).not.toHaveProperty('body');
	});

	it('斜杠候选携带显式 kind 与 command 生效来源作用域', () => {
		const cmd: SlashCommand = {
			id: 'command.review',
			command: 'review',
			label: 'review',
			description: '审查',
			send: false,
			kind: 'command',
			sourceScope: 'global',
		};
		expect(cmd.kind).toBe('command');
		expect(cmd.sourceScope).toBe('global');
	});

	it('斜杠分组 id 覆盖基础功能/命令/子智能体/SKILL', () => {
		const group: SlashCommandGroup = {
			id: 'commands',
			label: '命令',
			commands: [],
		};
		expect(group.id).toBe('commands');
	});

	it('发送消息的 Command 引用仅携带名称与作用域（无正文）', () => {
		const ref: CommandReference = { name: 'review', scope: 'project' };
		expect(ref).not.toHaveProperty('body');
		expect(ref.scope).toBe('project');
	});

	it('commandsList 属于 Host→Webview 判别联合，createCommand 等属于 Webview→Host 联合', () => {
		const host: HostToWebviewMessage = {
			command: 'commandsList',
			global: [],
			project: [],
			projectAvailable: false,
		};
		const webview: WebviewToHostMessage = {
			command: 'createCommand',
			scope: 'global',
			input: { name: 'new', body: '正文' },
		};
		expect(host.command).toBe('commandsList');
		expect(webview.command).toBe('createCommand');
	});
});
