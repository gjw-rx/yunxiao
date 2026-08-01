// Webview 脚本：加载 marked 库
// 此文件作为 Webview 内的全局脚本，将 marked 暴露到 window
const { marked } = require('marked');
window.marked = marked;
