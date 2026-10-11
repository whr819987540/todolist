import { history, undo } from "@codemirror/commands";
import { syntaxTree } from "@codemirror/language";
import { describe, expect, it } from "vitest";
import {
  clipboardImages,
  formatSize,
  ImageResolver,
  imageMarkdown,
  insertImages,
  isImageName,
  parseImageSrc,
  pastedImageExt,
} from "./images";
import { linkTarget } from "./links";
import { makeState, stringify, TestView } from "./testState";

// 按 docs/requirements.md「待办内容 → 图片」写的用例：插进正文的写法、正文里的地址怎么找到图片、粘贴时剪贴板里
// 什么算图片、插入后光标在哪里、能不能撤销

/** 正文里第一张图片的地址（编辑器的 Markdown 解析认出来的），经 parseImageSrc 解析 */
function srcOf(markdown: string) {
  const state = makeState(markdown);
  let found: ReturnType<typeof parseImageSrc> | null = null;
  syntaxTree(state).iterate({
    enter: (n) => {
      if (n.name !== "Image" || found) return;
      found = parseImageSrc(linkTarget(state, n.node) ?? "");
      return false;
    },
  });
  return found;
}

describe("插进正文的写法", () => {
  it("![去掉扩展名的文件名](相对于 .md 的地址)", () => {
    expect(imageMarkdown(".assets/20261010-101010/图片-20261010-101010.png", "图片-20261010-101010.png")).toBe(
      "![图片-20261010-101010](.assets/20261010-101010/图片-20261010-101010.png)",
    );
  });

  // Rust 端 export.rs 的 pasted_and_dropped_images_are_embedded 照同样的写法（同这两个例子）造正文，看导出时图片嵌不嵌得进去
  it("地址里有空格、括号时写成 <…>，说明里的 [ ] 转义", () => {
    expect(imageMarkdown(".assets/会议 纪要/截图 (1).png", "截图 (1).png")).toBe(
      "![截图 (1)](<.assets/会议 纪要/截图 (1).png>)",
    );
    expect(imageMarkdown(".assets/a/[草稿]b.png", "[草稿]b.png")).toBe("![\\[草稿\\]b](.assets/a/[草稿]b.png)");
  });

  it("写进去的地址按 Markdown 解析回来，就是原来的路径（Typora、VS Code 也这样认）", () => {
    for (const name of ["图片-20261010-101010.png", "会议 截图.png", "截图 (1).PNG", "a&b'c.jpg", "[草稿] 第一版.webp", "100%.gif"]) {
      for (const id of ["20261010-101010", "会议 纪要", "周报(第2版)"]) {
        const link = `.assets/${id}/${name}`;
        expect(srcOf(`前面的字\n\n${imageMarkdown(link, name)}\n`), link).toEqual({ kind: "local", path: link });
      }
    }
  });
});

describe("正文里的图片地址", () => {
  it("http / https、data:image 直接显示", () => {
    expect(parseImageSrc("https://example.com/a.png?w=100")).toEqual({ kind: "web", url: "https://example.com/a.png?w=100" });
    expect(parseImageSrc("HTTP://example.com/a")).toEqual({ kind: "web", url: "HTTP://example.com/a" });
    expect(parseImageSrc("data:image/png;base64,AAAA")).toEqual({ kind: "web", url: "data:image/png;base64,AAAA" });
  });

  it("相对于 .md 的路径（包括 .assets 以外的），%20 这类转义照样认", () => {
    expect(parseImageSrc("../图片/a.png")).toEqual({ kind: "local", path: "../图片/a.png" });
    expect(parseImageSrc(".assets/x/a%20b.png")).toEqual({ kind: "local", path: ".assets/x/a b.png" });
    expect(parseImageSrc("<.assets/x/a b.png>")).toEqual({ kind: "local", path: ".assets/x/a b.png" });
    // 文件名里本来就有 %
    expect(parseImageSrc("100%.png")).toEqual({ kind: "local", path: "100%.png" });
    // 文件名后面的 ? # 是网址的参数、锚点
    expect(parseImageSrc("a.png?raw=true")).toEqual({ kind: "local", path: "a.png" });
    expect(parseImageSrc("a.png#w=100")).toEqual({ kind: "local", path: "a.png" });
  });

  it("本地绝对路径：C:\\…、C:/…、file:///C:/…、\\\\服务器\\共享\\…", () => {
    expect(srcOf("![](C:\\Users\\我\\图片\\a.png)")).toEqual({ kind: "local", path: "C:\\Users\\我\\图片\\a.png" });
    expect(parseImageSrc("C:/Users/a.png")).toEqual({ kind: "local", path: "C:/Users/a.png" });
    expect(parseImageSrc("file:///C:/Users/a%20b.png")).toEqual({ kind: "local", path: "C:/Users/a b.png" });
    expect(srcOf("![](\\\\服务器\\共享\\a.png)")).toEqual({ kind: "local", path: "\\\\服务器\\共享\\a.png" });
    expect(parseImageSrc("file://服务器/共享/a.png")).toEqual({ kind: "local", path: "\\\\服务器/共享/a.png" });
    expect(parseImageSrc("//服务器/共享/a.png")).toEqual({ kind: "local", path: "\\\\服务器/共享/a.png" });
  });

  it("![说明][引用] 引用别处的地址", () => {
    expect(srcOf("![图][截图]\n\n[截图]: .assets/x/a.png")).toEqual({ kind: "local", path: ".assets/x/a.png" });
  });

  it("别的地址不支持", () => {
    expect(parseImageSrc("mailto:a@b.com")).toEqual({ kind: "unsupported" });
    expect(parseImageSrc("javascript:alert(1)")).toEqual({ kind: "unsupported" });
    expect(parseImageSrc("  ")).toEqual({ kind: "unsupported" });
  });
});

describe("找图片", () => {
  it("本地图片经外层找到地址，记着上次的；找不到时给出原因，不再用上次的", async () => {
    let missing = false;
    const asked: string[] = [];
    const r = new ImageResolver(async (path) => {
      asked.push(path);
      if (missing) throw "找不到图片";
      return `asset://${path}`;
    });
    expect(await r.resolve(".assets/x/a%20b.png")).toEqual({ url: "asset://.assets/x/a b.png" });
    expect(r.cached(".assets/x/a%20b.png")).toBe("asset://.assets/x/a b.png");
    missing = true;
    expect(await r.resolve(".assets/x/a%20b.png")).toEqual({ error: "找不到图片" });
    expect(r.cached(".assets/x/a%20b.png")).toBeUndefined();
    // 网络图片、不支持的地址不经外层
    expect(await r.resolve("https://example.com/a.png")).toEqual({ url: "https://example.com/a.png" });
    expect(await r.resolve("mailto:a@b.com")).toEqual({ error: "不支持的地址" });
    expect(await r.resolve("")).toEqual({ error: "没有地址" });
    expect(asked).toEqual([".assets/x/a b.png", ".assets/x/a b.png"]);
  });
});

/** 剪贴板里的一个文件 */
const file = (name: string, type: string) => ({ name, type });
const clipboard = (text: string, files: { name: string; type: string }[], items = false) => ({
  getData: (f: string) => (f === "text/plain" ? text : ""),
  files: items ? [] : files,
  items: items ? files.map((f) => ({ kind: "file", getAsFile: () => f })) : [],
});

describe("粘贴", () => {
  it("剪贴板里有图片、没有文字时当成图片（截图、从浏览器复制的图片）", () => {
    const shot = file("image.png", "image/png");
    expect(clipboardImages(clipboard("", [shot]))).toEqual([shot]);
    // 只放在 items 里的也认
    expect(clipboardImages(clipboard("", [shot], true))).toEqual([shot]);
  });

  it("同时有文字时照常粘贴文字（从 Word、Excel 复制的内容带着一张图片）", () => {
    expect(clipboardImages(clipboard("姓名\t年龄", [file("image.png", "image/png")]))).toBeNull();
  });

  it("没有文件时照常粘贴；只有不是图片的文件时是空的（提示只能粘贴图片）", () => {
    expect(clipboardImages(clipboard("", []))).toBeNull();
    expect(clipboardImages(null)).toBeNull();
    const doc = file("报告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(clipboardImages(clipboard("", [doc]))).toEqual([]);
    const gif = file("动图.gif", "image/gif");
    expect(clipboardImages(clipboard("", [doc, gif]))).toEqual([gif]);
  });

  it("存成什么扩展名：按图片的格式，认不出时看文件名", () => {
    expect(pastedImageExt(file("image.png", "image/jpeg"))).toBe("jpg");
    expect(pastedImageExt(file("a.WEBP", ""))).toBe("webp");
    expect(pastedImageExt(file("a.svg", "image/svg+xml"))).toBe("svg");
    expect(pastedImageExt(file("a.txt", "text/plain"))).toBeNull();
  });

  it("能插入的图片扩展名", () => {
    for (const ok of ["a.png", "C:\\图片\\b.JPG", "c.jpeg", "d.gif", "e.webp", "f.bmp", "g.svg", "h.ico", "i.avif"]) {
      expect(isImageName(ok), ok).toBe(true);
    }
    for (const no of ["a.txt", "b.md", "c.png.exe", "d", "e.tif"]) expect(isImageName(no), no).toBe(false);
    expect(formatSize(25.3 * 1024 * 1024)).toBe("25.3 MB");
    expect(formatSize(300)).toBe("1 KB");
  });
});

describe("插入", () => {
  const view = (marked: string) => new TestView(makeState(marked, [history()]));

  it("插在光标处（替换选中的文字），几张时每张一行，光标放在后面", () => {
    const v = view("前面«选中的»后面");
    insertImages(v.asView, ["![a](.assets/x/a.png)", "![b](.assets/x/b.png)"]);
    expect(stringify(v.state)).toBe("前面![a](.assets/x/a.png)\n![b](.assets/x/b.png)|后面");
  });

  it("拖进来的插在放下的位置", () => {
    const v = view("|第一行\n第二行");
    insertImages(v.asView, ["![a](a.png)"], 4);
    expect(stringify(v.state)).toBe("第一行\n![a](a.png)|第二行");
  });

  it("和打字一样可以撤销", () => {
    const v = view("正文|");
    insertImages(v.asView, ["![a](a.png)"]);
    expect(v.state.doc.toString()).toBe("正文![a](a.png)");
    undo(v.asView);
    expect(v.state.doc.toString()).toBe("正文");
  });
});
