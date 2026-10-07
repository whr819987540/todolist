import { describe, expect, it } from "vitest";
import { closeFenceOnEnter, downOutOfCodeBlock, exitCodeBlock } from "./codeFences";
import { exec } from "./testState";

// docs/requirements.md「代码块（同 Typora）」：输入 ```语言 后回车自动补上结尾的 ```；在代码块里按 Ctrl+Enter，
// 或在文末代码块的最后一行按 ↓，跳到代码块下面新的一行，缺结尾的 ``` 时顺便补上。记号：| 光标

describe("输入 ```语言 后回车，自动补上结尾", () => {
  it("补上结尾的 ```，光标放在中间的空行", () => {
    expect(exec("```js|", closeFenceOnEnter)).toEqual({ handled: true, text: "```js\n|\n```" });
    expect(exec("前\n```|", closeFenceOnEnter)).toEqual({ handled: true, text: "前\n```\n|\n```" });
  });

  it("~~~ 和缩进照样补", () => {
    expect(exec("  ~~~py|", closeFenceOnEnter).text).toBe("  ~~~py\n  |\n  ~~~");
  });

  it("代码块已经有结尾时照常换行（交给默认的回车）", () => {
    expect(exec("```js|\ncode\n```", closeFenceOnEnter).handled).toBe(false);
  });

  it("光标不在行末、不是代码块开头时照常换行", () => {
    expect(exec("```j|s", closeFenceOnEnter).handled).toBe(false);
    expect(exec("普通|文字", closeFenceOnEnter).handled).toBe(false);
  });
});

describe("Ctrl+Enter 跳出代码块", () => {
  it("跳到代码块下面新的一行", () => {
    expect(exec("```\nco|de\n```\n后面", exitCodeBlock)).toEqual({
      handled: true,
      text: "```\ncode\n```\n|\n后面",
    });
  });

  it("在 ``` 行上也算在代码块里", () => {
    expect(exec("```j|s\ncode\n```", exitCodeBlock).text).toBe("```js\ncode\n```\n|");
  });

  it("缺结尾的 ``` 时顺便补上", () => {
    expect(exec("```js\nco|de", exitCodeBlock).text).toBe("```js\ncode\n```\n|");
  });

  it("下面已经是空行时直接移过去，不再加空行", () => {
    expect(exec("```\nco|de\n```\n\n后面", exitCodeBlock).text).toBe("```\ncode\n```\n|\n后面");
  });

  it("不在代码块里时不处理", () => {
    expect(exec("普通|文字", exitCodeBlock).handled).toBe(false);
  });
});

describe("文末代码块的最后一行按 ↓ 跳出", () => {
  it("缺结尾的 ``` 时补上，跳到下面新的一行", () => {
    expect(exec("```\nco|de", downOutOfCodeBlock)).toEqual({ handled: true, text: "```\ncode\n```\n|" });
  });

  it("在结尾的 ``` 行上按 ↓", () => {
    expect(exec("```\ncode\n``|`", downOutOfCodeBlock).text).toBe("```\ncode\n```\n|");
  });

  it("不是最后一行、或不在代码块里时照常移动光标", () => {
    expect(exec("```\nco|de\n```", downOutOfCodeBlock).handled).toBe(false);
    expect(exec("```\ncode\n```\n末|尾", downOutOfCodeBlock).handled).toBe(false);
  });
});
