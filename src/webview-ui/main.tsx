/**
 * Webview 应用挂载入口。
 *
 * 职责：将 React 根应用挂载到 `index.html` 的 `#root` 节点，
 * 并引入全局样式 token。`App` 完成挂载后会发送 `webviewReady` 握手，
 * 请求宿主推送模型名与斜杠命令初始数据。
 */
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/tokens.css';
import './styles/chat.css';

const container = document.getElementById('root');
if (container) {
	createRoot(container).render(<App />);
}
