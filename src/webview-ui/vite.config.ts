import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

/**
 * Webview 前端构建配置。
 *
 * 职责：将 `src/webview-ui/` 的 React 应用构建为固定名称的浏览器侧静态资源，
 * 输出到 `dist/webview-ui/`（`index.js`、`index.css` 与 source map）。
 * 固定产物名使扩展宿主无需解析 Vite manifest，直接以 `asWebviewUri()` 注入。
 * 不使用开发服务器或 CDN，产物为纯本地静态资源。
 */
export default defineConfig({
	plugins: [react()],
	// Vite 以本配置文件所在目录（src/webview-ui）为根
	root: __dirname,
	// 相对路径 base，便于 webview 通过 asWebviewUri 生成可加载 URI
	base: './',
	build: {
		outDir: resolve(__dirname, '../../dist/webview-ui'),
		emptyOutDir: true,
		// 任务要求构建产出 source map（开发与生产均保留，便于排查线上问题）
		sourcemap: true,
		// 关闭 CSS 代码分割，保证只产出一个 index.css
		cssCodeSplit: false,
		rollupOptions: {
			input: resolve(__dirname, 'index.html'),
			output: {
				entryFileNames: 'index.js',
				chunkFileNames: 'chunk-[name].js',
				// 静态资源（CSS 等）使用固定名称：index.css
				assetFileNames: 'index[extname]',
			},
		},
	},
	// Webview 组件测试使用 Vitest + Testing Library（jsdom 环境）
	test: {
		environment: 'jsdom',
		include: ['test/**/*.test.{ts,tsx}'],
		globals: false,
	},
});
