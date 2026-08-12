import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

describe('Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	it('激活入口先注册侧栏并且不自动打开日志', () => {
		const sourcePath = path.join(__dirname, '..', '..', 'src', 'extension.ts');
		const source = fs.readFileSync(sourcePath, 'utf8');
		const registrationIndex = source.indexOf("registerWebviewViewProvider('yunxiaoAgent.chatView'");
		const initializationIndex = source.indexOf('const initializeSkills = async');

		assert.ok(registrationIndex >= 0, '扩展必须注册聊天侧栏 Provider');
		assert.ok(initializationIndex > registrationIndex, '首次 Skill 初始化必须在侧栏 Provider 注册后启动');
		assert.ok(!source.includes('logger.show();'), '扩展激活不得自动打开日志面板');
		assert.match(source, /syncChain = syncChain\.then\(run, run\)/, '所有 Skill 重载必须复用串行同步队列');
		assert.match(source, /await syncSkills\(\);\s*provider\.refreshModelInfo\(\);\s*provider\.setRuntimeStatus\('ready'\)/, '首次同步完成后必须发布 ready 状态');
		assert.match(source, /setSyncSource[\s\S]*?await syncSkills\(\);/, '切换 Skill 来源必须等待同步完成');
		assert.match(source, /setSkillDirectories[\s\S]*?await syncSkills\(\);/, '保存 Skill 目录必须等待同步完成');
	});

	it('Sample test', () => {
		assert.strictEqual(-1, [1, 2, 3].indexOf(5));
		assert.strictEqual(-1, [1, 2, 3].indexOf(0));
	});
});
