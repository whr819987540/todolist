# 待办清单

基于 Tauri 2 + React + Ant Design 的 Windows 桌面待办管理软件，按「工作区 → 项目 → 待办」三级组织。

## 功能

- **三级结构**：首页列出全部工作区；进入工作区后左侧是可折叠的树（工作区、项目两级都能折叠），右侧显示概览或待办内容
- **进入工作区**：从首页点进某个工作区时，直接打开上次在这个工作区打开的待办；还没打开过待办时显示工作区概览
- **拖动移动**：按住左侧列表或项目概览里的待办，拖到左侧的另一个项目上松开，就移到那个项目里；同时显示了几个工作区时，也能拖到其他工作区的项目里。按住左侧列表或工作区概览里的项目，拖到左侧的另一个工作区上，整个项目连同待办移过去（那里已有同名项目时不能放）。拖到折叠起来的工作区上停一会儿会自动展开，拖到列表上下边缘会自动滚动，按 Esc 取消
- **开屏**：打开软件时默认显示首页；在「设置 → 常规」里可改成「回到上次的位置」，恢复上次左侧选中的工作区和右侧打开的待办（下次启动时生效）
- **同时查看多个工作区**：点侧栏顶部的工作区名，勾选要显示的工作区（可多选、全选，或「仅显示」某一个），左侧会同时列出这些工作区的项目和待办；选中的工作区会记住，下次进入时恢复
- **后退 / 前进**：用鼠标侧键的后退键、前进键在看过的地方之间来回（首页、工作区概览、项目概览、待办），和浏览器一样；只记这次运行期间的
- **键盘操作**：Alt+← / → 在左侧列表和右侧编辑区之间切换，Alt+↑ / ↓ 在左侧的工作区、项目、待办之间上下移动
- **待办条目**：左侧显示标题；没有标题时显示正文开头（按侧栏宽度自动截断）。每条带完成勾选框、创建时间、最新修改时间，悬停可看完整时间
- **正文编辑**：右侧编辑 Markdown；右键待办可「用默认程序打开」，交给系统关联的 Markdown 软件
  - **实时渲染**（默认，类似 Typora）：标题、加粗、斜体、删除线、下划线、行内代码、链接、引用、列表、任务框、分隔线、代码块显示成渲染后的样子，光标移到哪里，哪里显示原文；点任务框直接勾选
  - **源码模式**：显示全部 Markdown 标记，只做语法高亮
  - 按 Ctrl+/ 或点状态栏上的「实时渲染 / 源码模式」切换，每条待办分别记住；没切换过的待办用实时渲染（以前的版本里选了源码模式的，沿用源码模式）。两种模式都只改变显示，文件按原样保存，不会被重新排版；图片和表格暂时显示原文
  - 按住 Ctrl 单击链接用浏览器打开；回车自动续写列表；在列表里按 Tab / Shift+Tab 把这一项（连同子项）缩进成上一项的子项 / 提到上一级，有序列表自动重新编号；不在列表里时 Tab 插入两个空格
  - **编辑快捷键**默认和 Typora 一样：Ctrl+B 加粗、Ctrl+I 斜体、Ctrl+U 下划线、Ctrl+K 超链接、Ctrl+1～6 标题、Ctrl+Shift+[ / ] 有序 / 无序列表、Tab / Shift+Tab 缩进列表、Ctrl+D 选中当前词等，完整列表见下文「快捷键」；都可以在「设置 → 快捷键」里改成自己习惯的按键。再按一次取消；只增删选中处的 Markdown 标记，不会重排别处的写法
  - **查找 / 替换**：按 Ctrl+F 在正文里查找，输入时直接跳到最近的结果，显示第几个 / 共几个，Enter / Shift+Enter（或 F3 / Shift+F3）找下一个 / 上一个，可以区分大小写、全字匹配、用正则；Ctrl+H 展开替换，逐个或全部替换；Esc 关闭查找框
  - 切换回某条待办时，光标和滚动回到上次编辑的地方，离开时选中的文字仍然选中；正文在外部被改过时按光标前后的文字找回位置，被大幅修改、找不到时回到开头
  - 切到别的待办再切回来，仍能用 Ctrl+Z / Ctrl+Y 撤销、重做之前的修改（只在这次运行期间；正文在外部被改过时从头记起）
  - 代码块：输入 ```语言 后回车会自动补上结尾的 ```；在代码块里按 Ctrl+Enter，或在文末代码块的最后一行按 ↓，跳出代码块（缺结尾的 ``` 时自动补上）
- **保存**：在「设置 → 保存」里修改，立即生效
  - auto save（默认关闭）：开启后，编辑器失去焦点、窗口失去焦点（包括隐藏到托盘）时立即保存，有修改时还定时保存（默认 3 分钟，可设 1 秒到 60 分钟；从第一处未保存的修改开始计时，继续输入不会推迟）
  - 不论开没开，Ctrl+S 立即保存，切换待办、从托盘退出前总会保存，重命名、移动、删除、用默认程序打开前也总会先保存
  - 关闭 auto save 时，失去焦点、隐藏到托盘都不保存；但修改后一直没保存的，满 1 小时会自动保存一次（从第一处未保存的修改开始计时，藏在托盘里时也照样），免得在托盘里挂好几天的程序把改动一直留在内存里
  - 用输入法打字时，拼音还没上屏不算修改，不会被存进文件
- **托盘常驻**：点窗口的关闭按钮只会隐藏到系统托盘，程序继续运行；左键单击托盘图标恢复窗口，右键托盘图标选「退出」才真正退出（会先保存正在编辑的内容）
- **全局快捷键**：默认 Ctrl+Alt+T，在任何程序里按下都能呼出主窗口，主窗口在前台时按下则隐藏到托盘；点右上角的设置按钮可修改、恢复默认或不使用
- **待办快捷键**：选中某条待办时，Ctrl+Alt+D 标记完成 / 未完成，Ctrl+Alt+O 用默认程序打开；同样可在设置里修改
- **设置备份**：在「设置 → 备份与恢复」里把设置打包成 `TodoList-settings-年月日-时分秒.zip`，可以存到本地（默认存在数据目录里，也可以另选位置），也可以上传到 WebDAV 服务器（如坚果云）；恢复时可从服务器上的备份列表选择，也可选择本地的备份 zip（默认从数据目录里找，从 WebDAV 下载的也行）。备份只含设置（包括改过的快捷键），不含待办数据
- **字号**：在「设置 → 外观」里分别调整左侧列表（工作区、项目与待办）和右侧待办编辑区的字号，立即生效；编辑时按住 Ctrl 滚动鼠标滚轮可快速调整编辑区字号，点状态栏上的字号恢复默认
- **主题**：浅色、深色或跟随系统（默认），点首页或侧栏顶部的主题按钮、或在「设置 → 外观」里切换，窗口标题栏跟着变
- **编辑区背景色**：待办编辑区默认是护眼米色，可在「设置 → 外观」里换成白色，或选「自定义」输入 RGB 数值设置任意颜色；深色模式下编辑区始终是深色背景
- **全局搜索**：首页可跨全部工作区搜索（Ctrl+Shift+F）工作区、项目和待办（标题与正文开头），点击结果直接打开
- **外部修改感知**：从其他编辑器切回时自动刷新；若两边同时改了同一条，会弹窗让你选择：放弃自己的修改重新加载、用自己的内容覆盖，或「另存为新待办」——两份都保留，你的修改存成同一项目里标题带「（我的版本）」的新待办并打开它，原来这条换成外部改过的内容
- 侧栏搜索（Ctrl+Shift+F，在选中的工作区里查找）、隐藏已完成、三种排序（这两项每个工作区各自记住，选中多个工作区时作用于右侧正在显示的那个）、在项目间移动待办（右键「移动到」，同时显示了几个工作区时按工作区分组列出它们的项目，和拖动一样能移到其他工作区）、删除进回收站、侧栏宽度可拖动

## 数据存储

所有数据保存在用户目录下的 `%USERPROFILE%\TodoList`：

```text
TodoList\
  {工作区}\
    {项目}\
      .todos.json            标题、完成状态、创建/修改/完成时间
      20260926-153012.md     待办正文，一条待办一个文件
  .settings.json             应用设置（快捷键和改过的编辑快捷键、主题、字号、编辑区背景色、保存方式、开屏方式），设置备份的内容就是这个文件
  .webdav.json               WebDAV 服务器地址、用户名、远程目录（密码存在 Windows 凭据管理器）
  .state.json                界面状态：选中的工作区、上次的位置、各工作区上次打开的待办、各待办的编辑位置和编辑模式
  TodoList-settings-*.zip    设置备份到本地时默认存在这里（选择恢复文件时也从这里开始找）
```

- 标题单独存在 `.todos.json` 里，正文存在 `.md` 文件里
- 直接往项目文件夹里放 `.md` 文件，软件会自动识别为新待办（文件名作为标题）
- 正文按 UTF-8 保存；放进来的 GBK（ANSI）或带 BOM 的 UTF-16 文件也能正常显示，在软件里改过后转存为 UTF-8；认不出编码的文件只读显示，需要修改时用默认程序打开
- `.todos.json` 损坏时会备份为 `.todos.json.broken-时间戳` 并重建，正文不受影响
- 删除的工作区 / 项目 / 待办进入 Windows 回收站
- WebDAV 密码保存在 Windows 凭据管理器（普通凭据 `webdav.com.whr.todolist`），不写进任何文件，也不会进入备份包
- 访问 WebDAV 时使用 Windows 的代理设置（或环境变量 `HTTPS_PROXY`），代理例外和 `NO_PROXY` 里的地址直连

界面状态里和数据有关的记在数据目录的 `.state.json`，跟着数据走（换电脑、重装系统后还在；数据目录用网盘同步时一起同步，几台电脑同时开着时以最后写的为准）：侧栏选中的工作区，各工作区上次打开的待办，上次停在哪里（开屏「回到上次的位置」用），各待办的编辑位置和编辑模式（各最多记 300 条，最久没动过的先忘掉；编辑模式只记切换过、和默认不一样的）。改动后 5 秒内写盘，隐藏到托盘、退出前立即写；以前的版本记在 localStorage 里的，第一次启动时搬过来。

其他界面偏好只记在本机（WebView2 的 localStorage）：侧栏宽度，各工作区的折叠状态、排序和隐藏已完成（还没单独设置过的工作区沿用以前不分工作区时的设置）。各待办的撤销记录（最多 50 条）和后退 / 前进的记录（最多 100 处）只在这次运行期间记在内存里。

测试时可用环境变量 `TODOLIST_DATA_DIR` 指定其他数据目录。

## 快捷键

快捷键分两类：应用快捷键操作软件本身，其中三个可以在「设置 → 快捷键」里修改；编辑快捷键只在待办正文里使用，默认按键与 Typora 相同，除了几个固定按键，都可以在「设置 → 快捷键 → 编辑快捷键」里修改、恢复默认或不使用。所有快捷键之间不能重复，设置时会提示。

### 应用快捷键

| 快捷键 | 作用 |
| --- | --- |
| Ctrl+N | 在当前项目新建待办（首页为新建工作区） |
| Ctrl+S | 立即保存（不受 auto save 开关影响） |
| Ctrl+Shift+F | 搜索（首页跨全部工作区，侧栏里搜索选中工作区的待办） |
| Ctrl+F / Ctrl+H | 在正在编辑的待办正文里查找 / 替换（焦点在左侧列表时也行）；没有打开待办时 Ctrl+F 聚焦搜索框 |
| Esc | 在侧栏搜索框里：清空搜索，焦点回到左侧列表 |
| F5 / Ctrl+R | 刷新：从磁盘重新读取（不会像网页那样整页重新加载）；带别的修饰键的不算 |
| Ctrl+Alt+T | 全局快捷键：显示主窗口 / 隐藏到托盘（可在设置里修改） |
| Ctrl+Alt+D | 选中的待办标记完成 / 未完成（可在设置里修改） |
| Ctrl+Alt+O | 用默认程序打开选中的待办（可在设置里修改） |
| Ctrl+/ | 正文在实时渲染和源码模式之间切换 |
| Ctrl+鼠标滚轮 | 在编辑区调整正文字号 |
| 鼠标后退键 / 前进键 | 回到上一处 / 下一处看过的地方（首页、工作区概览、项目概览、待办） |
| Alt+← / Alt+→ | 焦点移到左侧列表 / 右侧编辑区 |
| Alt+↑ / Alt+↓ | 在左侧列表里选中上一项 / 下一项 |
| ↑ ↓ ← → Enter | 左侧列表有焦点时：上下移动、展开 / 折叠（或回到上一级）、打开待办 |
| 右键 | 工作区 / 项目 / 待办的操作菜单 |

### 编辑快捷键

下表是默认按键；标了「固定」的不能修改。

| 快捷键 | 作用 |
| --- | --- |
| Ctrl+B / Ctrl+I / Ctrl+U | 加粗 / 斜体 / 下划线（`<u>` 标签） |
| Alt+Shift+5 | 删除线 |
| Ctrl+Shift+` | 行内代码 |
| Ctrl+K | 超链接：选中文字时变成 `[文字]()`，光标放进括号里填地址；选中网址时变成 `[网址](网址)`；光标在链接里时去掉链接 |
| Ctrl+\ | 清除格式（加粗、斜体、删除线、行内代码、链接、`<u>` 等） |
| Ctrl+1～6 / Ctrl+0 | 标题 1～6 / 正文 |
| Ctrl+= / Ctrl+- | 提升 / 降低标题级别 |
| Ctrl+Shift+Q | 引用 |
| Ctrl+Shift+[ / Ctrl+Shift+] | 有序列表 / 无序列表 |
| Ctrl+Shift+K | 代码块（光标在代码块里时去掉 ``` 两行） |
| Tab（固定）/ Ctrl+] | 在列表里：把这一项连同子项缩进成上一项的子项；不在列表里：Tab 插入两个空格，Ctrl+] 缩进所在的行 |
| Shift+Tab（固定）/ Ctrl+[ | 在列表里：把这一项连同子项提到上一级；不在列表里：减少所在行的缩进 |
| Ctrl+D | 选中当前词（中文按词） |
| Ctrl+Shift+D | 删除当前词 |
| Ctrl+L | 选中当前行，再按往下多选一行 |
| Ctrl+Z / Ctrl+Y | 撤销 / 重做（固定） |
| Ctrl+Enter | 在代码块里：跳到代码块下面新的一行（固定） |
| Ctrl+单击链接 | 用浏览器打开正文里的链接（固定） |
| Ctrl+F / Ctrl+H | 查找 / 替换（固定） |
| F3 / Shift+F3 | 查找下一个 / 上一个（固定；在查找框里按 Enter / Shift+Enter 也行） |

格式类（加粗到清除格式）：选中的文字已经是这种格式时去掉，否则加上，跨多行时每行分别加；没选中文字时，光标在这种格式里就去掉它，否则插入一对标记、光标放在中间。段落类（标题到代码块）作用于选中的各行，引用、列表、代码块再按一次去掉。列表缩进后有序列表跟着重新编号，原本就不是连续编号的（如全写成 `1.`）不动。光标在代码块里时格式、段落类不起作用。

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
npm run lint            # ESLint 检查前端代码（含 React hooks 的规则），要零错误、零警告
npm test                # 前端单元测试（vitest：编辑快捷键、列表缩进、代码块、查找、编辑位置、后退 / 前进、快捷键检查等）
cd src-tauri && cargo test   # 单元测试（存储、设置备份、WebDAV）
```

前端单元测试放在被测模块旁边（`*.test.ts`），配置在 `vitest.config.ts`。默认在 Node 里跑：编辑命令直接构造 CodeMirror 的 `EditorState` 测（`src/editor/testState.ts` 提供用 `|`、`«»` 标出光标和选区的写法，和编辑器用同一份 Markdown 解析），不需要 DOM；要用 DOM、`localStorage` 的（`workspaceState.test.ts`，渲染 `SettingsProvider` 的 `settings.test.ts`）在文件开头指定 happy-dom。用例按 CLAUDE.md 里写的行为写，不照着实现抄期望值。

ESLint 的配置在 `eslint.config.js`：typescript-eslint 的推荐规则，加上 eslint-plugin-react-hooks 的全部推荐规则（`rules-of-hooks`、`exhaustive-deps` 和 React Compiler 的 `refs`、`immutability`、`purity`、`set-state-in-effect` 等）。代码里有不少刻意绕开 hook 依赖的写法（用 ref 拿最新的值、只在挂载时执行一次的 effect），这些地方就地加了 `eslint-disable-next-line` 并写明原因；不要为了消掉警告机械地补依赖，那会让只该执行一次的 effect 反复执行。

有 CI（`.github/workflows/ci.yml`）：每次 push、提 PR 时在 GitHub 的 Windows 机器（windows-latest，Node 24、stable Rust，缓存 npm 和 Rust 的依赖）上依次跑 `npm ci`、`npm run lint`、`npm test`、`npm run build`、`cd src-tauri && cargo test`；提交前在本机按同样的顺序跑一遍即可。`npm run build` 放在 `cargo test` 前面：`tauri::generate_context!` 在不是 dev 的构建（`tauri build`）里要把 `frontendDist`（`../dist`）嵌进程序，现在的 `cargo test` 是 dev 构建、用 `devUrl`，其实不读 `dist`，先构建好是为了以后换了构建方式也不出错。

测量扫描数据目录的耗时（`list_workspaces`、`load_workspace`，含预览缓存是空的和已缓存两种情况）：用一份测试数据（不要用真实数据），跑标了 `#[ignore]` 的 `bench_scan`。它只读不写（数据和 `.todos.json` 一致时扫描不会写盘）：

```powershell
cd src-tauri; $env:TODOLIST_BENCH_DIR="$env:TEMP\todolist-bench"; cargo test --profile release-fast --lib bench_scan -- --ignored --nocapture
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

  换了 identifier 的构建在 WebView2 缓存（localStorage 里的侧栏宽度、折叠状态、排序）和凭据管理器里的 WebDAV 密码（`webdav.com.whr.todolist.test`）上与安装版分开，上次的位置、编辑位置和编辑模式在数据目录的 `.state.json` 里，要靠下面的 `TODOLIST_DATA_DIR` 分开；全局快捷键仍然会和安装版冲突，测试版里可以改成别的（如 Ctrl+Alt+Y）
- 运行测试构建时用 `TODOLIST_DATA_DIR` 指向临时目录，不要动真实数据：

  ```powershell
  $env:TODOLIST_DATA_DIR="$env:TEMP\todolist-test"; .\src-tauri\target\release-fast\todo-list.exe
  ```

  设置文件也在这个目录里。注意删除操作仍然进系统回收站

代码结构：

- `src-tauri/src/store.rs`：文件存储、元数据对齐、名称校验，界面状态文件 `.state.json` 的读写（内容由前端决定）；左侧显示的正文开头（预览）缓存在内存里，按 .md 的修改时间和大小判断是否失效，文件没变就不重新读（窗口每次获得焦点都要重新加载选中的工作区，待办多时读几千个文件开头很慢），缓存是空的时（刚启动）分给几个线程一起读；缓存不写进任何文件，免得数据目录用网盘同步时多出冲突
- `src-tauri/src/settings.rs`：应用设置（快捷键、改过的编辑快捷键、主题、字号、编辑区背景色、保存方式、开屏方式）的读写和字号、保存间隔的范围
- `src-tauri/src/backup.rs`：设置备份包的打包、解包、命名和读本地的备份文件
- `src-tauri/src/webdav.rs`：WebDAV 连接配置、密码存取、客户端（含代理处理）
- `src-tauri/src/lib.rs`：Tauri 命令、打开外部程序和链接、系统托盘、全局快捷键、窗口图标、本地备份、恢复设置时的文件对话框（tauri-plugin-dialog，只在 Rust 端调用，前端没有对话框的权限；都从数据目录打开）
- `src/settings.tsx`：前端的设置状态；主题、字号、编辑区背景色、保存方式改动立即生效，停顿片刻再存盘。主题交给 `main.tsx` 的 `Root` 应用（它在 antd 的主题配置外面）；字号写进 CSS 变量 `--fs-sidebar` / `--fs-editor`；背景色标在根元素的 `data-editor-bg` 上、自定义颜色写进 `--c-editor-custom`，`styles.css` 在浅色模式下据此给编辑区上色
- `src/theme.tsx`：主题按钮、antd 主题变量同步成 CSS 变量、窗口标题栏跟着切换；本机（localStorage）缓存一份设置里的主题，启动时设置读出来之前先用，免得界面闪一下（以前主题只记在这里，第一次读到设置时搬进设置文件）
- `src/hooks.ts`：窗口焦点监听；隐藏到托盘、退出前要写盘的内容登记在这里（隐藏到托盘时正在编辑的待办受 auto save 开关管，设置总是写盘；退出时都写盘）
- `src/App.tsx`：首页 / 工作区视图的切换；启动时先读出 `.state.json`，按开屏设置决定显示首页还是回到上次的位置；从首页进入工作区时打开它上次打开的待办；鼠标侧键后退、前进
- `src/navHistory.ts`：后退、前进的记录（首页和工作区里右侧显示过的内容），只在内存里；用键盘在左侧列表里连着移动时只记停下的那一处
- `src/workspaceState.ts`：界面状态，记在 `.state.json` 里的（选中的工作区、各工作区上次打开的待办、上次停在哪里、各待办的编辑位置和编辑模式；启动时读一次，改动后稍后写盘，隐藏到托盘、退出前立即写）、记在 localStorage 里的（各工作区的折叠状态、排序和隐藏已完成）和记在内存里的各待办撤销记录，工作区 / 项目改名、删除，待办移动、删除时同步（后退、前进的记录也在这时同步）
- `src/editShortcuts.ts`：编辑快捷键的列表（命令、名称、默认按键、固定按键、分组），设置里改过的盖在默认值上得到现在用的按键；编辑器按它绑定按键，设置界面按它展示和检查重复
- `src/editor/`：基于 CodeMirror 6 的正文编辑器
  - `setup.ts`：组装编辑器（快捷键、Markdown 解析、两种模式的切换）；输入法组合中的改动等上屏后再报告，免得拼音被存盘。Markdown 解析的配置（`markdownSupport`）单元测试也用
  - `editBindings.ts`：把编辑快捷键绑到 `formatting.ts`、`lists.ts` 的命令上，每次按键时按现在的设置查表（改了立即生效），先于 CodeMirror 自带的按键、后于应用快捷键
  - `formatting.ts`：编辑快捷键的命令（行内格式、标题、引用、列表、代码块、选词 / 选行），按语法树和行首的块标记增删原文里的标记
  - `lists.ts`：Tab / Shift+Tab 缩进列表项（按语法树找出列表项和它的上一项、上一级，移动整棵子树后给有序列表重新编号），不在列表里时的 Tab
  - `appearance.ts`：两种模式共用的外观（语法高亮、标题 / 代码块 / 引用的整行样式）
  - `livePreview.ts`：实时渲染，按语法树隐藏标记（含 `<u>` 标签）、替换成列表符号 / 任务框 / 分隔线，光标处显示原文
  - `links.ts`：解析链接地址、Ctrl+单击打开
  - `codeFences.ts`：代码块自动补结尾、Ctrl+Enter / ↓ 跳出代码块
  - `find.ts`：正文里的查找 / 替换。搜索状态、匹配高亮和查找替换命令用 `@codemirror/search`，查找框自己实现（中文、第几个 / 共几个、输入时跳到最近的结果）；Ctrl+F、Ctrl+H 由 `WorkspaceView` 经 `TodoEditor` 转过来，焦点不在正文里时也能打开
  - `position.ts`：编辑位置（光标和选区另一端、光标在编辑区里的高度、它们前后的原文），打开待办和外部修改后重新加载时据此找回光标（选区）和滚动
- `src/components/`：首页（含搜索）、工作区视图、侧栏树、概览、拖动移动（`DragMove.tsx`，用鼠标事件自己实现，没用 HTML5 拖放；放下的位置按侧栏节点上的 `data-drop-ws` / `data-drop-project` 找）、编辑器（`TodoEditor` 管定时保存（auto save 关闭时 1 小时兜底）、auto save、冲突（含「另存为新待办」：Rust 端 `create_todo` 可以带正文一次建好）和记下编辑位置，打字时不重新渲染，状态栏的字数、行数停顿片刻再算（`utils.ts` 的 `textStats`），`MarkdownEditor` 包装 CodeMirror）、设置
  - 设置：`SettingsButton.tsx` 是设置按钮和对话框，五个页签各在 `settings/` 下一个文件——`GeneralSettings`（常规）、`ShortcutSettings`（快捷键：应用快捷键和编辑快捷键，录制时检查冲突）、`AppearanceSettings`（外观：主题、编辑区背景色、字号）、`SaveSettings`（保存）、`BackupSettings`（备份与恢复）；`ShortcutRow` 是录制一个快捷键的那一行
  - 工作区视图：`WorkspaceView.tsx` 管选中的工作区、右侧显示的内容、加载和刷新、快捷键、侧栏宽度；新建、重命名、删除、移动、打开等操作在 `workspaceActions.ts` 的 `useWorkspaceActions`（`actionsFor(ws)` 每次渲染新建、用这次渲染的状态；`stableActions(ws)` 是传给侧栏行的不变对象，调用时转给最新的 `actionsFor`）
  - 侧栏：`Sidebar.tsx` 管树的焦点和键盘操作（↑↓←→、Enter、Alt+方向键），其余在 `sidebar/` 下——`SidebarToolbar`（顶部：返回首页、选中工作区的 `WorkspacePicker`、主题、设置、搜索、新建、排序、隐藏已完成、全部折叠 / 展开）、`TreeRows`（工作区、项目、待办的行）、`RowPopups`（待办行共用的悬停提示 `TodoTip` 和右键菜单）、`tree.ts`（右侧显示的内容 `Selection`、行上 `data-sel` 的键、折叠状态、计数）
  - 待办多（几千条）时侧栏也要快：`WorkspaceView` 刷新（窗口获得焦点、F5、保存后）时内容没变的工作区、项目、待办沿用原来的对象，什么都没变就不重新渲染；侧栏的工作区、项目、待办行（`sidebar/TreeRows.tsx`）都用 `memo`，只有自己的内容、选中、折叠、拖动状态变了才重新渲染（传给行的操作、拖动函数都是不变的对象，右键「移动到」列出的项目也是右键时才经不变的函数去算，别的待办、项目变了时行不跟着重新渲染；「x 分钟前」只有显示会变的行跟着每 30 秒刷新），待办行的悬停提示和右键菜单不每行各挂一个 antd 组件，整个侧栏共用一个（`sidebar/RowPopups.tsx`）；不在可见区域的项目里的待办不排版、不绘制（`.todo-group` 的 `content-visibility: auto`，加在项目这一级，加在每一行上反而让每一帧都变慢）
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
