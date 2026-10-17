/**
 * 「我的」页面
 * ---------------------------------------------------------------------------
 * 改造说明（MulanPSL-2.0 变更留痕，2026-02-14）：
 *   原页面为「会员卡 + 积分 + 积分记录 + 关于我们 + 联系我们」结构，
 *   绑定的是原面包店业务。现按蛋糕店需求重构为：
 *     1. 用户信息区（头像 / 昵称 / 用户编号）
 *     2. 订单管理区（待付款 / 待取货 / 已完成 / 全部订单）
 *     3. 常用功能（收货地址 / 联系客服 / 拨打门店电话）
 *     4. 门店信息（名称 / 地址 / 营业时间 / 一键导航）
 *
 *   2026-09-26 阶段二：会员体系**已整体删除**（会员卡、积分、积分记录、编辑会员卡信息），
 *   涉及页面文件、app.json 路由、云函数 action、数据库集合引用全部移除，不再是"隐藏"状态。
 *
 *   保留：扫码核销（商家核销订单用，不可删）
 *
 *   门店信息来源：shop-config.js（用户提供的真实信息）
 *   收货地址来源：utils/address.js（当前本地 storage）
 * ---------------------------------------------------------------------------
 */
const API = require('../../utils/api-map')
const AUTH = require('../../utils/auth')
const SHOP_CONFIG = require('../../shop-config')
const ADDR = require('../../utils/address')
const LOC = require('../../utils/location')
const OS = require('../../utils/order-status')
const FMT = require('../../utils/format')
const LOG = require('../../utils/log')
// 阶段 12：隐私授权（首次启动告知 / 登录前必须重新勾选）已收敛到两个组件：
//   · components/privacy-popup —— 首次启动的主动告知（只弹一次）；
//   · components/login-sheet  —— 登录弹层（每次重新登录都必须重新勾选同意）。
// 阶段 10：店主中心入口的显隐判断（只是展示判断，鉴权在云函数 requireAdmin）
const ADMIN = require('../../utils/admin')
const app = getApp()

// 订单入口（阶段 4.1）：状态与入口定义统一放在 utils/order-status.js，
// 本页不再自己维护一份（原来这里还写着"后端存在 status=2 与 4"的注释）。
const ORDER_ENTRIES = OS.ORDER_ENTRIES

/**
 * 阶段 10：按当前用户 openid 判断是否为店主（决定「店主中心」入口显不显示）。
 * 为什么要包一层 try/catch：utils/admin.js 依赖 storage 与 wx 环境，
 *   任何异常都不该把「我的」页的资料展示带崩 —— 取不到就按"非店主"处理（宁可不显示）。
 */
function isAdminByOpenid(openid) {
  try {
    if (!ADMIN || typeof ADMIN.isAdminOpenid !== 'function') return false
    return ADMIN.isAdminOpenid(openid)
  } catch (e) {
    LOG.error('[my] 店主身份判断失败，按非店主处理', e)
    return false
  }
}

Page({
  data: {
    // 用户信息
    userInfo: null,
    // 2026-10-14 审查修复：资料/登录加载失败时给明确提示与重试入口
    // （原来云函数不通会静默吞异常，卡片永远停在「点击完善资料」）
    profileError: false,
    // 用户编号（阶段 5.5 / P-12）：由 openid 派生的短编号，**不再把 OPENID 直接显示给顾客**
    userNo: '',
    // ===== 阶段 12：登录态 / 退出登录 =====
    // 微信小程序没有"账号密码"，身份就是当前微信的 openid。这里的 loggedOut 只是
    // 本机展示状态：退出后「我的」页显示登录卡片，重新点登录即恢复（订单/地址一直都在）。
    loggedOut: false,
    // 订单入口
    orderEntries: ORDER_ENTRIES,
    // 门店信息（来自 shop-config.js，全部为用户提供的真实值）
    shop: {
      name: '',
      address: '',
      phone: '',
      openingHours: '',
      latitude: 0,
      longitude: 0
    },
    // 默认收货地址（展示在「收货地址」入口右侧）
    defaultAddressText: '',
    // 是否是开发版 / 体验版：用于显示「校准门店坐标」这个店主专用入口
    //（正式版为 false，顾客看不到）
    isDevEnv: false,
    // ===== 阶段 10：店主中心入口 =====
    // 仅当 isShopAdmin() 为真时渲染（读 storage 的白名单，**只是展示判断**；
    // 真正的权限在云函数每个店主 action 的 requireAdmin）。
    isAdminUser: false,
    // 原始 openid：只在开发版 / 体验版显示，用于把它填进店主白名单
    // （正式版顾客永远看不到；顾客界面用的是不可反推的短编号 userNo）
    myOpenid: ''
  },

  onLoad() {
    this.loadShopConfig()
    this.setData({ isDevEnv: LOC.isDevOrTrialEnv() })
  },

  onShow() {
    this.loadShopConfig()
    this.loadDefaultAddress()
    // 阶段 12：本机"退出登录"状态优先 —— 退出后不再自动拉资料/判断店主身份，
    // 用户点「登录」再恢复（底层 openid 仍由微信提供，不影响订单查询）。
    const loggedOut = this.isLoggedOut()
    this.setData({ loggedOut: loggedOut })
    if (loggedOut) {
      this.setData({ userInfo: null, userNo: '', isAdminUser: false, profileError: false, myOpenid: '' })
      return
    }
    // 阶段 10 复核整改：app.js 写白名单 storage 与本次 userDetail 是并发的 ——
    // 先确保白名单到手再判断身份，否则刚配好白名单的店主第一次进来会看不到「店主中心」。
    this.ensureWhitelistThenLoad()
  },

  /** 本机是否已退出登录（storage 标志；不涉及云端身份） */
  isLoggedOut() {
    try {
      return wx.getStorageSync('loggedOut') === '1'
    } catch (e) {
      return false
    }
  },

  /** 见上：白名单缺失时补一次 appConfig（拿到就写 storage，之后纯本地判断） */
  async ensureWhitelistThenLoad() {
    try {
      if (ADMIN && typeof ADMIN.ensureWhitelist === 'function') await ADMIN.ensureWhitelist()
    } catch (e) {
      LOG.error('[my] 读取店主白名单失败，按非店主处理', e)
    }
    // 阶段 5.6 复核整改：AUTH.authorize() 在云函数不通时会 throw，
    // 原来没有 .catch → 未处理的 Promise rejection（真机上还伴随一条报错）。
    // 2026-10-14 审查修复：失败时**不能只是静默吞掉** —— 原来卡片会永远停在
    // 「点击完善资料」，顾客分不清"还没登录"和"云函数挂了"，也没有重试入口。
    AUTH.checkHasLogined().then((isLogined) => {
      if (isLogined) {
        this.userDetail()
      } else {
        AUTH.authorize().then(() => {
          this.userDetail()
        }).catch(() => {
          this.setData({ profileError: true })
        })
      }
    }).catch(() => {
      this.setData({ profileError: true })
    })
  },

  // wxml 里的「点击重试」（资料加载失败时）
  retryProfile() {
    this.setData({ profileError: false })
    this.onShow()
  },

  // ===== 门店配置（纯本地常量，不依赖网络）=====
  loadShopConfig() {
    const s = SHOP_CONFIG.shop || {}
    this.setData({
      shop: {
        name: s.name || '',
        address: s.address || '',
        phone: s.phone || '',
        openingHours: s.openingHours || '',
        latitude: s.latitude || 0,
        longitude: s.longitude || 0
      }
    })
  },

  // ===== 默认收货地址（用于入口处展示）=====
  loadDefaultAddress() {
    const addr = ADDR.getDefault()
    this.setData({
      defaultAddressText: addr ? ADDR.formatFull(addr) : ''
    })
  },

  // ===== 用户资料 =====
  async userDetail() {
    // 2026-10-14 审查修复：原实现直接 `res.code == 0`，res 为 undefined（或缺 data）
    // 时抛 TypeError，而外层是静默 catch → 表现为"资料永远刷不出来、也不报错"。
    // 同类判空在 current-order / pay / orders 都已做，这里补齐。
    const res = await API.userDetail(wx.getStorageSync('token'))
    if (res && res.code == 0 && res.data && res.data.base) {
      // 2026-10-10：扫码核销下线，本页不再需要 canHX 判定；
      // 店主的「完成订单」入口改在订单列表页（判定逻辑见 utils/admin.js）。
      const base = res.data.base
      this.setData({
        userInfo: base,
        profileError: false,
        // 阶段 5.5 / P-12：列表里显示短编号，不显示原始 OPENID
        userNo: FMT.shortUserNo(base.id || ''),
        // ===== 阶段 10 =====
        // 店主中心入口的显隐。注意：这只是"要不要显示入口"，不是鉴权 ——
        // 云函数每个店主 action 都会用 ctx.openid 在服务端重新校验白名单。
        isAdminUser: isAdminByOpenid(base.id),
        // 原始 openid 只在开发版 / 体验版回填（用于填白名单），正式版为空串
        myOpenid: this.data.isDevEnv ? String(base.id || '') : ''
      })
      return
    }
    this.setData({ profileError: true })
  },

  // ===== 阶段 12：登录 / 退出登录 / 编辑资料 =====
  // 说明（与旧版内联编辑的区别）：
  //   旧版在本页直接改头像+昵称；现在统一进「编辑资料」页（头像/昵称/手机号/地址入口），
  //   本页只负责"展示 + 进入编辑 + 登录/退出"。
  //   微信小程序的账号就是当前微信的 openid，没有真正的"注销登录"：
  //   退出只是清掉本机展示状态（storage.loggedOut），订单/地址仍归当前微信。
  goProfileEdit() {
    wx.navigateTo({ url: '/pages/profile-edit/index' })
  },

  /** 点用户卡片：已登录 → 编辑资料；已退出 → 重新登录 */
  onTapUserCard() {
    if (this.data.loggedOut) {
      this.login()
      return
    }
    this.goProfileEdit()
  },

  /**
   * 重新登录（2026-10-17 顾客反馈整改）
   * -------------------------------------------------------------------------
   * 以前：本地记过隐私同意就直接 AUTH.authorize() 静默登录 —— 顾客点「登录」后
   *   没再看到隐私政策，也看不到手机号/微信登录的可选项（反馈第 2 条）。
   * 现在：**永远先打开登录弹层**（components/login-sheet）：里面隐私勾选框每次重置为未勾选，
   *   顾客必须重新勾选并选择「手机号一键登录 / 微信登录」；弹层登录成功后才回调本页。
   *   这样"退出登录后重新登录必须先过隐私政策"就是代码保证的，而不是靠本地同意状态碰运气。
   */
  login() {
    const sheet = typeof this.selectComponent === 'function' ? this.selectComponent('#login-sheet') : null
    if (sheet && typeof sheet.open === 'function') {
      sheet.open()
      return
    }
    // 组件没挂上（页面结构被改坏 / 极老版本）时不要静默登录，明确提示
    wx.showToast({ title: '登录组件未就绪，请退出重进', icon: 'none' })
  },

  /** 登录弹层登录成功：清本机退出标志 → 重新拉资料/店主身份 */
  onLoginSuccess() {
    try {
      wx.removeStorageSync('loggedOut')
    } catch (e) {}
    this.setData({ loggedOut: false, profileError: false })
    this.ensureWhitelistThenLoad()
  },

  // 2026-10-17 顾客反馈：退出登录入口从「我的」页移到「编辑资料」页底部
  // （具体逻辑见 pages/profile-edit/index.js）。本页只负责显示未登录态。

  // ===== 订单管理：跳转到订单页并带状态参数 =====
  // 复用现有的 pages/current-order，不新建页面
  goOrders(e) {
    const status = e.currentTarget.dataset.status
    wx.navigateTo({
      url: '/pages/current-order/index?status=' + status
    })
  },

  // ===== 收货地址管理 =====
  goAddress() {
    wx.navigateTo({
      url: '/pages/address/index'
    })
  },

  // ===== 拨打门店电话 =====
  callShop() {
    const phone = this.data.shop.phone
    if (!phone) {
      wx.showToast({ title: '暂未设置门店电话', icon: 'none' })
      return
    }
    wx.makePhoneCall({
      phoneNumber: phone,
      fail: (err) => {
        // 用户主动取消不提示
        if (err && err.errMsg && err.errMsg.indexOf('cancel') < 0) {
          LOG.error('[my] makePhoneCall 失败', err)
        }
      }
    })
  },

  // ===== 一键导航到店 =====
  // 已收敛到 components/shop-map 组件（内部调 utils/location.js 的 openNavigation）：
  //   - 唤起微信内置地图并显示门店位置，用户可在其中选择「路线/导航」，
  //     用高德/百度/腾讯地图开始导航
  //   - 只传门店坐标，不获取用户位置，因此不需要 scope.userLocation 权限
  // 本页不再单独实现，避免与组件两套逻辑。

  // ===== 店主专用：门店坐标拾取 =====
  // 入口只在开发版 / 体验版显示（见 onLoad 的 isDevEnv），正式版顾客看不到。
  goShopLocator() {
    wx.navigateTo({
      url: '/pages/shop-locator/index'
    })
  },

  // ===== 阶段 10：店主中心 =====
  // 入口只在 isAdminUser 为真时渲染；即使有人手动改 storage 把入口点出来，
  // 云函数侧的 requireAdmin 也会拒绝所有店主接口（前端改不掉权限）。
  goAdmin() {
    wx.navigateTo({
      url: '/pages/admin/index'
    })
  },

  /** 复制原始 openid（仅开发版 / 体验版可见），用于填 shop-config.js 的 adminOpenids */
  copyMyOpenid() {
    const openid = this.data.myOpenid
    if (!openid) {
      wx.showToast({ title: '还没读到 openid，请稍后重试', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: openid,
      success: () => wx.showToast({ title: '已复制，发给开发者即可', icon: 'none' })
    })
  },

  // ===== 关于我们 =====
  goAbout() {
    wx.navigateTo({
      url: '/pages/about-us/index'
    })
  },

  // 2026-10-10：已删除 scanOrderCode（扫码核销）。
  // 扫码核销整体下线，店主改为在「订单」列表里对取餐码、点「完成订单」。

  tabbarChange(e) {
    app.tabbarChange(e)
  }
})
