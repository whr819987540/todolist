import { EditorSelection, type Extension, Facet, StateEffect, StateField } from "@codemirror/state";
import { EditorView, layer, RectangleMarker, WidgetType } from "@codemirror/view";

// 正文里的图片（docs/requirements.md「待办内容 → 图片」）：粘贴、拖进来的存进待办的附件目录（Rust 端 store.rs），
// 在光标处插入 ![说明](地址)；实时渲染时 livePreview.ts 把图片换成 ImageWidget 显示。这里是和 Tauri 无关的部分：
// 地址的解析、插入的写法、剪贴板里有没有图片、显示图片的小部件，和拖进来时标出放下位置的竖线

/** 能插入、显示的图片的扩展名（同 Rust 端 store.rs 的 IMAGE_EXTS） */
export const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"];

/** 图片超过这么大（字节）时提示一下 */
export const LARGE_IMAGE = 20 * 1024 * 1024;

const extOf = (name: string) => /\.([^./\\]+)$/.exec(name)?.[1].toLowerCase() ?? "";

/** 文件名（或路径）是不是能插入的图片 */
export const isImageName = (name: string) => IMAGE_EXTS.includes(extOf(name));

/** 路径里的文件名 */
export const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** 字节数写成「25.3 MB」「120 KB」 */
export const formatSize = (bytes: number) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

const MIME_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
  "image/avif": "avif",
};

/** 粘贴的图片存成什么扩展名：按图片的格式，认不出格式时看文件名；都不是能插入的图片时是 null */
export function pastedImageExt(file: { name: string; type: string }): string | null {
  const byType = MIME_EXTS[file.type.toLowerCase()];
  if (byType) return byType;
  return isImageName(file.name) ? extOf(file.name) : null;
}

/** 剪贴板（ClipboardEvent.clipboardData）里用到的部分 */
export interface ClipboardLike<F> {
  getData(format: string): string;
  files?: ArrayLike<F> | null;
  items?: ArrayLike<{ kind: string; getAsFile(): F | null }> | null;
}

/**
 * 粘贴时剪贴板里要当成图片插入的文件。有文字时照常粘贴文字（从 Word、Excel 复制的内容往往还带着一张选中部分的图片），
 * 没有文件时也交给编辑器照常粘贴，都返回 null；返回的列表里只有图片，空的说明剪贴板里只有不是图片的文件
 */
export function clipboardImages<F extends { name: string; type: string }>(data: ClipboardLike<F> | null): F[] | null {
  if (!data || data.getData("text/plain")) return null;
  let files = Array.from(data.files ?? []);
  if (!files.length) {
    files = Array.from(data.items ?? [])
      .filter((i) => i.kind === "file")
      .map((i) => i.getAsFile())
      .filter((f): f is F => !!f);
  }
  return files.length ? files.filter((f) => pastedImageExt(f) !== null) : null;
}

/**
 * 插进正文的一张图片：`![说明](地址)`。说明是去掉扩展名的文件名（[ ] \ 前面加 \）；
 * 地址里有空白、括号、尖括号时按 Markdown 的规则写成 `<…>`（里面的尖括号转义）
 */
export function imageMarkdown(link: string, name: string): string {
  const alt = name.replace(/\.[^.]*$/, "").replace(/[[\]\\]/g, "\\$&");
  const dest = /[\s()<>]/.test(link) ? `<${link.replace(/[<>]/g, "\\$&")}>` : link;
  return `![${alt}](${dest})`;
}

/**
 * 正文里图片地址指向哪里：web 是能直接放进 <img> 的（http / https、data:image），local 是本地路径（相对于 .md 文件，
 * 或者绝对路径，交给 Rust 端找文件），unsupported 是别的（mailto: 之类、空的）
 */
export type ImageSrc = { kind: "web"; url: string } | { kind: "local"; path: string } | { kind: "unsupported" };

/** 文件名后面的 ?… 或 #…（网址的参数、锚点），前面是图片的扩展名时去掉 */
const SUFFIX = /^(.*?\.[A-Za-z0-9]+)[?#].*$/;

/** 正文里写的图片地址（链接目标的原文，可能带着 <>、Markdown 的转义、%20 之类的转义）→ 去哪里找这张图片 */
export function parseImageSrc(raw: string): ImageSrc {
  let s = raw.trim();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1);
  // Markdown 的反斜杠转义：\ 后面的 ASCII 标点就是它自己（Windows 路径里的 \U 之类不受影响）；
  // 开头的 \\ 是网络路径（\\服务器\共享\…），不当成转义
  const unc = /^\\\\[^\\]/.test(s) ? "\\\\" : "";
  s = (unc + s.slice(unc.length).replace(/\\([!-/:-@[-`{-~])/g, "$1")).trim();
  if (!s) return { kind: "unsupported" };
  if (/^https?:\/\/\S/i.test(s) || /^data:image\//i.test(s)) return { kind: "web", url: s };
  let path = s;
  const file = /^file:\/\/(.*)$/i.exec(s);
  if (file) {
    // file:///C:/a.png → C:/a.png；file://服务器/共享/a.png → 网络路径
    path = /^\/[A-Za-z]:/.test(file[1]) ? file[1].slice(1) : `//${file[1].replace(/^\/+/, "")}`;
  } else if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(s) && !/^[A-Za-z]:([\\/]|$)/.test(s)) {
    return { kind: "unsupported" };
  }
  // 网络路径统一写成 \\服务器\…（写成 // 的也认）
  if (/^[\\/]{2}[^\\/]/.test(path)) path = `\\\\${path.slice(2)}`;
  const plain = SUFFIX.exec(path);
  if (plain && isImageName(plain[1])) path = plain[1];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* 不是转义（文件名里本来就有 %），照原样 */
  }
  return { kind: "local", path };
}

/** 找图片的结果：能放进 <img> 的地址，或者显示不了的原因 */
export type ImageResult = { url: string } | { error: string };

/**
 * 实时渲染时找正文里的图片（每个编辑器一个，经 imageResolver 交给 ImageWidget）。local 把本地路径换成能放进 <img> 的
 * 地址（TodoEditor 经 Rust 端找到文件，用 asset 协议），找不到等时抛出原因。记着上次找到的地址和图片的大小：
 * 光标离开那一行、图片重新显示时先用上次的，不闪一下，也不因为先显示一个小框、加载完再撑开而跳动
 */
export class ImageResolver {
  private readonly found = new Map<string, string>();
  private readonly sizes = new Map<string, [number, number]>();

  constructor(private readonly local: (path: string) => Promise<string>) {}

  /** 上次找到的地址 */
  cached(src: string): string | undefined {
    return this.found.get(src);
  }

  /** 找到图片；本地图片每次都重新问（在外部被替换了的，修改时间变了，地址跟着变） */
  async resolve(src: string): Promise<ImageResult> {
    const s = parseImageSrc(src);
    if (s.kind === "unsupported") return { error: src.trim() ? "不支持的地址" : "没有地址" };
    if (s.kind === "web") return { url: s.url };
    try {
      const url = await this.local(s.path);
      this.found.set(src, url);
      return { url };
    } catch (e) {
      this.found.delete(src);
      return { error: typeof e === "string" ? e : e instanceof Error ? e.message : String(e) };
    }
  }

  /** 加载过的图片原来的宽、高 */
  sizeOf(url: string): [number, number] | undefined {
    return this.sizes.get(url);
  }

  rememberSize(url: string, width: number, height: number) {
    if (width && height) this.sizes.set(url, [width, height]);
  }
}

/** 编辑器用的 ImageResolver（setup.ts 放进去，ImageWidget 取用） */
export const imageResolver = Facet.define<ImageResolver, ImageResolver | null>({ combine: (v) => v[0] ?? null });

/** 实时渲染时显示成图片的 ![说明](地址)：宽度不超过编辑区，按比例缩小；显示不了时是写明原因的占位框 */
export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
  ) {
    super();
  }

  eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(view: EditorView) {
    const box = document.createElement("span");
    box.className = "cm-md-image";
    box.title = this.src;
    const resolver = view.state.facet(imageResolver);
    const fail = (why: string) => {
      box.className = "cm-md-image-error";
      box.textContent = `图片无法显示：${why}${this.alt ? `（${this.alt}）` : ""}`;
      view.requestMeasure();
    };
    const show = (url: string) => {
      if (box.querySelector("img")?.getAttribute("src") === url) return;
      const img = document.createElement("img");
      img.alt = this.alt;
      // 不让 WebView 把图片当成拖动的东西（拖放由 Tauri 接管）
      img.draggable = false;
      const size = resolver?.sizeOf(url);
      if (size) [img.width, img.height] = size;
      img.onload = () => {
        resolver?.rememberSize(url, img.naturalWidth, img.naturalHeight);
        view.requestMeasure();
      };
      img.onerror = () => fail(/^https?:/i.test(url) ? "网络图片加载失败" : "图片加载失败（格式不支持或文件已损坏）");
      img.src = url;
      box.className = "cm-md-image";
      box.replaceChildren(img);
    };
    if (!resolver) {
      fail("不支持的地址");
      return box;
    }
    const cached = resolver.cached(this.src);
    if (cached) show(cached);
    else box.className = "cm-md-image cm-md-image-loading";
    resolver.resolve(this.src).then((r) => ("url" in r ? show(r.url) : fail(r.error)));
    return box;
  }

  // 单击图片照常放光标：光标进了这一行，显示原文
  ignoreEvent() {
    return false;
  }
}

/**
 * 在 pos 处（不给时在光标处，替换选中的文字）插入几张图片（imageMarkdown 的写法），每张一行；
 * 光标放在插入的后面。和打字一样算修改、可以撤销
 */
export function insertImages(view: EditorView, images: string[], pos?: number) {
  if (!images.length) return;
  const text = images.join("\n");
  const { state } = view;
  const at = pos === undefined ? state.selection.main : { from: Math.min(pos, state.doc.length), to: Math.min(pos, state.doc.length) };
  view.dispatch({
    changes: { from: at.from, to: at.to, insert: text },
    selection: EditorSelection.cursor(at.from + text.length),
    scrollIntoView: true,
    userEvent: pos === undefined ? "input.paste" : "input.drop",
  });
}

// ---- 拖进图片时标出放下的位置 ----

const setDropPos = StateEffect.define<number | null>();

/** 拖着图片停在正文的哪里，没在拖时是 null */
const dropPos = StateField.define<number | null>({
  create: () => null,
  update(pos, tr) {
    for (const e of tr.effects) if (e.is(setDropPos)) pos = e.value;
    return pos === null ? null : tr.changes.mapPos(pos);
  },
});

/** 放下的位置画一条竖线（同光标，画在文字上面的一层里，不挤动文字） */
const dropCaretLayer = layer({
  above: true,
  markers(view) {
    const pos = view.state.field(dropPos);
    return pos === null ? [] : RectangleMarker.forRange(view, "cm-drop-caret", EditorSelection.cursor(pos));
  },
  update: (u) => u.docChanged || u.geometryChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(setDropPos))),
});

export const dropCaret: Extension = [dropPos, dropCaretLayer];

/** 拖着图片停在 pos 处时画出竖线，null 时去掉 */
export function showDropCaret(view: EditorView, pos: number | null) {
  if (view.state.field(dropPos, false) !== pos) view.dispatch({ effects: setDropPos.of(pos) });
}
