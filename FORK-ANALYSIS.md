# Fork 分析：dsh-mobile 0.6.10 卡顿与 UI 样式问题

分析对象：`~/.dsh/profiles/web/node_modules/dsh-mobile`（已安装版本 0.6.10）。
源码定位基于上游仓库 `saya-ch/dsh-mobile`（Apache-2.0），本地检出为 `~/projects/dsh-mobile`（HEAD = 0.6.11）。
`~/projects/dsh-mobile-fork` 保存了 0.6.10 发布包（仅 `lib/` 编译产物）作为对照基线。

## 一、工作原理

三层结构，DSH 源码与电脑端页面（3080 端口）完全不动。

```
手机 (Android App / 浏览器)
   │  局域网 HTTPS :3443
   ▼
DSH Mobile Gateway（Host face，跑在 dsh web 进程内的一个 worker thread）
   │  ① 设备配对鉴权（Cookie → sha256 → Map 查表）
   │  ② HTML 重写：注入 compat.js / boot batch / 模块选择
   │  ③ HTTP + WebSocket 双向代理
   ▼
原生 DSH Web :3080  ──►  同一份 session / workspace / 事件流
```

- **Host face**（`src/index.ts`，编译为 `lib/index.mjs`）：网卡发现、设备配对与撤销、TLS 终结、回环代理、扩展注册表。
- **Client face**（`src/client.ts` + `src/native-mobile.ts` + `src/mobile-layout.ts`）：在已认证的移动页面里换一套专用根布局（`.dshm-shell`），并挂载触摸/键盘适配。
- **Android App**：Kotlin WebView 薄壳，通过 `androidx.webkit` WebMessage 桥接，不含第二份网页。

数据实时性依赖 `/api/remote.mux` 这条 WebSocket；静态资源与启动 HTML 由网关改写后下发。

## 二、卡顿根因（按影响排序）

### P0 · 自持的 60fps MutationObserver → rAF 死循环

`src/native-mobile.ts:1793-1795` 注册了一个观察 `document.body` 整棵子树、
监听 `class` / `aria-selected` 的 MutationObserver，回调直接 `requestAnimationFrame(sync)`：

```ts
const schedule = (): void => { if (scheduled === 0) scheduled = requestAnimationFrame(sync) }
const observer = new MutationObserver(schedule)
observer.observe(document.body, {
  childList: true, subtree: true, attributes: true,
  attributeFilter: ['class', 'style', 'disabled', 'readonly', 'aria-busy', 'aria-selected', 'data-dsh-mobile-session'],
})
```

而 `sync()` → `placeCameraAction()`（`src/native-mobile.ts:1754`）里有**未做幂等判断**的属性写入：

```ts
cameraButton.className = 'dsh-mobile-media-action'   // :1357
cameraButton.className = nativeItem.className       // :1367
cameraButton.setAttribute('aria-selected', 'false') // :1376
```

按 DOM 规范，`className` 赋值器和 `setAttribute()` 都会入队一条 mutation record，
**无论新值是否与旧值相同**。一旦 `cameraButton` 挂载（`:1385` 附近的 `lastItem.after(...)`，
这一处有正确的守卫，所以 DOM 结构不会自我复制），闭环成立：

`sync()` → 写 `class`/`aria-selected` → observer 微任务 → `schedule()` → `rAF(sync)` → 循环。

结果：**只要打开一个带输入框的会话，页面就永远以每帧一次全量扫描的节奏空转**，
CPU 持续占用、滚动与输入掉帧。这与"手机上明显卡顿"的主观描述完全吻合。

对照参考：紧邻的 `setCameraActionDisabled`（`:1388-1391`）恰恰做了
`if (cameraButton.disabled !== disabled)` 判断——同一文件里两种写法并存。

**修法**：把 `className` / `setAttribute` 改成幂等写入；更好的做法是把相机按钮的定位
从 `sync()` 里挪出，按 `composerCard` 挂载一次。

### P0 · sync() 每帧把整棵会话子树物化 5 次

`src/native-mobile.ts:280-282`：

```ts
function firstByClassSuffix(root: ParentNode, suffix: string): HTMLElement | undefined {
  return Array.from(root.querySelectorAll<HTMLElement>('[class]')).find(element => classToken(element, suffix))
}
```

`Array.from` 让惰性 NodeList 失去短路能力——即使 `.find()` 第一个就命中，
整份结果集也会先被分配出来。该函数在本文件有 **17 处调用点**，其中会话滚动容器、
中心列、侧栏根都是整棵会话树。长会话下每次 `sync()` 会分配并遍历数份万级元素数组，
再乘以上面那个 60 次/秒的循环。

**修法**：直接遍历 NodeList 短路返回；或改用 `[class*="_viewArea"]` 这类属性选择器，
让引擎走 class 选择器索引；再给解析结果加一层按 root 的 memo。

### P1 · 两个挂在 documentElement 上的观察器 + characterData

- `observeTaskActivity(document.documentElement, …)`（`src/client.ts`，编译产物 `lib/client.js:3154`）
  带 `characterData: true, subtree: true`——**流式输出的每一个 token 都会触发**。
  回调里每次跑 2 次全文档 `querySelector`（`hasPendingInputQuestion` 与
  `pendingInputQuestionKey` 查的是同一个选择器）+ `document.title.normalize('NFC')` + 正则。
- voice-session 的观察器同样是 `document.documentElement` 全文档 + 每个增删节点跑 `containsVoiceRow`。

**修法**：观察目标收窄到会话滚动容器；去掉 `characterData`；两次 `querySelector` 合并成一次。

### P1 · compat.js 在关键路径上且没有任何 Cache-Control

48 KB 的 core-js 以**同步解析阻塞**的 `<script>` 注入在所有 DSH 脚本之前，
但 `/mobile-access/compat.js` 的响应只带 ETag + Last-Modified，没有 `Cache-Control`，
冷启动时往往被重新下载并重新解析。

### P1 · `/api/**` 的 JSON 从不压缩

网关的压缩门禁只放行 `/plugins/` 和 `/assets/` 前缀，会话列表、会话状态、设置等
所有 `/api/` JSON 响应都是未压缩原样下发。实测有代表性的会话状态负载约 2.8× 的压缩空间。

### P2 · index.html 每次都重取、重改写、无 ETag、不压缩

网关没有 HTML 缓存：每次请求都向上游取 index、跑一次完整的改写
（内部 `parseMobileBootPlan` 还会重复跑第二遍），然后**删掉**上游的 ETag、
删掉 `Content-Encoding`，并且在转发前把客户端的 `If-None-Match` /
`If-Modified-Since` 一并删掉并强制 `accept-encoding: identity`——
等于彻底废掉了浏览器侧的缓存能力。

### P2 · 为算体积而对每个前端包做全量上游读取

`resolveMobileBootSizes` 在 index 请求的关键路径上，对每个候选启动项发一次全量 GET
把整个 body 读出来数字节，8 路并发、30 秒 TTL。约 75 个包 → 约 36 MB 上游读取，
实测在关键路径上增加 77–130 ms 阻塞时间，且与手机正在等的请求争抢上游。

### P2 · `/api/remote.mux` 默认不压缩

`websocketCompression.paths` 默认为 `[]`，会话同步帧在 Wi-Fi 上原样传输。
压缩桥本身写得是对的（有真实的背压处理），只是没开。

### P3 · 主机侧常驻轮询

2 秒轮询 `mobile.css`/`mobile.js`（stat + readFile + 两次 sha256）、
2 秒轮询扩展目录、3 秒 UDP 广播 + mDNS 常驻。这两个 2 秒轮询完全可以用 `fs.watch` 替代。

## 三、UI 样式问题根因

### 布局层

| 现象 | 位置 | 原因 |
|---|---|---|
| 抽屉 / 详情面板跟手发滞 | `src/mobile-layout.ts` `.dshm-drawer` | `will-change:width` + `width` / `margin-right` 过渡——这两个属性不可合成，每帧都重排；`box-shadow: 18px 0 46px` 每帧重新光栅化 |
| 移动访问面板底部被裁掉 / 缩在键盘下面 | `.dsh-mobile-control__panel` | 用 `calc(100vh - 140px)`，而同一份包里其它全高规则都用 `dvh`。`100vh` 在手机浏览器上不会随地址栏/软键盘收缩 |
| 软键盘弹出时输入框被遮挡、布局跳变 | 全包 | 全插件**没有任何 `visualViewport` 处理**；唯一的视口监听是 `window.resize`，它在键盘动画期间每帧触发一次 `setViewportWidth` → 整个 `MobileAppFrame` 重渲染 |
| 长会话里越滚越卡 | `src/mobile-layout.ts` | 见上文 `firstByClassSuffix` 的物化开销 |

### 与你本机皮肤的冲突

你的 profile 里同时装了 `dsh-claude-style`（皮肤）和 `dsh-mobile`。移动页面用的是
**专用根布局** `.dshm-shell`，DOM 结构和电脑端不一样；插件自己的文档
（`docs/SKIN_COMPATIBILITY.md`）明确记录了这类冲突的典型症状：侧栏透底、
浅色主题下文字难读、轨迹区域高度塌成 0——原因就是皮肤的宽泛根布局规则
把移动容器改成了纵向 Flex。

插件从 0.6.5 起给自己的根容器加了 `@layer` + `!important` 的 Grid 几何保护，
但**配色、阴影、装饰挂载仍然要皮肤自己适配**。如果你的样式问题集中在
侧栏颜色/背景/文字对比度，根源在 `dsh-claude-style`，不在 dsh-mobile。

### 皮肤本身的成本

`dsh-claude-style` 在每个页面（含手机）额外注入：
620 KB client.js + 844 KB 字体（其中 JetBrains Mono 是两个 **TTF**，共 612 KB，
而不是 woff2）+ 872 KB 资源。在手机上是实打实的加载与解析开销。

## 四、不用改代码就能立刻缓解的配置

在 profile 的 `cordis.patch.yml` 里给 `mobile-access` 条目加：

```yaml
- id: mobile-access
  config:
    websocketCompression:
      paths:
        - /api/remote.mux
```

以及把心跳放宽（针对慢链路反复重连，不是针对卡顿）：

```yaml
- id: typert-gateway
  config:
    websocketHeartbeatIntervalMs: 30000
- id: connection
  config:
    trustedHosts: !!js ctx.webRuntime.trustedHosts
    recovery:
      generationReadyTimeoutMs: 120000
```

另外，手机端 **设置 → 通用设置 → 移动页面模块 → 管理** 里可以按设备排除
用不上的客户端模块；`excludedClientModules` 排除
`@deepseek-ai/dsh-client-ui-sidebar-documentpreview` 和 `dsh-claude-style`
能显著减小首屏流量（该模块含 PDF/Excel 查看器，体积占绝对大头）。
这只影响手机页面，电脑端不变。

> 注意：patch 的 `config` 是**整体替换**目标条目的 config，不是合并。
> 你当前 `~/.dsh/profiles/web/cordis.patch.yml` 里没有 `mobile-access` 条目，
> 新增时需要把插件自带的默认值一并写全。

## 五、建议的 fork 改造顺序

1. 修 P0 死循环（幂等写入 / 相机按钮移出 sync）——改动最小，收益最大。
2. 修 P0 的 `firstByClassSuffix` 物化 + 加 memo。
3. 收窄两个全文档观察器。
4. index.html 缓存 + ETag + gzip + 不删客户端验证头；去掉重复的 `parseMobileBootPlan`。
5. 体积探测改为按 boot `rev` 缓存，或直接用 `Content-Length`。
6. 放开 `/api/**` JSON 压缩；gzip 降到 level 1。
7. CSS：`100vh`→`100dvh`；`width`/`margin-right` 过渡改 `transform`；去掉 `will-change:width`；
   加 `visualViewport` 键盘内缩变量；给 compat.js 加 `Cache-Control`。
8. 两个 2 秒轮询改 `fs.watch`。

## 六、复现与验证

源码仓库自带 Playwright 冒烟脚本，可在 fork 里直接跑：

```
npm run smoke:native-layout        # 原生移动布局
npm run smoke:mobile-layout-ownership
npm run smoke:mobile-compat
npm run smoke:composer-keyboard
```

P0 死循环可以用 Performance 面板验证：打开一个会话后静置，
主线程应持续出现 60fps 的脚本帧；打补丁后应立即停止。
