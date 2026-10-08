# Linux 上开发、Windows 上测试

软件只支持 Windows，但可以在 Linux 上开发：2026-10 那一批功能（正文查找 / 替换、全文搜索、大纲、开机自启、快速记录、置顶、手动排序、批量操作、回收站）就是在 Linux 上写完、再到 Windows 上实测的。开发用的 Linux（Ubuntu 20.04，没有 sudo）没有 webkit2gtk-4.1，Tauri 程序在上面既编译不了也运行不了，所以分三段：

1. **Linux 上开发**：一个功能一个提交；能在 Linux 上验证的都验证掉（见「Linux 上能验证什么」），验证不了的写进端到端测试和手动清单
2. **推送，看 GitHub Actions 的结果**：GitHub 的 Windows 机器上跑和本机相同的检查（`.github/workflows/ci.yml`）和全部端到端测试（`.github/workflows/e2e.yml`），在 Linux 上用 `gh` 就能看结果、修了再推，不用去 Windows 上
3. **Windows 上手动试**：端到端测试测不到的（`docs/windows-test-checklist.md` 的「要手动试的」），以及要在本机重现、调试端到端测试时

在 Windows 上开发时也一样：写好功能推到功能分支，端到端测试在 GitHub 上跑，不在本机跑 `npm run e2e`。本机跑会弹出测试版的窗口、抢前台、模拟键盘鼠标，打断这台电脑上正在做的事（见 CLAUDE.md「测试在 GitHub 上跑，不在本机跑」）。

## Linux 上的环境

- Node.js（vitest 5 要 22.12 以上）；Rust 装在用户目录（`~/.cargo/bin`，用之前加进 `PATH`），再加上 Windows 目标：`rustup target add x86_64-pc-windows-msvc`
- 下载要走代理时：`npm ci --proxy $http_proxy --https-proxy $http_proxy`，rustup、cargo 设 `HTTPS_PROXY=$http_proxy`；`~/.npmrc` 指向的镜像缺包（404）时加 `--registry https://registry.npmjs.org`
- 不需要 webkit2gtk：Linux 上不编整个 Tauri 程序，Rust 只编下面的测试壳，对 Windows 目标只做 `cargo check`

## Linux 上能验证什么

| 检查 | 怎么跑 | 查得出 | 查不出 |
| --- | --- | --- | --- |
| 前端 | `npm run lint; npm test; npm run build` | 和 CI 相同：ESLint（含 `e2e/` 的脚本）、vitest、tsc、Vite 构建 | — |
| Rust 单元测试 | 测试壳里 `cargo test` | 存储、回收站、设置、备份、WebDAV 的逻辑 | `lib.rs` 里的 Tauri 命令、托盘、窗口、全局快捷键；`#[cfg(windows)]` 的测试（如开机自启的注册表读写） |
| Windows 目标的类型检查 | 测试壳里 `./check-windows.sh` | 整个程序（含 `lib.rs`、`cfg(windows)` 的代码和测试代码）在 Windows 上能不能编译 | 运行起来的行为 |
| 界面 | 模拟后端 + Vite + 无头 Chromium 截图 | 交互、样式、浅色 / 深色、窄窗口 | WebView2 和 Chromium 的差别、几个窗口之间的事件和状态、真实的 Rust 端 |
| 审查 | 另起一个审查代理（或请人）过一遍全部改动 | 只在 Windows 上出现、要读 tao 和插件源码才看得出的问题 | — |
| 端到端测试 | 推送后 GitHub Actions 在 Windows 机器上跑（`e2e.yml`），`gh run view <编号> --log` 看结果 | WebView2 里的界面、几个窗口之间、窗口的显示 / 隐藏 / 前台、全局快捷键、注册表、Windows 回收站、文件被占用 | 真实的按键和输入法、托盘菜单、多显示器、真的重启后的开机自启、安装包 |

## Linux 测试壳

放在 `src-tauri/target/linux-harness/`。`target/` 被 gitignore 了，测试壳不在仓库里，`cargo clean` 之后要按下面重建。

### Rust：不依赖 Tauri 的模块单独编成一个 crate

`Cargo.toml`：依赖照抄 `src-tauri/Cargo.toml`，去掉 tauri、它的插件和只在 Windows 上用的依赖，`keyring` 去掉 `windows-native`：

```toml
[package]
name = "todolist-harness"
version = "0.0.0"
edition = "2021"

[lib]
path = "src/lib.rs"

[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
chrono = "0.4"
trash = "5"
encoding_rs = "0.8"
reqwest = { version = "0.13", default-features = false, features = ["native-tls", "system-proxy"] }
zip = { version = "8", default-features = false, features = ["deflate-flate2-zlib-rs"] }
keyring = { version = "3" }
roxmltree = "0.21"
percent-encoding = "2"
```

`src/lib.rs`：用 `#[path]` 直接引用主程序的源文件，不复制：

```rust
#![allow(dead_code)]
#[path = "../../../src/store.rs"]
pub mod store;
#[path = "../../../src/settings.rs"]
pub mod settings;
#[path = "../../../src/backup.rs"]
pub mod backup;
#[path = "../../../src/autostart.rs"]
pub mod autostart;
#[path = "../../../src/webdav.rs"]
pub mod webdav;
```

```sh
cd src-tauri/target/linux-harness && PATH=$HOME/.cargo/bin:$PATH cargo test
```

新加的 Rust 模块不依赖 Tauri 时，也加进这里的 `lib.rs`；依赖 Tauri 的代码放在主程序的 `lib.rs` 里，在 Linux 上只能靠下面的类型检查。

### Windows 目标的类型检查

`check-windows.sh`：

```sh
#!/bin/sh
# 在 Linux 上对 Windows 目标做类型检查（含测试代码）
cd "$(dirname "$0")/../.." || exit 1
PATH="$HOME/.cargo/bin:$PATH" HTTPS_PROXY=$http_proxy https_proxy=$http_proxy \
  env "RC_x86_64-pc-windows-msvc=$(pwd)/target/linux-harness/fake-llvm-rc.sh" \
  cargo check --target x86_64-pc-windows-msvc --all-targets --message-format short "$@"
```

tauri-build 要编 Windows 的资源文件（图标、版本信息），系统的 llvm-rc 解析不了；`cargo check` 不链接，用不到编出来的资源，所以经环境变量 `RC_x86_64-pc-windows-msvc` 换成一个只生成空文件的假编译器 `fake-llvm-rc.sh`：

```sh
#!/bin/sh
# cargo check --target x86_64-pc-windows-msvc 用的假资源编译器：只生成空的输出文件（check 不链接）
case "$*" in
  *"/?"*) echo "OVERVIEW: LLVM Resource Converter"; echo "  /no-preprocess"; exit 0 ;;
esac
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "/fo" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && : > "$out"
exit 0
```

两个脚本都要 `chmod +x`。改了 Rust 代码，说「能编译」之前，测试壳的 `cargo test` 和 `check-windows.sh` 都要过。

### 界面：在浏览器里模拟 Rust 端

放在测试壳的 `ui/` 下：

- `mock.ts`：用 `@tauri-apps/api/mocks` 的 `mockIPC`、`mockWindows` 模拟全部 Tauri 命令，数据放在内存里（几个工作区、项目、带多级标题的长待办），刷新页面就恢复原样。URL 参数 `theme`（light / dark）定主题，`window`（main / quick）定当前是哪个窗口；`window.__mock` 露出 `db`、`handlers`、`calls`（调用过的命令）和 `emit`，场景脚本可以直接改数据、模拟 Rust 端发来的事件（如快速记录存好后的 `data-changed`、`open-todo`）。没模拟的命令在控制台打出「没有模拟的命令」，`plugin:` 开头的一律返回 `null`
- `harness.html`、`quick-harness.html`：先 `import "./mock.ts"`，再 `await import("/src/main.tsx")`（快速记录小窗是 `/src/quick.tsx`）
- 在仓库根目录起 Vite：`node node_modules/vite/bin/vite.js --port 1420 --strictPort`，打开 `http://localhost:1420/src-tauri/target/linux-harness/ui/harness.html?theme=dark`。`vite.config.ts` 不监视 `src-tauri/**`，改了 `mock.ts` 要重启 Vite（`restart-vite.sh`：按 `vite.pid` 结束上一个、起新的、等它能访问）
- `shot.mjs`：用 playwright-core（装在 `ui/` 里）和 Playwright 的 chrome-headless-shell（`~/.cache/ms-playwright/` 下）打开页面，跑一个场景脚本，截图存进 `shots/`，页面的报错、警告打在最后。场景脚本 `export default async (page, shot) => { … }`：

  ```sh
  cd src-tauri/target/linux-harness/ui
  PAGE=harness VIEWPORT=1280x800 THEME=dark node shot.mjs s-find.mjs
  PAGE=quick-harness VIEWPORT=600x248 node shot.mjs s-quick.mjs
  ```

加了 Tauri 命令要在 `mock.ts` 里加上模拟。看截图时浅色、深色都看，最小窗口宽度（860）下看会不会挤。

## 推送之后

GitHub Actions 的两个 workflow 都跑在 GitHub 的 Windows 机器上，在 Linux 上就能看结果（README.md「在 GitHub Actions 上跑」）：

```sh
gh run list --branch <分支> --limit 4         # CI 约 3 分钟，E2E 约 9 分钟
gh run view <编号> --log                      # E2E 里搜 ✗ 看没通过的检查
gh run download <编号> -n desktop             # E2E 没通过时当时整个桌面的截图
gh workflow run e2e.yml --ref <分支> -f suites="batch recycle"   # 修了以后只重跑这几个套件
```

写好的功能先推到功能分支（不是 main）上试，两个 workflow 照样跑；都通过后再决定要不要合进 main。

## 还要在 Windows 上做的

1. 照 `docs/windows-test-checklist.md` 的「要手动试的」逐项试；要自己开测试版试别的，按 README.md「本机测试用的构建」换 identifier 和产品名、用 `TODOLIST_DATA_DIR` 指向临时目录
2. 端到端测试在 GitHub 上没通过、又看不出原因时，在本机跑 `npm run e2e -- <套件>` 重现（README.md「端到端测试（Windows）」），能看着窗口调试。会弹出窗口、抢前台，跑之前和用这台电脑的人说好
3. 修掉的问题各自单独提交，提交说明写清在 Windows 上怎么实测的；能自动化的实测步骤补进 `e2e/suites/`

## Linux 上发现不了的问题

2026-10 这一批在 Linux 上验证过之后，到 Windows 上还发现了这些：

| 问题 | 原因 | 提交 |
| --- | --- | --- |
| 开机自启只在托盘里、一直没打开主窗口就退出，下次正常打开时不是最大化了 | 记住窗口状态的插件退出时按隐藏着的窗口记成了「没最大化」 | `d799263` |
| 在快速记录小窗里换了存到的项目，主窗口设置「常规」里还显示原来的 | 主窗口的设置只在启动时读一次；模拟后端只有一个窗口，看不出几个窗口之间的状态 | `e7f1558` |
| 快速记录小窗出现在 Alt+Tab 里 | `skip_taskbar` 只去掉任务栏按钮，tao 给没有所有者的窗口总加上 `WS_EX_APPWINDOW` | `86d7131` |
| 端到端测试里的拖动偶尔没开始 | 跑的时候有人在用别的程序，测试版失去焦点，页面按设计取消了拖动 | `d93d65b` |

端到端测试搬到 GitHub 的 Windows 机器上时，又碰到三处那台机器和本机不同的地方（WebView2 不认环境变量、`TEMP` 是短文件名、机器慢），见 README.md「在 GitHub Actions 上跑」。

另有两处是在 Linux 上靠审查、读 tao 和插件的源码提前发现的：恢复「最大化」会把隐藏着的主窗口显示出来（`47fd93b`）；快速记录小窗在事件处理里同步创建，Windows 上可能卡死（`823b13a`）。

窗口的显示 / 隐藏 / 最大化 / 前台、窗口样式、几个窗口之间的事件和状态、插件在启动和退出时做的事、注册表、全局快捷键、Windows 回收站、文件被占用、真实的按键和输入法，这些在 Linux 上只能读源码推断：写代码时就按 Windows 上的行为想清楚，到 Windows 上重点测。

## 加功能时的清单

Linux 上：

- [ ] 改 `docs/requirements.md` 和 `README.md`
- [ ] 新的 Tauri 命令在 `mock.ts` 里加上模拟；新的、不依赖 Tauri 的 Rust 模块加进测试壳的 `lib.rs`
- [ ] `npm run lint; npm test; npm run build`，测试壳的 `cargo test` 和 `check-windows.sh`
- [ ] 在模拟后端里把功能点一遍，浅色、深色都截图看
- [ ] 要在 Windows 上才能确认的，写进 `e2e/suites/`（Linux 上跑不了，`npm run lint` 会检查脚本；推送后在 E2E 里跑），端到端测试也测不到的写进 `docs/windows-test-checklist.md` 的「要手动试的」
- [ ] 一个功能一个提交，推到功能分支后看 CI 和 E2E 都通过，没通过的修了再推

Windows 上：

- [ ] 同 Linux 上：本机只跑 `npm run lint; npm test; npm run build` 和 `cargo test`，端到端测试推到功能分支后在 GitHub 上跑
- [ ] 手动清单里新加的那几项
- [ ] 修掉的问题各自提交

## 两边用到的工具

| | Linux | Windows |
| --- | --- | --- |
| 前端检查 | ESLint、vitest（happy-dom）、tsc、Vite | 同左 |
| Rust | 测试壳的 `cargo test`；`cargo check --target x86_64-pc-windows-msvc`（假的资源编译器） | `cargo test`（含 `cfg(windows)` 的测试） |
| 界面 | `@tauri-apps/api/mocks` 模拟后端 + playwright-core + chrome-headless-shell | 测试版程序，经 WebView2 的远程调试端口（CDP）操作页面（`e2e/lib/cdp.mjs`） |
| 系统 | — | PowerShell 调 Win32 API（`e2e/win/win.ps1`）：窗口、`WM_HOTKEY`、注册表、回收站、任务栏、文件占用 |
| 打包、安装 | — | NSIS 安装包，`npm run release` |
| CI | GitHub Actions（`windows-latest`）：`ci.yml`（lint、单元测试、构建、`cargo test`）和 `e2e.yml`（端到端测试），推送后自动跑，在 Linux 上用 `gh` 看结果 | |
