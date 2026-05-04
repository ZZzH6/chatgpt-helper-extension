# ChatGPT Context Helper

ChatGPT 网页助手扩展，用于估算当前对话的可见 token 使用量，并提供公式复制增强。

## 功能

- 估算 ChatGPT 当前页面可见上下文的 token 数量。
- 支持设置提醒阈值和高风险阈值。
- 支持显示或隐藏每条消息的 token 估算。
- 鼠标悬停或点击公式时，可复制为 LaTeX、Markdown 或 Unicode。

## 公式复制格式

### LaTeX

- 输出单行 LaTeX，自动压缩公式中的换行和多余空白。
- 自动将 `\tag{2-13}` 转换为 Word 公式可识别的 `#(2-13)`。
- 适合粘贴到 Microsoft Word 公式编辑器。

### Markdown

- 保留 LaTeX 语法，适合 Markdown 渲染器、笔记软件或文档系统。
- 行内公式输出为 `$...$`。
- 行间公式、带 `\tag{}` 的公式，以及 `aligned`、`cases`、`matrix` 等环境输出为 `$$...$$` 块。

### Unicode

- 输出可读的纯文本数学表达式。
- 尽量转换希腊字母、常见数学符号、上下标、分式和 `\mathcal{}` 字体。
- 将公式编号保留为普通文本，例如 `(2-13)`。

## 使用

1. 打开浏览器扩展管理页。
2. 启用开发者模式。
3. 加载 `chatgpt-helper-extension` 目录作为未打包扩展。
4. 打开 ChatGPT 页面后使用右侧面板和公式复制按钮。

## 版本

- 当前版本：`1.0.3`
