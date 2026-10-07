用Tauri 2写一个todo管理软件

## 文档维护要求

- 加入新功能或修改现有功能时, 需要修改 docs/requirements.md 与 README.md
- 代码结构、数据目录布局、开发与测试命令写在 README.md；测试时用环境变量 `TODOLIST_DATA_DIR` 指向临时目录，不要动用户的真实数据（`%USERPROFILE%\TodoList`）

## 仓库提交要求

应该按照时间顺序与逻辑功能进行逐个提交, 禁止多个不相关的功能合并提交

## 软件要求

软件要做成什么样（工作区界面、待办内容、窗口与系统集成、搜索、快捷键、设置备份）写在 [docs/requirements.md](docs/requirements.md)。加功能、改功能、写测试用例之前，先读里面相关的那几节；测试用例按里面写的行为写，不照着实现抄期望值。
