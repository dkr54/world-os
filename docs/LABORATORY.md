# world os 实验室功能包开发说明

实验室从 world os 1.1.0 开始提供。它承载用户编写的独立页面，不需要修改扩展源码或重新安装插件。

## 保存范围与生命周期

- 包文件、版本和已安装列表全局共享。使用稳定且唯一的包 ID，例如 demo.notes。
- 启用开关和设置按角色卡保存，同一卡的全部聊天共享；群聊按群 ID 保存。
- 聊天状态按聊天保存，只有当前包可以通过接口读写自己的命名空间。
- 新导入的包默认关闭。开启后，首页的“本卡功能包”出现入口。
- 页面只有打开时执行。返回首页、打开其他功能、关闭窗口、切换聊天或角色卡、关闭总开关，都会销毁页面并停止其计时器与监听；再次进入会重新初始化。需要保留的内容应及时保存。
- 更新相同 ID 会替换所有角色卡使用的代码，保留设置和状态。新增权限时，所有卡的该包会关闭，需要重新启用；降级版本也需要确认更新，不会自动迁移旧数据。
- 全局卸载移除代码和首页入口，并关闭所有角色卡的开关；保留配置和聊天状态。同 ID 重新导入后可继续使用这些数据，但需要重新启用。
- 卡片标识沿用插件已有方式：角色头像文件名；更换头像文件名相当于另一张卡。不要使用聊天标题作为卡片标识。

## 两种导入格式

### 单文件 JSON

文件名建议为 demo.notes.worldos.json。所有资源都打包到 files 中，界面导出包和下载示例也使用这个格式。可直接导入仓库中的 examples/notes.worldos.json。

~~~json
{
  "format": "world-os-package",
  "schema": 1,
  "id": "demo.hello",
  "name": "问候页",
  "version": "1.0.0",
  "description": "一个最小功能页",
  "author": "示例作者",
  "icon": "fa-note-sticky",
  "permissions": [],
  "entry": "index.html",
  "defaultSettings": {"title": "你好"},
  "files": {
    "index.html": "<main><h1 id=\"title\"></h1></main><script src=\"app.js\"></script>",
    "app.js": "(async()=>{await worldOS.ready;const s=await worldOS.getSettings();document.getElementById('title').textContent=s.title;})().catch(e=>worldOS.notify(e.message));"
  }
}
~~~

### ZIP

把以下文件放在 ZIP 根目录，或放在唯一的外层目录中：

~~~text
manifest.json
index.html
app.js
style.css
images/picture.png
~~~

manifest.json 使用上面相同的字段，省略 files。HTML 通过普通 script src 和 link rel="stylesheet" 引用包内资源；CSS url 和 img src 可引用包内 PNG/JPEG/WebP/GIF。JSON 格式里的图片内容需要写成 data:image/...;base64,... 字符串。

ZIP 支持 Store 和 Deflate，校验 CRC、解压大小、重复路径与目录越界。不支持加密 ZIP、ZIP64、分卷、远程资源、SVG、字体文件或可执行程序。旧 WebView 若不支持 Deflate 解压，可升级 WebView，或改用 JSON 包。

所有文件名使用英文字母、数字、下划线、点、斜杠和短横线。文件名区分大小写，包内存储路径不能包含 ..。允许引用同一包内的相对路径。单包最多 100 个资源文件、8 MB；单个文件文本最多 190 万字符；所有已安装包合计最多 16 MB、32 个包。包 ID 不能与内置功能重名。

## 页面脚本

脚本使用普通 JavaScript。不要在脚本中使用 ES module、相对 import、require 或 Node.js 文件接口。React/Vue 等项目需要在发布前构建为普通脚本，并将依赖和资源一并打包。不要依赖远程 CDN。

页面已提供基础移动端样式与 worldOS 对象。需要宿主数据时先等待 worldOS.ready。SDK 方法返回 Promise，必须处理失败；切换聊天或关闭页面后，旧请求不会写入新聊天。

~~~javascript
(async () => {
  await worldOS.ready;
  const context = await worldOS.getContext();
  const settings = await worldOS.getSettings();
  const state = await worldOS.getState();

  document.getElementById("title").textContent = settings.title || context.characterName;

  document.getElementById("save").onclick = async () => {
    try {
      await worldOS.setState({note: document.getElementById("note").value});
      await worldOS.notify("笔记已保存");
    } catch (error) {
      document.getElementById("status").textContent = error.message;
    }
  };
})().catch(error => worldOS.notify(error.message));
~~~

## SDK

| 接口 | 行为 |
| --- | --- |
| worldOS.ready | 页面与宿主连接完成 |
| worldOS.getContext() | 返回 packageId、version、owner、chatId、characterName；不包含宿主设置或密钥 |
| worldOS.getSettings() | 读取当前卡的包配置；未保存时返回 defaultSettings 的独立副本 |
| worldOS.setSettings(object) | 整体替换当前卡的包配置，同一卡其他聊天共用 |
| worldOS.getState() | 读取当前聊天的包状态，缺失时为 {} |
| worldOS.setState(object) | 整体替换当前聊天的包状态并等待保存；尚未打开聊天时拒绝 |
| worldOS.getChat(limit = 20) | 需 chat.read；读取最近 1～100 条实际用户/AI 消息，不包含系统或工具消息；返回 role、name、text，总正文最多 20 万字符 |
| worldOS.setInput(text, mode = "prepend") | 需 input.write；向当前输入框前置或追加文本，不清空原输入，也不发送；mode 为 prepend/append，最多 2 万字符 |
| worldOS.getFile(path) | 读取打包的文本或图片 data URL，找不到时为 null；路径相对包根 |
| worldOS.notify(text) | 显示状态文字，最多 1000 字 |
| worldOS.on("chat.changed", callback) | 需 chat.read 才会收到事件；返回取消订阅函数。事件表示聊天发生变化，可能重复，不等于一次真实生成完成 |

设置和状态必须是普通 JSON 对象，每包每份最多 256 KB。不支持函数、循环对象、危险属性名或无限深层嵌套。getSettings/getState 返回副本；修改返回对象不会自动保存。setSettings/setState 为整体替换，想保留其他字段时先读出再合并。

getChat 返回聊天原文，功能包应按自己的用途清洗；不会自动套用角色目录或楼层记忆的正则。不要在收到每条 chat.changed 事件时自动执行昂贵工作；可以先合并重复事件，再读取最新聊天。

## 隔离与权限

功能页运行在仅允许脚本的 sandbox iframe 中，不授予 allow-same-origin。它不能直接读取宿主 DOM、localStorage、Cookie、角色目录设置或 API 密钥。宿主按来源窗口、随机会话标记、角色卡、聊天、包版本和权限逐次校验消息；所有写入只进入该包自己的配置/状态。

当前只支持 chat.read 和 input.write 两项附加权限，导入预览会显示它们。没有声明的接口会拒绝。自身配置/状态与基础上下文不需要额外权限。

页面的内容策略限制直接网络请求、远程图片/脚本、子框架和表单提交。它不是第三方网站浏览器，也没有后台常驻、提示词注入或模型请求接口。后续模型调用需通过单独设计的受控宿主接口接入，不应通过放开整个网络或暴露宿主密钥实现。只导入可信包；执行脚本仍可能占用 CPU、造成页面卡顿，沙盒不等于资源配额隔离。

## 快照与导出

world os 快照包含全局已安装包、所有角色卡的包配置及当前聊天的包状态。旧版无实验室字段的快照仍可导入，不会擦除现有实验室数据。恢复完成后不自动运行包脚本，用户需点击入口打开。

功能包配置和状态会随快照明文导出；不要把 API 密钥存入其中。单独“导出包”只导出包代码、资源和默认配置，不附带用户修改后的卡片配置或聊天笔记。

快照原有 32 MB 导入/导出限制保持不变。包内大量图片也会占用快照容量。Android 的包导出与示例下载使用现有 TauriTavern 原生文件保存接口。

## 测试建议

至少检查：同一卡切换聊天保留配置、不同卡不开启且不继承配置、状态按聊天隔离、关闭包停止运行、更新后数据可读、手机窄屏与键盘下可操作、快照导出恢复。异步处理应保存动作 ID 和数据版本，以免重复点击或迟到结果覆盖新状态。发布示例只使用虚构占位角色，不复制真实聊天中的人名和私人内容。
