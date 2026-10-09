# 审计 D：工程化 + 发布合规 + 文档一致性

> 审计对象：工作区根 `C:\Users\lenovn\Desktop\卿欢蛋糕\` + 被审项目 `bread-main\`
> 审计方式：**严格只读**（未修改 `bread-main` 下任何文件；未执行 `npm install`；未初始化 git）
> 审计时间：2026-10-09
> 证据形式：`文件相对路径:行号` + 本次实跑的命令输出

**本次审计使用的验证手段（全部亲自执行）**

| 手段 | 具体命令/操作 |
|---|---|
| 版本控制核查 | `Test-Path .git`（工作区根 / bread-main / 递归深度 3） |
| 体积测算 | `Get-ChildItem -Recurse -File \| Measure-Object Length -Sum`（分目录 + 主包口径） |
| 依赖一致性 | `npm ls --json`（只读，未安装任何包）、比对 `package.json` / `package-lock.json` |
| 组件清点 | 枚举 `miniprogram_npm/@vant/weapp` 目录 + 解析全项目 `usingComponents` |
| 测试实跑 | `node tests/test-cloud-api.js`、`test-spec.js`、`test-address.js`、`test-delivery.js` |
| 文档比对 | Node 脚本解析 `categories.jsonl` / `handlers.js` / `app.json` 与文档声明逐条对照 |
| 编码核查 | 全量源码 UTF-8 严格解码校验（结论：无编码缺陷） |
| 密钥/泄露检索 | 全项目正则检索 AppSecret / mchId / merchantId / subDomain / 第三方域名 |

---

## 一、结论摘要

### 1.1 分级计数

| 级别 | 数量 | 编号 |
|---|---|---|
| **P0（阻断上线）** | **4** | D-01、D-02、D-03、D-04 |
| **P1（影响正确性）** | **8** | D-05 ～ D-12 |
| **P2（健壮性 / 文档一致性）** | **7** | D-13 ～ D-19 |
| **P3（整洁度）** | **5** | D-20 ～ D-24 |
| 合计 | 24 | — |

另有 **9 项待验证**（平台/业务方确认，见第四节），**不**计入上述缺陷。

### 1.2 最致命的 5 条结论

1. **项目完全没有版本控制，且回滚方案是手工拷贝。**
   工作区根与 `bread-main` 均无 `.git`（实测 `Test-Path` 全为 `False`），全项目无 `.gitignore`。所谓"回滚"依赖 `.trash-cleanup\20260926-1945\ROLLBACK.md` 里 11 条手工 `Copy-Item`。**任何一次误删/误改都不可追溯**，多人协作与上线前的"改动前/改动后"比对完全无据可依。→ D-01

2. **`config.js` 仍指向原面包店的 api 工厂账号，且代码里保留了"切回原后端"的开关。**
   `config.js:4` `subDomain: 'yuanqibread'`、`config.js:5` `merchantId: 24340951`；`utils/data-source.js:26-27` 与 `cloudfunctions/README.md:155-158` 明确写着"数据是原店的，但能跑"。一旦有人把 `useCloud` 改成 `false`（文档把它描述为排障手段），本店小程序将**直接读写第三方商户的经营数据**——既是数据串号，也是未授权使用他人账号。→ D-02

3. **隐私协议正文是一个占位符，且全项目没有任何隐私授权接入。**
   `cloudfunctions/api/shop-config.js:45`：`content: '<p>（内容待补充）本店用户隐私协议正在完善中，将在上线前替换为正式文本。</p>'`。同时检索全项目：**零命中** `onNeedPrivacyAuthorization` / `requirePrivacyAuthorize` / 隐私弹窗。微信要求小程序提交审核时配置《小程序用户隐私保护指引》，用户信息收集必须可声明。当前状态**提交审核必被驳回**。→ D-03

4. **依赖不可重现，"换台机器一次装好"做不到。**
   `npm ls --json` 直接报 `ELSPROBLEMS`：`@vant/weapp@1.2.2` invalid（`package.json:16` 要求 `^1.11.7`）、`apifm-wxapi@3.8.0` invalid（`package.json:17` 要求 `^26.2.5`）。`package-lock.json` 仅 801 字节 / 23 行、`lockfileVersion: 1`（npm 5/6 时代），本机 npm 为 **11.19.0**。更关键的是 `node_modules/*/package.json` 里 `_where` 字段残留着 **`F:\小程序\蛋糕店`** 与 **`/Users/gongguojun/wxapp/cakeshop`**（macOS 路径）——**这套 `node_modules` 是跨机器拷贝来的，不是在本项目里装出来的**。→ D-04

5. **`packOptions.ignore` 没有排除 `node_modules`，含它主包实测 2.053 MB，已越过 2 MB 上限。**
   按当前 ignore 规则打包实测 **1011.4 KB（0.988 MB）**，安全；但把 `node_modules`（951.2 KB）计入则 **2,152,387 字节 = 2.053 MB**。`project.config.json:3-19` 的 ignore 只列了 `cloudfunctions` / `cloud-data` / `tests`，**没有 `node_modules`**。若开发者工具的上传打包未自动排除它，上传会被 2 MB 限制直接拒绝。此风险零成本可消除（加一行 ignore）。→ D-05

### 1.3 好消息（避免过度悲观）

- **主包目前没有超限**：按 `packOptions.ignore` 口径实测 1011.4 KB，距 2 MB 上限有近一倍余量，**暂不需要分包**（`app.json` 无 `subPackages`，符合现状）。
- **测试脚本本身是健康的**：四个脚本实跑 **74 + 27 + 33 + 103 = 237 项断言全部通过，exit code 全为 0**，且含"两端运费一致性"这类跨副本校验断言。
- **文档并非放任腐烂**：`cloudfunctions/README.md` 有 3 处带日期的自我更正块（第 69-72、110-113、182-184、204-205 行），说明有人在维护。问题集中在**更正后仍残留的旧数字**（见 D-14/D-15/D-16）。
- **源码无编码缺陷**：全量 `.js/.json/.wxml/.wxss/.md/.jsonl` UTF-8 严格解码校验**零失败**（终端里看到的乱码是控制台代码页显示问题，非文件问题）。
- **`.trash-cleanup` 不属于小程序工程**：它位于工作区根，不在 `bread-main`（开发者工具的项目目录）内，**不会被打进小程序包**。

---

## 二、缺陷清单

### 2.1 总表

| ID | 级别 | 标题 | 关键证据位置 |
|---|---|---|---|
| D-01 | **P0** | 工作区根与 bread-main 均无 `.git`，无 `.gitignore`，回滚靠手工拷贝 | 实测 `Test-Path .git` = False ×2 |
| D-02 | **P0** | `config.js` 仍指向原面包店 api 工厂账号，且保留"切回原后端"路径 | `config.js:4,5`；`utils/data-source.js:26-27`；`cloudfunctions/README.md:155-158` |
| D-03 | **P0** | 隐私协议/常见问题为占位文案，全项目无隐私授权接入 | `cloudfunctions/api/shop-config.js:45,49` |
| D-04 | **P0** | 依赖不可重现：lock 与 package.json 不匹配，`node_modules` 跨机器拷贝 | `package-lock.json:8,13` vs `package.json:16,17`；`npm ls` ELSPROBLEMS |
| D-05 | P1 | `packOptions.ignore` 未排除 `node_modules`；含它 2.053 MB > 2 MB | `project.config.json:3-19`；实测 2,152,387 字节 |
| D-06 | P1 | `libVersion` 两文件冲突 3.8.1 / 3.17.3（私有配置生效） | `project.config.json:61` vs `project.private.config.json:23` |
| D-07 | P1 | `requiredPrivateInfos: []` 但地址页调用 `wx.chooseLocation` → 地图选点失效 | `app.json:18`；`pages/address/edit.js:118` |
| D-08 | P1 | 构建了 72 个 Vant 组件目录，仅 10 个被引用，363.4 KB 死重量 | `miniprogram_npm/@vant/weapp/`；`app.json:28-36` |
| D-09 | P1 | 重新构建 npm 会装到 `@vant/weapp@1.11.x`（当前产物是 1.2.2）→ 组件行为与体积漂移 | `package.json:16`；`node_modules/@vant/weapp/package.json` `_id: 1.2.2` |
| D-10 | P1 | `urlCheck: false` 在两个配置文件中，掩盖域名合法性校验 | `project.config.json:21`；`project.private.config.json:7` |
| D-11 | P1 | 无 CI、无 lint/格式化配置、无 `.gitignore`、无 `.npmrc` | 全项目检索 `.eslintrc*`/`tsconfig.json`/`*.yml`/`.npmrc`/`.gitignore` 零命中 |
| D-12 | P1 | 237 项断言全部集中在纯函数与云函数逻辑；页面/启动链路/路由表/双通道零覆盖 | `tests/*.js`；`package.json:7-11` |
| D-13 | P2 | `cloudfunctions` 同时是 `cloudfunctionRoot` 又被 `packOptions.ignore` 排除（自洽性待确认） | `project.config.json:7,60` |
| D-14 | P2 | `cloudfunctions/README.md` 称"实际接线 13 个页面"，实测 9 个 | `cloudfunctions/README.md:111` |
| D-15 | P2 | `docs/云开发初始化清单.md` 称"云函数 23 个 action"，`handlers` 实际 24 个 | `docs/云开发初始化清单.md:170`；`handlers.js:890-923` |
| D-16 | P2 | `cloud-data/README.md` 称 26 个分类，正文只列 25 个（漏「生日蛋糕」） | `cloud-data/README.md:48,51-55` |
| D-17 | P2 | `legacy-apifm.js` 自称"全项目只有这一个文件 require apifm-wxapi"，实际 3 处 | `utils/services/legacy-apifm.js:6`；`app.js:5`；`utils/auth.js:6` |
| D-18 | P2 | `.trash-cleanup/.../ROLLBACK.md` 声称保留 `LICENSE`，`bread-main` 下无此文件 | `ROLLBACK.md` 第五节；`bread-main` 根目录清单 |
| D-19 | P2 | `wx.getUserProfile`（已废弃）仍用于取头像昵称 → 只能拿到匿名数据 | `pages/my/index.js:117` |
| D-20 | P3 | 项目名三处不一致：`张润航蛋糕店` / `bread-main` / `卿欢蛋糕` | `project.config.json:63`；`project.private.config.json:4`；`shop-config.js` |
| D-21 | P3 | 页面硬编码版本号 `Version 1.0 17:30:54` | `pages/about-us/index.wxml:15` |
| D-22 | P3 | `docs/` 未加入 `packOptions.ignore`（与 `tests`/`cloud-data` 处理不一致） | `project.config.json:3-19` |
| D-23 | P3 | `.trash-cleanup` 手工回滚方式不可靠（无校验、无历史、易漏项） | `.trash-cleanup/20260926-1945/ROLLBACK.md` |
| D-24 | P3 | 无 `LICENSE` 文件，模板授权来源不明 | `bread-main` 根目录实测无 `LICENSE` |

---

### 2.2 P0 详细小节

#### D-01 ｜P0｜项目无版本控制，回滚依赖手工拷贝

**证据**

```text
=== .git at root ===        False
=== .git in bread-main ===  False
=== any .git anywhere (depth 3) ===   （无输出）
=== eslint/tsconfig/CI 检索 → 含 .gitignore 在内，零命中 ===
```

`bread-main` 根目录实测清单（10 个文件）：`app.js` `app.json` `app.wxss` `config.js` `package-lock.json` `package.json` `project.config.json` `project.private.config.json` `shop-config.js` `sitemap.json`——**无 `README.md`、无 `LICENSE`、无 `.gitignore`**（`README.md` 已被移入 `.trash-cleanup`）。

唯一"回滚"手段是 `.trash-cleanup\20260926-1945\ROLLBACK.md` 中 11 条手工命令：

```powershell
Copy-Item "$trash\01__README.md"  "bread-main\README.md" -Force
Copy-Item "$trash\04__.backup-phase2"  "bread-main\.backup-phase2" -Recurse -Force
... （共 11 条）
```

**影响**

- 无法回溯：谁在什么时候把 `libVersion`、`appid`、`useCloud` 改成什么值，无任何记录。
- 无法回滚：只能整体覆盖式恢复 11 个被清理过的条目；**清理之后发生的新改动全部丢失**。
- 无法协作/评审：没有 diff，"改动前 vs 改动后"只能靠人眼比对文件内容。
- 无安全网：`ROLLBACK.md` 第四节写着"直接删除整个 `.trash-cleanup\20260926-1945\` 目录即可（此操作不可逆）"——**一旦删除，连这层手工保险也没了**。
- 上线审计不可用：审核被驳回、线上出故障时无法定位"哪次改动引入的"。

**建议（最小可行方案）**

```powershell
# 1) 在 bread-main 初始化（项目根，不是工作区根）
cd C:\Users\lenovn\Desktop\卿欢蛋糕\bread-main
git init
git add -A
git commit -m "chore: 阶段二基线（云开发主通道 + 删除 mock/多门店）"

# 2) 立刻打 tag，作为"上线前唯一可信基线"
git tag baseline-phase2-20261009
```

`bread-main\.gitignore` 建议内容（**取舍理由逐条给出**）：

```gitignore
# ---- 绝不提交 ----
node_modules/            # 依赖产物，951.2KB / 744 文件，由 package.json 重建
.trash-cleanup/          # 手工回收站，提交它等于把"没有版本控制"制度化
audit/                   # 审计报告，工作流产物，不属于小程序源码
*.log
.DS_Store

# ---- 个人/本机配置：官方建议不提交，但见下方说明 ----
project.private.config.json

# ---- 构建产物的取舍（重要）----
# miniprogram_npm/  **建议先提交**（见下方说明），因此这里故意不写它
```

**该提交**：`app.js`、`app.json`、`app.wxss`、`sitemap.json`、`config.js`、`shop-config.js`、`pages/**`、`components/**`、`template/**`、`images/**`、`utils/**`、`config/**`、`docs/**`、`tests/**`、`cloudfunctions/**`、`cloud-data/**`、`project.config.json`、`package.json`、`package-lock.json`（**修好 D-04 之后再提交**）。

**`miniprogram_npm` 的取舍（明确建议）**：
- 现状**没有 CI**、没有自动化构建，开发者工具"构建 npm"是手工动作。
- 若不提交，clone 下来必须先在开发者工具里点一次"构建 npm"才能上传；漏做会导致 `usingComponents` 解析失败。
- **建议：现阶段提交 `miniprogram_npm/`（670.9 KB），并在提交信息/文档中注明"由 `package.json` 构建所得，修改依赖后必须重新构建并一并提交"**；等 D-11 的 CI 建起来后，再改为忽略 + 构建产物由 CI 生成。

**`project.private.config.json` 的坑（必须一并处理）**：官方建议忽略它，但它里面的 `libVersion: 3.17.3` **覆盖** `project.config.json` 的 `3.8.1`（见 D-06）。若直接忽略，别的机器 clone 后生效值会掉回 `3.8.1`，行为不一致。**因此顺序必须是：先按 D-06 把 `project.config.json` 的 `libVersion` 定为团队约定值，再忽略 private 配置（或删掉 private 里的 `libVersion` 行）。**

---

#### D-02 ｜P0｜`config.js` 仍指向原面包店 api 工厂账号，且保留"切回原后端"

**证据**

`config.js:1-7`（完整内容）：

```js
module.exports = {
  version: '26.2.9',
  note: 'SDK升级', // 这个为版本描述，无需修改
  subDomain: 'yuanqibread', // 此处改成你自己的专属域名。什么是专属域名？请看教程 https://www.it120.cc/help/qr6l4m.html
  merchantId: 24340951, // 商户ID，可在后台工厂设置-->商户信息查看
  // 2026-09-26 阶段二：已移除 bindSeller（三级分销抢客）开关。本店不做分销。
}
```

配套证据（说明这不是"死配置"，而是被文档化的可用路径）：

- `utils/data-source.js:12`：`* 3. api 工厂 —— 原 apifm-wxapi SaaS（config.js 指向原面包店账号）`
- `utils/data-source.js:26-27`：`降级到 api 工厂意味着**数据来自原面包店账号**，仅用于"让项目能跑起来"，不能作为上线数据。`
- `cloudfunctions/README.md:155-158`：`## 切回原后端 / 如果切换后出问题，把 utils/data-source.js 的 useCloud 改回 false 即可，小程序会回到原来的 api工厂 通道（数据是原店的，但能跑）。`
- `app.js:20-23`：`} else { WXAPI.init(CONFIG.subDomain); WXAPI.setMerchantId(CONFIG.merchantId) }`——`subDomain`/`merchantId` 被真实使用。
- 被清理的 `bread-main\README.md`（现存于 `.trash-cleanup\20260926-1945\01__README.md:41-45`）记载模板的原始用法：`"工厂设置" --> "数据克隆" --> "将别人的数据克隆给我"`，`对方商户ID填写 24340`。即 **`config.js` 的这套值来自"克隆他人商户数据"的模板流程**。

**影响**

1. **未授权使用第三方账号**：`yuanqibread` / `24340951` 是模板作者的演示商户。上线版本里带着它，等于把一个能读写他人经营数据的通道打包进生产环境。
2. **数据串号**：任何一次 `useCloud=false`（文档把它写成排障手段）或 legacy 通道被走到，顾客看到的是**别的面包店**的商品、价格、门店。
3. **审核与法律责任**：若线上出现跨商户数据访问，属于严重合规事故；且残留的第三方 SaaS 配置会削弱"本店自建后端"的整套改造论证。

**补充的准确边界（避免与其他审计重复或夸大）**：`app.js:16-19` 显示 `useCloud=true` 时**只**调 `API.init()`，**不会**执行 `WXAPI.init()`；而 `utils/api-map.js:100-102` 的注释自认"降级到 api 工厂后又会因为『云模式下没 init 过 api 工厂 SDK』而失败"。也就是说 `fallbackToLegacy=true` 在当前配置下的真实后果**可能是"二次失败"而不是"串号"**。这一点的最终判定属于审计 A 的范围；**无论哪种结果，`config.js` 的这两个值都必须在上线前替换或彻底禁用 legacy 通道。**

**建议（三选一，按推荐度排序）**

1. **推荐**：把 `config.js` 改为 `subDomain: ''`、`merchantId: 0`，并在 `utils/data-source.js` 把 `fallbackToLegacy` 改 `false`；同时把 `cloudfunctions/README.md` 的"## 切回原后端"整节删除或改写为"已停用"。
2. 保留 legacy 代码但**从发布包中移除**：把 `config.js` 与 `utils/services/legacy-apifm.js` 移到工作区根（不参与编译），并把 `app.js`/`utils/auth.js` 的 `require('apifm-wxapi')` 一并摘除（同时解决 D-17 与 134.2 KB 包体积）。
3. 若业务方确实要保留 legacy 作为兜底，**必须**把 `config.js` 换成**本店自己的** api 工厂账号（`subDomain`/`merchantId` 由业务方提供），并在文档中删除所有"原店数据"表述。

---

#### D-03 ｜P0｜隐私协议为占位文案，全项目无隐私授权接入

**证据**

`cloudfunctions/api/shop-config.js:38-51`：

```js
  // ===== 内容单页（pages/about-us/detail 读取）=====
  // ⏳ 待补充（业务方 2026-09-26 答复：隐私协议、常见问题、店铺介绍后续补充）。
  cms: {
    agreement: {
      title: '用户隐私协议',
      content: '<p>（内容待补充）本店用户隐私协议正在完善中，将在上线前替换为正式文本。</p>'
    },
    qa: {
      title: '常见问题',
      content: '<p>（内容待补充）本店常见问题正在整理中，届时将替换为正式内容。如有疑问可致电门店或在「我的 → 联系客服」中咨询。</p>'
    }
  },
```

全项目检索 `onNeedPrivacyAuthorization`、`requirePrivacyAuthorize`、`getPrivacySetting`、`privacy` 相关隐私授权 API：**除 `pages/address/edit.js:130` 的错误串匹配外，零命中。**

同时 `pages/about-us/index.wxml:1-3` 的入口文案是"用户隐私协议"，点进去（`pages/about-us/detail`）**展示的就是上面这段占位文本**。

**影响**

- 微信小程序提交审核要求配置**《小程序用户隐私保护指引》**，且收集用户信息（手机号 `getPhoneNumber`、位置 `chooseLocation`、头像昵称）需要在指引中声明并具备可访问的隐私政策文本。**用占位文案提审，属于高概率直接驳回项**（内容不含实际收集范围、用途、存储期限、第三方共享、联系方式）。
- 更棘手的是"收集了但没声明"：`components/bind-mobile/index.wxml:16` 有 `open-type="getPhoneNumber"`，`pages/address/edit.js:118` 调 `wx.chooseLocation`，而 `app.json:18` 是 `"requiredPrivateInfos": []`、`app.json:38` 是 `"permission": {}`——**权限申报与隐私政策文本两处同时缺失**。
- 这不是"上线前补文案"那么轻：隐私政策正文是**审核材料**，且必须与《隐私保护指引》后台填写内容一致。

**建议**

1. 业务方提供正式隐私政策文本（收集范围/用途/存储/共享/用户权利/联系方式），替换 `shop-config.js:45`。
2. 在微信后台配置《小程序用户隐私保护指引》，与正文逐条对齐。
3. 在 `app.json` 补 `requiredPrivateInfos`（见 D-07）与 `permission.scope.userLocation` 描述（若启用定位）。
4. 若使用了隐私接口，接入 `wx.onNeedPrivacyAuthorization` / `wx.requirePrivacyAuthorize` 或在 `app.json` 配置 `__usePrivacyCheck__`（新规下需按平台当前要求处理，列入待验证 V-03）。

---

#### D-04 ｜P0｜依赖不可重现：lock 与 `package.json` 不匹配，且 `node_modules` 是跨机器拷贝

**证据 1：`package-lock.json` 全文仅 801 字节 / 23 行，`lockfileVersion: 1`**

```json
{
  "name": "dgd",
  "version": "1.0.0",
  "lockfileVersion": 1,
  "requires": true,
  "dependencies": {
    "@vant/weapp": { "version": "1.2.2", ... },
    "apifm-wxapi":  { "version": "3.8.0", ... },
    "wxbarcode":    { "version": "1.0.2", ... }
  }
}
```

**证据 2：与 `package.json` 直接冲突**

| 包 | `package.json` 声明 | `package-lock.json` 锁定 | 是否兼容 |
|---|---|---|---|
| `@vant/weapp` | `^1.11.7`（`package.json:16`） | `1.2.2`（`package-lock.json:8`） | ❌ `^1.11.7` 不允许 `1.2.2` |
| `apifm-wxapi` | `^26.2.5`（`package.json:17`） | `3.8.0`（`package-lock.json:13`） | ❌ `^26.2.5` 不允许 `3.8.0` |
| `wxbarcode` | `^1.0.2`（`package.json:18`） | `1.0.2`（`package-lock.json:18`） | ✅ |

**证据 3：`npm ls --json` 实测（只读，未安装任何包）**

```text
npm error code ELSPROBLEMS
npm error invalid: @vant/weapp@1.2.2  ...node_modules\@vant\weapp
npm error invalid: apifm-wxapi@3.8.0  ...node_modules\apifm-wxapi
"invalid": "\"^1.11.7\" from the root project"
"invalid": "\"^26.2.5\" from the root project"
```

**证据 4：`node_modules` 是跨机器拷贝来的（决定性）**

`node_modules/*/package.json` 中的 `_where` 字段残留：

- `@vant/weapp`：`"_where": "F:\\小程序\\蛋糕店"`（Windows，另一个盘符）
- `apifm-wxapi`：`"_where": "F:\\小程序\\蛋糕店"`
- `wxbarcode`：`"_where": "/Users/gongguojun/wxapp/cakeshop"`（**macOS 路径，模板作者机器**）

而本项目实际位于 `C:\Users\lenovn\Desktop\卿欢蛋糕\bread-main`。**这套依赖从来没有在本项目里被安装过。**

**证据 5：环境代差**

本机 `node -v` = **v24.21.0**、`npm -v` = **11.19.0**；lock 是 `lockfileVersion: 1`（npm 5/6 时代）。

**影响**

- `npm ci` 在 lock 与 `package.json` 不同步时会**直接报错退出**（npm 的硬性前置校验）——"一次装好"不成立。
- `npm install` 能装上，但会：① 把 lock 重写为 v3；② 装 `@vant/weapp@1.11.x`（而不是当前的 1.2.2）；③ 装 `apifm-wxapi@26.x`（而不是 3.8.0）。**装完之后再"构建 npm"，`miniprogram_npm` 与当前经过测试的产物不是同一个东西**（详见 D-08/D-09）。
- 没有任何机制能保证"换台机器构建出来的包"和"现在测过的包"一致 → 交接、换机、上 CI 全部受阻。

**建议**

```powershell
# 在 bread-main 下（需要业务方同意后执行，本审计不代执行）
# 1) 先确定目标版本：是"跟着 package.json 升到 1.11.x/26.x"还是"把 package.json 降到实际在用的版本"
#    推荐：先问清 @vant/weapp 是否必须 1.11.x（当前 wxml 用的是基础组件，1.2.2 已跑通）
# 2) 选定后统一：
npm install            # 让 lock 与 package.json 同步，生成 lockfileVersion 3
git add package.json package-lock.json miniprogram_npm
git commit -m "fix(deps): 同步 package-lock 与实际依赖，固定版本"
# 3) 用精确版本（去掉 ^）锁死，避免"今天装和明天装不一样"
```

并把 `package.json` 的 `^` 改为精确版本（`"@vant/weapp": "1.11.7"` 形式），从根本上杜绝漂移。

---

### 2.3 P1 详细小节（要点式）

#### D-05 ｜P1｜`packOptions.ignore` 未排除 `node_modules`，含它 2.053 MB > 2 MB

**证据**

`project.config.json:3-19` 的 ignore 只有三项：

```json
"packOptions": { "ignore": [
  { "type": "folder", "value": "cloudfunctions" },
  { "type": "folder", "value": "cloud-data" },
  { "type": "folder", "value": "tests" }
], "include": [] }
```

实测体积：

| 口径 | 字节 | 换算 |
|---|---|---|
| 主包口径（排除 `node_modules`，按 ignore 排除 cloudfunctions/cloud-data/tests，**保留 docs**） | 1,035,676 | **1011.4 KB = 0.988 MB** ✅ |
| 全部文件（含 `node_modules`） | 2,152,387 | **2.053 MB** ❌ 超 2 MB |
| `node_modules` 单独 | 974,038 | 951.2 KB / 744 文件 |

**影响**：微信小程序**主包上限 2 MB**。若开发者工具的上传打包**没有**自动排除 `node_modules`，上传会被直接拒绝，且报错信息通常只提示"包体积过大"，排查成本高。

**关于"工具是否自动排除"**：本次审计**无法离线证实**开发者工具的行为（需要实际点一次"上传"或看"代码依赖分析"面板）。因此本条按"**高风险未确认项**"处理：**这是零成本可消除的风险，没有理由不去消除它。**

**建议**：`project.config.json` 的 `packOptions.ignore` 增加：

```json
{ "type": "folder", "value": "node_modules" },
{ "type": "folder", "value": "docs" }
```

上传前用开发者工具的「详情 → 代码依赖分析 / 上传预览」核对实际计入体积。

---

#### D-06 ｜P1｜`libVersion` 两文件冲突（3.8.1 vs 3.17.3）

**证据**

- `project.config.json:61`：`"libVersion": "3.8.1"`
- `project.private.config.json:23`：`"libVersion": "3.17.3"`
- `project.private.config.json:3`（文件自述）：`"此文件中的内容将覆盖 project.config.json 中的相同字段"`

→ **实际生效值为 3.17.3**，`project.config.json` 里的 3.8.1 是"写了但没用"的死值。

**影响**

- 同一份代码在不同机器/不同人身上可能跑在不同基础库上（3.8.1 与 3.17.3 相差近 9 个小版本，组件能力与 API 行为有差异），"我这里好好的"类问题难以复现。
- 与 D-01 的 `.gitignore` 建议**直接冲突**：若忽略 private 配置，生效值就掉回 3.8.1，等于**静默改变了运行环境**。
- `project.private.config.json:19` 还有 `"ignoreDevUnusedFiles": true`，也会影响编译行为。

**建议**：把 `project.config.json:61` 的 `libVersion` 改为团队约定值（与真机/审核要求一致），并**删除** `project.private.config.json` 中的 `libVersion` 行或改为同值；确认无误后再将 private 配置加入 `.gitignore`。

---

#### D-07 ｜P1｜`requiredPrivateInfos: []` 但地址页调用 `wx.chooseLocation`

**证据**

- `app.json:18`：`"requiredPrivateInfos": [],`
- `app.json:38`：`"permission": {},`
- `pages/address/edit.js:5-6`（代码自述）：`本页的「地图选点」按钮使用 wx.chooseLocation（微信原生…）。但该接口要求在 app.json 的 requiredPrivateInfos 中声明 "chooseLocation"。`
- `pages/address/edit.js:117-133`：`onChooseLocation() { wx.chooseLocation({...}) }`，失败时走 `showModal` 明确告知"当前小程序未声明 chooseLocation 权限"。

**影响**：**地图选点功能 100% 不可用**（已有优雅降级，用户可手填地址，因此不阻断下单）。但它是一个"线上必然失效的功能"，且失效原因是配置缺项而非环境问题——审核时也容易被判为"功能不完整"。

**建议**：在 `app.json` 中补 `"requiredPrivateInfos": ["chooseLocation"]`；若同时启用定位，补 `"permission": { "scope.userLocation": { "desc": "用于定位最近门店并计算配送距离" } }`；并在《用户隐私保护指引》中同步声明位置用途（与 D-03 联动）。

---

#### D-08 ｜P1｜构建了 72 个 Vant 组件目录，仅 10 个被引用，363.4 KB 死重量

**证据**

- `miniprogram_npm/@vant/weapp` 下**实际存在 72 个目录**（`common`/`mixins`/`wxs`/`definitions`/`info` + 67 个组件），共 **466 文件 / 447.3 KB**。
- 全项目 `usingComponents` 清点结果，**Vant 组件仅 10 个入口**：
  - `app.json:28-36` 全局注册 9 个：`van-tabbar`、`van-tabbar-item`、`van-button`、`van-icon`、`van-popup`、`van-stepper`、`van-notice-bar`、`van-dialog`、`van-datetime-picker`
  - `pages/address/edit.json` 页面级 1 个：`van-area`
  - 另有 2 个项目内组件：`components/parser.20200414.min/parser`、`components/bind-mobile/index`
- 未注册的 62 个目录合计 **363.4 KB**。

体积最大的未注册组件（KB）：

| 组件 | KB | 组件 | KB | 组件 | KB |
|---|---|---|---|---|---|
| `calendar` | 35.5 | `uploader` | 21.2 | `tabs` | 18.4 |
| `common`* | 17.4 | `field` | 14.8 | `mixins`* | 12.5 |
| `picker` | 11.1 | `slider` | 11.0 | `cascader` | 10.9 |
| `index-bar` | 10.3 | `circle` | 9.4 | `share-sheet` | 6.8 |

\* `common`/`mixins`/`wxs`/`definitions`/`info` 共 35.9 KB 属基础目录，**可能被已注册组件依赖，不可盲删**；保守可裁剪量约 **300–360 KB**。

**包体积构成（主包口径 1011.4 KB）**

| 目录 | KB | 占主包 |
|---|---|---|
| `miniprogram_npm`（合计） | 670.9 | **66.3%** |
| ├ `@vant/weapp` | 447.3 | 44.2% |
| ├ **其中未被引用的部分** | **363.4** | **35.9%** |
| ├ `apifm-wxapi` | 134.2 | 13.3% |
| └ `wxbarcode` | 89.3 | 8.8% |
| `pages` | 165.1 | 16.3% |
| `images` | 54.8 | 5.4% |
| `utils` | 54.7 | 5.4% |
| `components`（parser ≈30.0 + bind-mobile ≈2.8） | 32.8 | 3.2% |
| `docs`（**未 ignore**） | 8.4 | 0.8% |

**影响**：主包约 **36%** 的体积是永远不会被渲染的组件代码。虽然当前 0.988 MB 未超限，但这直接压缩了后续录真实商品图、加功能的空间，并且拖慢小程序下载/启动。

**建议（按优先级）**

1. 把未使用的 Vant 组件目录从 `miniprogram_npm/@vant/weapp` 删除（先备份 + 在真机回归一遍已注册的 10 个组件）。
2. 用 `project.config.json:48-49` 已存在的 `packNpmManually: false` / `packNpmRelationList: []` 改为**手动构建模式**，把产物做成受控清单，避免下次"构建 npm"又把 62 个目录带回来。
3. `wxbarcode`（89.3 KB）只服务核销码；核销是低频内部功能，可考虑移到分包（但需先评估，见下）。
4. **是否需要分包？当前结论：不需要。** 主包 0.988 MB，余量充足；`app.json` 无 `tabBar`、无 `subPackages`，引入分包会增加"分包不能引用主包外组件"的约束与跳转改造量，收益为负。**先做 Vant 裁剪（预计主包降到 ~650 KB），再谈分包。**

---

#### D-09 ｜P1｜重新构建 npm 会装到 1.11.x，当前产物却是 1.2.2

**证据**

- 实际安装版本：`node_modules/@vant/weapp/package.json` → `"_id": "@vant/weapp@1.2.2"`、`"version": "1.2.2"`
- `package.json:16` 声明：`"@vant/weapp": "^1.11.7"`
- 实际安装版本：`node_modules/apifm-wxapi/package.json` → `"version": "3.8.0"`；`package.json:17` 声明 `"^26.2.5"`

**影响**：`miniprogram_npm` 里那份"经过测试的 UI 组件库"是 **1.2.2**（2019 年代），而任何一次正规 `npm install` + 构建 npm 都会换成 **1.11.x**（相隔 9 个大版本）。

- 组件属性、事件名、样式类名在 1.2.x → 1.11.x 之间有大量变更 → **可能整片 UI 静默走样或报错**。
- 构建产物体积也会变（1.11.x 组件更多更大），**当前的 2 MB 余量测算随之失效**。
- 结论：**当前"测试通过"的包，无法用 `package.json` 的内容重建出来。**

**建议**：二选一并固化成一条命令（`npm run build:npm` 之类的脚本 + 文档说明）——
① **锁回当前在用的版本**（把 `package.json` 写成 `"@vant/weapp": "1.2.2"`），零风险，但停留在旧版本；
② **升级到 1.11.x 并做一次完整真机回归**（重点：`van-dialog`、`van-datetime-picker`、`van-area`、`van-stepper`），同时重测包体积。
推荐 ① 先保证上线可复现，把 ② 排到上线后的迭代。

---

#### D-10 ｜P1｜`urlCheck: false` 出现在两个配置文件中

**证据**

- `project.config.json:21`：`"urlCheck": false,`
- `project.private.config.json:7`：`"urlCheck": false,`

**影响**：关闭了开发者工具的**域名合法性校验**。开发期确实方便（不必先配服务器域名），但它会**掩盖上线必炸的问题**：`request`/`uploadFile`/`downloadFile`/`socket` 的域名未在后台配置"服务器域名"时，本地模拟器照样跑通，**真机/线上直接失败**。

本项目改造为云开发为主通道后，业务请求走 `wx.cloud.callFunction`（不受域名白名单限制），风险面收窄；但 legacy 通道仍会发起 HTTP 请求，且**商品图片若用外链 HTTPS（`docs/云开发初始化清单.md:117` 推荐的方案 B）必须配置 downloadFile 合法域名**。

**建议**：上线前把 `urlCheck` 改回 `true`，在开发者工具里过一遍所有网络请求，确认域名白名单齐备；至少在发布检查清单里保留"用真机（非模拟器）验证一遍"的强制项（见第三节）。

---

#### D-11 ｜P1｜无 CI、无 lint/格式化配置、无 `.gitignore`、无 `.npmrc`

**证据**：全项目（排除 `node_modules`）检索 `.eslintrc*`、`*.eslintrc*`、`tsconfig.json`、`.editorconfig`、`*.yml`、`*.yaml`、`.npmrc`、`.gitignore` —— **全部零命中**。

**影响**

- **质量无护栏**：237 个断言只能靠人记得手动跑 `npm test`；没有任何机制在提交时执行。
- **风格漂移**：项目内已存在缩进/空格不一致（`handlers.js` 注释与代码混排、多处 `console.log`），无 lint 约束只会继续扩散。
- **无自动化构建**：`node_modules` 是拷来的、`miniprogram_npm` 是手工构建的、`package-lock` 是坏的——三者互相印证"没有构建流水线"。

**建议（分两步，不要一次上大工程）**

1. **第一步（半天）**：`git init` + `.gitignore`（D-01）+ 一个 `pre-commit` 或最简 CI：`.github/workflows/ci.yml` 只做 `npm ci && npm test`（注意：`npm ci` 现在必失败，需先修 D-04）。
2. **第二步（可选）**：加 `eslint` + `prettier`（对小程序 `.js` 用 `eslint:recommended` 即可，不要引入需要 TS 的复杂配置）；`tsconfig.json` 对纯 JS 小程序**不必强加**。

---

#### D-12 ｜P1｜237 项断言全绿，但覆盖盲区很大：页面/启动链路/路由表/双通道零覆盖

**实跑结果（`node tests/<file>`，全部 exit code 0）**

| 脚本 | 断言数 | 覆盖对象 |
|---|---|---|
| `tests/test-cloud-api.js` | **74** | 用内存版 `db` 跑云函数 `handlers.js` 全流程：规格加价、分类、商品、购物车、多用户隔离、下单、查单、取消回补库存、核销、**防前端改价**、外送运费重算、蛋糕识别 |
| `tests/test-spec.js` | **27** | 纯函数：规格组构建（`buildPropertyGroups`）、`buildSku`、**串位 bug 修复验证**、购物车 key 与前端一致性、价格计算 |
| `tests/test-address.js` | **33** | 地址簿逻辑：增删改、默认地址补位、手机号校验、格式化、店铺地址隔离 |
| `tests/test-delivery.js` | **103** | 距离计算、配送区域、蛋糕识别、运费档位与边界、预约时间校验、时段生成、**云函数侧副本一致性（两端运费结果一致）** |
| **合计** | **237 / 0 失败** | — |

**覆盖盲区（逐项确认无对应测试）**

| 盲区 | 为什么危险 | 当前有无任何测试 |
|---|---|---|
| **页面逻辑**（14 个页面的 `Page({})`）：`pages/goods-details`、`pages/orders`、`pages/pay`、`pages/current-order`… | 上线后顾客直接接触的就是这些；`goods-details` 的历史问题是"未登录加购抛 `ReferenceError`" | ❌ 零 |
| **启动链路 `app.js`** | `onLaunch` 的三态分支（`useMock`/`useCloud`/legacy）决定全站数据源；`DS.useCloud` 写错就是全站白屏 | ❌ 零 |
| **云函数路由表 `handlers`** | 24 个 action 的注册完整性；**测试用的是 `dispatch`，不校验"某个 action 是否被注册"** | ❌ 零（`test-cloud-api.js` 只测已调用的 action） |
| **`utils/api-map.js` 双通道一致性** | 35+ 个方法各有 cloud / legacy 两个实现，**名称与返回结构靠人工对齐**；`useCloud` 一切换就换一套实现 | ⚠️ 间接（只测了 cloud 侧，legacy 侧未跑） |
| **`components/bind-mobile`** | 手机号绑定是唯一"实名"入口 | ❌ 零 |
| **支付流程 `utils/pay.js`** | 含 `wx.requestPayment`，是资金链路 | ❌ 零（且当前 `wxpay` 返回 501，本来也无法端到端测） |
| **`utils/auth.js` 的云/legacy 分支** | 登录态错乱 = 用户看不到自己的订单 | ❌ 零 |
| **`pages/**/*.json` / `app.json` 配置合法性** | 如 `requiredPrivateInfos` 缺失（D-07）、`usingComponents` 路径写错 | ❌ 零 |

**"测试全绿但线上仍会挂"的具体例子（本题要求）**

1. **`requiredPrivateInfos` 缺失（D-07）**：237 项断言全绿 → 上线后点"地图选点"必失败。因为没有任何测试读 `app.json`。
2. **`@vant/weapp` 版本漂移（D-09）**：`npm test` 全绿 → 重新构建 npm 后 UI 组件换成 1.11.x，`van-datetime-picker` 属性变更导致"选时间"页异常。因为测试**不引入任何 Vant 组件**，只测纯函数。
3. **`app.js` 数据源分支**：测试直接 `require` `handlers.js` 并注入内存 `db`，**从不执行 `app.js` 的 `onLaunch`**。若 `useCloud` 被误改为 `false`，测试依然全绿，线上却会去连第三方账号（D-02）。
4. **云函数未部署/env 写错**：`test-delivery.js` 的"云函数侧副本一致性"断言只做**文件文本比对**（比较 `cloudfunctions/api/shop-config.js` 与根 `shop-config.js` 的数值），**不验证云函数是否真的能被调用**。环境 ID 写错 → 测试全绿，线上全站无数据。
5. **legacy 通道**：`tests/` 中没有一行执行 `utils/services/legacy-apifm.js`。这条"备用生命线"**从未被验证过**——真到降级时刻才发现它是坏的（`api-map.js:100-102` 的注释已自认这一点）。
6. **页面级 `usingComponents` 路径**：`pages/address/edit.json` 注册 `van-area`，而 `app.json` 全局注册了 9 个；两者若路径写错，编译期报错但**测试期无感**。

**建议补充的测试（按性价比排序）**

1. **配置断言测试（最高性价比，约 1 小时）**：写 `tests/test-config.js`，断言 `app.json` 的 `requiredPrivateInfos` 包含 `chooseLocation`（若地址页在用）、`app.json` 的每个 `usingComponents` 路径在磁盘存在、`app.json.pages` 与磁盘页面一一对应、`project.config.json` 的 `cloudfunctionRoot` 存在、`packOptions.ignore` 覆盖 `node_modules`。**这类测试能直接拦住 D-05、D-07、D-22 与"删了页面忘删注册"类问题。**
2. **路由表契约测试（约 1 小时）**：断言 `handlers` 的 key 集合与 `cloudfunctions/README.md` 的 action 表格**双向一致**（文档多写/少写都失败）——直接把 D-15 变成"改了代码不改文档就红"。
3. **api-map 双通道契约测试（约半天）**：对 `api-map.js` 导出的每个方法，断言 cloud / legacy 两侧都存在且参数个数一致（可用静态解析，不必真的发请求）。
4. **页面可加载性 smoke 测试（约半天）**：在小程序模拟器或 `miniprogram-simulate` 中对 14 个页面逐个 `Page()` 加载，断言 `onLoad` 不抛错（需 mock `wx.*`）。可覆盖"未登录加购抛错""缺失事件处理函数"这类历史问题。
5. **`app.js` 启动分支测试（约 2 小时）**：mock `utils/data-source` 的三种组合，断言 `onLaunch` 只调用了预期的那一个初始化函数。

---

### 2.4 P2 详细小节（文档一致性 —— 逐条"文档说 X / 代码是 Y"）

#### D-13 ｜P2｜`cloudfunctions` 既是 `cloudfunctionRoot` 又被 `packOptions.ignore` 排除

- **文档/配置说 X**：`project.config.json:60` `"cloudfunctionRoot": "cloudfunctions/"`（把该目录声明为云函数根）；同时 `project.config.json:7` 又把 `cloudfunctions` 放进 `packOptions.ignore`。
- **实际是 Y**：两项**并不必然冲突**——云函数目录本就不应进入小程序代码包，开发者工具对云函数根有独立处理。但**显式 ignore 一个已声明为云函数根的目录，属于配置冗余**；一旦将来有人误删 `cloudfunctionRoot` 而只留 ignore，会得到"云函数目录存在但上传按钮消失"的迷惑现象（`cloudfunctions/README.md:122-123` 恰好记录了历史上"此前缺失、无法右键上传"的事故）。
- **影响**：P2，可维护性/误操作风险。**建议**：保留 `cloudfunctionRoot`，在 `packOptions.ignore` 中**保留** `cloudfunctions` 但加注释说明（JSON 不支持注释 → 改为在 `cloudfunctions/README.md` 的部署步骤里明确写"该目录被 ignore 是有意为之，不影响云函数上传"）；另一个更干净的选项是删掉这条 ignore，依赖云函数根的默认行为——但不能与"云函数目录被上传进小程序包"的风险同时存在，**需实测确认后二选一**。

#### D-14 ｜P2｜`cloudfunctions/README.md` 称"实际接线 13 个页面"，实测 9 个

- **文档说 X**：`cloudfunctions/README.md:111`
  > 经核对，`utils/tools.js` **已不存在**（全项目无该文件），实际接线为 **13 个页面** + `utils/auth.js` + `app.js`。
- **代码是 Y**：实测 require `utils/api-map` 的**页面只有 9 个**：
  `pages/about-us/detail.js`、`pages/current-order/index.js`、`pages/goods-details/index.js`、`pages/index/index.js`、`pages/my/index.js`、`pages/order-view/index.js`、`pages/order-view/scan-result.js`、`pages/orders/index.js`、`pages/pay/index.js`
  非页面接线方**还多了 2 个文档未提的**：`components/bind-mobile/index.js`、`utils/pay.js`
  （`app.json` 共注册 14 个页面；未接 api-map 的 5 个是 `select-time`、`add-note`、`address`、`address/edit`、`about-us/index`，它们属纯本地/静态页。）
- **影响**：P2。文档高估了改造覆盖度 44%，会误导"还有哪些页面没接"的排查；且漏记 `bind-mobile`（新接的组件）与 `utils/pay.js`。**建议**：改为"实测：9 个页面 + `app.js` + `components/bind-mobile/index.js` + `utils/auth.js` + `utils/pay.js`"，并附一条 grep 命令让读者可自行复核。

#### D-15 ｜P2｜`docs/云开发初始化清单.md` 称"云函数 23 个 action"，实际 24 个

- **文档说 X**：`docs/云开发初始化清单.md:170`：`| cloudfunctions/README.md | 云函数 23 个 action 的清单与部署说明 |`
- **代码是 Y**：`cloudfunctions/api/handlers.js:890-923` 的 `handlers` 对象实测 **24 个 key**：
  `getUser, updateUser, bindMobile, appConfig, cmsPage, importData, banners, fetchShops, shopSubdetail, categoryList, goodsList, goodsDetail, cartInfo, cartAdd, cartModifyNumber, cartRemoveItem, cartRemoveAll, orderCreate, orderList, orderDetail, orderClose, orderDelete, orderHx, wxpay`
  （`cloudfunctions/README.md:42-67` 的表格恰好也是 24 行，**即 README 是对的、docs 这份是旧数字**。）
- **影响**：P2。第三份文档出现与另外两份不一致的数字，读者无法判断哪份为准。**建议**：改为 24；更好的做法是按 D-12 建议加一条"路由表 ↔ README 表格双向一致"的测试，让数字不可能过期。

#### D-16 ｜P2｜`cloud-data/README.md` 称 26 个分类，正文只列 25 个（漏「生日蛋糕」）

- **文档说 X**：`cloud-data/README.md:48`："从你提供的三张截图去重后得到 **26 个**分类，已落在本目录的 `categories.jsonl`"；随后 `:51-55` 的分类清单代码块。
- **数据是 Y**：用 Node 解析 `cloud-data/categories.jsonl` 实测 **26 条**，但 README 清单逐条拆分后**只有 25 项**，差集精确为 **`["生日蛋糕"]`**（其余 25 项与数据库完全一致，无错名）。

  ```text
  README列出=25  DB实际=26
  README有DB无: []
  DB有README无: ["生日蛋糕"]
  ```
- **交叉印证**：`docs/云开发初始化清单.md:80` 写"`category` 应该是 26 条，**第 1 条是「生日蛋糕」**"，而 `categories.jsonl` 第 1 条确实是 `{"_id":"cat_birthday","name":"生日蛋糕","sort":5}`。也就是说**清单文档是对的，cloud-data/README.md 的清单漏了排在第一位的那个分类**。
- **影响**：P2。业务方照 README 的 25 项目录核对后台，会以为少了一条数据而反复排查。**建议**：在 `:51-55` 的开头补上「生日蛋糕」，或直接改为"共 26 个，完整清单以 `categories.jsonl` 为准（26 行）"。

#### D-17 ｜P2｜"全项目只有这一个文件 require apifm-wxapi"，实际 3 处

- **文档说 X**：`utils/services/legacy-apifm.js:5-6`：
  > api 工厂代码**全部保留、不删除**，但业务层不再直接 `require('apifm-wxapi')`。
  > **整个项目里只有这一个文件 require apifm-wxapi**，其余一律通过 `utils/api-map.js`。
- **代码是 Y**：实测直接 require `apifm-wxapi` 的还有两处——
  `app.js:5`：`const WXAPI = require('apifm-wxapi')`
  `utils/auth.js:6`：`const WXAPI = require('apifm-wxapi')`
  （这两个文件**各自在头部写了免责注释**：`app.js:1-4`、`utils/auth.js:1-5`，说明作者知情，只是 `legacy-apifm.js` 的这句总结**从未更新**。）
- **影响**：P2。这句话是"依赖收敛完成"的验收依据，读起来像已完成，实际**收敛到 3 个文件**。它还会误导"删掉 legacy 就能去掉 134.2 KB 的 apifm-wxapi"的判断——**实际需要同时改 3 个文件的引用**。**建议**：改为"收敛为 3 处：`utils/services/legacy-apifm.js`（适配层）+ `app.js:5`（启动 init）+ `utils/auth.js:6`（登录），均已就地注释说明"。

#### D-18 ｜P2｜`ROLLBACK.md` 声称保留 `LICENSE`，`bread-main` 下无此文件

- **文档说 X**：`.trash-cleanup/20260926-1945/ROLLBACK.md` 第五节"本次清理**没有**触碰的东西（明确保留）"中列有 `LICENSE`：
  > - 全部 14 个页面、19 张图片、4 个测试脚本、`docs\云开发初始化清单.md`、`LICENSE`
- **实际是 Y**：`bread-main` 根目录实测 10 个文件，**无 `LICENSE`**；`manifest.csv` 的 11 条删除记录里也**没有 `LICENSE`**（即它既不是被这次清理删的，就是**本来就不存在**）。
- **其余核对结果（说明这份清单总体是可信的）**：`14 个页面` ✅（`app.json` 14 页、磁盘 14 个 `.js` 完全对应）、`19 张图片` ✅、`4 个测试脚本` ✅、`docs\云开发初始化清单.md` ✅。**仅 `LICENSE` 一项对不上。**
- **影响**：P2。回滚清单是当前唯一的"事实来源"，一项对不上就会让人怀疑整份清单；且 `LICENSE` 缺失牵出**模板授权来源不明**（见 D-24 与待验证 V-08）。**建议**：修正该行；若模板来自 it120.cc / api工厂生态，**向业务方确认授权范围**后再决定是否需要补许可证文件。

#### D-19 ｜P2｜`wx.getUserProfile`（已被平台回收）仍用于获取头像昵称

- **证据**：`pages/my/index.js:117`：`wx.getUserProfile({ ... })`
- **实际行为**：`wx.getUserProfile` 自 2022 年起被平台调整为**默认返回匿名数据**（昵称"微信用户"、灰色默认头像），官方推荐改用**头像昵称填写能力**（`button open-type="chooseAvatar"` + `<input type="nickname">`）。
- **影响**：P2。功能不会报错，但**用户资料永远拿不到真实头像昵称**，表现为"改了没反应/显示微信用户"，客服量上升。**建议**：改用头像昵称填写能力；同时这属于"收集用户信息"，需与 D-03 的隐私指引声明一致（本项与审计 C 的范围有重叠，此处仅从合规与发布角度记录）。

---

### 2.5 P3 详细小节

| ID | 问题 | 证据 | 影响 | 建议 |
|---|---|---|---|---|
| D-20 | 项目名三处不一致 | `project.config.json:63` = `%E5%BC%A0%E6%B6%A6%E8%88%AA%E8%9B%8B%E7%B3%95%E5%BA%97`（解码 = **张润航蛋糕店**）；`project.private.config.json:4` = **bread-main**（生效值，覆盖前者）；`shop-config.js` 的 `name` 与 `cloud-data/app-config.jsonl` 的 `mallName` = **卿欢蛋糕**；工作区目录 = `卿欢蛋糕` | 开发者工具标题与上传显示名是模板遗留名，与实际店铺品牌不符；对客无影响 | 统一为 `卿欢蛋糕`：改 `project.config.json:63` 的 `projectname`，并删掉 `project.private.config.json:4` 的覆盖 |
| D-21 | 页面硬编码版本号 | `pages/about-us/index.wxml:15`：`<view class="version">Version 1.0 17:30:54</view>` | 显示的版本与时间戳是写死的，永不更新，顾客可能据此判断"应用没更新" | 改为从 `wx.getAccountInfoSync().miniProgram.version` 读取，或直接删除该行 |
| D-22 | `docs/` 未加入 `packOptions.ignore` | `project.config.json:3-19` 排除了 `cloudfunctions`/`cloud-data`/`tests`，**唯独没有 `docs`**（8.4 KB，含 AppID/环境 ID/内部操作步骤） | 内部文档可能随包上传；与已排除的其他非运行目录处理不一致 | ignore 增加 `{ "type": "folder", "value": "docs" }`（与 D-05 一并改） |
| D-23 | `.trash-cleanup` 手工回滚方式不可靠 | `.trash-cleanup/20260926-1945/`：`ROLLBACK.md` + `manifest.csv`（11 条）+ 手工 `Copy-Item` | ① 只覆盖"被清理时"的状态，之后的改动全丢；② 无校验和自动核对（`manifest.csv` 里有 SHA256，但回滚脚本**不校验**它）；③ `ROLLBACK.md` 第四节建议"确认后删除整个目录"→ 删了就彻底没有回滚能力；④ 已出现一项失实（D-18） | 用 `git` 取代它（D-01）；迁移完成后保留 `.trash-cleanup` 作为归档但**从工作流中移除**，并在 `ROLLBACK.md` 顶部标注"已被 git 取代，仅供历史查阅" |
| D-24 | 无 `LICENSE` 文件，模板授权来源不明 | `bread-main` 根目录实测无 `LICENSE`；被清理的 `bread-main\README.md`（`.trash-cleanup\20260926-1945\01__README.md`）是 it120.cc/api工厂生态的模板说明，并包含 `"将别人的数据克隆给我"`、`对方商户ID填写 24340` 等指引 | 上线商用前无法证明对该模板/资源的授权范围（含 `images/` 素材、`components/parser.20200414.min` 第三方组件） | 向业务方/模板提供方确认授权（待验证 V-08）；确认后补 `LICENSE` 与第三方组件声明 |

---

## 三、发布前检查清单（可勾选）

状态图例：`[x]` 已具备 · `[ ]` 缺失/待做 · `[?]` 待平台/业务方确认

### A. 版本控制与工程基线

- [ ] **A1** 在 `bread-main` 执行 `git init` 并完成首次提交（对应 D-01）
- [ ] **A2** 添加 `.gitignore`（排除 `node_modules/`、`.trash-cleanup/`、`audit/`、`project.private.config.json`）
- [ ] **A3** 打一个上线前基线 tag（`baseline-phase2-20261009`）
- [ ] **A4** `package-lock.json` 与 `package.json` 同步，`npm ci` 可成功（对应 D-04）
- [x] **A5** `npm test` 可运行且全绿（实测 237 断言 / 0 失败）
- [ ] **A6** 确认 `miniprogram_npm` 是否为提交产物，并在文档写明重建方式（对应 D-09）
- [ ] **A7** 加入 CI 或至少一个提交前钩子跑 `npm test`（对应 D-11）

### B. 配置与包体积

- [ ] **B1** `packOptions.ignore` 增加 `node_modules` 与 `docs`（对应 D-05、D-22）
- [ ] **B2** 用开发者工具「上传预览/代码依赖分析」确认实际计入体积 **< 2 MB**（关键未知项）
- [x] **B3** 主包当前体积 1011.4 KB，未触发 2 MB，**暂不需要分包**
- [ ] **B4** `libVersion` 两文件统一（删除或同步 `project.private.config.json:23`）（对应 D-06）
- [ ] **B5** `urlCheck` 改回 `true`，并用真机验证所有网络请求/图片域名（对应 D-10）
- [ ] **B6** 裁剪未使用的 62 个 Vant 组件目录（约 300–360 KB）（对应 D-08）
- [ ] **B7** `app.json` 补 `requiredPrivateInfos: ["chooseLocation"]` 与 `permission.scope.userLocation`（对应 D-07）
- [ ] **B8** 统一 `projectname` 为「卿欢蛋糕」（对应 D-20）

### C. 发布合规（微信平台侧）

- [ ] **C1** 小程序**类目**选择：需含「食品/烘焙」类（蛋糕烘焙 + 餐饮配送）—— **待业务方确认具体类目**
- [?] **C2** **食品经营许可证**：蛋糕/烘焙制售+配送类目通常要求资质 —— **待业务方确认是否需要、是否已备**
- [?] **C3** 主体类型确认：`wx5b0e027deafefc01` 是否**个人主体**（若是 → 无法开通微信支付、部分能力不可用，见待验证 V-01/V-02）
- [?] **C4** 微信支付**商户号**申请与绑定（当前 `wxpay` 返回 501，见待验证 V-02）
- [ ] **C5** 后台配置《小程序用户隐私保护指引》，且与页面隐私政策正文一致（对应 D-03）
- [ ] **C6** 替换隐私协议正式文本（`cloudfunctions/api/shop-config.js:45`）
- [ ] **C7** 替换常见问题正式文本（`cloudfunctions/api/shop-config.js:49`）
- [ ] **C8** 用户信息收集申报：手机号（`getPhoneNumber`）、位置（`chooseLocation`）、头像昵称（`getUserProfile`）（对应 D-03、D-07、D-19）
- [x] **C9** 客服入口已具备：`pages/my/index.wxml:76` 使用原生 `open-type="contact"`
- [ ] **C10** 小程序后台「功能 → 客服」添加客服人员（代码注释 `pages/my/index.wxml:75` 已提醒"否则点击无响应"）
- [ ] **C11** 订阅消息模板配置（全项目**零命中** `requestSubscribeMessage` → 当前**未使用**订阅消息，如业务需要下单/核销通知需新做）
- [ ] **C12** 版本号与审核材料：`app.json`/`package.json` 版本（`1.0.0`）与页面显示版本一致（对应 D-21）
- [ ] **C13** 提审前用**体验版 + 真机**走通：首页 → 点单 → 规格 → 加购 → 结算 → 下单（注意支付会停在"支付未接入"）
- [ ] **C14** 云函数 `api` 已在**正确环境**部署，集合（7 个）已建且权限正确（属审计 B 范围，此处列为发布前置）
- [ ] **C15** 上线前处理 `.trash-cleanup`：迁移到 git 后归档，不留在活跃工作流（对应 D-23）

### D. 安全与泄露

- [ ] **D1** 替换 `config.js:4-5` 的 `subDomain`/`merchantId`，或彻底禁用 legacy 通道（对应 D-02）
- [ ] **D2** `utils/data-source.js:39` 的 `fallbackToLegacy` 改为 `false`（或确认降级目标不再是第三方账号）
- [x] **D3** 全项目**未发现** AppSecret / 支付密钥 / 证书 / `mch_id` 等硬编码密钥（检索结果见 2.6）
- [ ] **D4** 移除/改写 `cloudfunctions/README.md:155-158`「切回原后端」一节（对应 D-02）
- [ ] **D5** 确认发布包内不含内部文档（`docs/`）与测试（`tests/` 已 ignore ✅）
- [x] **D6** 图片与第三方组件无外链 CDN 依赖残留（原 `ns.s2m.cc` 字体加载已在 `app.js:24-34` 注释禁用 ✅）

---

### 2.6 安全与泄露检索结果（第 8 项要求）

**检索范围**：全项目 `*.js` `*.json` `*.md` `*.jsonl` `*.wxml` `*.wxss`（排除 `node_modules`/`miniprogram_npm`）
**检索词**：`appsecret|AppSecret|app_secret|secret|mch_id|mchId|merchantId|subDomain|sub_domain|yuanqibread|24340951|apiKey|api_key|private_key|-----BEGIN|paymentKey|it120.cc|apifm`

| 类别 | 结论 | 证据 |
|---|---|---|
| **AppSecret / 支付密钥 / 证书** | **未发现**（零命中 `appsecret`、`-----BEGIN`、`private_key`、`paymentKey`） | 检索输出 |
| **商户号 / subDomain（第三方归属）** | ⚠️ **命中，P0** | `config.js:4` `subDomain: 'yuanqibread'`；`config.js:5` `merchantId: 24340951` → D-02 |
| **模板/第三方平台引用** | ⚠️ 大量残留（P3） | 实测 **29 行**命中 `https://www.yuque.com/apifm/...` 文档链接（如 `pages/pay/index.js:172,181,215,353,362`、`utils/auth.js:59,142,217`）；另 **1 行**命中 `https://www.it120.cc/help/qr6l4m.html`（`config.js:4`） |
| **`app.js` 是否使用第三方账号** | 条件是：仅当 `useCloud=false` 且 `useMock=false` | `app.js:16-23`（云模式下不 init legacy） |
| **内部文档/备份/临时文件是否会被打进包** | `tests/`、`cloud-data/`、`cloudfunctions/` **已 ignore** ✅；`docs/` **未 ignore**（8.4 KB，含 AppID/环境 ID/操作步骤）→ D-22；`.trash-cleanup/` 在工作区根，**不在项目目录内**，不会被打包 ✅ | `project.config.json:3-19`；实测目录位置 |
| **备份/临时文件残留** | `bread-main` 内**零命中** `*.bak/*.old/*.tmp/*.log/*.zip/副本/backup`（`.backup-phase2` 已被清理确认不存在） | 全项目文件检索 |

**必须替换才能上线的 P0 项**：仅 **`config.js:4` 的 `subDomain` 与 `config.js:5` 的 `merchantId`**（连同 `fallbackToLegacy` 与文档"切回原后端"路径）。

---

## 四、待验证清单（需业务方 / 平台方确认，**不作为已确认缺陷**）

| ID | 待验证事项 | 为什么要确认 | 怎么确认 |
|---|---|---|---|
| **V-01** | 小程序 `wx5b0e027deafefc01` 的**主体类型**（个人 / 企业 / 个体工商户） | `docs/云开发初始化清单.md:1` 标题自称"个人测试 AppID"，`:105` 称"个人主体办不了商户号"。**若确认是个人主体，则微信支付无法开通、`getPhoneNumber` 手机号快速验证组件等能力受限**——这会直接决定"能否做线上收款"。另：若确认非个人主体，则哪几处文档表述需更正 | 微信公众平台 → 设置 → 基本设置 → 主体信息 |
| **V-02** | 微信支付**商户号**是否已申请、是否已与 AppID 绑定 | `cloudfunctions/api/handlers.js` 的 `wxpay` 当前返回 `fail('云开发支付尚未接入：需先申请微信支付商户号并配置云开发支付（cloud.cloudPay）', 501)`；`docs/云开发初始化清单.md:105` 把"云开发支付尚未接入"列为"正常现象"。**没有商户号 = 上线后顾客无法付款**，这是业务闭环的硬前提 | 商户平台 / 微信支付后台 |
| **V-03** | 《小程序用户隐私保护指引》当前配置状态与平台最新要求（是否需 `__usePrivacyCheck__` / `onNeedPrivacyAuthorization`） | D-03 只证明了"代码与文案都缺位"；**具体需要哪种接入形式取决于平台当前规则**，需以最新官方文档为准 | 微信公众平台 → 设置 → 服务内容声明 → 用户隐私保护指引；对照官方文档（[获取头像昵称](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/userProfile.html)、[手机号快速验证组件](https://developers.weixin.qq.com/miniprogram/dev/framework/open-ability/getPhoneNumber.html)） |
| **V-04** | 蛋糕烘焙 + 餐饮配送的**类目与资质**：是否需要《食品经营许可证》（或小餐饮备案等） | 涉及食品制售/配送的类目，平台通常要求资质；缺资质会导致提审被驳回或类目受限。**具体需要哪一类、哪种证照由业务方与平台确认** | 微信公众平台 → 设置 → 基本设置 → 服务类目；对照平台类目资质要求 |
| **V-05** | 开发者工具上传时是否自动排除 `node_modules` | 决定 D-05 是"必须修"还是"保险起见"。可确认的路径：点一次上传/预览，看包体积是否约 1.0 MB（自动排除）还是约 2.05 MB（未排除） | 开发者工具「上传」的包体积提示 / 代码依赖分析 |
| **V-06** | 云环境 `cloud1-d7g2txuxpf22bb979` 是否属于该 AppID、是否仍在有效套餐内 | `utils/data-source.js:61` 硬编码该环境 ID。若环境过期/不匹配，`useCloud=true` 会全站无数据并触发降级（进而触碰 D-02 的第三方账号通道）。属审计 A/B 范围，此处登记为发布前置 | 微信开发者工具 → 云开发 → 环境设置 |
| **V-07** | 核销白名单 `adminOpenids: []` 何时填入 | `cloudfunctions/api/shop-config.js:33-36` 注明"待配置"，填之前「扫码核销」入口不显示（`docs/云开发初始化清单.md:119-128` 有步骤）。不影响上线，但影响商家实际可用性 | 业务方提供店主 openid |
| **V-08** | 模板与素材的**授权范围**（it120.cc / api工厂 面包店模板、`images/*`、`components/parser.20200414.min`、`wxbarcode`） | D-24：项目内无 `LICENSE`，而被清理的原始 `README.md` 是第三方模板说明（含"克隆他人商户数据"指引）。**商用上线前需确认授权**，避免版权争议 | 向模板提供方/业务方索取授权凭证 |
| **V-09** | 订阅消息模板是否业务需要 | 全项目零命中 `requestSubscribeMessage`——**当前完全没有订阅消息**。若业务希望"下单成功/核销成功"给顾客发通知，需要新增订阅模板与代码（属功能缺口，非缺陷） | 业务方确认是否需要通知能力 |

---

## 五、建议修复顺序

原则：**先建立安全网（能量化、能回滚），再消除阻断上线项，最后清体积与文档。**

### 阶段 0 ｜半天 ｜建立安全网（**先做这个，否则后面所有改动都不可回溯**）

1. `git init` + `.gitignore` + 首次提交 + 打 tag（**D-01**）
2. 修 `package-lock.json` 与 `package.json` 的一致性，让 `npm ci` 能跑通（**D-04**）
3. 在 CI 或提交前钩子里挂上 `npm test`（**D-11** 第一步）

> 为什么放最前：D-04 的修复必须动 `package.json` / `node_modules` / 可能重建 `miniprogram_npm`——**没有 git 就做不了这个操作**（改坏了无法回退）。

### 阶段 1 ｜1 天 ｜消除阻断上线的 P0

4. 替换/禁用 `config.js` 的第三方 `subDomain`/`merchantId`，`fallbackToLegacy=false`，改写 `cloudfunctions/README.md` 的"切回原后端"（**D-02**）
5. 补隐私协议正式文本 + 平台《用户隐私保护指引》+ 补齐 `requiredPrivateInfos`/`permission`（**D-03**、**D-07**）
6. 确认 V-01/V-02（主体类型、商户号）——**这是"能不能收款"的决策点，越早越好**：若要收款而当前是个人主体，全部后续排期都要围着"换主体/换 AppID"重排

### 阶段 2 ｜1 天 ｜包体积与配置正确性

7. `packOptions.ignore` 增加 `node_modules` + `docs`（**D-05**、**D-22**），上传预览确认 < 2 MB
8. `libVersion` 统一（**D-06**）、`urlCheck` 改回 `true` 并真机验域名（**D-10**）
9. 裁剪 62 个未使用 Vant 组件目录（**D-08**），主包预计从 ~988 KB 降到 ~650 KB
10. 决定 `@vant/weapp` 版本策略并固化构建命令（**D-09**）

### 阶段 3 ｜1–2 天 ｜测试护栏（防止前面修完的东西再退化）

11. 新增 `tests/test-config.js`（配置断言：ignore/requiredPrivateInfos/usingComponents 路径/pages 对应）（**D-12** 建议 1）
12. 新增路由表 ↔ README 双向一致性测试（**D-12** 建议 2，顺带让 **D-15** 不可能复现）
13. 补 `api-map` 双通道契约测试与 `app.js` 启动分支测试（**D-12** 建议 3、5）
14. （可选）页面 smoke 测试（**D-12** 建议 4）

### 阶段 4 ｜半天 ｜文档与整洁度

15. 修 **D-14**（13 页面 → 9 页面 + 2 个非页面接线方）、**D-15**（23 → 24 action）、**D-16**（补「生日蛋糕」）、**D-17**（单文件声明 → 3 处）、**D-18**（LICENSE 行）
16. 统一项目名（**D-20**）、去掉硬编码版本号（**D-21**）、`.trash-cleanup` 归档并标注已被 git 取代（**D-23**）
17. 处理 `LICENSE` 与第三方素材授权（**D-24** / V-08）

### 阶段 5 ｜发布前最后一遍

18. 走完第三节检查清单（A/B/C/D 四组），重点：**B2（上传预览体积）**、**C13（体验版真机全链路）**、**C10（客服人员配置）**、**C12（版本号）**
19. 打发布 tag，冻结分支

---

## 附：本次审计的一处自我限制（诚实声明）

1. **`packOptions.ignore` 对 `node_modules` 的实际效果未能离线证实**（D-05）。结论按"高风险未确认项"表述，并给了零成本消除方案，未夸大为"已确认超限"。
2. **平台侧规则（类目资质、隐私指引具体形式、主体能力限制）只做了官方文档抓取尝试，未拿到正文**（`developers.weixin.qq.com` 返回内容以导航为主）。因此相关结论全部放入第四节"待验证"，**未当作已确认缺陷**。
3. `npm ls` 触发了 npm 日志写入尝试，因环境目录权限失败而报错（`Log files were not written due to an error writing to the directory: ...npm-cache\_logs`）——**未对项目产生任何写入**；`npm ls` 的输出本身完整可用。
4. 未执行 `npm install` / `npm ci` / 未初始化 git / 未修改 `bread-main` 下任何文件，符合只读审计要求。
