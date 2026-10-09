# 第二阶段审计报告 C —— 页面 + 组件 + 交互

> 审计对象：`bread-main/pages/**`（14 个注册页面）、`bread-main/components/**`、`bread-main/template/tabbar/**`、`bread-main/images/**`、`bread-main/app.wxss`
> 审计方式：**严格只读**（列目录 / 读文件 / 文本检索 / 临时 Node 静态校验脚本，脚本写在系统临时目录，未写入 `bread-main/`）
> 审计基准：当前代码（第二阶段已删除 `utils/mock-backend.js`、`utils/tools.js`、`utils/image.js` 与 `pages/card`、`pages/card-info`、`pages/user-record`、`pages/all-stores`；`utils/data-source.js` 的 `useCloud = true`）
> 报告日期：2026-10-09
> 本次审计未修改 `bread-main/` 下任何文件。

工具证据（可复现）：
- 事件绑定静态校验：全项目 wxml 的 `bind*`/`catch*` 处理函数逐个比对同名 js，结果 **MISSING HANDLER = 0 处**。
- 路由一致性校验：`app.json` 14 条路由四件套（js/wxml/json）**全部存在**；所有 `/pages/...` 跳转目标 **全部已注册**；无"注册但无引用"页面。
- WXSS 重复规则扫描：`pages/**` + `app.wxss`（19 个 wxss）中，≥40 字符的**完全相同规则体 28 处**。
- 图片引用校验：wxml/wxss/js 共引用 15 个 `/images/*`，**无缺失**；磁盘 19 张，4 张未被引用。

---

## 一、结论摘要

### 分级计数

| 级别 | 数量 | 含义 |
|---|---|---|
| **P0 阻断上线** | **2** | 交易/履约闭环在云开发模式下完全跑不通 |
| **P1 影响正确性** | **9** | 可稳定复现的错误行为、错误文案、规则失效 |
| **P2 健壮性** | **8** | 边界/异常路径崩溃、无空态错误态、合规与风控缺口 |
| **P3 整洁度** | **15** | 死代码、重复、残留日志、样式与文案瑕疵 |

### 最致命的 5 条结论

1. **【P0-1】云开发模式下没有任何支付通道，订单永久停在「待支付」。**
   `cloudfunctions/api/handlers.js:449-451` 的 `wxpay` 固定返回 `code 501`「云开发支付尚未接入」；`utils/pay.js:32-74` 拿到非 0 后弹「出错了」+ 原始 JSON，然后 `reLaunch` 回订单列表；阶段二已删除 `orderPay` action（`handlers.js:757-762`），`handlePayCallback`（`cloudfunctions/api/index.js:100-119`）**没有任何下单调用方**，永远不会被触发。净效果：**顾客下的每一单都停在 status=0「待支付」，商家永远收不到钱、也看不到"待制作"的订单**；顾客在「我的 → 待付款」里能反复点「再次支付」，每点一次都只弹一次报错弹窗。
2. **【P0-2】核销闭环整体不可用（两个独立原因叠加）。**
   (a) 入口被白名单门控且白名单为空：`cloudfunctions/api/shop-config.js:36` `adminOpenids: []` → `appConfig` 返回 `order_hx_uids: ''` → `pages/my/index.js:106-110` `canHX` 恒为 `false` → `pages/my/index.wxml:38` 的「扫码核销」入口**永远不显示**，商家根本没有核销入口。
   (b) 即便有入口，核销码也画不出来：`pages/order-view/index.js:51-55` **先调 `wxbarcode.qrcode()` 再 `setData({orderDetail})`**，而画布在 `wx:if` 里（`index.wxml:156-166`），绘制时节点尚不存在；且条件是 `status > 0 && status < 3`，在 P0-1 修复前恒为 false。
3. **【P1-1】点单页点「全部商品」不刷新商品列表。** `pages/orders/index.js:64-76` 在 `id == '0'` 时 `setData({cid: ''})` 后直接 `return`，**没有调用 `getGoodsList()`**。用户先点某个分类、再点「全部商品」，右侧仍是上一个分类的商品 → 容易误下单。
4. **【P1-2】结算页选完收货地址后，「详细地址」显示的是旧地址（或空白）。** `pages/address/index.js:93-100` 只给上一页 `setData({selectedAddress})`，**没有同步 `addressText`**；`pages/pay/index.js:74-79` 因为 `selectedAddress` 已存在而跳过 `applyAddress()`，`pages/pay/index.wxml:45-47` 于是渲染出陈旧的 `addressText`。外送订单的地址快照来自 `selectedAddress`（正确），**但顾客在屏幕上核对的那一行地址是错的**。
5. **【P1-3】自提（默认、主要场景）完全不校验自取时间，蛋糕「提前 3 小时」规则在自提路径失效。** `pages/pay/index.js:244-276` 的时间校验整段包在 `if (this.data.isDelivery)` 里；自提单可以直接下单，`extJson['自取时间']` 写入默认值 `'请选择'`（`pages/pay/index.js:15,306`）。同时订单里存的是**相对文案**（`pages/select-time/index.js:126-128` 存 `"今天 15:00"`），商家隔天核对订单无法确定具体日期。

---

## 二、上阶段（第一阶段报告）页面级缺陷复核表

| # | 第一阶段结论 | 现状判定 | 现状证据（行号） |
|---|---|---|---|
| a | `pages/goods-details/index.js` 未定义变量 `e`，未登录加购抛 ReferenceError | **已修** | `pages/goods-details/index.js:143-150`：`const isLogined = await AUTH.checkHasLogined()` … `AUTH.authorize().then(() => { this.addCart() })`，`addCart()` 已无参数，`e` 不再出现 |
| b | `bind:close="onClose"` 缺处理函数（orders / goods-details） | **已修** | `pages/orders/index.js:206-210`、`pages/goods-details/index.js:257-267` 均已实现；静态校验全项目 `MISSING-HANDLER = 0` |
| c | `pages/orders/index.wxml` 的 `shopNotice` 从未 setData | **仍在** | `pages/orders/index.wxml:48` `wx:if="{{ shopNotice }}"`；全项目检索 `shopNotice` **仅此一处命中**，任何 js 都未赋值 → 公告块永不显示 |
| d | 9 处 `app.configLoadOK = () => {}` 空函数覆盖 | **部分修 + 危害已降级** | 页面从 9 处减为 **8 处**（`card-info`/`user-record` 已删）：`about-us/detail.js:6`、`add-note/index.js:2`、`current-order/index.js:6`、`goods-details/index.js:4`、`order-view/index.js:6`、`order-view/scan-result.js:5`、`orders/index.js:6`、`pay/index.js:9`。**但第一阶段给它定的"高"危害已不成立**：`auth.js:96/138/160` 的 `page.onShow()` 只在 `AUTH.login(page)` 传了 page 时才执行，而全项目两处调用（`app.js:119`、`pages/pay/index.js:44`）**都没传 page**，所以该回调链当前根本不会被触发 → 现阶段属**整洁度问题（P3）**，不是缺陷 |
| e | `pages/order-view` 与 `scan-result` 中 `return` 之后不可达的 `getDistance` / `toRadians` | **已修** | 两文件的 `getDistance`/`toRadians` 代码段已整体删除，只剩说明注释（`pages/order-view/index.js:60-63`、`pages/order-view/scan-result.js:49-52`）；全项目检索 `toRadians`/`getDistance` 无代码命中 |
| f | `import Dialog` 导入但从未调用 | **部分修** | 6 个页面的导入**已全部删除**；**`utils/auth.js:8` 仍在**（`import Dialog from '@vant/weapp/dialog/dialog'`，全文件无第二处 `Dialog` 使用）。该文件属审计 A 范围，此处仅交叉记录 |
| g | `pages/index` 的 `if (false)` 与 `wx:if="{{false}}"`（附近门店/所有门店/距离卡片） | **已修** | `pages/index/index.wxml:31-34` 只剩删除说明；全项目 grep `wx:if="{{false}}"`、`if (false)` **零命中** |
| h | `card` / `card-info` / `user-record` / `all-stores` 孤立页面与残留跳转 | **已修** | `app.json` 现 14 条路由；全项目检索 `card-info` / `user-record` / `all-stores` **仅命中 2 处注释**（`pages/index/index.wxml:33`、`utils/services/legacy-apifm.js:13`），**无任何 navigateTo/redirectTo/switchTab 指向已删除页面**；路由一致性脚本：跳转目标全部已注册 |
| i | `pages/about-us/detail.js:22` 直连 `WXAPI.cmsPage`（云开发下必空白） | **已修（接法）／P1 仍在（内容）** | `pages/about-us/detail.js:20-31` 已改走 `API.cmsPage(key)`；云函数 `handlers.js:406-420` 从 `cloudfunctions/api/shop-config.js:42-51` 取文案，但该文案是**占位符**「（内容待补充）」→ 见 C-P1-9 |
| j | `components/bind-mobile` 直连 `WXAPI.bindMobileWxappV2`（云开发下必失败） | **已修（接法）／功能仍缺** | `components/bind-mobile/index.js:65-70` 已改走 `API.bindMobile`；云函数 `handlers.js:433-435` 返回 `501`「云开发模式下手机号绑定尚未接入」→ 见 C-P1-8 / C-P2-x |
| k | 页面直连 `apifm` / `WXAPI` 的残留 | **已修** | 在 `pages/**`、`components/**` 中检索 `WXAPI`：**仅命中 20+ 条 api 工厂文档注释**，无任何真实调用 |
| l | `pages/current-order` 走 `API.shopSubdetail` 取门店电话（云开发必失败） | **已修** | `pages/current-order/index.js:147-165` 改读 `SHOP_CONFIG.shop.phone` |
| m | `pages/current-order` 的 tab `'0, 1, 2'` / `'-1, 3, 4'` 与云函数状态机不匹配 | **部分修（BUG 仍在）** | `pages/current-order/index.js:56-62` 仍是 `'0, 1, 2'` / `'-1, 3, 4'`。实测云函数只产生 `0 / -1 / 3`（`handlers.js:620,726,753`，`1` 仅存在于不可达的 `cloudfunctions/api/index.js:116`）→ 见 C-P1-6 |
| n | `pages/my` 的 `getUserProfile`（受限接口） | **仍在** | `pages/my/index.js:117-131`；全项目仅此一处 |
| o | 页面级 `updateUserInfo` 重复（my ↔ card） | **已消除** | `pages/card` 已删除，现仅 `pages/my/index.js:116-149` |
| p | 页面级 `bindMobile` 三方法重复（pay ↔ card-info） | **已消除** | 现仅 `pages/pay/index.js:223-239` |
| q | 页面级 `userDetail` 重复（5 处） | **部分修** | 减为 2 处：`pages/my/index.js:103-113`、`pages/pay/index.js:214-222` |
| r | `syncDeliveryMode`/`onModeChange` 重复（orders ↔ pay） | **仍在** | `pages/orders/index.js:39-54` ↔ `pages/pay/index.js:144-161`（近乎逐字重复） |
| s | `shopMarkers`/`shop` data 定义逐字相同（order-view ↔ scan-result） | **仍在** | `pages/order-view/index.js:11-28` ↔ `pages/order-view/scan-result.js:10-27` |
| t | 页面级订单状态映射各写一遍 | **仍在** | `pages/current-order/index.js:73-80`（`1→制作中`、`3→交易成功`）↔ `pages/order-view/index.js:44-49`；而云函数已返回 `statusStr`（`handlers.js:683,706`）→ 前端这段是冗余覆盖 |
| u | 「订单入口状态」三处硬编码 | **仍在** | `pages/my/index.js:30-35`（`'0','1','3','all'`）↔ `pages/current-order/index.js:24-29`（`TITLES`）↔ `pages/current-order/index.js:56-62` |
| v | WXSS 重复规则块（第一阶段：14 组） | **仍在（扩大到 28 处）** | 扫描结果：`pages/**` + `app.wxss` 中 ≥40 字符的完全重复规则体 **28 处**，其中绝大多数是 `pages/order-view/index.wxss` + `scan-result.wxss` + `pages/pay/index.wxss` 三页共有（如 `width:670rpx;height:2rpx;background-color:#ebebeb;margin-left:40rpx;`） |
| w | `console.log` 调试残留 | **仍在（已收敛）** | 页面侧由 20 个文件收敛到 **9 处 / 6 个文件**，清单见 C-P3-4；另 `components/parser.20200414.min/parser.js` 为第三方压缩文件内含 `console.warn`（不建议手改） |
| x | 多规格商品详情（第一阶段认定"已完成"） | **已复核，无回归** | `pages/goods-details/index.js:41-57,120-140` 多组规格构建/汇总完整；`pay/index.js:286-292` 拼接全部规格；云函数 `handlers.js:49-61` 计价规则「基础价 + 各选中项 priceDelta」与前端 `updateSelectedText`（`goods-details/index.js:105-118`）一致 |
| y | `utils/tools.js` / `utils/image.js` 死文件 | **已删除** | `utils/` 现有 8 个文件：address / api-map / auth / data-source / delivery / delivery-range / pay / services/legacy-apifm |
| z | `pages/index/index.js:104` `if(false)` 包 `fetchShops` | **已修** | `pages/index/index.js:15-18,65` 只剩删除说明 |

---

## 三、新发现缺陷清单

### 3.1 总表

| 编号 | 级别 | 标题 | 位置 |
|---|---|---|---|
| C-P0-1 | P0 | 云开发模式下无支付通道，订单永久停留在「待支付」 | `utils/pay.js:32-74`、`cloudfunctions/api/handlers.js:449-451`、`pages/pay/index.js:373` |
| C-P0-2 | P0 | 核销闭环不可用（入口白名单为空 + 核销码画布绘制时机错误） | `cloudfunctions/api/shop-config.js:36`、`pages/my/index.js:106-110`、`pages/order-view/index.js:51-55` |
| C-P1-1 | P1 | 点单页「全部商品」不刷新商品列表 | `pages/orders/index.js:64-76` |
| C-P1-2 | P1 | 选完收货地址后结算页「详细地址」不同步（显示旧地址/空白） | `pages/address/index.js:93-100`、`pages/pay/index.js:74-79`、`pages/pay/index.wxml:45-47` |
| C-P1-3 | P1 | 自提订单不校验自取时间，蛋糕提前 3 小时规则在自提路径失效 | `pages/pay/index.js:244-276`、`:306` |
| C-P1-4 | P1 | 时段列表无条件要求「现在 + 3 小时」，非蛋糕订单也选不到近期时段 | `utils/delivery-range.js:445-467` |
| C-P1-5 | P1 | `wx.getUserProfile` 已匿名化 →「我的」页永远显示「点击登录」 | `pages/my/index.js:117-131`、`pages/my/index.wxml:15` |
| C-P1-6 | P1 | 订单状态机：`status=1` 永不产生（「待取货」永远空）+ 同一状态两处文案不一致 | `handlers.js:620,726,753`、`pages/my/index.js:30-35`、`pages/current-order/index.js:56-62,73-80` |
| C-P1-7 | P1 | 订单快照里的「自取时间」是相对文案（今天/明天 HH:MM），无绝对日期 | `pages/select-time/index.js:126-128`、`pages/pay/index.js:306,328` |
| C-P1-8 | P1 | 未绑定手机号也能下单，订单「联络电话」写入 `-`（外送靠电话确认地址） | `pages/pay/index.js:15,305`、`components/bind-mobile/index.js:65-82` |
| C-P1-9 | P1 | 用户隐私协议/常见问题正文为占位文案「（内容待补充）」 | `cloudfunctions/api/shop-config.js:42-51` |
| C-P2-1 | P2 | 结算页在购物车未加载成功时点「结算」抛 TypeError | `pages/pay/index.js:280` |
| C-P2-2 | P2 | 商品详情数据未加载成功时点「加入购物车」抛 TypeError | `pages/goods-details/index.js:152` |
| C-P2-3 | P2 | 列表为空数组时不显示空态（点单页商品、订单页订单） | `pages/orders/index.wxml:80`、`pages/current-order/index.wxml:10` |
| C-P2-4 | P2 | 订单详情/结算页无错误态：接口失败后整页空白无提示 | `pages/order-view/index.js:40-59`、`pages/pay/index.js:162-213` |
| C-P2-5 | P2 | 支付失败提示为「出错了」+ 原始 JSON（掩盖真实原因，与 `utils/pay.js` 注释自述不符） | `utils/pay.js:62-73` |
| C-P2-6 | P2 | 自定义 tabbar：点当前 tab 也 `reLaunch` 整页（`curIndex` 守卫恒不生效） | `app.js:123-136`、`template/tabbar/index.wxml:2`、`miniprogram_npm/@vant/weapp/tabbar-item/index.js` |
| C-P2-7 | P2 | 「用户编号」直接展示原始微信 OPENID | `cloudfunctions/api/handlers.js:295`、`pages/my/index.wxml:20` |
| C-P2-8 | P2 | 全项目无 `onShareAppMessage` / `onShareTimeline`（无法转发分享） | `pages/**/*.js`（零命中） |
| C-P3-1 | P3 | `shopNotice` 从未 setData，店铺公告块永不显示 | `pages/orders/index.wxml:48` |
| C-P3-2 | P3 | 8 处 `app.configLoadOK = () => {}` 空覆盖（现无功能影响） | 见复核表 d |
| C-P3-3 | P3 | `utils/auth.js:8` 未使用的 `Dialog` 导入 | `utils/auth.js:8`（交叉记录） |
| C-P3-4 | P3 | `console.*` 残留 9 处 | 见 3.4 |
| C-P3-5 | P3 | 关于我们页硬编码版本号 `Version 1.0 17:30:54` | `pages/about-us/index.wxml:15` |
| C-P3-6 | P3 | 4 张图片资源未被任何文件引用 | `images/icon-font-solid.png`、`icon-font-solid@2x.png`、`logo@2x.png`、`rectangle@2x.png` |
| C-P3-7 | P3 | `app.json` 全局注册的 `van-dialog` / `van-datetime-picker` 已无任何 wxml 使用 | `app.json:35-36` |
| C-P3-8 | P3 | 页面级重复代码 7 组（配送同步/门店载入/userDetail/状态映射/shopMarkers/TITLES/WXSS） | 见复核表 r、s、t、u、v、q |
| C-P3-9 | P3 | `pages/address/edit.js` 的 `refreshAreaText()` 是孤立方法（无人调用） | `pages/address/edit.js:90-95` |
| C-P3-10 | P3 | 地址页提示「省市区与详细地址至少填其一即可下单」与 `onSave` 校验矛盾 | `pages/address/edit.wxml:66` vs `pages/address/edit.js:160-163` |
| C-P3-11 | P3 | `pay` 页 `onShow` 直接写 `this.data.code`（死数据）且每次显示都调 `wx.login` | `pages/pay/index.js:56-58` |
| C-P3-12 | P3 | `current-order` 的 `filterTitle` 死数据、`data-id="{{item.shopIdZt}}"` 死 dataset | `pages/current-order/index.js:20,33`、`pages/current-order/index.wxml:36` |
| C-P3-13 | P3 | `pages/orders/index.js` 的 `addCart()` 已成孤儿方法（wxml 已改绑 `goDetail`） | `pages/orders/index.js:296-343` |
| C-P3-14 | P3 | `pay` 页底部固定栏未适配 iPhone 安全区 | `pages/pay/index.wxss:281-292` |
| C-P3-15 | P3 | 首页「开始点单」用 `navigator` 入栈，底部 tabbar 用 `reLaunch`，两条路径返回行为不一致 | `pages/index/index.wxml:24-26` vs `app.js:133-135` |

---

### 3.2 P0 详细

#### C-P0-1 云开发模式下无支付通道，订单永久停留在「待支付」

**证据（关键片段）**

`cloudfunctions/api/handlers.js:449-451`
```js
async function wxpay(payload, ctx) {
  return fail('云开发支付尚未接入：需先申请微信支付商户号并配置云开发支付（cloud.cloudPay）', 501)
}
```
`pages/pay/index.js:363-373`
```js
  await API.shippingCarInfoRemoveAll(token)
  wx.showToast({ title: '下单成功！', icon: 'success' })
  // 2026-09-26 阶段二：已删除会员余额支付分支。……
  wxpay.wxpay('order', res.data.amountReal, res.data.id, "/pages/current-order/index");
```
`utils/pay.js:62-73`
```js
    } else {
      wx.showModal({
        title: '出错了',
        content: JSON.stringify(res),
        showCancel: false,
        success (res) { wx.reLaunch({ url: redirectUrl }); }
      })
    }
```
`cloudfunctions/api/index.js:100-119`：`handlePayCallback` 只在 `event.outTradeNo && event.resultCode` 时生效，而全项目没有任何 `cloudPay.unifiedOrder` / 统一下单调用方 → 该回调永不可达。
`cloudfunctions/api/handlers.js:757-762`：阶段二已删除 `orderPay`（标记已支付）action。

**影响**：订单状态永远为 `0 待支付`。商家侧没有"已付款"订单可做；顾客侧订单永远留在「当前订单／待付款」。蛋糕店属"先付后做"，等于**整条交易链路不可用**。

**触发条件**：任意模式下单 —— 点单页加购 → 底部「去结算」→ 结算页「结算」→ 弹「出错了 {...}」→ 自动跳回订单列表，订单状态「待支付」。反复点「再次支付」只重复同一弹窗。

**建议改法**：
1. 短期（拿不到商户号前）：在结算页把「结算」改为「提交订单（货到付款/线下支付）」并明确文案，或临时禁用下单入口（`pages/pay/index.wxml:134` 增加 `disabled` 态 + 说明），**避免产生大量永久待支付订单**。
2. 接入 `cloud.cloudPay.unifiedOrder` 后：在 `handlers.js` 重新加回「标记订单已支付」的 action，并让 `index.js:100-119` 的回调调用它把 `status` 推进到 `1`。
3. 同时修 C-P2-5（错误提示文案）。

**严重级：P0（阻断上线）**

---

#### C-P0-2 核销闭环不可用

**证据 (a)：入口不显示**

`cloudfunctions/api/shop-config.js:33-36`
```js
  // ⏳ 待配置（业务方 2026-09-26 答复：暂不提供，等微信云环境与管理员账号确定后再填）。
  adminOpenids: [],
```
`cloudfunctions/api/handlers.js:376-379` → `order_hx_uids: (SHOP.adminOpenids || []).join(',')`（即 `''`）
`pages/my/index.js:106-110`
```js
      const order_hx_uids = wx.getStorageSync('order_hx_uids')
      this.setData({
        userInfo: res.data.base,
        canHX: !!(order_hx_uids && order_hx_uids.indexOf(res.data.base.id) != -1)
      })
```
`pages/my/index.wxml:38`：`<view wx:if="{{ canHX }}" class="scan-entry" ...>` → 恒不渲染。全项目仅此一处进入 `pages/order-view/scan-result`（`pages/my/index.js:216-232`）。

**证据 (b)：核销码画布绘制时机错误**

`pages/order-view/index.js:43-56`
```js
    if (res.code == 0) {
      if (res.data.orderInfo.status == 1) { res.data.orderInfo.statusStr = '制作中' }
      if (res.data.orderInfo.status == 3) { res.data.orderInfo.statusStr = '交易成功' }
      // 绘制核销码
      if (res.data.orderInfo.hxNumber && res.data.orderInfo.status > 0 && res.data.orderInfo.status < 3) {
        wxbarcode.qrcode('qrcode', res.data.orderInfo.hxNumber, 650, 650);   // ← 先画
      }
      this.setData({ orderDetail: res.data })                                 // ← 后 setData
```
`pages/order-view/index.wxml:156-166`
```html
<block wx:if="{{orderDetail.orderInfo.hxNumber && orderDetail.orderInfo.status > 0 && orderDetail.orderInfo.status < 3}}">
  ...
  <view class="text"><canvas class="hx-canvas" canvas-id="qrcode" /></view>
```
`miniprogram_npm/wxbarcode/index.js`：`qrcode()` 内部是 `wx.createCanvasContext(id)` + `ctx.draw()` 的立即绘制 —— **同步画一次，不会重绘**。首次进入订单详情时 `this.data.orderDetail` 仍是 `undefined`，`wx:if` 为假 → 画布节点不存在 → 绘制被丢弃，之后也没有补画。`pages/order-view/index.js:37-39` 的 `onShow` 为空，页面再次显示也不会重画。

**影响**：商家看不到核销二维码，`scan-result` 页又进不去 → **自提核销（蛋糕店交付出货的关键动作）完全无法执行**；也无法阻止重复取货。

**触发条件**：(a) 店主在「我的」页找「扫码核销」→ 不存在；(b) 即便手工把 `adminOpenids` 填上，进入订单详情也不会出现二维码图。

**建议改法**：
1. `cloudfunctions/api/shop-config.js:36` 填入店主 openid（云开发控制台用户管理可查），或改判定口径（例如 `app_config` 集合写 `order_hx_uids`）。
2. 把绘制移到 `setData` 的回调里，并用 `wx.nextTick` 或 `createSelectorQuery` 确认节点已存在：
```js
this.setData({ orderDetail: res.data }, () => {
  const info = res.data.orderInfo
  if (info.hxNumber && info.status > 0 && info.status < 3) {
    wx.nextTick(() => wxbarcode.qrcode('qrcode', info.hxNumber, 650, 650))
  }
})
```
3. 注意 `pages/orders` 等其他页面没有该画布，`wx.createCanvasContext` 必须在本页上下文调用（现状 OK）。
4. 核销接口的服务端鉴权问题（`handlers.js:747-755` 不校验调用者身份）属审计 B 范围，但前端 `canHX` 只是本地 storage 判断（可被篡改），**不能作为唯一门控** —— 建议前端入口 + 服务端白名单双校验。

**严重级：P0（阻断上线）**

---

### 3.3 P1 详细

#### C-P1-1 点单页「全部商品」不刷新商品列表

`pages/orders/index.js:64-76`
```js
  onCategoryClick(e) {
    var id = e.target.dataset.id;
    if (!id || id == '0') {
      this.setData({
        cid: '',
      })
      return                 // ← 没有调用 this.getGoodsList()
    }
    this.setData({
      cid: id,
    })    
    this.getGoodsList()
  },
```
`pages/orders/index.wxml:64-68`：全部商品项为 `data-id="0"`。

**触发条件**：点单页 → 点左侧任一分类（如「蛋糕」）→ 再点「全部商品」→ 右侧商品列表**仍停留在「蛋糕」分类的结果**（`cid` 已被清空，但列表未重新拉取，状态与数据不一致）。
**影响**：顾客看到的是被过滤后的商品，可能漏看商品或误以为"本店只有这些"。同时 `data.cid` 与 `goodsList` 长期不一致，后续切分类才恢复。
**建议改法**：把 `getGoodsList()` 移到 `setData` 的回调里，或统一在方法末尾调用：
```js
onCategoryClick(e) {
  const id = e.currentTarget.dataset.id
  if (!id || id == '0') { this.setData({ cid: '' }, () => this.getGoodsList()); return }
  this.setData({ cid: id }, () => this.getGoodsList())
}
```
顺带把 `e.target` 改为 `e.currentTarget`（见下条说明）。

**严重级：P1**

#### C-P1-2 选完收货地址后结算页「详细地址」不同步

`pages/address/index.js:87-101`
```js
  onCardTap(e) {
    if (!this.data.selectMode) return
    const id = e.currentTarget.dataset.id
    const addr = ADDR.getById(id)
    if (!addr) return
    const pages = getCurrentPages()
    const prev = pages[pages.length - 2]
    if (prev && typeof prev.setData === 'function') {
      prev.setData({
        selectedAddress: Object.assign({}, addr, { fullText: ADDR.formatFull(addr) })
      })                                  // ← 只写了 selectedAddress，没有写 addressText
    }
    wx.navigateBack()
  }
```
`pages/pay/index.js:72-89`
```js
    if (!this.data.selectedAddress) {
      const def = ADDR.getDefault()
      if (def) { this.applyAddress(def) }   // ← selectedAddress 已存在，这里被跳过
    }
    ...
  applyAddress(addr) {
    this.setData({
      selectedAddress: addr,
      addressText: ADDR.formatFull(addr) || (addr.detail || '')
    })
  },
```
`pages/pay/index.wxml:44-47`：`<view wx:if="{{ selectedAddress }}" class="addr-detail-row"><view class="addr-detail-text">{{ addressText }}</view></view>`

**触发条件**：结算页（外送模式）→ 点「收货地址」→ 选另一个地址 → 返回结算页 → 列表行显示新的「姓名 电话」，但下方**详细地址行显示的是默认地址（或空白）**。
**影响**：顾客核对时的地址与实际下单项不一致（`postData.address` 用 `selectedAddress`，是正确的；`extJson['收货地址']` 用 `ADDR.formatFull(addr)`，也正确）→ **仅屏幕显示错误**，但会引发顾客投诉与取消订单。
**建议改法**：`pages/pay/index.js` 的 `onShow` 增加兜底同步：
```js
if (this.data.selectedAddress) {
  this.setData({ addressText: ADDR.formatFull(this.data.selectedAddress) })
} else { /* 原有默认地址逻辑 */ }
```
或让地址页 `setData({ selectedAddress, addressText: ADDR.formatFull(addr) })`。

**严重级：P1**

#### C-P1-3 自提订单不校验自取时间，蛋糕「提前 3 小时」规则在自提路径失效

`pages/pay/index.js:240-276`
```js
  async createorder() {
    const token = wx.getStorageSync('token')
    // ===== 改造：外送下单前的校验 =====
    if (this.data.isDelivery) {          // ← 自提（默认模式）完全不进入校验
      if (!this.data.selectedAddress) { ... return }
      if (!this.data.fetchTime || this.data.fetchTime === '请选择') { ... return }
      if (this.data.quote && this.data.quote.deliverable === false) { ... return }
      const expectTime = wx.getStorageSync('expectTime')
      if (expectTime) {
        const check = DR.checkAdvanceTime({ ... })
        if (!check.valid) { wx.showToast({ title: check.tip, icon: 'none' }); return }
      }
    }
```
`pages/pay/index.js:15` `fetchTime: '请选择'`；`:306` `extJsonStr['自取时间'] = this.data.fetchTime`。
`utils/delivery.js:33-39` 默认 `pickup`；`config/delivery.js:96-99` `applyToAll: false`（仅蛋糕需提前 3 小时）。

**触发条件**：结算页保持默认「自提」→ 不点「自取时间」→ 直接点「结算」→ 订单创建成功，订单详情「自取时间」显示 `请选择`；含 6 寸蛋糕时也**不会**被 3 小时规则拦截。
**影响**：商家无法按时出餐；蛋糕预约规则（业务核心）形同虚设；订单里留下无意义的 `请选择`。
**建议改法**：把校验提升为两种模式共用，只把"收货地址/配送范围"留在外送分支内：
```js
if (!this.data.fetchTime || this.data.fetchTime === '请选择') { toast('请选择' + (isDelivery ? '期望送达时间' : '自取时间')); return }
const expectTime = wx.getStorageSync('expectTime')
const check = DR.checkAdvanceTime({ expectTime: ..., items: this.data.cartItemsForQuote || [], now: new Date(), openingHours: SHOP_CONFIG.shop.openingHours })
if (!check.valid) { toast(check.tip); return }
```
（注意 `expectTime` 是绝对时间串，不要用 `fetchTime` 的相对文案去构造 `Date`。）

**严重级：P1**

#### C-P1-4 时段列表无条件要求「现在 + 3 小时」，非蛋糕订单也选不到近期时段

`utils/delivery-range.js:445-467`
```js
function buildTimeSlots(dateStr, now) {
  const openingHours = require('../shop-config').shop.openingHours
  const hours = parseHours(openingHours) || { startH: 9, startM: 0, endH: 22, endM: 0 }
  const base = now ? new Date(now) : new Date()
  const minMs = CFG.advance.minHours * 60 * 60 * 1000           // ← 无条件 3 小时
  const earliest = new Date(base.getTime() + minMs)
  ...
    if (dt.getTime() < earliest.getTime()) continue              // ← 无条件过滤
```
`pages/select-time/index.js:57` 调用 `DR.buildTimeSlots(date.value, new Date())`，**没有传 items，也不看 `hasCake`**；而同页 `index.js:44-45` 又按 `needAdvance = CFG.advance.applyToAll || hasCake` 只对蛋糕显示"提前 3 小时"提示。

**触发条件**：购物车只有非蛋糕商品（如饮品）→ 结算页 → 自取时间 → 「今天」的时段列表从 `现在 + 3 小时` 起才有值；若当前 20:30，则今天**一个时段都不剩**，页面显示「当天已无可选时间」，而 `config/delivery.js:96-99` 明确写"非蛋糕商品可立即下单"。
**影响**：非蛋糕订单被无谓地强制延后 3 小时以上，直接影响成交量；而 `checkAdvanceTime`（`delivery-range.js:399`）会放行，两处规则自相矛盾。
**建议改法**：给 `buildTimeSlots(dateStr, now, opts)` 增加 `needAdvance` 参数，由 `select-time` 传入 `CFG.advance.applyToAll || hasCake`；`needAdvance === false` 时 `minMs = 0`（只过滤已过去的时段）。

**严重级：P1**

#### C-P1-5 `wx.getUserProfile` 已匿名化 →「我的」页永远显示「点击登录」

`pages/my/index.js:116-131`
```js
  updateUserInfo() {
    wx.getUserProfile({
      lang: 'zh_CN',
      desc: '用于完善用户资料',
      success: (res) => { this._updateUserInfo(res.userInfo) },
      fail: (err) => { console.log(err); wx.showToast({ title: err.errMsg, icon: 'none' }) }
    })
  },
```
`pages/my/index.js:133-149`：把 `userInfo.avatarUrl`（新基础库下为空串）写进 `API.modifyUserInfoV2`；云函数 `handlers.js:316-331` 的 `allow` 列表含 `avatarUrl`，`payload[k] !== undefined` 判断**会接受空串并落库**。
`pages/my/index.wxml:15`：`<block wx:if="{{ userInfo && userInfo.avatarUrl }}">` 否则渲染 `pages/my/index.wxml:26-35` 的「点击登录」块。

**触发条件**：基础库 ≥ 2.27.1（`project.config.json` / `project.private.config.json` 的 libVersion 为 3.x）→ 点「点击登录」→ `wx.getUserProfile` 返回匿名信息（空 `avatarUrl`、昵称"微信用户"）→ 提示「登录成功」→ `userDetail()` 回读后 `avatarUrl` 仍为空 → **页面依旧显示「点击登录」**。
**影响**：用户以为没登录成功而反复点击；`getUserProfile` 属受限接口，也增加审核风险。订单链路本身不受影响（云开发身份走 OPENID，无需前端登录）。
**建议改法**：改用 `button open-type="chooseAvatar"` + `input type="nickname"`（官方现行方案）收集头像昵称；或直接删除该入口，把用户区改为展示"OPENID 生成的短编号 + 订单数"等不依赖授权的信息。**注意保持 `handlers.js:318` 的 `allow` 白名单，避免继续写入空串覆盖已有资料。**

**严重级：P1**
**待验证**：受限于无真机/开发者工具，未实测当前基础库下的 `getUserProfile` 返回值；但按官方 2.27.1 起的调整，结论方向确定。

#### C-P1-6 订单状态机：`status=1` 永不产生 + 同一状态两处文案不一致

**云函数实际产生的状态（全量检索 `handlers.js`）**

| 位置 | 写入 |
|---|---|
| `handlers.js:620-621` | 创建订单：`status: 0` / `statusStr: '待支付'` |
| `handlers.js:726` | 取消订单：`status: -1` / `statusStr: '已取消'` |
| `handlers.js:753` | 核销：`status: 3` / `statusStr: '交易成功'` |
| `cloudfunctions/api/index.js:116` | 支付回调：`status: 1` / `statusStr: '制作中'` —— **不可达**（无下单调用方，见 C-P0-1） |

**前端筛选与文案**

`pages/current-order/index.js:56-62`
```js
    } else if (this.data.tabIndex == 0) {
      statusBatch = '0, 1, 2'      // 当前订单
    } else {
      statusBatch = '-1, 3, 4'     // 历史订单
    }
```
`pages/current-order/index.js:73-80`：`status==1 → '制作中'`、`status==3 → '交易成功'`（覆盖服务端 `statusStr`）。
`pages/my/index.js:30-35`：入口键 `'0' 待付款 / '1' 待取货 / '3' 已完成 / all 全部订单`。
`pages/my/index.js:153-158` → `navigateTo('/pages/current-order/index?status=' + status)`。

**逐条结论**

- **「待取货」（`status=1`）永远查不到数据**：没有任何可达代码把订单置为 1。`pages/my` 的「待取货」入口 → `statusBatch='1'` → `handlers.js:667-671` 过滤后 `list = []` → 恒显示「暂无订单记录」（且见 C-P2-3，空数组时连这句话都不显示，直接空白）。
- **「当前订单」tab 只可能命中 `status=0`**（`1`/`2` 不存在）；在支付未接入前，**所有订单都会一直堆在「当前订单」里**，「历史订单」只有被取消的单。
- **文案不一致**：同一状态在「我的」页叫「待取货」（`my/index.js:32`），在订单列表项里叫「制作中」（`current-order/index.js:75`）。
- **冗余覆盖**：服务端已返回 `statusStr`（`handlers.js:683,706`），前端这段 `if (status==1) statusStr='制作中'` 属重复实现，两处一旦改口径就会打架。

**建议改法**：抽 `utils/order-status.js` 统一常量（`{0:'待付款',1:'待取货',3:'已完成',-1:'已取消'}`）+ 统一 `statusBatch`；前端**不要覆盖**服务端 `statusStr`；把 `statusBatch` 改为由常量派生（过滤掉不存在的 2/4）。

**严重级：P1**

#### C-P1-7 订单快照里的「自取时间」是相对文案，无绝对日期

`pages/select-time/index.js:125-128`
```js
    // 展示用文案：今天/明天 15:00
    const timeText = `${date.label} ${slot}`
    wx.setStorageSync('fetchTime', timeText)     // ← '今天 15:00'
    wx.setStorageSync('expectTime', expectTimeStr) // ← '2026-10-09 15:00'（绝对，但没进订单）
```
`pages/pay/index.js:306,328`：`extJsonStr['自取时间'] = this.data.fetchTime`、`extJsonStr['期望送达时间'] = this.data.fetchTime`
`pages/order-view/index.wxml:56-63`：详情页展示 `orderDetail.extJson['自取时间']`

**触发条件**：今天下午下单选「今天 15:00」→ 明天商家在订单详情/核销页看到「今天 15:00」，无法判断是哪一天。
**影响**：履约时间歧义；对账单/客服沟通都会出错。`storage.expectTime`（绝对时间）虽被写入，但**从未被写入订单或详情页**。
**建议改法**：下单时把绝对时间一并写入并优先展示，例如 `extJson['自取时间'] = wx.getStorageSync('expectTime') || this.data.fetchTime`（或加 `extJson['自取时间文案']` 保留友好文案）。顺带在订单成功后清理 `fetchTime` / `expectTime` / `checkoutItems`（`storage` 目前永不过期，见"待验证"）。

**严重级：P1**

#### C-P1-8 未绑定手机号也能下单，订单「联络电话」写入 `-`

`pages/pay/index.js:15`：`mobile: '-'`
`pages/pay/index.js:214-222`：
```js
  async userDetail() {
    const res = await API.userDetail(wx.getStorageSync('token'))
    if (res.code == 0 && res.data.base.mobile) { this.setData({ mobile: res.data.base.mobile }) }
  },
```
`pages/pay/index.js:305`：`extJsonStr['联络电话'] = this.data.mobile`（未绑定时即 `-`）
`components/bind-mobile/index.js:65-82`：改走 `API.bindMobile`，云函数 `handlers.js:433-435` 固定返回 `501`「云开发模式下手机号绑定尚未接入」→ 云模式下**永远绑不上**。
`pages/pay/index.wxml:64-66`：`<view class="get1-box" bind:tap="bindMobile"><view class="get1">自动填写</view></view>`（唯一入口，且点了必然弹"未接入"）
`shop-config.js:70-72`：外送提示"下单后商家将与您电话确认配送地址"。

**触发条件**：不点「自动填写」直接下单 → 订单 `extJson['联络电话'] = '-'`；外送订单的收货电话虽然写入了 `extJson['收货电话']`，但商家最常用的「联络电话」一栏是 `-`。
**影响**：商家联系不上顾客；外送订单无法按设计好的方式电话确认地址；订单履约缺环。
**建议改法**：短期在 `createorder` 前加硬校验（`if (!this.data.mobile || this.data.mobile === '-') { toast('请先绑定手机号'); return }`，并把 `pay` 页的「联络电话」改成显式「去绑定」按钮）；或允许顾客手填手机号（`input` + `ADDR.isValidPhone`）避免依赖受限的 `getPhoneNumber` 能力。云函数侧的手机号换取实现属第 2 阶段工作（需小程序后台开通"手机号快速验证"）。

**严重级：P1**

#### C-P1-9 用户隐私协议/常见问题正文为占位文案

`cloudfunctions/api/shop-config.js:39-51`
```js
  // ⏳ 待补充（业务方 2026-09-26 答复：隐私协议、常见问题、店铺介绍后续补充）。
  cms: {
    agreement: { title: '用户隐私协议',
      content: '<p>（内容待补充）本店用户隐私协议正在完善中，将在上线前替换为正式文本。</p>' },
    qa: { title: '常见问题',
      content: '<p>（内容待补充）本店常见问题正在整理中，届时将替换为正式内容。……</p>' }
  },
```
调用链：`pages/about-us/index.wxml:1-13`（两个入口）→ `pages/about-us/detail.js:20-31`（`API.cmsPage(key)`）→ `handlers.js:406-420` → 上述占位文案。

**触发条件**：「我的」→「关于卿欢蛋糕」→「用户隐私协议」/「常见问题」。
**影响**：顾客看不到任何有效协议与问答；**小程序审核/合规要求下，隐私协议页展示"内容待补充"属明显缺陷**（本小程序收集头像昵称、手机号、收货地址、定位选点等个人信息，必须有可见的隐私说明）。
**建议改法**：上线前把 `cms.agreement.content` / `cms.qa.content` 替换为正式 HTML（正文由业务方提供）；同时按微信当前要求在小程序后台配置《用户隐私保护指引》并处理 `wx.getPrivacySetting` / 隐私弹窗（本次未在代码中发现任何隐私授权弹窗实现）。
**严重级：P1（合规）**
> 说明：第一阶段"云开发下隐私协议必为空白"的判断**不成立** —— 现在能取到内容（占位文案），不会空白，但内容无效。

---

### 3.4 P2 详细

#### C-P2-1 结算页在购物车未加载成功时点「结算」抛 TypeError

`pages/pay/index.js:162-213`（`shippingCarInfo`）只在 `res.code == 0` 时 `setData({shippingCarInfo: res.data})`；失败分支什么都不写。
`pages/pay/index.js:280`
```js
    this.data.shippingCarInfo.items.forEach(ele => {
```
**触发条件**：云函数不可用且降级后的 api 工厂通道也失败（`utils/api-map.js:99-110`：只有 `code === 500` 才降级，其它错误码原样返回）→ `shippingCarInfo` 保持 `undefined` → 点「结算」→ `TypeError: Cannot read property 'items' of undefined`，按钮无任何反应、无提示。
**建议改法**：进入 `createorder` 先做防御并给用户可读提示：
```js
const cart = this.data.shippingCarInfo
if (!cart || !Array.isArray(cart.items) || !cart.items.length) {
  wx.showToast({ title: '购物车数据未加载，请下拉重试', icon: 'none' }); return
}
```
**严重级：P2**

#### C-P2-2 商品详情数据未加载成功时点「加入购物车」抛 TypeError

`pages/goods-details/index.js:58-77`：仅 `res.code == 0` 时写 `goodsDetail`；失败（商品不存在/下架/云函数异常）时页面只剩空壳。
`pages/goods-details/index.js:141-158`
```js
  async addCart() {
    const isLogined = await AUTH.checkHasLogined()
    if (!isLogined) { ... return }
    if (this.data.goodsDetail.basicInfo.stores <= 0) {   // ← goodsDetail 可能是 undefined
```
**触发条件**：从点单页进入某商品详情（或从历史订单/他人分享的 `?id=` 进入）而该商品已被删除 → 点「加入购物车」→ TypeError。
**建议改法**：`if (!this.data.goodsDetail || !this.data.goodsDetail.basicInfo) { wx.showToast({title:'商品已下架', icon:'none'}); return }`；同时在 `goodsDetail()` 的失败分支给出提示并调用 `onClose()` 返回点单页。
**严重级：P2**

#### C-P2-3 列表为空数组时不显示空态

`pages/orders/index.wxml:80`：`<view wx:if="{{ !goodsList }}" class="goods-empty">暂无商品</view>`
`pages/current-order/index.wxml:10`：`<view wx:if="{{ !orderList}}" class="no-orders">暂无订单记录</view>`
WXML 中 `![]` 为 `false`。而云函数 `handlers.js:123` 返回 `result: []`（空分类）、`:680` 返回 `orderList: []`（无订单）。

**触发条件**：① 新用户（无任何订单）打开「我的 → 全部订单」→ `orderList = []` → **整页空白，连"暂无订单记录"都没有**（只有接口报错时 `orderList: null` 才会显示该文案）；② 打开一个没有商品的分类 → 右侧空白。
**建议改法**：改为 `wx:if="{{ !goodsList || goodsList.length === 0 }}"` / `wx:if="{{ !orderList || orderList.length === 0 }}"`；同时把加载中与空态区分（`orders` 页首屏会闪一下"暂无商品"）。
**严重级：P2**

#### C-P2-4 订单详情/结算页无错误态

`pages/order-view/index.js:40-59`：`res.code != 0`（如"订单不存在""无权查看该订单"，`handlers.js:696-699`）时不做任何处理，页面全部字段为空白。
`pages/order-view/scan-result.js:39-48` 同理。
`pages/pay/index.js:172-213` 失败时页面显示「共 件商品，小计 ¥」的空壳。
**触发条件**：订单被删除后从旧链接进入 `/pages/order-view/index?id=xxx`；或扫码核销一个无效 `hxNumber`。
**影响**：用户看到白页，无法判断是加载失败还是订单不存在，会反复重试。
**建议改法**：失败分支 `wx.showModal({title:'提示', content: res.msg || '订单加载失败', showCancel:false, success: () => wx.navigateBack()})`。
**严重级：P2**

#### C-P2-5 支付失败提示为「出错了」+ 原始 JSON

`utils/pay.js:1-7`（注释自述）：
```js
// 云开发模式下若微信支付尚未接入，API.wxpay 会返回明确文案
// "云开发支付尚未接入：需先申请微信支付商户号并配置云开发支付"，
// 下面 else 分支会直接弹出该文案（不再是"出错了"）。
```
`utils/pay.js:62-73`（实际实现）：
```js
    } else {
      wx.showModal({ title: '出错了', content: JSON.stringify(res), showCancel: false, success (res) { wx.reLaunch({ url: redirectUrl }) } })
    }
```
**触发条件**：任意下单后的支付。
**影响**：顾客看到 `出错了 {"code":501,"msg":"云开发支付尚未接入…"}` 这种字符串，**注释声称已改好但实现没改**；真正的业务原因被"出错了"掩盖，极易被当成系统故障投诉。同时失败后无条件 `reLaunch` 到订单列表，用户失去上下文。
**建议改法**：`title: '支付暂不可用'`、`content: (res && res.msg) || '请稍后重试'`；`code === 501` 时不 reLaunch 或给出更明确的后续指引。
**严重级：P2**

#### C-P2-6 自定义 tabbar：点当前 tab 也 `reLaunch` 整页

`app.js:123-136`
```js
  tabbarChange(e, curIndex) {
    if (e.detail == curIndex) { return }
    const pages = ['/pages/index/index','/pages/orders/index','/pages/current-order/index','/pages/my/index']
    wx.reLaunch({ url: pages[e.detail] })
  },
```
四个页面的调用点都**只传了 e**：`pages/index/index.js:66-68`、`pages/orders/index.js:358-360`、`pages/current-order/index.js:104-106`、`pages/my/index.js:234-236` → `curIndex` 恒为 `undefined`，**守卫永真不成立**。
`miniprogram_npm/@vant/weapp/tabbar-item/index.js` 的 `onClick`：
```js
        var active = this.data.name || index;
        if (active !== this.data.active) { parent.$emit('change', active); }
```
`data.active` 经 `updateFromParent` 赋值为**布尔**（`var active = (data.name || index) === parentData.active; patch.active = active`），而左侧 `active` 是编号/名称 → `0 !== true` 恒成立 → **点击当前项也会 emit change**。

**触发条件**：在点单页已选好分类、填好购物车后，误点底部「点单」→ 整个页面 `reLaunch` 重建 → 已选分类丢失、购物车/商品重新拉取。
**影响**：无谓的全页重载与请求放大；用户感知为"页面闪一下、状态被重置"。
**建议改法**：页面侧传入当前索引（如 `app.tabbarChange(e, 1)`），或在 `app.js` 里按 `getCurrentPages()` 判断当前页是否已是目标页，是则直接 return。**注意 van-tabbar 自身的比较缺陷，不要依赖它**。
**严重级：P2**（症状为 UX 与重复请求，不产生错误数据）

#### C-P2-7 「用户编号」直接展示原始微信 OPENID

`cloudfunctions/api/handlers.js:294-309`
```js
  const base = {
    id: ctx.openid,          // ← 28 位 openid 直接回给前端
    mobile: ..., avatarUrl: ..., nick: ..., sex: ..., gender: ..., birthday: ...
  }
```
`pages/my/index.wxml:20`：`<view class="user-id">用户编号: {{ userInfo.id }}</view>`
**触发条件**：「我的」页（云开发模式）。
**影响**：敏感标识明文展示在顾客界面上（截图/分享外泄），既不美观也不符合最小暴露原则；`pages/my/index.js:110` 的 `canHX` 判定也用同一个值（本地判断可篡改）。
**建议改法**：云端返回短编号（如 `order` 计数或 openid 哈希后 6-8 位），前端展示短编号；白名单校验放服务端（见 C-P0-2 建议 4）。
**严重级：P2**

#### C-P2-8 全项目无 `onShareAppMessage` / `onShareTimeline`

检索 `pages/**/*.js`、`app.js`：`onShare` **零命中**。同时 `pages/goods-details/index.wxml` 也没有任何分享按钮。
**影响**：蛋糕店最有效的自然获客渠道（顾客把商品/店铺转发给朋友）不可用；小程序右上角"转发"点击后无自定义内容（默认转发当前页，但无标题/图片优化）。
**建议改法**：至少在 `pages/index/index` 与 `pages/goods-details/index` 增加：
```js
onShareAppMessage() {
  return { title: '卿欢蛋糕 · 现烤现做', path: '/pages/index/index', imageUrl: '...' }
}
```
商品详情页用 `path: '/pages/goods-details/index?id=' + this.data.goodsId`。
**严重级：P2**（若本项目明确不需要分享，可降为 P3；但第一阶段已把"分享未实现"列为功能空缺，此处保持 P2）

---

### 3.5 P3 详细（汇总）

**C-P3-4 `console.*` 残留清单（页面侧共 9 处 / 6 文件）**

| 文件:行 | 语句 | 说明 |
|---|---|---|
| `pages/address/edit.js:128` | `console.warn('[address] chooseLocation 失败', err)` | 失败留痕，可保留但建议走统一 debug 开关 |
| `pages/current-order/index.js:161` | `console.error(err)` | 拨号失败 |
| `pages/current-order/index.js:197` | `console.log('用户点击取消支付')` | **纯调试残留** |
| `pages/my/index.js:124` | `console.log(err)` | getUserProfile 失败 |
| `pages/my/index.js:179` | `console.error(err)` | 拨号失败 |
| `pages/my/index.js:202` | `console.error('[my] openLocation 失败', err)` | 合理 |
| `pages/my/index.js:225` | `console.error(err)` | 扫码失败 |
| `pages/pay/index.js:229` | `console.log(e.detail); // 这里是组件里data的数据` | **纯调试残留** |
| `components/parser.20200414.min/parser.js:2` | 压缩文件内 `console.warn` | 第三方，不建议手改（若必须，用构建后替换） |

建议：统一收敛到 `DS.debug` 开关（`utils/data-source.js:68` 已有 `debug` 字段，`utils/api-map.js` 已在用），或直接删除两处 `console.log`。

**其余 P3 要点**
- **C-P3-1**：`pages/orders/index.wxml:48` 的 `{{ shopNotice }}` 永不显示；注释称"来自商品购买须知"。若确需展示，应在 `shippingCarInfo()` 里把商品 `purchaseNotes` 汇总后 `setData({shopNotice})`（`pages/pay/index.js:175-198` 已有相同汇总逻辑可复用）；若不需要，删掉该节点与注释 —— **不要留着不接线的 UI**。
- **C-P3-5**：`pages/about-us/index.wxml:15` `<view class="version">Version 1.0 17:30:54</view>` 是模板占位符（时间戳形式），应改为真实版本号或删除。
- **C-P3-6**：未被引用的图片：`images/icon-font-solid.png`、`images/icon-font-solid@2x.png`、`images/logo@2x.png`、`images/rectangle@2x.png`（共约 37KB，其中 `rectangle@2x.png` 29KB）。确认无引用后可删除。
- **C-P3-7**：`app.json:35-36` 全局注册 `van-dialog`、`van-datetime-picker`；静态检索全项目 wxml **无任何使用**（`van-datetime-picker` 的唯一使用方 `pages/card-info` 已删除）。建议移除注册，减小包体。
- **C-P3-9**：`pages/address/edit.js:90-95` 的 `refreshAreaText()` 无任何调用方（`onAreaConfirm` 自己拼了 `areaText`）。
- **C-P3-10**：`pages/address/edit.wxml:66` 写"省市区与详细地址至少填其一即可下单"，而 `onSave`（`edit.js:160-163`）要求 `detail` 必填。二者取一：改文案，或放宽校验为"省市区或详细地址至少填一项"。
- **C-P3-11**：`pages/pay/index.js:56-58` `AUTH.wxaCode().then(code => { this.data.code = code })` —— 直接改 `this.data` 且该值全项目再无引用（死数据）；云开发模式下也不需要 `wx.login`。建议整段删除。
- **C-P3-12**：`pages/current-order/index.js:20,33` 的 `filterTitle` 从未在 wxml 使用；`pages/current-order/index.wxml:36` 的 `data-id="{{item.shopIdZt}}"` 自 `callShop` 改读本地配置后已成死 dataset。
- **C-P3-13**：`pages/orders/index.js:296-343` 的 `addCart()` 已无 wxml 绑定（`index.wxml:114-118` 的「＋」改为 `catchtap="goDetail"`），代码内注释也承认保留；建议删除或明确标注为"未接线"。
- **C-P3-14**：`pages/pay/index.wxss:281-292` 的 `.pay-bar` 为 `position:fixed; bottom:0rpx; height:120rpx`，**没有 `env(safe-area-inset-bottom)`**；对比 `pages/orders/index.wxss:329` 已处理（`bottom: calc(100rpx + env(safe-area-inset-bottom))`）。iPhone 全面屏下「结算」按钮会压到 Home 指示条区域。
- **C-P3-15**：`pages/index/index.wxml:24` 用 `<navigator url="/pages/orders/index">`（navigateTo 入栈）进点单页，而底部 tabbar 用 `wx.reLaunch`（清栈）。两条路径进入同一页面后，左上角"返回"行为不同（前者可返回首页，后者没有上一页）。建议统一为 `open-type="reLaunch"` 或在 `orders` 页 `onShow` 中处理。
- **C-P3-16（交叉记录，属审计 B/配置范围）**：`shop-config.js:58-59` 的经纬度自述为"约值/占位值"，但 `pages/order-view/index.js:11-28`、`scan-result.js:10-27` 与 `pages/my/index.js:189-206` 的「一键导航」直接使用该坐标 → 地图标记与导航目的地点会偏移。建议取腾讯坐标拾取器精确值。
- **C-P3-17（样式）**：`pages/orders/index.wxss:177,211` 用 `height: calc(100vh - 500rpx)` 固定高度同时约束左右两栏，`pages/orders/index.wxss:315-318` 的占位块为 300rpx；固定值与实际头部高度（`shop-head` + `main-tabs`）耦合，换机型/改文案后容易出现底部留白或列表被结算栏遮挡。建议改为 flex 布局（`page{display:flex;flex-direction:column}`）而非 `calc(100vh - 固定值)`。

---

## 四、待验证清单（静态审计无法定论，需在开发者工具/真机确认）

| # | 待验证项 | 现状与怀疑点 | 验证方法 |
|---|---|---|---|
| V1 | `wxbarcode.qrcode` 在 `wx:if` 内首次进入是否确实画不出来 | 代码顺序（先画后 setData）+ wxbarcode 内部 `createCanvasContext` 立即 `draw`，静态判断为空白 | 开发者工具真机预览 `pages/order-view/index?id=<含 status=1 的订单>`，观察 canvas；把绘制移入 setData 回调对比 |
| V2 | 基础库实际生效版本（`project.config.json` 3.8.1 vs `project.private.config.json` 3.17.3） | 直接决定 `wx.getUserProfile` 是否匿名化，进而决定 C-P1-5 的严重级 | 开发者工具「详情 → 本地设置 → 调试基础库」 |
| V3 | `wx.getUserProfile` 在该版本下的真机返回 | `avatarUrl` 是否为空串、`fail` 是否触发 | 真机点「点击登录」并查看 `_updateUserInfo` 的入参 |
| V4 | van-tabbar「点当前项仍 emit change」的实际表现 | vant 源码比较 `active !== this.data.active`（编号 vs 布尔）恒真，但需真机确认是否还有其它短路 | 在 `app.js:124` 打点，观察点当前 tab 是否进入 `reLaunch` |
| V5 | iOS 上 `utils/delivery-range.js:461` 的 `new Date('YYYY-MM-DDTHH:MM:00')` 是否解析正常 | JS 规范允许，但需确认小程序 iOS 运行时（历史上 `YYYY-MM-DD HH:mm:ss` 会 Invalid Date；本处用的是 `T`） | iOS 真机打开 `select-time`，确认时段列表非空；或在控制台直接 `new Date('2026-10-09T15:00:00')` |
| V6 | `input type="number"` 的 `maxlength="11"` 是否生效 | `pages/address/edit.wxml:21-30`；iOS 上 `maxlength` 对 number 类型常被忽略 | iOS 真机输入 15 位数字，观察是否被截断（即使不截断，`ADDR.isValidPhone` 也会拦下，影响有限） |
| V7 | 云开发环境是否已部署 `cloudfunctions/api`、7 个集合是否已建、`goods` 是否有数据 | `utils/data-source.js:61` 已写死环境 ID `cloud1-d7g2txuxpf22bb979`；若云函数未部署，`fallbackToLegacy=true` 会自动降级到**原面包店**账号（`utils/api-map.js:105-108`），页面会显示原店数据 | 云控制台 + 开发者工具 Network/云函数日志 |
| V8 | `cloudfunctions/api/shop-config.js` 的 `adminOpenids` / `cms` 是否已按上线要求补齐 | 现为 `[]` 与占位文案（C-P0-2、C-P1-9） | 检查云端该文件与 `app_config` 集合 |
| V9 | `select-time` 写入的 `storage.checkoutItems` / `fetchTime` / `expectTime` 在订单完成后是否残留并影响下一单 | `fetchTime`/`remark` 会被 `pay.onShow` 读回（`pages/pay/index.js:60-71`），`checkoutItems` 会被下次 `shippingCartInfo` 覆盖；但取消订单后重新下单可能带出上一单的时间文案 | 连续下两单，观察第二单的「自取时间」是否默认带出上一单值（`pages/pay/index.js:60-65` 只在有值时 setData，**不会清空**） |
| V10 | `pages/my` 的「扫码核销」在 `adminOpenids` 填好后的完整链路 | 需同时验证 C-P0-2 的两点 | 填白名单 → 部署 → 我的页出现入口 → 扫码 → `scan-result` → `orderHx`（`handlers.js:747-755`） |
| V11 | 微信小程序后台是否已配置客服人员 | `pages/my/index.wxml:76` `open-type="contact"`；未配置则点击无响应 | 后台「功能 → 客服」 |
| V12 | 是否需要为收集用户信息配置《用户隐私保护指引》/隐私弹窗 | 代码中未见 `wx.getPrivacySetting` / `wx.requirePrivacyAuthorize` 相关实现 | 小程序后台合规检查 + 审核经验判断 |

---

## 五、建议修复顺序

**第 0 步：止血（不写代码也要先决策）**
1. 明确支付方案与排期。在拿到微信支付商户号之前，**必须先决定结算按钮的行为**（改文案为"提交订单，线下支付"或临时禁用），否则每上线一天就积累一批永久「待支付」订单（C-P0-1）。

**第 1 步：让交易与履约能闭环（P0）**
2. C-P0-2：填 `adminOpenids`（或改判定口径）+ 修核销码绘制时机（两处都不难，收益最大）。
3. C-P0-1 的第 2 步：接入 `cloud.cloudPay.unifiedOrder` + 在 `handlers.js` 加回"标记已支付" action + 打通 `index.js:100-119` 回调，把 `status` 推进到 `1`。这一步做完后 C-P1-6 的「待取货」状态才真正有意义。

**第 2 步：修确定性错误（P1，改动都很小）**
4. C-P1-1（`onCategoryClick` 补 `getGoodsList()`）。
5. C-P1-2（结算页 `addressText` 同步）。
6. C-P1-3 + C-P1-4（时间校验口径统一：自提也校验；`buildTimeSlots` 接受 `needAdvance`）。
7. C-P1-6（抽 `utils/order-status.js`，统一 `statusBatch` 与文案，去掉前端对 `statusStr` 的覆盖）。
8. C-P1-7（订单写入绝对时间）。
9. C-P1-8（下单前手机号校验 + 提供手填手机号兜底）。
10. C-P1-5（改 `chooseAvatar` / `nickname` 输入，或移除该入口）。

**第 3 步：健壮性与合规（P2）**
11. C-P2-1 / C-P2-2（两处空指针防御）。
12. C-P2-3 / C-P2-4（空态与错误态）。
13. C-P2-5（支付失败文案）。
14. C-P1-9（隐私协议/常见问题正文）+ C-P2-7（不展示原始 openid）+ C-P2-8（分享）。
15. C-P2-6（tabbar 守卫）。

**第 4 步：收敛整洁度（P3）**
16. C-P3-1 / C-P3-5~C-P3-15 分批清理（死代码、未用图片与组件注册、`console.log`、重复方法、样式安全区）。
17. C-P3-8 的重复抽取建议**放最后**：抽 `order-status`（第 2 步已顺带完成）之外的 `syncDeliveryMode`、`shopMarkers`、WXSS 公共块属纯重构，务必独立提交、单独回归。

**不建议现在动的**：`template/tabbar` 的自定义导航方案（改造成本高于收益，只需修 C-P2-6 的守卫）；`pages/orders/index.wxss` 的 `calc(100vh - 500rpx)` 布局（属外观优化，等有真机截图再定）。

---

**本次审计只读，未修改 `bread-main/` 下任何文件。**
