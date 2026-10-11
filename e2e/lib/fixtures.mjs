// 测试数据：三个工作区、几个项目和待办（标题就是文件名），一篇有标题和代码块的长文档，一个 GBK 编码的 .md
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 测试版用的全局快捷键：避开安装版的默认按键（Ctrl+Alt+T、Ctrl+Alt+N），两个能同时运行 */
export const TEST_KEYS = { toggle: "Ctrl+Alt+Y", quick: "Ctrl+Alt+J" };

const lines = (n, f) => Array.from({ length: n }, (_, i) => f(i + 1)).join("\n");

export function seed(dir, settings = {}) {
  const file = (rel, content) => {
    const path = join(dir, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  for (const n of ["A", "B", "C"])
    file(`工作/需求/${n}.md`, `# 待办 ${n}\n\n${lines(60, (i) => `第 ${i} 行内容 ${n}，这里是一些用来测试的文字`)}\n`);
  file(
    "工作/需求/长文档.md",
    [
      "# 长文档",
      "",
      "## 第一节",
      "",
      lines(40, (i) => `第一节第 ${i} 行 apple Apple APPLE`),
      "",
      "## 第二节 **加粗** [链接](http://x.com)",
      "",
      "```",
      "# 代码里的井号",
      "```",
      "",
      lines(40, (i) => `第二节第 ${i} 行 banana`),
      "",
      "### 第三节",
      "",
      Array.from({ length: 300 }, (_, i) => `铺垫${i + 1}`).join(" "),
      "藏在后面的独角兽关键词",
      "",
      "路径 C:\\new\\temp 在这里",
      "",
    ].join("\n"),
  );
  file("工作/日常/D.md", "# 待办 D\n\n日常内容\n");
  file("生活/杂事/E.md", "# 买菜\n\n番茄 鸡蛋\n");
  // 「你好，这是 GBK 编码的会议纪要」
  file(
    "生活/购物/GBK笔记.md",
    Buffer.from("c4e3bac3a3acd5e2cac72047424b20b1e0c2ebb5c4bbe1d2e9bccdd2aa0a", "hex"),
  );
  mkdirSync(join(dir, "学习"), { recursive: true });
  // 自动备份默认关掉：开着的话每个套件启动几秒后都要打包一份，打包时读着文件，和套件在外面改名、删除文件夹撞上时
  // （Windows 上文件夹里有文件开着时改不了名）会偶尔失败。backup 套件导出 settings = { autoBackup: undefined }，用软件的默认值（开着）
  writeFileSync(
    join(dir, ".settings.json"),
    JSON.stringify(
      {
        toggleShortcut: TEST_KEYS.toggle,
        quickCaptureShortcut: TEST_KEYS.quick,
        startupView: "home",
        theme: "light",
        autoBackup: false,
        ...settings,
      },
      null,
      2,
    ),
  );
}
