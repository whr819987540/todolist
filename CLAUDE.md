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
