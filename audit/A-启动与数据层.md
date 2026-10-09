# 审计 A：启动链路 + 数据层（app.js / utils/*）

- 审计员：`audit-core`（共享任务 `task-1`）
- 审计范围：`bread-main/app.js`、`utils/auth.js`、`utils/api-map.js`、`utils/data-source.js`、`utils/services/legacy-apifm.js`、`utils/pay.js`、`project.config.json`、`project.private.config.json`、`app.json`
- 方式：**严格只读**（未修改 `bread-main` 下任何文件）。逐行通读代码 + 用 `node` 对数据层做「桩化 `wx` 复现」实验（`node -` 从 stdin 执行，不落盘）、对 apifm SDK 做方法面清点。所有结论均有 `文件:行号` 证据。
- 取证时间：2026-10-09（工作区快照；项目无 git，无法比对历史版本）
- 运行环境区分：`app.js`/`utils/**` 跑在**微信小程序 JS 环境**；`cloudfunctions/api/**` 跑在**云函数 Node + wx-server-sdk**。文中已分别标注。
- 与第一阶段报告的关系：一阶段的结论**未照抄**，其中「`app.configLoadOK` 空函数破坏 `page.onShow()` 回调链」一条经复核**在当前代码中不成立**（见 A-P2-01）。

---

## 一、结论摘要

### 1.1 分级计数

| 级别 | 数量 | 编号 |
| --- | --- | --- |
| P0（阻断上线／资损／数据外泄） | 2 | A-P0-01、A-P0-02 |
| P1（影响正确性） | 6 | A-P1-01 ~ A-P1-06 |
| P2（健壮性） | 8 | A-P2-01 ~ A-P2-08 |
| P3（整洁度） | 7 | A-P3-01 ~ A-P3-07 |
| 合计 | 23 | — |

### 1.2 最致命的 5 条

1. **A-P0-01（降级通道既不通、又指向原店）**：`useCloud=true` 时 `app.js` 从不初始化 api 工厂 SDK（只调 `API.init()` = `wx.cloud.init`），因此云函数失败后所谓的"自动降级到 api 工厂"实际请求打到 `https://api.it120.cc/-/…`（`subDomain` 默认 `'-'`，实测复现），**拿不到原店数据**；而一旦有人按 `api-map.js:178` 的注释补上一行 `WXAPI.init(CONFIG.subDomain)`，`orderCreate` / `cartAdd` 等真实存在的方法**就会把顾客订单与购物车写进原面包店账号**（`config.js:4-5`：`yuanqibread` / `merchantId 24340951`）。当前"没串号"是碰巧，不是设计保证。
2. **A-P0-02（收不了钱）**：云开发通道 `wxpay` 是 501 桩（`handlers.js:449-451`），`utils/pay.js:32` 拿到非 0 就弹原始返回体并 `reLaunch`。个人测试 AppID 无法申请商户号（`docs/云开发初始化清单.md:105` 自述），**上线前必须解决**，否则用户能下单、不能付款。
3. **A-P1-01（降级后鉴权整条走错）**：`api-map.js:428` 在降级后把 `__dataSource()` 从 `'cloud'` 改成 `'cloud(degraded→apifm)'`，而 `auth.js:16` 用 `__dataSource() === 'cloud'` 判断云模式 → **降级一次之后 `isCloudMode()` 永久为 false**，`checkHasLogined` 改去读 `storage.token`（云模式从不写 token）→ 返回未登录 → `AUTH.login()` 走 legacy 分支 → 用户看到「无法登录」弹窗，且购物车判断逻辑与页面侧的 `API.__isCloudMode()` 互相矛盾。
4. **A-P1-02（500 语义混淆 = 静默换源）**：`withFallback` 只认 `code === 500`（`api-map.js:105`），而云函数把**任何业务异常**也返回 500（`handlers.js:1023`）。于是"云端一次数据库报错"会被当成"环境不可用"而切到 legacy 通道——这正是把写操作送到原店账号的入口。
5. **A-P1-04（依赖三方不一致，重建 npm 即崩）**：`package.json:17` 声明 `apifm-wxapi ^26.2.5`、`package-lock.json:13` 与 `node_modules` 实际是 **3.8.0**、`miniprogram_npm/apifm-wxapi` 则是 26.x 时代的旧产物（**849** 个方法 vs 3.8.0 的 **229** 个）。实测 3.8.0 **缺少** `goodsCategoryV2 / goodsv2 / goodsDetailV2 / shippingCarInfoAddItemV2 / orderHXV2 / modifyUserInfoV2 / authorize / wxappServiceLogin / wxappServiceAuthorize / bindMobileWxappV2 / wxappServiceBindMobile / setMerchantId`。今天能跑，只是因为运行时解析到了旧的 `miniprogram_npm` 产物；任何人执行一次「构建 npm」就会把这些调用变成 `TypeError: not a function`。

---

## 二、缺陷清单

### 2.0 总表

| 编号 | 级别 | 位置（文件:行号） | 一句话 |
| --- | --- | --- | --- |
| A-P0-01 | P0 | `app.js:18-22`、`utils/data-source.js:39`、`utils/api-map.js:99-111` | 降级通道未初始化（请求打到 `it120.cc/-/`）；一旦补 init 即把订单写进原店 |
| A-P0-02 | P0 | `cloudfunctions/api/handlers.js:449-451`、`utils/pay.js:32-73` | 云开发支付 501 桩，无法收款 |
| A-P1-01 | P1 | `utils/api-map.js:428` + `utils/auth.js:15-17` | 降级后 `isCloudMode()` 永久 false，鉴权走 legacy 分支 |
| A-P1-02 | P1 | `utils/api-map.js:105` + `cloudfunctions/api/handlers.js:1023` | 业务 500 被误判为环境故障 → 静默换源 |
| A-P1-03 | P1 | `utils/api-map.js:79-111` | 「只降级一次」名不副实，每次调用都先打一次失败云函数 |
| A-P1-04 | P1 | `package.json:17`、`package-lock.json:13`、`node_modules/apifm-wxapi`、`miniprogram_npm/apifm-wxapi` | 依赖三版本冲突，重建 npm 后 16 个方法消失 |
| A-P1-05 | P1 | `pages/pay/index.wxml:134` + `pages/pay/index.js:240-354` | 结算按钮无防抖 → 重复下单、重复扣库存 |
| A-P1-06 | P1 | `utils/auth.js:36-47,182` + `pages/my/index.js:71`、`pages/orders/index.js:300`、`pages/current-order/index.js:45` | 未捕获的 reject → unhandled rejection，页面静默空白 |
| A-P2-01 | P2 | `app.js:66-68` + 8 个页面模块顶层 | `configLoadOK` 空函数覆盖链（当前无可见故障，属埋雷） |
| A-P2-02 | P2 | `pages/index/index.js:19-21`（唯一写入）→ `pages/orders/index.js:29`（无兜底读取） | `shopInfo` 只有首页会写，直达二级页时为空 |
| A-P2-03 | P2 | `app.js:82-88` | 降级时把原店后台配置键值写入本地 storage，只保护了 `mallName` |
| A-P2-04 | P2 | `utils/auth.js:94,242-245` | `uid` 只写不读；云模式无 `token`；混合态残留 |
| A-P2-05 | P2 | `cloudfunctions/api/handlers.js:784-967,983`、`utils/api-map.js` | `importData` 无鉴权且未纳入 api-map，任意端可调用 |
| A-P2-06 | P2 | `app.json:18` + `pages/address/edit.js:118` | 未声明 `chooseLocation`，地图选点必然失败 |
| A-P2-07 | P2 | `utils/pay.js:42-45,63-65` | 失败分支把原始 JSON 弹给用户、`'支付失败:' + 对象` |
| A-P2-08 | P2 | `project.private.config.json:23` vs `project.config.json:61`；两者 `urlCheck:false` | 有效基础库版本由私有文件决定；`urlCheck:false` 掩盖降级域名问题 |
| A-P3-01 | P3 | `utils/auth.js:8` | 未使用的 `@vant/weapp/dialog` 死 import |
| A-P3-02 | P3 | `utils/services/legacy-apifm.js:35-36,65,70-77`、`utils/api-map.js:178` | 死导出 + 注释与实现不符 |
| A-P3-03 | P3 | `utils/services/legacy-apifm.js:64` | `LEGACY.login` 传空 code（`WXAPI.login_wx('')`） |
| A-P3-04 | P3 | `utils/data-source.js:7`、`utils/api-map.js:9,63` | 注释仍指向已删除的 `utils/mock-backend.js`；`void action` 反模式 |
| A-P3-05 | P3 | `utils/data-source.js:61` + `docs/云开发初始化清单.md:4-5,116` | 环境 ID 多处硬编码，无集中配置 |
| A-P3-06 | P3 | `app.json:22`、`pages/about-us/*.json` | 全局标题为空，两页标题依赖运行期接口结果 |
| A-P3-07 | P3 | `pages/pay/index.js:229`、`utils/pay.js:18` | `console.log` 残留 + 已删充值分支的死字段 |

---

### 2.1 P0

#### A-P0-01 云函数失败「自动降级」：通道不可用，且方向指向原面包店账号

**位置与代码**

```js
// app.js:16-23  —— 三态初始化
if (DS.useMock) {                                   // 16
  // Mock 模式：不初始化任何后端
} else if (DS.useCloud) {                           // 18
  API.init()                                        // 19  ← 只做 wx.cloud.init，不 init api 工厂
} else {
  WXAPI.init(CONFIG.subDomain)                      // 21  ← 只有纯 legacy 模式才 init
  WXAPI.setMerchantId(CONFIG.merchantId)            // 22
}
```

```js
// utils/api-map.js:99-111 —— 失败降级
function withFallback(cloudFn, legacyFn) {
  return async (...args) => {
    const res = await cloudFn(...args)
    if (res && res.code === 0) return res
    if (res && res.code === 500 && DS.fallbackToLegacy && typeof legacyFn === 'function') {
      notifyDegrade(res.msg)                        // 106 弹窗
      return legacyFn(...args)                      // 107 走 api 工厂
    }
    return res
  }
}
```

```js
// utils/data-source.js:39 / 43 / 61
fallbackToLegacy: true,                 // 39
cloudFunctionName: 'api',               // 43
cloudEnvId: 'cloud1-d7g2txuxpf22bb979', // 61
```

**取证（已实测复现）**：用桩化的 `wx`（`wx.cloud.callFunction` 一律 `fail`）直接 `require('utils/api-map')` 并调用，输出为：

```
dataSource BEFORE: cloud
CLOUD_CALL action= getUser
MODAL: 云开发不可用，已临时降级 | cloud.callFunction:fail cloud function api not found
LEGACY_HTTP_URL: https://api.it120.cc/-/user/detail      ← subDomain 仍是默认 '-'
dataSource AFTER : cloud(degraded→apifm)
CLOUD_CALL action= cartInfo                              ← 第 2 次调用仍然先打云函数
LEGACY_HTTP_URL: https://api.it120.cc/-/shopping-cart/info
```

`node_modules/apifm-wxapi/src/index.js:3-4`（以及旧构建 `miniprogram_npm/apifm-wxapi/index.js:97-100`）默认 `subDomain = '-'`，只有 `WXAPI.init(subDomain)` 才会改写。**云模式下从未调用它**，所以降级请求不会打到 `config.js:4` 的 `yuanqibread` 账号。

**为什么会出问题**

1. 降级承诺（弹窗文案 `api-map.js:90`：「已临时切换到 api 工厂（备用数据源），数据仍为原面包店账号」）**与事实不符**：请求打到了 `api.it120.cc/-/`，既不是本店数据，也不是原店数据，只会得到错误响应。用户/店主看到"降级成功"的暗示，实际全站无数据。
2. 更危险的是反向：这段代码的**意图**是"云不可用时用原店账号兜底"，而 `orderCreate`、`cartAdd`、`shippingCarInfoAddItemV2` 等在旧构建里都存在。一旦有人为了让降级"真的能用"而补上 `WXAPI.init(CONFIG.subDomain)`（或把 `useCloud` 改成 `false` 却没清理 `fallbackToLegacy`），顾客的**真实订单、购物车、手机号**就会写进**第三方的 api 工厂账号**（`yuanqibread` / 24340951），且顾客在小程序里看到"下单成功"。这是不可逆的资损与数据外泄。
3. `project.config.json:21` / `project.private.config.json:7` 的 `urlCheck:false` 让**开发者工具与真机调试不校验合法域名**，因此"降级在 IDE 里看起来能跑、在体验版/正式版被域名校验拦住"的差异不会在开发期暴露（正式版 `wx.request` 失败 → `legacy-apifm` 的 promise **reject**，见下一条）。

**触发条件**：云函数未部署（现状就有此风险，见 `docs/云开发初始化清单.md` 的待办清单）、环境 ID 与实际环境不一致、云开发未开通、网络异常、或云函数内部抛错返回 500（`handlers.js:1023`）。**当前 `useCloud=true` 下必然触发**。

**建议改法**

1. 立刻把 `utils/data-source.js:39` 的 `fallbackToLegacy` 改为 `false`（改为"云不可用时明确报错"，不要让写操作有第二条路）。
2. 若要保留降级通道：在 `app.js` 的云分支里补 `WXAPI.init(CONFIG.subDomain)`+`WXAPI.setMerchantId(...)`，**同时**把 `config.js` 换成自店账号，并且只允许**只读**接口降级——写接口（`orderCreate`/`orderDelete`/`orderClose`/`cartAdd`/`cartModifyNumber`/`cartRemoveAll`/`cartRemoveItem`/`orderHx`/`updateUser`/`bindMobile`/`wxpay`）一律 `pickCloudOnly`。
3. 弹窗文案改为面向顾客的中性提示（当前文案把"原面包店账号""仅供调试"直接给终端用户看，见 A-P2-07）。

**严重级**：P0（潜在资损/数据外泄 + 阻断上线）

---

#### A-P0-02 云开发通道微信支付为 501 桩：用户能下单、不能付款

**位置与代码**

```js
// cloudfunctions/api/handlers.js:449-451
async function wxpay(payload, ctx) {
  return fail('云开发支付尚未接入：需先申请微信支付商户号并配置云开发支付（cloud.cloudPay）', 501)
}
```

```js
// utils/pay.js:32-37, 62-73
API.wxpay(postData).then(function (res) {
  if (res.code == 0) {
    wx.requestPayment({ ... })
  } else {
    wx.showModal({ title: '出错了', content: JSON.stringify(res), showCancel: false,
      success (res) { wx.reLaunch({ url: redirectUrl }); } })
  }
})
```

**为什么会出问题**：`utils/api-map.js:322` 用 `pickCloudOnly` 包了 `wxpay`——云模式下**不降级**（这个设计本身是对的），于是支付永远返回 501；`utils/pay.js` 把 `{code:501,msg:'云开发支付尚未接入…'}` 原样 `JSON.stringify` 弹给顾客，然后跳转订单页。**顾客看到一个带原始 JSON 的"出错了"弹窗，订单处于"待支付"却不能支付**。`docs/云开发初始化清单.md:105` 自述"个人主体办不了商户号，支付未接"，即当前 AppID 下无解。

**触发条件**：任何一次结算（100% 复现）。

**建议改法**：上线前必须（a）换企业主体 AppID + 申请微信支付商户号；（b）用 `cloud.cloudPay.unifiedOrder` 实现 `wxpay`，并把 `handlePayCallback`（`cloudfunctions/api/index.js:100-119`）接到 `cloudPay` 回调上；（c）在接入前，结算按钮应前置拦截并给出业务化文案（"暂不支持在线支付，请到店支付/联系门店"），而不是让用户走到支付再报错。

**严重级**：P0（阻断上线；属阶段二"设计内未完成"，但必须在上线前闭环）

---

### 2.2 P1

#### A-P1-01 降级后 `isCloudMode()` 永久为 false → 鉴权整条走错分支

**位置与代码**

```js
// utils/api-map.js:426-430
__dataSource() {
  if (DS.useMock) return 'mock'
  if (DS.useCloud) return degradedToLegacy ? 'cloud(degraded→apifm)' : 'cloud'   // 428
  return 'apifm'
},
```

```js
// utils/auth.js:15-17
function isCloudMode() {
  return API.__dataSource() === 'cloud'    // 16 ← 降级后 'cloud(degraded→apifm)' !== 'cloud'
}
```

**为什么会出问题**：`degradedToLegacy`（`api-map.js:79`）一旦被 `notifyDegrade()` 置 true，**再也不会复位**。于是：

- `auth.js:40` 的云分支被跳过 → `checkHasLogined()` 走到 `auth.js:50` 读 `wx.getStorageSync('token')`，而云模式**从不写 token**（`auth.js:89-97` 只写 `uid`）→ 恒返回 `false`；
- `app.js:117-121` 的 onShow 自动登录 → `AUTH.login()` → `auth.js:111+` legacy 分支 → `wx.login` → `WXAPI.login_wx(code)` → 未 init 的 SDK 请求 `https://api.it120.cc/-/user/wxapp/login` → `res.code != 0` → `auth.js:127-133` 弹出 **「无法登录」** 弹窗给顾客；
- 同时 `auth.js:172-183` 的 `authorize()` 云分支被跳过，`pages/my`、`orders`、`current-order` 的授权流程全部改走 legacy；
- 页面侧用的是另一个判据 `API.__isCloudMode()`（`api-map.js:433-435`，基于 `DS.useCloud`，**不受降级影响**），于是 `pages/orders/index.js:117`、`pages/pay/index.js:168` 认为"仍是云模式"继续发请求——**同一份代码里两个互相矛盾的"云模式"定义**。

**触发条件**：任意一次云函数失败（未部署/网络抖动/环境错）之后，直到小程序被销毁重启。即"降级过一次"之后的所有鉴权行为。

**建议改法**：`auth.js:16` 改为 `return API.__isCloudMode()`（消除第二个判据）；或在 `api-map.js:428` 降级时**不要改变 `__dataSource()` 的返回语义**，另加 `__degraded()` 供调试/提示使用。

**严重级**：P1

---

#### A-P1-02 `code === 500` 同时表示「环境不可用」和「业务异常」→ 静默换源

**位置与代码**

```js
// utils/api-map.js:103-108
if (res && res.code === 0) return res
if (res && res.code === 500 && DS.fallbackToLegacy && typeof legacyFn === 'function') {
  notifyDegrade(res.msg)
  return legacyFn(...args)
}
```

```js
// cloudfunctions/api/handlers.js:1017-1025（云函数侧）
async function dispatch(action, payload, ctx) {
  const fn = handlers[action]
  if (!fn) return fail('未知的接口：' + action, 404)
  try { return await fn(payload, ctx) }
  catch (e) { return fail('服务异常：' + (e && e.message ? e.message : '未知错误'), 500) }  // 1023
}
```

同时 `callCloud` 在**云函数无返回/调用失败**时也塞 500（`api-map.js:48,52`），即 500 被复用了三种含义：网络失败、云函数不存在、云端业务异常。

**为什么会出问题**：云端任何一次 `db` 异常（集合权限、`_openid` 规则、超时）都会被前端判定为"云开发不可用"，然后**静默把这次调用转发到 legacy 通道**。对读接口是数据错乱（本店商品/原店商品混着显示），对写接口（`orderCreate`）就是"订单写到了另一个账号里、顾客却看到成功"。弹窗只提示一次，之后的换源连提示都没有。

**触发条件**：云端 handler 抛异常（例如 `db.collection('order').add` 因权限被拒）、或云函数返回结构为空。

**建议改法**：把"环境不可用"与"业务失败"的码分开：`callCloud` 的传输层失败用**独立错误码**（如 `code: 599/errcode:'CLOUD_UNREACHABLE'`），降级只认这个码；`dispatch` 的业务异常保持 `code:1`；`withFallback` 里再加白名单（只允许显式标记为可降级的只读接口）。

**严重级**：P1

---

#### A-P1-03 「只降级一次」名不副实：无粘性记忆，每次调用都先打一次注定失败的云函数

**位置与代码**

```js
// utils/api-map.js:95-111（withFallback 全文）
function withFallback(cloudFn, legacyFn) {
  return async (...args) => {
    const res = await cloudFn(...args)   // 101 ← 每次都先打云函数
    ...
```

对照注释：`utils/data-source.js:21`「会**自动降级**到 api 工厂通道，**只降级一次并弹窗提示**」；`api-map.js:12`「仅一次，会弹窗提示」。

**取证**：上面的桩跑实验中，第 2 次调用（`shippingCarInfo`）仍然打印了 `CLOUD_CALL action= cartInfo`，随后才失败转发——`degradedToLegacy` **只控制弹窗**（`api-map.js:85-86`），不影响通道选择。

**为什么会出问题**：云环境不可用时，页面每次 `onShow`/每个接口都要先经历一次云函数超时（真机 3~10s）才降级 → 用户感觉"全站卡死"，且每次都产生失败调用配额。注释让人误以为有熔断，实际没有。

**建议改法**：在 `withFallback` 里加真正的熔断：`if (degradedToLegacy) return legacyFn(...args)`（并给一个重新探测的时间窗口）；或至少把注释改成与实现一致。

**严重级**：P1（可用性/性能，且与文档承诺不符）

---

#### A-P1-04 apifm-wxapi 三方版本冲突：重建 npm 会让 16 个方法变 `undefined`

**位置与代码**

```json
// package.json:15-19
"dependencies": { "@vant/weapp": "^1.11.7", "apifm-wxapi": "^26.2.5", "wxbarcode": "^1.0.2" }
```

```json
// package-lock.json:12-16
"apifm-wxapi": { "version": "3.8.0", "resolved": "https://registry.npmjs.org/apifm-wxapi/-/apifm-wxapi-3.8.0.tgz" }
```

**取证（`node` 实测方法面）**：

| 载体 | 版本 | 方法总数 |
| --- | --- | --- |
| `node_modules/apifm-wxapi`（`main: miniprogram_dist/index.js`） | 3.8.0 | 229 |
| `miniprogram_npm/apifm-wxapi/index.js`（小程序实际解析到的构建产物） | 26.x 时代 | 849 |

3.8.0 **缺失**（项目正在使用）：`goodsCategoryV2`、`goodsv2`、`goodsDetailV2`、`shippingCarInfoAddItemV2`、`orderHXV2`、`modifyUserInfoV2`、`authorize`、`wxappServiceLogin`、`wxappServiceAuthorize`、`bindMobileWxappV2`、`wxappServiceBindMobile`、`setMerchantId`。
对应代码：`utils/services/legacy-apifm.js:40-42,46,58,67,71-77,36`、`utils/auth.js:117,201,218`、`app.js:22`。

**为什么会出问题**：`require('apifm-wxapi')` 在小程序里解析到 `miniprogram_npm/`（项目 `project.config.json:48` `packNpmManually:false`，即由工具自动构建）。**今天不报错，只是因为 `miniprogram_npm` 是旧版本留下的产物**。任何人执行一次「工具 → 构建 npm」（或以当前 `node_modules` 重新构建），`miniprogram_npm` 就被 3.8.0 覆盖，上述 16 处调用立刻变成 `TypeError: WXAPI.xxx is not a function`：`app.js:22` 会让 legacy 模式**启动即崩**，`utils/auth.js:218` 会让授权流程直接抛错，降级通道彻底失效。

**触发条件**：执行「构建 npm」/清理后重建/新环境 clone 后构建/CI 构建。

**建议改法**：（a）确定目标版本后**同时**对齐三处：`package.json` 写精确版本、`npm install` 重新生成 `package-lock.json`、重新构建 `miniprogram_npm`；（b）在代码里对 `WXAPI.xxx` 做存在性判断，缺失时抛业务化错误而不是 `TypeError`；（c）考虑到 legacy 通道已被判定为风险源（A-P0-01），更彻底的做法是**删除 legacy 通道与 apifm 依赖**，只留云开发。

**严重级**：P1

---

#### A-P1-05 结算按钮无防重复提交：重复下单 + 重复扣库存

**位置与代码**

```xml
<!-- pages/pay/index.wxml:134 -->
<view class="pay-byn" bindtap="createorder">结算</view>
```

```js
// pages/pay/index.js:240-294（createorder 开头）
async createorder() {
  const token = wx.getStorageSync('token')
  ...            // 无 submitting/loading 互斥锁
  const goodsJson = []
  this.data.shippingCarInfo.items.forEach(ele => { ... })   // 280 ← 用页面缓存的购物车条目重放
```

对照：同一个项目在"再次支付"按钮上**是有防抖的**——`pages/current-order/index.js:167-179` 用 `payButtonClicked` + 3 秒窗口。

**为什么会出问题**：`createorder` 不读服务端购物车，而是用页面缓存的 `shippingCarInfo.items` 重新拼 `goodsJsonStr` 提交；`orderCreate` 只校验商品存在与库存（`handlers.js:519-522`），**不校验这些条目是否仍在该用户购物车里**。因此 3 秒内点两次"结算"→ 服务端创建两笔订单、库存扣两次；第一笔成功后云函数已清空购物车（`handlers.js:648`），但第二笔仍会成功。随后 `wxpay.wxpay(...)` 还会被调用两次。

**触发条件**：结算按钮双击/弱网下连点。

**建议改法**：给 `createorder` 加 `if (this.data.submitting) return; this.setData({submitting:true})`，并在 `finally` 复位；同时 wxml 上给按钮加 `disabled/loading` 态；服务端侧建议对 `goodsJsonStr` 与购物车做一致性校验（不匹配则拒绝）。

**严重级**：P1

---

#### A-P1-06 云函数不可用时：`checkHasLogined` / `authorize` 抛未捕获异常，页面静默空白

**位置与代码**

```js
// utils/auth.js:40-47（无 try/catch）
if (isCloudMode()) {
  const res = await API.userDetail('')   // 41 降级时 legacyFn 可能 reject（wx.request fail）
  if (res && res.code === 0) return true
  return false
}
```

```js
// utils/auth.js:178-183
wx.showToast({ title: ..., icon: 'none' })
throw new Error((res && res.msg) || 'cloud login failed')   // 182
```

```js
// pages/my/index.js:67-75 / pages/orders/index.js:298-302 / pages/current-order/index.js:41-48
AUTH.checkHasLogined().then(isLogined => {
  if (isLogined) { this.userDetail() }
  else { AUTH.authorize().then(() => { this.userDetail() }) }   // 无 .catch
})
```

**为什么会出问题**：`withFallback` 转发到 legacy 时，`legacy-apifm.js:66/45/...` → `WXAPI.*` → `request()`（`apifm-wxapi/src/index.js:6-27`）在 `wx.request` fail 时是 **reject**，不是返回错误码。于是：`checkHasLogined` 抛出 → `app.js:117` 的 `.then()` 没有 `.catch` → 未处理的 promise rejection（控制台红字、后续逻辑中断）；`authorize()` 的 throw 同样无人接 → `this.userDetail()` 永不执行、页面停留空白，**且没有任何用户可见的错误提示**。

**触发条件**：云函数不可用（此时降级请求又打不到合法域名/网络失败）。三个页面 + app onShow 均可复现。

**建议改法**：（a）`checkHasLogined` 内部 `try/catch`，异常按"未登录"处理并返回 false；（b）`authorize()` 不 `throw`，改为返回 `{code:-1,msg}`，或所有调用点补 `.catch`；（c）给用户一个统一的"网络/服务不可用"提示组件。

**严重级**：P1

---

### 2.3 P2

#### A-P2-01 `app.configLoadOK` 空函数覆盖链：**当前不会造成可见故障**，但机制已失效且依赖模块注入顺序

**位置与代码**

```js
// app.js:61-69
const afterConfigLoaded = () => {
  if (configuredShopName) { wx.setStorageSync('mallName', configuredShopName) }  // 64
  if (this.configLoadOK) { this.configLoadOK() }                                  // 66-68
}
```

```js
// pages/index/index.js:12-13 与 26-30（"正确写法"）
onLoad: function () {
  this.configLoadOK()                 // 13 立即自设标题
  ...
  getApp().configLoadOK = () => {     // 26 注册回调（onLoad 时注册）
    this.configLoadOK()
  }
},
configLoadOK() {                      // 30
  const configured = SHOP_CONFIG.shop && SHOP_CONFIG.shop.name
  const title = configured || wx.getStorageSync('mallName') || '卿欢蛋糕'
  wx.setNavigationBarTitle({ title })
},
```

**空函数覆盖清单（实际 8 处，非一阶段报告的 9 处；`card-info`/`user-record` 已删除）**：

| 文件:行号 | 内容 |
| --- | --- |
| `pages/goods-details/index.js:4` | `app.configLoadOK = () => { }` |
| `pages/pay/index.js:9` | 同上 |
| `pages/orders/index.js:6` | 同上 |
| `pages/current-order/index.js:6` | 同上 |
| `pages/add-note/index.js:2` | 同上 |
| `pages/order-view/index.js:6` | 同上 |
| `pages/order-view/scan-result.js:5` | 同上 |
| `pages/about-us/detail.js:6` | 同上（该文件第 5 行注释还写着"已移除未使用的 dialog 导入"） |

**取证与推理链（含实测与官方文档依据）**

1. `app.json` 未配置 `lazyCodeLoading`，主包页面 JS 在启动时被注入执行（这正是官方《[代码注入优化](https://developers.weixin.qq.com/miniprogram/dev/framework/performance/tips/start_optimizeB.html)》《[按需注入和用时注入](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/lazyload.html)》要解决的问题）。页面模块顶层代码 = `Page()` 注册 + 这 8 行赋值，**同步执行**。
2. `app.js:81` 的 `API.appConfig()` 是异步云调用，其 `.then`（`app.js:89`）必须是**后续事件循环**才执行，不可能插入到同步的启动脚本中间。
3. 冷启动进入首页的顺序为：`app.js` 求值 → `App()` 注册 → `onLaunch`（同步发起云调用、注册回调）→ 页面模块注入执行（8 个空函数依次赋值）→ `pages/index/index.js` 的 `onLoad` → **`getApp().configLoadOK` 被覆盖为"正确实现"** → 云调用返回 → `afterConfigLoaded()` → 调用的是 **index 的处理器**。
4. **结论：当前代码下 `configLoadOK` 机制"正常工作"**（准确说是"被 index 覆盖成唯一有意义的实现"），那 8 个空函数是死代码。**第一阶段报告"空函数覆盖破坏 `page.onShow()` 回调链"的说法在当前代码中不成立**：`utils/auth.js:95-97,137-139,159-161` 的 `page.onShow()` 只有传入 `page` 参数才会执行，而全项目三处调用（`app.js:119`、`pages/pay/index.js:44`、`pages/my/index.js:71` 等）**都是 `AUTH.login()`/`AUTH.authorize()` 无参调用**，`page` 恒为 `undefined`。
5. 但有两个真实的"被覆盖成空函数"隐患场景：
   - **冷启动直达二级页**（分享卡片/扫码/公众号菜单直接进入 `pages/goods-details` 等，或 `reLaunch`）：index 的 `onLoad` 不执行 → `app.configLoadOK` 保持空函数 → `app.js:67` 调了个空操作。今天无可见后果（那些页面本来就没实现内容），**但一旦某个二级页按原始模板把"配置加载完刷新"写在模块顶层，就是顺序竞态**。
   - **未来启用按需注入/分包**后页面模块改为用时注入：用户在云配置返回前进入某个二级页，该页顶层赋值会**覆盖掉 index 注册的处理器** → 首页标题刷新丢失。
6. 各页面"登录/配置加载完成后不刷新"的实际表现：**不属于"不刷新"**——`mallName` 的写入（`app.js:64`）与 8 个空 handler 无关；而所有页面标题都已在 `page.json` 里静态配置（`pages/index/index.json:3` = "卿欢蛋糕"），或由各自 `onLoad` 自行设置（`pages/address/index.js:24`、`pages/about-us/index.js:15`、`pages/current-order/index.js:35,101`）。即这套全局回调**已经是残留机制**，`mallName` 现在也只被 `pages/index/index.js:34`、`pages/about-us/index.js:14` 当作**兜底**读取（本店配置优先）。

**建议改法**：删除全部 8 处 `app.configLoadOK = () => {}` 与 `app.js:61-69` 的 `configLoadOK` 调用；需要"配置就绪后刷新"的页面统一改为 `app.onConfigReady(cb)` 或在 `onLoad` 内 `await API.appConfig()`；不要再用"模块顶层赋值 + 全局单槽回调"这种写法。

**严重级**：P2（健壮性埋雷；当前无用户可见影响，故不升为 P1，同时纠正一阶段结论）

---

#### A-P2-02 `shopInfo` 只有首页会写入，直达二级页时为空

**位置与代码**

```js
// pages/index/index.js:19-25（全项目唯一写入点）
const shop = wx.getStorageSync('shopInfo') || SHOP_CONFIG.shop
if (!wx.getStorageSync('shopInfo')) { wx.setStorageSync('shopInfo', shop) }   // 20-21
this.setData({ shop })
```

```js
// pages/orders/index.js:29（无兜底）
this.setData({ shopInfo: wx.getStorageSync('shopInfo') })   // 可为 undefined
```

对照：`pages/pay/index.js:47` 有兜底（`|| SHOP_CONFIG.shop`）。

**为什么会出问题**：`shopInfo` 是"首页副作用"产生的缓存。从分享卡片/扫码**直接进入点单页或结算页**时 storage 为空：点单页拿到 `undefined`（wxml 上 `{{shopInfo.name}}` 渲染为空），结算页虽有兜底但语义仍分裂。任何依赖 `storage.shopInfo` 的页面在冷启动路径上都不保证有值。

**触发条件**：冷启动直达非首页（`app.json:7` 起的任一页，尤其 `pages/orders`、`pages/pay`）。

**建议改法**：把"写 `shopInfo`"移到 `app.js onLaunch`（或 `utils/` 里的 `ensureShopInfo()`，每个读取点先调用），读取处统一 `|| SHOP_CONFIG.shop`。

**严重级**：P2

---

#### A-P2-03 降级时把原店后台配置键值整体写入本地 storage，只保护了 `mallName`

**位置与代码**

```js
// app.js:81-88（云分支）
API.appConfig().then(res => {
  if (res && res.code == 0 && Array.isArray(res.data)) {
    res.data.forEach(config => {
      if (config.key === 'mallName') return     // 85 ← 只跳过 mallName
      wx.setStorageSync(config.key, config.value);   // 86 ← 其它键照单全收
    })
  }
```

**为什么会出问题**：`app.js:53-57` 的注释明确承认历史坑："原逻辑从 api工厂 后台拉配置并写入 storage，而 `config.js` 目前仍指向原店铺账号，导致会把【原店名】写进 `mallName`"。现在的保护**只针对 `mallName` 一个键**。降级/legacy 模式下，原店的 `order_remark_msg`、`order_hx_uids` 等会写进本地 storage，并直接影响业务：`pages/my/index.js:106-110` 用 `order_hx_uids` 判断"扫码核销"权限，`pages/add-note/index.js:10` 用 `order_remark_msg` 渲染快捷短语——即原店的运营配置会渗透到本店小程序。

**触发条件**：`fallbackToLegacy` 生效且 legacy 通道真的可用时（见 A-P0-01：当前因未 init 而失败，但一旦 init 就会成立）。

**建议改法**：只接受白名单键（`['order_remark_msg','order_hx_uids']`）并以本店配置为唯一事实来源（像 `mallName` 一样本地优先）；或在 `data-source.js` 里增加 `allowConfigFromLegacy:false`。

**严重级**：P2

---

#### A-P2-04 云模式的 storage 约定混乱：`uid` 只写不读、`token` 永不写入、混合态残留

**位置与代码**

```js
// utils/auth.js:89-97（云模式登录）
const res = await API.userDetail('')
if (res && res.code === 0) {
  wx.setStorageSync('uid', res.data.base.id)   // 94 ← 存的是 openid（handlers.js:295 id: ctx.openid）
  if (page) { page.onShow() }
}
```

```js
// utils/auth.js:242-245
function loginOut(){ wx.removeStorageSync('token'); wx.removeStorageSync('uid') }
```

**取证**：全项目 `getStorageSync('uid')` 出现 **0 次**（仅 `set`/`remove`，见 storage 键清点）；`getStorageSync('token')` 出现 **24 次**（`utils/pay.js:16`、`components/bind-mobile/index.js:66` 及 6 个页面），而云模式下 **token 从不写入**，取值恒为 `''`。

**为什么会出问题**：注释 `auth.js:93`「缓存 openid 便于本地判断'已登录'」是失效的——没有任何地方读取它；这导致 `checkHasLogined()` 只能每次发云函数（每个页面 `onShow` 一次）来判断登录态，而"是否已登录"本可以本地短路。另外 `loginOut()` 在云模式下只清这两个键，无法清理云端身份（云模式身份由 OPENID 决定，本来也不可"登出"），UI 上若有"退出登录"会造成误解。

**触发条件**：常态。

**建议改法**：要么删除 `uid` 写入（明确"云模式登录态以云函数为准"），要么在 `checkHasLogined()` 云分支里先用 `uid` 做本地快速判断再校验；统一把"云模式没有 token"写成文档并逐步清掉 24 处 `getStorageSync('token')` 的传参。

**严重级**：P2

---

#### A-P2-05 云函数 `importData` 已注册但未纳入 api-map，且无任何鉴权

**位置与代码**

```js
// cloudfunctions/api/handlers.js:973-1009（路由表节选）
const handlers = { ... importData, ... }     // 983
```

```js
// cloudfunctions/api/index.js:121-136（入口：无 action 白名单之外的任何权限校验）
const result = await dispatch(action, payload || {}, { db: dbAdapter, openid: wxContext.OPENID, appid: wxContext.APPID })
```

**为什么会出问题**：双通道核对结果（见 2.5 节）显示：api-map 暴露 23 个 action，云函数路由表有 24 个，**唯一多余的正是 `importData`**。它虽未被前端暴露，但云函数是可被任意小程序端直接调用的（`wx.cloud.callFunction({name:'api',data:{action:'importData'}})`），而 `dispatch` 只做"action 是否存在"的判断，没有调用者身份校验。`importData` 会返回**全部集合的存在性与条数**（`handlers.js:936-944`），并可按 `checkOnly:false` 插入种子数据（幂等，`handlers.js:909-931`），构成信息泄露 + 可被刷数据面。

**触发条件**：任何人拿到 AppID + 环境 ID 后直接 `callFunction`。

**建议改法**：`importData` 应校验 `ctx.openid` 在管理员白名单内（`cloudfunctions/api/shop-config.js:36` 的 `adminOpenids`）后再执行，或干脆从生产路由表里移除、只在本地/初始化脚本里使用。

**严重级**：P2（深层权限面由审计 B 继续覆盖）

---

#### A-P2-06 `app.json` 未声明 `chooseLocation`，地址"地图选点"必然失败

**位置与代码**

```json
// app.json:18
"requiredPrivateInfos": [],
```

```js
// pages/address/edit.js:117-133
onChooseLocation() {
  wx.chooseLocation({ ... })
  // 失败分支：console.warn('[address] chooseLocation 失败', err)
  //   content: '当前小程序未声明 chooseLocation 权限，请手动填写地址，或联系开发者在 app.json 中开启该权限。'
```

**为什么会出问题**：`chooseLocation` 属于必须写入 `requiredPrivateInfos` 的隐私接口，未声明时调用直接失败（页面自己也在 `pages/address/edit.js:5-6,115` 写明了这一点）。功能上"手填地址"仍可用，故不是阻断，但"地图选点"是摆设。

**触发条件**：`pages/address/edit` 点击"地图选点"。

**建议改法**：确认隐私协议内容后，把 `"chooseLocation"` 写入 `app.json` 的 `requiredPrivateInfos`，并在小程序后台配置"用户隐私保护指引"；若决定不提供该能力，则删掉入口与代码。

**严重级**：P2

---

#### A-P2-07 `utils/pay.js` 失败路径把原始返回体弹给用户，且成功提示与订单状态无关

**位置与代码**

```js
// utils/pay.js:42-45
console.error(aaa)
wx.showToast({ title: '支付失败:' + aaa })     // 44 ← aaa 是对象 → "支付失败:[object Object]"
```

```js
// utils/pay.js:52-60
success: function () {
  wx.showToast({ title: '支付成功' })          // 54 ← 仅凭客户端回调
  wx.reLaunch({ url: redirectUrl });           // 57
}
```

```js
// utils/pay.js:63-72
wx.showModal({ title: '出错了', content: JSON.stringify(res), showCancel: false,
  success (res) { wx.reLaunch({ url: redirectUrl }) } })
```

**为什么会出问题**：501/网络失败时用户看到 `{"code":501,"msg":"云开发支付尚未接入…"}` 这样的原始 JSON（A-P0-02 的实际观感）；`fail` 回调里 `'支付失败:' + aaa` 直接拼对象得到 `[object Object]`。另外 `success` 只做客户端提示就跳转，未与服务端订单状态核对（`handlers.js:100-119` 的回调会把 status 改成"制作中"，但前端不查询）。

**触发条件**：任何支付失败/未接入场景。

**建议改法**：失败文案走业务化映射（`res.msg`）；`'支付失败:' + (aaa && aaa.errMsg || '')`；`success` 后改为跳转订单页并轮询/查询订单状态再提示。

**严重级**：P2

---

#### A-P2-08 有效基础库版本由 `project.private.config.json` 决定；`urlCheck:false` 掩盖域名问题

**位置与代码**

```json
// project.config.json:61 / project.private.config.json:23
"libVersion": "3.8.1"        // project.config.json
"libVersion": "3.17.3"       // project.private.config.json ← 按官方说明覆盖前者
```

```json
// project.config.json:21 与 project.private.config.json:7
"urlCheck": false
```

**为什么会出问题**：（a）两处 `libVersion` 冲突，实际生效的是私有文件里的 `3.17.3`，而 `project.private.config.json` 按官方约定属于"不应提交/可被覆盖"的本地文件，于是**审核与真机所用的基础库版本不受版本控制**（另一位开发者/CI 打开工程可能得到 3.8.1）；（b）`urlCheck:false` 关闭合法域名校验，使 A-P0-01 中"降级请求打向 `api.it120.cc/-/`"在开发期看起来一切正常，正式版才被域名校验拦住。

**触发条件**：换开发机、CI 构建、上传体验版。

**建议改法**：统一 `libVersion` 到一个受控值（写在 `project.config.json`，私有文件不参与），确认该版本号在开发者工具中存在；把 `urlCheck` 在提交前改回 `true` 以暴露域名问题。

**严重级**：P2

---

### 2.4 P3

#### A-P3-01 `utils/auth.js:8` 未使用的 vant Dialog 死 import

```js
import Dialog from '@vant/weapp/dialog/dialog'   // utils/auth.js:8，全文件仅此一处出现 Dialog
```

`pages/about-us/detail.js:5` 的注释已做过同类清理（"已移除未使用的 @vant/weapp dialog 导入"），`utils/auth.js` 漏网。`auth.js` 被 6 个页面 + 组件引用，这个 import 会把 vant dialog 组件代码拉进主包引用链（包体），且在 CommonJS 文件里混用 ESM `import`，风格不一致。**建议**：删除该行。**级别**：P3。

#### A-P3-02 legacy 适配层的死导出与注释不符

```js
// utils/services/legacy-apifm.js:35-36
init: (subDomain) => WXAPI.init(subDomain),
setMerchantId: (merchantId) => WXAPI.setMerchantId(merchantId),
```

```js
// utils/api-map.js:178（注释）
* api 工厂 模式下由 app.js 直接调 LEGACY.init()（本函数不做任何事）。
```

实际 `app.js:21-22` 直接调用的是 `WXAPI.init/setMerchantId`（不是 `LEGACY.init`），且全项目 `LEGACY.init` / `LEGACY.setMerchantId` **无任何调用点**；`LEGACY.login_wx`、`wxappServiceLogin`、`wxappServiceAuthorize`、`wxappServiceBindMobile` 同样无调用点。**建议**：删除死导出，或让 `app.js` 改为调用 `LEGACY.init` 以兑现注释。**级别**：P3。

#### A-P3-03 `LEGACY.login` 传空 code

```js
// utils/services/legacy-apifm.js:64
login: () => WXAPI.login_wx(''),   // 空 code 必然换不到 token
```

`api-map.js:356-359` 的 legacy 分支正是 `() => LEGACY.login()`。当前无调用方（全项目无 `API.login(` 调用点），但一旦使用就是"静默登录失败"。**建议**：删除该导出，或改为内部 `wx.login` 取 code。**级别**：P3。

#### A-P3-04 注释仍指向已删除的 mock 层；`callMock` 反模式

```js
// utils/data-source.js:7  →  1. Mock —— 本地内存假数据（utils/mock-backend.js）
// utils/api-map.js:9,63    →  useMock=true → utils/mock-backend.js（本地假数据）/ 阶段三补齐 call()
function callMock(action, payload) { void action; void payload; return Promise.resolve({ code: 501, ... }) }  // 66-73
```

`utils/mock-backend.js` 已被删除（`Test-Path` 为 False），注释与现存的 `void` 占位属于文档漂移。**建议**：删除 mock 通道与相关注释，或补齐实现。**级别**：P3。

#### A-P3-05 云环境 ID 硬编码且多处重复

```js
// utils/data-source.js:61
cloudEnvId: 'cloud1-d7g2txuxpf22bb979',
```

同一 ID 还出现在 `docs/云开发初始化清单.md:5,15,36,116`（后者是云存储 `cloud://cloud1-…` 路径前缀），AppID `wx5b0e027deafefc01` 出现在 `project.config.json:62`、`docs:4,13,28`。切企业号需改的地方文档写的是 3 处（`docs:146-154`），但**云存储文件路径里残留的环境 ID 不会被任何检查发现**。**建议**：环境 ID 走单一配置源；文档里的存储路径改为占位说明。**级别**：P3。（另：`wx.cloud.init` 传的是硬编码 ID，与 `project.config.json:62` 的 AppID 是否属于同一环境**无法从代码判断**，见待验证 T-02。）

#### A-P3-06 全局标题为空字符串，两个页面标题依赖运行期结果

```json
// app.json:22
"navigationBarTitleText": "",
```

`pages/about-us/index.json`、`pages/about-us/detail.json` 的标题为空，靠 `pages/about-us/index.js:15` 与 `pages/about-us/detail.js:27-29` 在运行期设置；`cmsPage` 返回非 0（`pages/about-us/detail.js:23` 无 else 分支）时标题保持空白。**建议**：给两页补静态标题兜底，并给 `cmsPage` 失败分支加提示。**级别**：P3。

#### A-P3-07 `console.log` 残留与已删除分支的死字段

```js
// pages/pay/index.js:229
console.log(e.detail); // 这里是组件里data的数据
// utils/pay.js:18,27
remark: "在线充值",          // 充值分支已在阶段二删除（utils/pay.js:6），此默认值仍保留
postData.payName = postData.remark;
```

**建议**：删除调试日志与死字段。**级别**：P3。

---

### 2.5 双通道一致性逐项核对（对应任务重点 5）

核对方法：用脚本从 `utils/api-map.js` 提取全部 `callCloud('X')` 与 `LEGACY.y` 引用，与 `cloudfunctions/api/handlers.js:973-1009` 的路由表、`utils/services/legacy-apifm.js` 的导出逐一比对；再用 `node` 清点 apifm SDK 的方法面。

**结论：api-map 使用的 23 个 action 在云函数侧与 legacy 侧都有实现，没有"某 action 只有一边实现"的缺口。**

| api-map 方法（行号） | 云 action | 云侧实现 | legacy 侧 | 备注 |
| --- | --- | --- | --- | --- |
| `goodsCategoryV2` :210 | `categoryList` | ✅ handler:76 | ✅ 适配层:40 | legacy 依赖 SDK 版本（A-P1-04） |
| `goodsv2` :218 | `goodsList` | ✅ :95 | ✅ :41 | 同上 |
| `goodsDetailV2` :230 | `goodsDetail` | ✅ :142 | ✅ :42 | 同上 |
| `shippingCarInfo` :239 | `cartInfo` | ✅ :205 | ✅ :45 | — |
| `shippingCarInfoAddItemV2` :244 | `cartAdd` | ✅ :214 | ✅ :46 | legacy 依赖 SDK 版本 |
| `shippingCarInfoModifyNumber` :256 | `cartModifyNumber` | ✅ :257 | ✅ :47 | — |
| `shippingCarInfoRemoveItem` :262 | `cartRemoveItem` | ✅ :272 | ✅ :49 | — |
| `shippingCarInfoRemoveAll` :267 | `cartRemoveAll` | ✅ :280 | ✅ :50 | — |
| `orderCreate` :273 | `orderCreate` | ✅ :490 | ✅ :53 | 服务端重算价（`handlers.js:533,604`） |
| `orderList` :278 | `orderList` | ✅ :663 | ✅ :54 | 云侧只透传 `statusBatch`（`:281`） |
| `orderDetail` :286 | `orderDetail` | ✅ :694 | ✅ :55 | — |
| `orderClose` :293 | `orderClose` | ✅ :720 | ✅ :56 | — |
| `orderDelete` :298 | `orderDelete` | ✅ :730 | ✅ :57 | — |
| `orderHXV2` :303 | `orderHx` | ✅ :747 | ✅ :58 | — |
| `wxpay` :322 | `wxpay` | ⚠️ **501 桩** :449 | ✅ :61 | 用 `pickCloudOnly`，云模式不降级（**A-P0-02**） |
| `userDetail` :332 | `getUser` | ✅ :292 | ✅ :66 | 云侧 `data.base.id = openid` |
| `modifyUserInfoV2` :341 | `updateUser` | ✅ :316 | ✅ :67 | legacy 依赖 SDK 版本 |
| `login` :356 | `getUser` | ✅ :292 | ⚠️ `WXAPI.login_wx('')` :64 | 无调用方（A-P3-03） |
| `bindMobile` :370 | `bindMobile` | ⚠️ **501 桩** :433 | ✅ :76 | `pickCloudOnly` |
| `banners` :379 | `banners` | ✅ :341 | ✅ :80 | — |
| `appConfig` :389 | `appConfig` | ✅ :369 | ✅ :84 | 云侧三键来源 `shop-config.js` |
| `cmsPage` :399 | `cmsPage` | ✅ :406（占位文案） | ✅ :81 | 失败时页面无提示（A-P3-06） |
| `fetchShops` :409 | `fetchShops` | ⚠️ 空数组桩 :465 | ✅ :82 | 前端已无调用方 |
| `shopSubdetail` :418 | `shopSubdetail` | ⚠️ 固定 fail :474 | ✅ :83 | `pages/current-order/index.js:144` 已改为读本地配置 |
| **（云侧多余）** | `importData` | ✅ :784 | ❌ 无 | **未纳入 api-map 且无鉴权（A-P2-05）** |

`orderPay` / `orderPayV2` / `userAmount` / `scoreLogs`：**双通道一致地已删除**，全项目仅剩注释（`handlers.js:334,757`、`api-map.js:308,361`、`pages/pay/index.js:369-371`、`pages/current-order/index.js:183-186,203`），无残留调用。

**真实缺口汇总（仅 3 条）**：
1. `wxpay` / `bindMobile` 云侧是 501 桩（P0-02 / P2 级）；
2. `importData` 只在云侧存在、且未纳入 api-map、且无鉴权（P2-05）；
3. legacy 侧有 12 个方法在当前 `node_modules` 版本中**不存在**（P1-04，属依赖层缺口而非映射缺口）。

---

## 三、待验证清单（需在微信开发者工具/真机验证）

| 编号 | 要验证什么 | 具体怎么做 | 影响哪条结论 |
| --- | --- | --- | --- |
| T-01 | **页面模块注入时机**：主包页面 JS 是否在 `onLaunch` 之后、首页 `onLoad` 之前全部执行 | 在 `app.js` onLaunch 首行、每个页面模块顶层、`pages/index/index.js` onLoad 首行各加一条 `console.log(时间戳/标记)`，冷启动看控制台顺序；再对「分享直达 `pages/goods-details`」重复一次 | A-P2-01（当前判定为"正常工作/死代码"，若顺序相反则升为 P1） |
| T-02 | **环境 ID 与 AppID 是否匹配** | 开发者工具 → 云开发控制台，确认 `cloud1-d7g2txuxpf22bb979` 是否属于 `wx5b0e027deafefc01`；再在真机预览下打开首页看云函数是否报 `env not exists`/`-501005` | A-P0-01、A-P3-05 |
| T-03 | **云函数是否已部署**：未部署时的实际表现 | 不部署 `cloudfunctions/api`，真机预览打开首页，观察是否出现「云开发不可用，已临时降级」+「无法登录」两个弹窗、首页是否无数据 | A-P0-01、A-P1-01~03、A-P1-06（本文的推理链中"未部署"是最容易命中的触发条件） |
| T-04 | **降级请求在真机上的真实结果** | 真机（**非调试模式**、体验版）触发一次降级，看 `wx.request` 是否报 `url not in domain list`（合法域名未配置 `api.it120.cc`）；在 IDE 里把 `urlCheck` 设为 true 复现一次 | A-P0-01（本文只证明了 URL 是 `https://api.it120.cc/-/…`，未证明服务端返回体） |
| T-05 | **运行时真正加载的 apifm 版本** | 开发者工具控制台执行 `Object.keys(require('apifm-wxapi')).length`（预期 849 = 旧构建；229 = node_modules 的 3.8.0），再执行一次「工具 → 构建 npm」后重测 | A-P1-04（判定崩坏范围） |
| T-06 | **`project.config.json` 忽略 `cloudfunctions` 是否影响云函数上传** | 保持 `packOptions.ignore` 含 `cloudfunctions`，右键 `cloudfunctions/api` → 「上传并部署：云端安装依赖」，看是否报找不到云函数/空包；再临时移除该忽略项对比 | 本文未定级；确认后若失败则新增 P1 |
| T-07 | **`libVersion` 3.17.3 是否有效** | 开发者工具「详情 → 本地设置 → 调试基础库」下拉是否出现 3.17.3；`project.private.config.json` 删除后是否退回 3.8.1 | A-P2-08 |
| T-08 | **重复下单是否真的发生** | 结算页 1 秒内连点两次「结算」，到云开发控制台 `order` 集合确认是否生成 2 条订单、`goods.stores` 是否被扣两次 | A-P1-05 |
| T-09 | **legacy 支付通道的金额信任边界** | 核对 api 工厂 `/pay/wx/wxapp` 是否以客户端 `money` 为准（`utils/pay.js:18` 把页面 `dataset.money` 原样上传，`pages/current-order/index.js:182` 取值来源是视图数据）；若是，则 legacy 通道存在改价风险 | 本文未定级（仅 legacy 通道；云通道已 501） |
| T-10 | **`order_remark_msg` / `order_hx_uids` 是否真的会被原店值污染** | 在 IDE 下临时 `useCloud=false` + `fallbackToLegacy` 生效，打印 `wx.getStorageSync('order_remark_msg')` / `order_hx_uids`，对比原店后台配置 | A-P2-03 |

---

## 四、建议修复顺序

**第 0 步（上线安全闸，1 小时内可完成）**
1. `utils/data-source.js:39` `fallbackToLegacy: false` —— 立即消除"写操作有第二条通道"的隐患（A-P0-01、A-P1-02、A-P2-03 一起降级）。
2. `utils/auth.js:16` 改为 `return API.__isCloudMode()` —— 修掉降级后鉴权走错分支（A-P1-01）。
3. `utils/api-map.js:105` 的降级判定与 `callCloud` 的错误码拆分（A-P1-02）；若要保留降级，按 A-P0-01 的建议限定为只读接口。

**第 1 步（阻断上线项）**
4. 微信支付接入（A-P0-02）：换企业主体 + 商户号 + `cloud.cloudPay` + 接 `handlePayCallback`（`cloudfunctions/api/index.js:100-119`）。
5. 结算前拦截 + 防重复提交锁（A-P1-05）。
6. `checkHasLogined` / `authorize` 的异常兜底与 `.catch`（A-P1-06）。

**第 2 步（依赖与工程可控）**
7. 对齐 apifm-wxapi 三处版本并重建 `miniprogram_npm`；此后**所有** `WXAPI.*` 调用点补存在性判断（A-P1-04）。
8. 统一 `libVersion`、恢复 `urlCheck`、确认 `packOptions.ignore` 与云函数上传（A-P2-08、T-06）。

**第 3 步（数据层收尾）**
9. 删除 `configLoadOK` 全局回调机制与 8 处空赋值（A-P2-01）。
10. `shopInfo` 的写入移到启动层（A-P2-02）；storage 键整理（A-P2-04）。
11. `importData` 加管理员校验或移出生产路由（A-P2-05）。
12. `app.json` 补 `chooseLocation` 声明（A-P2-06）；`utils/pay.js` 失败文案（A-P2-07）。

**第 4 步（整洁度，随手清理）**
13. A-P3-01 ~ A-P3-07：死 import、死导出、死注释、死字段、`console.log`、环境 ID 集中化、标题兜底。

---

### 附：本次审计用到的复现命令（只读，不落盘）

```powershell
# 1) 复现"云失败 → 降级 → 请求打到 it120.cc/-/"（桩化 wx，从 stdin 执行，不写文件）
#    见正文 A-P0-01 的取证输出
# 2) 清点 SDK 方法面
node -e "const W=require('apifm-wxapi');console.log(Object.keys(W).length)"
node -e "const W=require('./miniprogram_npm/apifm-wxapi/index.js');console.log(Object.keys(W).length)"
# 3) 交叉核对 api-map 的 action 与云函数路由表（require cloudfunctions/api/handlers）
```

> 本报告全部结论均来自对上述文件的直接阅读与上述命令的输出；不确定项已全部列入第三节，未做任何推测性定级。
