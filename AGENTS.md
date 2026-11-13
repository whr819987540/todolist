用Tauri 2写一个todo管理软件

## 文档维护要求

- 加入新功能或修改现有功能时, 需要修改 docs/requirements.md 与 README.md
- 代码结构、数据目录布局、开发与测试命令写在 README.md；测试时用环境变量 `TODOLIST_DATA_DIR` 指向临时目录，不要动用户的真实数据（`%USERPROFILE%\TodoList`）

## 仓库提交要求

应该按照时间顺序与逻辑功能进行逐个提交, 禁止多个不相关的功能合并提交

## 软件要求

软件要做成什么样（工作区界面、待办内容、窗口与系统集成、搜索、快捷键、设置备份）写在 [docs/requirements.md](docs/requirements.md)。加功能、改功能、写测试用例之前，先读里面相关的那几节；测试用例按里面写的行为写，不照着实现抄期望值。

## 开发流程

在 Linux 上开发（Tauri 在这里编不了、跑不了）、到 Windows 上测试，流程写在 [docs/linux-windows-workflow.md](docs/linux-windows-workflow.md)：Linux 上能验证什么、测试壳（`src-tauri/target/linux-harness/`，不在仓库里）怎么建和用、怎么交到 Windows 上测，以及加功能时的清单。在 Linux 上改代码之前先读它；改了流程或测试壳时同步更新它。

## 每次改动：在 worktree 里开新分支，测试通过后合进 main

不在主检出（`~/projects/todolist`）里直接改，也不直接往 main 上提交：每个功能、每组修复（只改文档的也一样）都在一个新的 git worktree 里开新分支做，测试通过后合进 main。主检出只用来合并到 main、跑测试壳，几条线可以同时做、互不干扰。

1. 开分支：先 `git fetch`，从最新的 `origin/main` 开，worktree 放在主检出旁边；依赖链接到主检出的 `node_modules`，不用重新下载：
   ```bash
   git worktree add ../todolist-<名字> -b <feat|fix|docs>/<名字> origin/main
   cd ../todolist-<名字> && ln -s ../todolist/node_modules node_modules
   ```
2. 在 worktree 里改、提交，照「仓库提交要求」一个逻辑功能一个提交
3. 测试：本机跑 `npm run lint; npm test; npm run build`（改了 Rust 时加上测试壳的 `cargo test` 和 `check-windows.sh`），推到这个分支，等 CI 和 E2E 都通过（见下面的「测试在 GitHub 上跑」；只改了文档的两个都不跑，本机检查过就算通过）。没通过的修了再推；和这次改动无关的偶发失败先查清原因，用 `gh run rerun <编号> --failed` 重跑，要修的另开一个分支修
4. 合进 main：历史保持线性，不做合并提交。分支落后于 main 时先在 worktree 里变基到最新的 `origin/main`，重跑本机的检查；然后在主检出里让 main 快进到这个分支、推送，再看 main 上这个提交的 CI 和 E2E 也通过：
   ```bash
   git -C ../todolist-<名字> rebase origin/main   # main 动过时
   cd ~/projects/todolist && git switch main && git pull --ff-only && git merge --ff-only <分支> && git push origin main
   ```
5. 收尾：`git worktree remove ../todolist-<名字>`（`node_modules` 只是链接，删的不是主检出的依赖）

同时有几条互不相关的改动（如一个功能和中途发现的一个修复）时并排做、并排推：各开各的 worktree 和分支，写好一条就推一条，几条的 CI、E2E 同时跑，不要等前一条跑完才开下一条——每推一次都要等一轮 E2E，排着队等就是几轮加起来。都通过后依次变基、让 main 快进过去，最后只推送一次 main（main 上只跑一轮，跑的是最后合起来的样子）。要动同一块代码的不算互不相关，照下面「分支要短」先合一条、另一条在它上面做。

测试壳（`src-tauri/target/linux-harness/`，被 gitignore 了）只在主检出里，跑的是主检出的代码。要用它（界面截图、`e2e-harness.mjs`）看 worktree 里的改动时，在主检出里 `git switch --detach <分支>` 再跑，跑完 `git switch main`。合进 main 不等于发版：发版另有规矩，见「发布新版本」。

## 测试在 GitHub 上跑，不在本机跑

写好功能后，端到端测试在 GitHub Actions 上跑，在 Windows 上开发时也一样。本机的 `npm run e2e` 会弹出测试版的窗口、抢前台、模拟键盘鼠标，打断用户在这台电脑上正在做的事；用户用着电脑时结果也不可靠（窗口被最小化、拿不到前台）。

- 本机只跑不弹窗的检查：`npm run lint`、`npm test`、`npm run build`、`cd src-tauri && cargo test`
- 提交后推到功能分支（不是 main），CI 和 E2E 推送后自动跑（E2E 全部套件约 10 分钟；改动的文件全是根目录的 `.md`、`docs/`、`.vscode/`、`release.yml` 时两个都不跑，也就没有结果可等）：`gh run list --branch <分支>` 看进度，`gh run view <编号> --log` 看结果，没通过的修了再推；只重跑几个套件用 `gh workflow run e2e.yml --ref <分支> -f suites="tabs hidedone"`（同一分支推送触发的 E2E 还在跑时别派，会把它挤掉）。都通过后合进 main（见上面的「每次改动」）
- 在本机跑 `npm run e2e`、启动测试版程序截图或调试之前，先问用户（比如 GitHub 上重现不了、要看着窗口查的时候）

## 分支要短，尽早合进 main

功能分支开得越久，main 在这期间变了以后要返工的越多：曾经有 40 个提交按「只有一层子项目」「单个编辑区」写完、都通过了 CI，main 却已经改成了多级子项目和分屏，只好逐个提交按新架构重做一遍。

- 一个功能（或一组修复）在功能分支上 CI 和 E2E 都通过了就合进 main，不要攒好几个功能一起合
- 开始一个新功能、一批新改动之前先 `git fetch`，看 `git log --oneline HEAD..origin/main`：main 动了就先把分支变基到最新的 main 上，趁差得少时处理，再接着做；做得久的，中途也看几次
- 同时有几条线在开发（另一台机器、另一个会话、worktree 里的 subagent）时，先约好谁改哪些核心模块（存储层的项目路径、编辑区和会话、侧栏的树等）；要动同一块的，一条先合进 main，另一条再在它上面做，不要两边各写各的最后再合
- 变基时的冲突不只是文字：对面改了架构或规则时，每个提交要按新的规则重新落实它要做到的行为，每个提交单独拿出来都要能编译、测试通过

## 发布新版本（在 Linux 上）

发版会影响到用户：tag 推上去后，`release.yml` 在 GitHub 的 Windows 机器上打包，发布成这个 tag 的 Release 并标成 Latest，已经装了软件的人随后都会收到更新提示。所以要等用户说了发哪个版本再做；用户没说版本号时先问（一般是改最后一位）。README.md「发布到 GitHub」里的 `npm run release -- <版本>` 会顺带在本机打包、安装，Linux 上做不了，所以在 Linux 上只改版本号，打包交给 GitHub：

1. 发版前确认：要发的东西都已经合进 main，并且这个提交的 CI 和 E2E 都通过了（在功能分支上通过的同一个提交也算；只改了文档的提交不跑，看它前面最近一个跑过的提交）；`git fetch` 后 `main` 和 `origin/main` 一致、工作区干净；`git ls-remote --tags origin "v$v"` 查到的结果是空的，说明这个 tag 还没用过
2. 改版本号：要改 5 个文件、6 行，和以前「chore: 版本号改为 …」的提交一样（对照 `git show v0.1.5 --stat`）。Cargo.lock 在 Windows 上打包时会自动更新，Linux 上不打包，要手动改：
   ```bash
   v=0.1.6
   npm version $v --no-git-tag-version   # package.json、package-lock.json
   sed -i -E "0,/(\"version\":[[:space:]]*\")[^\"]*\"/s//\1$v\"/" src-tauri/tauri.conf.json
   sed -i -E "0,/^version = \"[^\"]*\"/s//version = \"$v\"/" src-tauri/Cargo.toml
   sed -i "/^name = \"todo-list\"$/{n;s/^version = \".*\"$/version = \"$v\"/}" src-tauri/Cargo.lock
   git diff --stat                       # 应该正好是这 5 个文件、6 行
   ```
3. 预览更新说明：release 页面的说明和软件里的更新提示，都取上一个 tag 以来 feat / fix / perf 提交的标题（规则见 `release.yml` 的「更新说明」那一步）。用下面的命令看一遍，把结果告诉用户：
   ```bash
   git log --no-merges --format='%s' "$(git describe --tags --abbrev=0)..HEAD" \
     | grep -E '^(feat|fix|perf)(\([^)]*\))?: ' | grep -vE '^[a-z]+\((e2e|ci|test|docs|build)\): '
   ```
4. 提交、打 tag、推送：tag 打在改版本号的那个提交上，用轻量 tag，名字是 `v` 加版本号。这里推送走 SSH，不受代理影响：
   ```bash
   git commit -am "chore: 版本号改为 $v"   # 提交说明照常带署名行
   git tag "v$v"
   git push origin main "v$v"
   ```
5. 盯着发布跑完（约 6～10 分钟）：用 `gh run list --workflow Release --limit 3` 找到这次的运行编号，写一个循环在后台每分钟查一次 `gh run view <编号> --json status,conclusion`，等它结束（Release 运行里有两个任务：打包发布的 build，和把版本号最大的标成 Latest 的 latest，要两个都结束）。`gh` 等联网命令要走用户 shell 里的代理，`gh` 用不了时轮询 Actions 页面（这两点见用户级的说明）
6. 跑完后核对：`gh release view "v$v"` 里要有 `TodoList_<版本>_x64-setup.exe` 和 `latest.json` 两个附件，说明和第 3 步预览的一样；`gh release list --limit 3` 里它标着 Latest。最后告诉用户：安装包在 Linux 上没有试装过，要到 Windows 上装一下，或者等已经装着的软件提示更新时验证
7. 失败时：
   - 「检查版本号」那一步失败：说明 tag 和 `tauri.conf.json` 里的版本号对不上，多半是忘了改版本号或者改漏了。这时 tag 已经推上去了，删掉重打会改动别人已经拉到的东西，所以先问用户再动
   - 打包、上传失败（网络、Actions 临时出故障）：tag 不用动，用 `gh workflow run release.yml -f tag="v$v"` 重新打包；这个 tag 已经有 release 时，只会替换安装包和 `latest.json`
