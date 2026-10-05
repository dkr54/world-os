# world os 发布与更新

当前版本 1.0.0，包含 world os 应用首页、楼层记忆、日历、角色目录、CG、Token 计数、默认状态模板、角色查询清洗、总开关与状态快照。仓库使用 world-os 名称与统一安装地址；1.0.0 已清理示例及历史。不要合并或推送清理前的旧历史。运行文件仍支持 floor-memory 与 world-os 两种安装目录。

仓库：**https://github.com/dkr54/world-os**
默认分支：**main**

## 已准备好的仓库结构

```text
world-os/
├── manifest.json
├── index.js
├── calendar-core.js
├── calendar.js
├── world-state.js
├── characters-core.js
├── character-cg.js
├── character-api.js
├── characters-engine.js
├── characters.js
├── snapshots.js
├── core.js
├── host-runtime.js
├── floating-window.js
├── embeddings.js
├── keyword-ai.js
├── keyword-json.js
├── regex-runner.js
├── regex-worker.js
├── settings.html
├── style.css
├── README.md
├── PUBLISHING.md
├── package.json
├── build-package.ps1
└── tests/
```

用户打开仓库首页时，直接能看到 `manifest.json`。宿主从该文件读取插件入口、样式、版本和生成拦截器。保持这个布局，用户就可以通过「安装扩展」粘贴仓库地址安装。

## 如果以后需要手动创建另一个仓库

1. 登录 GitHub，打开 [新建仓库](https://github.com/new)。
2. Owner 选自己的账号，填写 Repository name，Visibility 选 Public。
3. 本地已有这些文件时，创建空仓库即可，暂不预填 README、.gitignore 或 License。
4. 创建后选择上传已有文件，或在仓库页面选择 **Add file → Upload files**。
5. 选中扩展项目中的文件直接上传到仓库根目录；提交后确认根目录可见 `manifest.json` 和 `index.js`。
6. 把新仓库的首页地址粘贴到宿主「安装扩展」中。

创建与上传入口依据：[GitHub 创建仓库说明](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-new-repository)、[上传文件说明](https://docs.github.com/en/repositories/working-with-files/managing-files/adding-a-file-to-a-repository)。

## 以后更新这个仓库

当前工作目录已连接到上面的 GitHub 仓库。修改完成后：

1. 让 `manifest.json` 和 `package.json` 的版本号保持一致。
2. 执行 `npm run check`、`npm test`。修改交互或生成流程时，执行 `npm run test:browser` 和 `npm run test:tauri`。
3. 检查改动并提交、推送。

```powershell
git status
git diff
git add -u
git commit -m "Update World OS"
git push origin main
```

`git add -u` 会暂存已经跟踪的文件的修改；新文件请用 `git add 文件名` 单独添加。发布后，用户从扩展管理中更新并重新加载即可。

也可以在 GitHub 页面通过 **Add file → Upload files** 更新同路径文件。网页修改后，下次在本地工作前先运行 `git pull --ff-only`，让本地与远端同步。

## ZIP 安装包和 Release

1. 运行 `powershell -NoProfile -File ./build-package.ps1`。
2. 安装包内部继续使用 floor-memory 目录，供旧安装覆盖升级；不要在已有 world-os 目录的安装中重复导入另一份。脚本生成并校验两个包：`world-os-版本.zip` 和 `world-os-tauritavern-版本.zip`。
3. 在 GitHub 的 **Releases → Draft a new release** 中创建对应版本标签（如 `v1.0.0`），附上说明和两个 ZIP 后发布。
4. 使用 GitHub 链接安装的用户从 `main` 获取更新；Release ZIP 供离线／手动安装使用。

源码上传时保留 `.gitignore`：临时浏览器数据、参考源码、ZIP 和本地环境文件已排除。API Key 由用户在宿主设置中填写。
