import { defineConfig } from "vitest/config";

// 前端单元测试：测试文件放在被测模块旁边（*.test.ts）。
// 默认在 Node 里跑：编辑命令直接构造 CodeMirror 的 EditorState 测，不需要 DOM；
// 要用 window、localStorage 的测试文件在开头用 @vitest-environment happy-dom 单独指定
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
