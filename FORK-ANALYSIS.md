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

### P0 · 自持的 60fps MutationObserver → rAF 死循环（已实测确认并修复）

`src/native-mobile.ts` 注册了一个观察 `document.body` 整棵子树、
监听 `class` / `aria-selected` 的 MutationObserver，回调直接 `requestAnimationFrame(sync)`：

```ts
const schedule = (): void => { if (scheduled === 0) scheduled = requestAnimationFrame(sync) }
const observer = new MutationObserver(schedule)
observer.observe(document.body, {
  childList: true, subtree: true, attributes: true,
  attributeFilter: ['class', 'style', 'disabled', 'readonly', 'aria-busy', 'aria-selected', 'data-dsh-mobile-session'],
})
```

而 `sync()` → `placeCameraAction()` 里写 `class` 与 `aria-selected`。按 DOM 规范，
`className` 赋值器和 `setAttribute()` 都会入队一条 mutation record，**无论新值是否与旧值相同**，
于是闭环成立：`sync()` → 写属性 → observer 微任务 → `schedule()` → `rAF(sync)` → 循环。

**关键细节（第一版修复失败的原因）**：只把写入改成"先比较再赋值"**不够**。
`placeCameraAction` 是**两步赋值**——先设占位类 `'dsh-mobile-media-action'`，
下一句再覆盖成原生菜单的类名。两次写入**都与当前值不同**，所以每次 sync 仍然产生
两条 mutation record，闭环照旧。实测证据：89 次 sync 对应 178 次 `className` 写入，正好 2 次/轮。

**修法**：先算出最终类名，只赋一次。这样重复的 sync 会收敛到同一个值、不再写入。

实测（输入框附件菜单打开、页面静置 2 秒）：

| | rAF 回调 | script | style 重算 | tasks |
| --- | --- | --- | --- | --- |
| 基线 | 119（≈60/秒） | 113.7 ms | **442.8 ms** | 600.0 ms |
| 只做幂等判断 | 119 | 97.0 ms | 543.0 ms | 689.9 ms |
| **先算后赋一次** | **0** | **0.0 ms** | **0.0 ms** | **0.8 ms** |

注意这个循环**只在附件菜单打开时成立**：菜单关闭时 `placeCameraAction` 找不到
"添加"分组，走 `cameraButton.remove()` 分支，`remove()` 对已脱离节点不产生记录，
所以菜单关闭时基线也只有 5 次 rAF / 2 秒。这也说明只测"静置"会漏掉这个 bug。

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

### P1 · 两个挂在 documentElement 上的观察器 + characterData（已实测确认并修复）

- `observeTaskActivity(document.documentElement, …)`（`src/task-notify.ts`）
  带 `characterData: true, subtree: true`——**流式输出的每一个 token 都会触发**。
  回调里每次跑 2 次全文档 `querySelector`（`hasPendingInputQuestion` 与
  `pendingInputQuestionKey` 查的是**同一个选择器**）+ `document.title.normalize('NFC')` + 正则。
- voice-session 的观察器同样是 `document.documentElement` 全文档 + 每个增删节点跑 `containsVoiceRow`。

实测（模拟 200 个 token，每次 mutation 让出一个任务边界，与真实 token 到达一致）：

| | querySelector 调用 | script | 榜首选择器 |
| --- | --- | --- | --- |
| 基线 | 464 | 40.2 ms | `[data-question-key],[data-plan-review-key]` × 402 |
| **合并查询 + 节流** | **67** | **4.0 ms** | `[class]` × 8（那个选择器已跌出榜） |

402 / 200 = **每个 token 两次全文档查询**，且查的是同一个选择器——一半是纯重复。

**修法（已实施）**：`readPendingInputQuestion` 一次解析、同时给出"有没有卡片"和"卡片的 key"；
观察器改为**前导节流**（首个变化立即评估，窗口内的后续批次合并成一次尾部评估，
锚点定时器与 visibilitychange 仍立即评估，所以决定通知的状态不会被压后）。

未做：观察目标收窄到会话滚动容器、去掉 `characterData`。节流已经把每个 token 的成本
压到接近零，进一步收窄需要先确认弹窗等 portal 节点不会被漏掉。

### P1 · compat.js 在关键路径上，且以未压缩形式下发

48 KB 的 core-js 以**同步解析阻塞**的 `<script>` 注入在所有 DSH 脚本之前。

> 更正：本文档早先写"它没有任何 `Cache-Control`"，这是**错的**。
> `setSecurityHeaders` 会统一设置 `Cache-Control: no-store`，而且单测
> （`tests/gateway.test.ts`，custom.css / custom.js / compat.js 共 4 处）把
> `no-store` 钉住了。这个策略是**有意**的：这些正是 `/mobile` 流程手工改写、
> 手机必须重读的文件，改掉它会破坏"保存后几秒内生效"的承诺。
> 正确的优化只是在 `no-store` 之上**加压缩**，把每次冷启动的 48 KB 降到约 16 KB。

### P1 · `/api/**` 的压缩门禁：实际收益比想象中小得多（已更正）

网关的 `canCompressResponse` 只放行 `/plugins/` 和 `/assets/` 前缀。

> 更正：本文档早先据此断言"`/api/**` JSON 从不压缩"，并称约 2.8× 压缩空间。
> **实测推翻了它**：在一次刷新中捕获的 20 个 `/api/**` 200 响应**全部**带
> `Content-Encoding: gzip`。原因是上游 DSH 自己的 webserver 有 gzip 中间件，
> 网关只在 `content-encoding` 为空时才自己压；所以 `/api/**` 早就被上游压过了。
> 那个 2.8× 是对负载本身算的，不是对实际链路上缺失的压缩算的。

所以把门禁改为按响应媒体类型判断，**价值有限**（只覆盖上游没压的响应），
不构成主要优化项。真正被它改变的是**正确性边界**，不是带宽。

### 反例 · 不要试图把 SSE 从压缩中排除

代码审查会让人觉得 `text/event-stream` 不该被压缩（压缩要等块填满才出字节，
会推迟实时流的每个事件），而 `/plugins/events` 确实会在旧白名单下被压缩。

**但实测推翻了这个推理**：只把这处守卫加到未改动的网关上，boot 冒烟即失败——
移动端客户端始终不就绪，`/plugins/events` 报 `ERR_INCOMPLETE_CHUNKED_ENCODING`，
客户端抛出 `renderSlot('root') before any 'root' registration`；去掉守卫后同一份
构建通过。该 SSE 流在引导期是被依赖的。**改动此处前务必先跑 `npm run smoke:dsh-boot`。**


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

| 现象 | 位置 | 原因 | 状态 |
|---|---|---|---|
| 抽屉 / 详情面板跟手发滞 | `.dshm-drawer` | `width` / `margin-right` 过渡不可合成，每帧重排；`box-shadow: 18px 0 46px` 每帧重光栅化 | **实测不构成阻塞点，未改**（见下） |
| 移动访问面板底部被裁掉 | `.dsh-mobile-control__panel` | `calc(100vh - 140px)`，而同包其它全高规则都用 `dvh` | ✅ 已改为 `vh` + `dvh` 回退对 |
| 软键盘弹出时输入框被遮挡 | 全包 | 网关注入的 viewport meta 没有 `interactive-widget`，键盘只缩视觉视口、`100dvh` 不变；而全插件**没有任何 `visualViewport` 处理** | ✅ 已补（见下） |
| 长会话里越滚越卡 | `src/mobile-layout.ts` | `firstByClassSuffix` 的物化开销 | ✅ 已改为短路遍历 |

**关于抽屉过渡（为什么最终没改）**：实测打开抽屉的 600ms 窗口内 layout 仅 10.2ms、
style 36.3ms，关闭 3.2ms / 20.3ms，且 `rafCallbacks: 1`——CSS 过渡不产生 JS 帧循环。
再用运行时注入 CSS 做 A/B（去掉 `box-shadow` 过渡、只保留 `width`）：打开时 script
从 7.6ms 降到 0.8ms，但 layout 反而从 6.3ms 升到 13.3ms，同一次运行的 idle 基线本身
就在 28–43ms 之间波动。**结论：这项成本在噪声范围内。**

之所以不改，还有一个结构性原因：抽屉关闭态是**可见的 56px 轨道**，且子元素宽度在
56px ↔ 100% 之间切换，DSH 侧栏的折叠态布局依赖这个宽度。单纯换成 `transform`
会变成"把 340px 布局裁掉左边"，而不是 DSH 的折叠轨道。要为 0 可测收益改动这个
布局契约，不划算。

**关于软键盘**：`resolveKeyboardInset(layoutHeight, visualHeight, visualOffsetTop)`
取布局视口与视觉视口的差值，并在主列底部预留。它同时覆盖两种情况——浏览器若已经
缩了布局视口（差值为 0）就不会重复预留；视觉视口被滚动时只预留其下方仍被遮挡的部分。
小阈值用来滤掉浏览器工具栏与取整误差。

端到端实测（把 `visualViewport.height` 覆写为 300px 键盘并派发 `resize`）：

| | `--dshm-keyboard-inset` | 主列 padding | 输入框底部 |
|---|---|---|---|
| 初始 | 0px | 0px | 559 |
| 键盘 300px | 300px | 300px | 409 |
| 键盘收起 | 0px | 0px | 559 |

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

已在 `fix/transport-and-jank` 分支完成的（见该分支提交）：

1. ~~修 P0 死循环~~ ✅ `perf(client)` 两次：先加幂等判断（不够），再改成"先算后赋一次"。
   实测 443ms 样式重算 / 2 秒 → 0。
2. ~~修 P0 的 `firstByClassSuffix` 物化~~ ✅（加 memo 未做）
3. ~~收窄/节流两个挂在 `documentElement` 上、带 `characterData` 的观察器~~ ✅
   改为合并查询 + 前导节流：每个 token 的脚本成本 40.2ms → 4.0ms（200 token）
4. ~~index.html 缓存 + ETag + gzip~~ ✅ `perf(gateway)`；并在 `fix(gateway)` 中修正了
   缓存键漏请求 URL、batch 计划未随缓存保留、未设时限三个缺陷
5. ~~体积探测优先用 `Content-Length`~~ ✅（按 `rev` 键控未做）
6. ~~压缩门禁改按媒体类型~~ ✅（实测收益有限，见上文更正）
7. ~~CSS：`100vh`→`100dvh`；去掉 `will-change:width`~~ ✅ `fix(ui)`

8. ~~加 `visualViewport` 键盘内缩~~ ✅ `feat(client)`，端到端实测见上。

未做：

9. 抽屉的 `width` / `margin-right` 过渡改 `transform`——**实测后决定不做**：
   打开/关闭的 layout 成本在 3–10ms，A/B 差异落在噪声里，而换成 `transform`
   会破坏关闭态 56px 轨道的渲染。见「布局层」一节。
10. 去掉 `rewriteMobileIndexWithBatch` 内部重复的 `parseMobileBootPlan`（每请求跑两遍）。
11. 两个 2 秒轮询改 `fs.watch`。
12. 两个缓存目前按 TTL 失效；改为按 boot `rev` 键控更准。
13. 观察目标收窄到会话滚动容器、去掉 `characterData`——节流后收益已经很小，
    且要确认 portal 弹窗不会被漏掉。

## 六、复现与验证

源码仓库自带 Playwright 冒烟脚本，可在 fork 里直接跑：

```
npm run smoke:native-layout        # 原生移动布局
npm run smoke:mobile-layout-ownership
npm run smoke:mobile-compat
npm run smoke:composer-keyboard
```

### 本文数字是怎么来的

上面所有数字来自一个临时测量脚本（不在仓库里），它复用
`scripts/mobile-boot-fixture.mjs` 的 `createMobileProfile` / `launchDsh` /
`openPairing` / `pairMobilePage`，把打包好的插件装进一个真实的 DSH，
用 390×844 的手机视口配对后做三件事：

1. **主线程成本**：CDP `Performance.getMetrics` 取 `ScriptDuration` /
   `RecalcStyleDuration` / `LayoutDuration` / `TaskDuration` 的窗口差值。
2. **观察器行为**：在页面里包一层 `MutationObserver`、`requestAnimationFrame`，
   以及 `querySelector` / `querySelectorAll` / `setAttribute` / `className` 赋值器，
   按选择器和目标元素计数——这样才能指名"谁在写、写了几次"，而不是靠读代码推断。
3. **传输**：CDP `Network` 事件记录状态码、`content-encoding`、字节数与缓存来源。

**关键教训：只测"静置"会漏掉 P0 循环。** 循环只在输入框附件菜单打开时成立，
必须显式点开菜单再测。第一版修复之所以"看起来对但没用"，就是因为没做这个区分。

### 关于 304

我的改动给界面文档加了 `ETag` 与 `Cache-Control: private, no-cache`，但在这个无头
测量环境里**观测不到 304**。做了对照才确认原因：连 `/assets/*` 和 `/plugins/*?rev=`
（带 `max-age=31536000, immutable`）在第二次导航时也是 `disk=false`、且不发
`if-none-match`。也就是说**该浏览器上下文根本不用 HTTP 缓存**，所以这不是响应头的问题，
只是无法在这里验证。服务端缓存（避免重取上游 index 与重跑改写）的收益与浏览器缓存无关，
仍然成立。
