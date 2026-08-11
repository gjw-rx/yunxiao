import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
	files: 'out/test/**/*.test.js',
	mocha: {
		ui: 'bdd',
		// 文件模式 MessageStore 写入 1000+ 条消息的用例在慢环境需更长超时
		timeout: 15000,
	},
});
