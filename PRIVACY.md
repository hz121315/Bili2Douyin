# 隐私政策 / Privacy Policy

Bili2Douyin 是一个浏览器扩展，用于把 B 站直播间的实时弹幕叠加显示到抖音直播页面上。

Bili2Douyin is a browser extension that overlays Bilibili live danmaku on Douyin live streams.

## 收集的数据 / Data collection

不收集、不上传任何个人数据。没有账号系统、没有统计、没有遥测、没有广告。

No personal data is collected, stored on a server, or transmitted to third parties. There is no account system, analytics, telemetry, or advertising.

## 本地存储 / Local storage

扩展使用 `chrome.storage.local` 保存以下设置，仅保存在你的浏览器中：

- B 站直播间号、已保存的直播间列表和房间标题
- 弹幕延迟、字号、字体、颜色、密度、显示区域等显示设置
- 控制面板的位置和大小

卸载扩展或清除扩展数据会删除这些内容。

The extension stores the following settings locally via `chrome.storage.local`:

- Bilibili room IDs, the saved room list, and room titles
- Display preferences such as delay, font size, font family, color, density, and display area
- Control panel position and size

Removing the extension or clearing its data deletes these settings.

## 网络请求 / Network requests

- 请求 B 站公开接口（房间信息、弹幕服务器信息）时使用匿名身份，不携带你的登录 Cookie
- 弹幕通过 B 站的公开 WebSocket 接口接收
- 不向任何第三方服务器发送数据

- Bilibili public APIs (room info, danmaku server info) are requested anonymously, without your login cookies
- Danmaku is received through Bilibili's public WebSocket endpoint
- No data is sent to any third-party server

## 权限 / Permissions

- `storage`：保存上述本地设置 / store the local settings above
- `declarativeNetRequest`：给发往 B 站接口的扩展请求补充 Referer / add a Referer header required by Bilibili APIs
- `scripting`：扩展安装或更新后，给已打开的抖音直播页补注入最新脚本 / inject the latest content script into already-open pages after an update
- `offscreen`：在没有可用 iframe 的环境下承载弹幕长连接 / host the danmaku connection when an iframe is unavailable
- 主机权限：`https://*.bilibili.com/*`、`https://live.douyin.com/*` / host permissions for Bilibili APIs and Douyin live pages

扩展不申请 `cookies` 权限，不读取登录态；当前版本不包含发送弹幕功能。

The extension does not request the `cookies` permission and does not read your login state. The current version does not send danmaku.

## 联系 / Contact

GitHub Issues: https://github.com/hz121315/Bili2Douyin/issues
