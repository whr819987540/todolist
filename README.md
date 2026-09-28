# 待办清单

基于 Tauri 2 + React + Ant Design 的 Windows 桌面待办管理软件，按「工作区 → 项目 → 待办」三级组织。

## 功能

- **三级结构**：首页列出全部工作区；进入工作区后左侧是可折叠的树（工作区、项目两级都能折叠），右侧显示概览或待办内容
- **开屏**：打开软件时默认显示首页；在「设置 → 常规」里可改成「回到上次的位置」，恢复上次左侧选中的工作区和右侧打开的待办（下次启动时生效）
- **同时查看多个工作区**：点侧栏顶部的工作区名，勾选要显示的工作区（可多选、全选，或「仅显示」某一个），左侧会同时列出这些工作区的项目和待办；选中的工作区会记住，下次进入时恢复
- **键盘操作**：Alt+← / → 在左侧列表和右侧编辑区之间切换，Alt+↑ / ↓ 在左侧的工作区、项目、待办之间上下移动
- **待办条目**：左侧显示标题；没有标题时显示正文开头（按侧栏宽度自动截断）。每条带完成勾选框、创建时间、最新修改时间，悬停可看完整时间
- **正文编辑**：右侧编辑 Markdown；右键待办可「用默认程序打开」，交给系统关联的 Markdown 软件
  - **实时渲染**（默认，类似 Typora）：标题、加粗、斜体、删除线、行内代码、链接、引用、列表、任务框、分隔线、代码块显示成渲染后的样子，光标移到哪里，哪里显示原文；点任务框直接勾选
  - **源码模式**：显示全部 Markdown 标记，只做语法高亮
  - 按 Ctrl+/ 或点状态栏上的「实时渲染 / 源码模式」切换。两种模式都只改变显示，文件按原样保存，不会被重新排版；图片和表格暂时显示原文
  - 按住 Ctrl 单击链接用浏览器打开；回车自动续写列表，Tab 插入两个空格
  - 切换回某条待办时，光标和滚动回到上次编辑的地方；正文在外部被改过时按光标前后的文字找回位置，被大幅修改、找不到时回到开头
  - 代码块：输入 ```语言 后回车会自动补上结尾的 ```；在代码块里按 Ctrl+Enter，或在文末代码块的最后一行按 ↓，跳出代码块（缺结尾的 ``` 时自动补上）
- **保存**：在「设置 → 保存」里修改，立即生效
  - auto save（默认关闭）：开启后，编辑器失去焦点、窗口失去焦点（包括隐藏到托盘）时立即保存，有修改时还定时保存（默认 3 分钟，可设 1 秒到 60 分钟；从第一处未保存的修改开始计时，继续输入不会推迟）
  - 不论开没开，Ctrl+S 立即保存，切换待办、从托盘退出前总会保存，重命名、移动、删除、用默认程序打开前也总会先保存；关闭 auto save 时只在这些时候保存
  - 用输入法打字时，拼音还没上屏不算修改，不会被存进文件
- **托盘常驻**：点窗口的关闭按钮只会隐藏到系统托盘，程序继续运行；左键单击托盘图标恢复窗口，右键托盘图标选「退出」才真正退出（会先保存正在编辑的内容）
- **全局快捷键**：默认 Ctrl+Alt+T，在任何程序里按下都能呼出主窗口，主窗口在前台时按下则隐藏到托盘；点右上角的设置按钮可修改、恢复默认或不使用
- **待办快捷键**：选中某条待办时，Ctrl+Alt+D 标记完成 / 未完成，Ctrl+Alt+O 用默认程序打开；同样可在设置里修改
- **设置备份**：在「设置 → 备份与恢复」里填写 WebDAV 服务器（如坚果云），可把设置打包成 `TodoList-settings-年月日-时分秒.zip` 上传；恢复时可从服务器上的备份列表选择，也可选择本地的备份 zip。备份只含设置，不含待办数据
- **字号**：在「设置 → 外观」里分别调整左侧列表（工作区、项目与待办）和右侧待办编辑区的字号，立即生效；编辑时按住 Ctrl 滚动鼠标滚轮可快速调整编辑区字号，点状态栏上的字号恢复默认
- **编辑区背景色**：待办编辑区默认是护眼米色，可在「设置 → 外观」里换成白色，或选「自定义」输入 RGB 数值设置任意颜色；深色模式下编辑区始终是深色背景
- **全局搜索**：首页可跨全部工作区搜索工作区、项目和待办（标题与正文开头），点击结果直接打开
- **外部修改感知**：从其他编辑器切回时自动刷新；若两边同时改了同一条，会弹窗让你选择保留哪一份
- 侧栏搜索（Ctrl+F，在选中的工作区里查找）、隐藏已完成、三种排序、在项目间移动待办、删除进回收站、深色模式、侧栏宽度可拖动

## 数据存储

所有数据保存在用户目录下的 `%USERPROFILE%\TodoList`：

```text
TodoList\
  {工作区}\
    {项目}\
      .todos.json            标题、完成状态、创建/修改/完成时间
      20260926-153012.md     待办正文，一条待办一个文件
  .settings.json             应用设置（快捷键、字号、编辑区背景色、保存方式、开屏方式），设置备份的内容就是这个文件
  .webdav.json               WebDAV 服务器地址、用户名、远程目录（密码存在 Windows 凭据管理器）
```

- 标题单独存在 `.todos.json` 里，正文存在 `.md` 文件里
- 直接往项目文件夹里放 `.md` 文件，软件会自动识别为新待办（文件名作为标题）
- 正文按 UTF-8 保存；放进来的 GBK（ANSI）或带 BOM 的 UTF-16 文件也能正常显示，在软件里改过后转存为 UTF-8；认不出编码的文件只读显示，需要修改时用默认程序打开
- `.todos.json` 损坏时会备份为 `.todos.json.broken-时间戳` 并重建，正文不受影响
- 删除的工作区 / 项目 / 待办进入 Windows 回收站
- WebDAV 密码保存在 Windows 凭据管理器（普通凭据 `webdav.com.whr.todolist`），不写进任何文件，也不会进入备份包
- 访问 WebDAV 时使用 Windows 的代理设置（或环境变量 `HTTPS_PROXY`），代理例外和 `NO_PROXY` 里的地址直连

界面状态记在 WebView2 的 localStorage 里，不在数据目录：侧栏选中的工作区、折叠状态、宽度、排序，上次停在哪里（开屏「回到上次的位置」用），各待办的编辑位置（最多记 300 条，最久没动过的先忘掉）。

测试时可用环境变量 `TODOLIST_DATA_DIR` 指定其他数据目录。

## 快捷键

| 快捷键 | 作用 |
| --- | --- |
| Ctrl+N | 在当前项目新建待办（首页为新建工作区） |
| Ctrl+S | 立即保存（不受 auto save 开关影响） |
| Ctrl+F | 搜索（首页跨全部工作区，侧栏里搜索选中工作区的待办） |
| Esc | 在侧栏搜索框里：清空搜索，焦点回到左侧列表 |
| F5 | 刷新 |
| Ctrl+Alt+T | 全局快捷键：显示主窗口 / 隐藏到托盘（可在设置里修改） |
| Ctrl+Alt+D | 选中的待办标记完成 / 未完成（可在设置里修改） |
| Ctrl+Alt+O | 用默认程序打开选中的待办（可在设置里修改） |
| Ctrl+/ | 正文在实时渲染和源码模式之间切换 |
| Ctrl+单击链接 | 用浏览器打开正文里的链接 |
| Ctrl+Enter | 在代码块里：跳到代码块下面新的一行 |
| Ctrl+鼠标滚轮 | 在编辑区调整正文字号 |
| Alt+← / Alt+→ | 焦点移到左侧列表 / 右侧编辑区 |
| Alt+↑ / Alt+↓ | 在左侧列表里选中上一项 / 下一项 |
| ↑ ↓ ← → Enter | 左侧列表有焦点时：上下移动、展开 / 折叠（或回到上一级）、打开待办 |
| 右键 | 工作区 / 项目 / 待办的操作菜单 |

## 开发

需要 Node.js、Rust（MSVC 工具链）和 WebView2（Windows 11 自带）。

```bash
npm install
npm run tauri dev       # 开发调试
npm run build:debug     # 不打安装包的 debug 版 exe，见下文「本机测试用的构建」
npm run build:fast      # 不打安装包、不做 LTO 的优化版 exe，见下文
npm run tauri build     # 正式打包，安装包在 src-tauri/target/release/bundle/nsis/
npm run release         # 打包并安装到本机，见下文
npm run release:fast    # 同上，但用 release-fast profile 构建，快很多
cd src-tauri && cargo test   # 单元测试（存储、设置备份、WebDAV）
```

### 本机测试用的构建

`npm run tauri build` 慢在三处：release 配置开了 `lto = true`、`codegen-units = 1`（最耗时），前端要重新 `tsc && vite build`，最后还要打 NSIS 安装包。测试时按需要跳过：

| 命令 | 产物 | 适用 |
| --- | --- | --- |
| `npm run tauri dev` | 不产出独立 exe，连 Vite 开发服务器（:1420） | 日常改功能：前端改动热更新，不用重新编译；Rust 增量编译 |
| `npm run build:debug` | `src-tauri/target/debug/todo-list.exe` | 要一个能直接双击运行的 exe（前端已打包进去，不需要 Vite）；未优化，性能与正式版不同 |
| `npm run build:fast` | `src-tauri/target/release-fast/todo-list.exe` | 接近正式版的性能：用 `Cargo.toml` 里的 `release-fast` profile，优化级别同 release，但不做 LTO、16 个代码单元并行、增量编译 |
| `cd src-tauri && cargo test` | — | 只改了存储、备份、WebDAV 等 Rust 逻辑，不用启动界面 |
| `npm run release:fast` | 安装包，装到本机 | 频繁装到本机试用，见下文「安装到本机与升级」 |
| `npm run tauri build` / `npm run release` | 安装包 | 发布前完整跑一次 |

参考耗时（本机）：`build:fast` 首次约 2 分钟，之后只改 Rust 代码时几秒到十几秒；`build:debug` 约 30 秒。三种构建的目录（`debug`、`release-fast`、`release`）互不覆盖。

测试构建的注意事项：

- 这些 exe 和安装版是同一个应用（identifier `com.whr.todolist`），单实例插件会把新启动的那个交给已在运行的安装版（把它的窗口调到前台），新启动的自己悄悄退出。要么先从托盘「退出」安装版，要么构建时换一个测试用的 identifier，两者就能同时运行：

  ```powershell
  $env:TAURI_CONFIG='{"identifier":"com.whr.todolist.test"}'; npm run build:debug
  ```

  换了 identifier 的构建在 WebView2 缓存（localStorage 里的侧栏状态、编辑模式、上次的位置、编辑位置）和凭据管理器里的 WebDAV 密码（`webdav.com.whr.todolist.test`）上与安装版分开；全局快捷键仍然会和安装版冲突，测试版里可以改成别的（如 Ctrl+Alt+Y）
- 运行测试构建时用 `TODOLIST_DATA_DIR` 指向临时目录，不要动真实数据：

  ```powershell
  $env:TODOLIST_DATA_DIR="$env:TEMP\todolist-test"; .\src-tauri\target\release-fast\todo-list.exe
  ```

  设置文件也在这个目录里。注意删除操作仍然进系统回收站

代码结构：

- `src-tauri/src/store.rs`：文件存储、元数据对齐、名称校验
- `src-tauri/src/settings.rs`：应用设置（快捷键、字号、编辑区背景色、保存方式、开屏方式）的读写和字号、保存间隔的范围
- `src-tauri/src/backup.rs`：设置备份包的打包、解包和命名
- `src-tauri/src/webdav.rs`：WebDAV 连接配置、密码存取、客户端（含代理处理）
- `src-tauri/src/lib.rs`：Tauri 命令、打开外部程序和链接、系统托盘、全局快捷键、窗口图标
- `src/settings.tsx`：前端的设置状态；字号、编辑区背景色、保存方式改动立即生效，停顿片刻再存盘。字号写进 CSS 变量 `--fs-sidebar` / `--fs-editor`；背景色标在根元素的 `data-editor-bg` 上、自定义颜色写进 `--c-editor-custom`，`styles.css` 在浅色模式下据此给编辑区上色
- `src/hooks.ts`：窗口焦点监听；隐藏到托盘、退出前要写盘的内容登记在这里（隐藏到托盘时正在编辑的待办受 auto save 开关管，设置总是写盘；退出时都写盘）
- `src/App.tsx`：首页 / 工作区视图的切换；启动时按开屏设置决定显示首页还是回到上次的位置
- `src/workspaceState.ts`：记在 localStorage 里的界面状态（选中的工作区、各工作区的折叠状态、上次停在哪里、各待办的编辑位置），工作区 / 项目改名、删除，待办移动、删除时同步
- `src/editor/`：基于 CodeMirror 6 的正文编辑器
  - `setup.ts`：组装编辑器（快捷键、Markdown 解析、两种模式的切换）；输入法组合中的改动等上屏后再报告，免得拼音被存盘
  - `appearance.ts`：两种模式共用的外观（语法高亮、标题 / 代码块 / 引用的整行样式）
  - `livePreview.ts`：实时渲染，按语法树隐藏标记、替换成列表符号 / 任务框 / 分隔线，光标处显示原文
  - `links.ts`：解析链接地址、Ctrl+单击打开
  - `codeFences.ts`：代码块自动补结尾、Ctrl+Enter / ↓ 跳出代码块
  - `position.ts`：编辑位置（光标、光标在编辑区里的高度、光标前后的原文），打开待办和外部修改后重新加载时据此找回光标和滚动
- `src/components/`：首页（含搜索）、侧栏树、概览、编辑器（`TodoEditor` 管定时保存、auto save、冲突和记下编辑位置，`MarkdownEditor` 包装 CodeMirror）、设置（常规、快捷键、外观、保存、备份与恢复）
- `scripts/release.mjs`：改版本号、打包并安装到本机（`npm run release`，`release:fast` 传 `--fast`）

### 安装到本机与升级

```bash
npm run release              # 用当前版本号打包并安装
npm run release -- patch     # 先升版本号（0.1.0 → 0.1.1）再打包安装；也可以是 minor、major 或 0.2.0 这样的具体版本
npm run release:fast         # 同 release，但用 release-fast profile 构建（不做 LTO），参数用法一样
```

`release:fast` 编出来的程序性能接近正式版、体积稍大，适合频繁装到本机试用；安装包在 `src-tauri/target/release-fast/bundle/nsis/`。

`scripts/release.mjs` 依次：

1. 带了版本参数时，改 `package.json`、`package-lock.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 里的版本号（`Cargo.lock` 在构建时自动更新），这几个文件的改动要一起提交
2. `npm run tauri build`（`release:fast` 用 `npm run tauri -- build -- --profile release-fast`）
3. 如果程序正在运行，提示从托盘「退出」并等它退出后再继续。安装程序会直接结束所有名为 `todo-list.exe` 的进程，先正常退出才能保证正在编辑的内容已保存
4. 运行安装包（只显示进度条，不用点下一步），装完自动启动。已经装过时按升级处理：直接覆盖，不先卸载旧版，也不会重建你删掉的快捷方式

程序只装给当前用户，位置是 `%LOCALAPPDATA%\待办清单\`，不需要管理员权限，可以在「设置 → 应用」里卸载。待办数据在 `%USERPROFILE%\TodoList`，安装、升级、卸载都不会动它。

平时请从开始菜单或桌面快捷方式启动安装版，不要直接运行 `src-tauri\target\release\todo-list.exe`：两者是同一个应用，同时只能开一个；而且它运行时文件被占用，再次构建会报拒绝访问（os error 5）。
