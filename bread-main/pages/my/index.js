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
const app = getApp()

// 订单入口（阶段 4.1）：状态与入口定义统一放在 utils/order-status.js，
// 本页不再自己维护一份（原来这里还写着"后端存在 status=2 与 4"的注释）。
const ORDER_ENTRIES = OS.ORDER_ENTRIES

Page({
  data: {
    // 用户信息
    userInfo: null,
    // 用户编号（阶段 5.5 / P-12）：由 openid 派生的短编号，**不再把 OPENID 直接显示给顾客**
    userNo: '',
    // ===== 阶段 5.5（缺陷 P-06）：登录 / 资料编辑 =====
    // 原实现用 wx.getUserProfile，该接口已匿名化（拿不到真实昵称头像），
    // 于是「我的」页永远显示"点击登录"。现改为：
    //   · 头像：<button open-type="chooseAvatar">（微信头像填写能力）
    //   · 昵称：<input type="nickname">（微信昵称填写能力）
    // 编辑态由 profileEditing 控制；草稿字段避免"边选边写库"。
    profileEditing: false,
    draftAvatarUrl: '',
    draftNick: '',
    // 草稿头像是本地临时路径（尚未上传成功）时为 true —— 此时不允许保存，
    // 否则会把 wxfile:// 这种会话级路径写进用户资料，下次打开就是碎图。
    draftAvatarIsLocal: false,
    savingProfile: false,
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
    isDevEnv: false
  },

  onLoad() {
    this.loadShopConfig()
    this.setData({ isDevEnv: LOC.isDevOrTrialEnv() })
  },

  onShow() {
    this.loadShopConfig()
    this.loadDefaultAddress()
    // 阶段 5.6 复核整改：AUTH.authorize() 在云函数不通时会 throw，
    // 原来没有 .catch → 未处理的 Promise rejection（真机上还伴随一条报错）。
    AUTH.checkHasLogined().then((isLogined) => {
      if (isLogined) {
        this.userDetail()
      } else {
        AUTH.authorize().then(() => {
          this.userDetail()
        }).catch(() => {})
      }
    }).catch(() => {})
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
    const res = await API.userDetail(wx.getStorageSync('token'))
    if (res.code == 0) {
      // 2026-10-10：扫码核销下线，本页不再需要 canHX 判定；
      // 店主的「完成订单」入口改在订单列表页（判定逻辑见 utils/admin.js）。
      const base = res.data.base || {}
      this.setData({
        userInfo: base,
        // 阶段 5.5 / P-12：列表里显示短编号，不显示原始 OPENID
        userNo: FMT.shortUserNo(base.id || '')
      })
    }
  },

  // ===== 阶段 5.5：登录 / 更新头像昵称 =====
  // 原实现（已删除）：
  //   wx.getUserProfile({ success: res => this._updateUserInfo(res.userInfo) })
  //   —— 该接口自 2022 年起返回的是匿名数据（灰色头像 + "微信用户"），
  //      拿不到真实昵称头像，导致「我的」页永远停在"点击登录"。
  // 现实现：进入编辑态 → 用 open-type="chooseAvatar" 选头像（会上传到云存储）、
  //        用 <input type="nickname"> 填写昵称 → 保存时一次性写入云函数。
  startEditProfile() {
    const u = this.data.userInfo || {}
    this.setData({
      profileEditing: true,
      draftAvatarUrl: u.avatarUrl || '',
      draftNick: u.nick || '',
      draftAvatarIsLocal: false
    })
  },

  cancelEditProfile() {
    this.setData({
      profileEditing: false,
      draftAvatarUrl: '',
      draftNick: '',
      draftAvatarIsLocal: false
    })
  },

  /**
   * 选择头像（<button open-type="chooseAvatar" bind:chooseavatar>）。
   * e.detail.avatarUrl 是**本地临时路径**，必须先上传到云存储拿到 fileID 才能持久化，
   * 否则重启小程序后就是碎图（云函数只存字符串，不存文件）。
   */
  async onChooseAvatar(e) {
    const temp = e && e.detail && e.detail.avatarUrl
    if (!temp) return
    // 先本地预览，让顾客立刻看到自己选的头像
    this.setData({ draftAvatarUrl: temp, draftAvatarIsLocal: true })
    // 阶段 5.5 复核整改：连选两次头像时，先发的上传可能后返回，
    // 会把顾客最后选的那一张覆盖掉。用序号丢弃过期结果。
    this._avatarSeq = (this._avatarSeq || 0) + 1
    const seq = this._avatarSeq
    const openid = (this.data.userInfo && this.data.userInfo.id) || wx.getStorageSync('uid') || 'anonymous'
    const ext = (/\.(png|jpg|jpeg|webp)$/i.exec(temp) || [null, 'png'])[1].toLowerCase()
    wx.showLoading({ title: '上传头像…' })
    const res = await API.uploadFile(temp, 'avatars/' + openid + '_' + Date.now() + '.' + ext)
    wx.hideLoading()
    if (seq !== this._avatarSeq) return // 已有更新的一次选择，丢弃这次上传结果
    if (res.code == 0 && res.fileID) {
      this.setData({ draftAvatarUrl: res.fileID, draftAvatarIsLocal: false })
    } else {
      // 上传失败：保留本地预览，但标记为"未上传成功"，保存时会被拦住并提示重试
      LOG.error('[my] 头像上传失败', res && res.msg)
      wx.showToast({ title: '头像上传失败，请重试', icon: 'none' })
    }
  },

  /**
   * 昵称输入（<input type="nickname"> 的 bindinput / bindblur / bindchange 都会带 value）
   */
  onNickInput(e) {
    this.setData({ draftNick: String((e && e.detail && e.detail.value) || '') })
  },

  /**
   * 校验昵称长度。微信昵称最长 32 字符（中文按字数），这里只做基本约束，
   * 服务端/微信侧还有各自的限制。
   */
  validateNick(nick) {
    const text = String(nick || '').trim()
    if (!text) return { ok: false, msg: '请填写昵称' }
    if (text.length > 20) return { ok: false, msg: '昵称最多 20 个字' }
    return { ok: true, value: text }
  },

  async saveProfile() {
    if (this.data.savingProfile) return // 防重复提交
    const nickRes = this.validateNick(this.data.draftNick)
    if (!nickRes.ok) {
      wx.showToast({ title: nickRes.msg, icon: 'none' })
      return
    }
    if (this.data.draftAvatarIsLocal) {
      wx.showToast({ title: '头像还没上传成功，请重新选择', icon: 'none' })
      return
    }
    this.setData({ savingProfile: true })
    try {
      const postData = { nick: nickRes.value }
      if (this.data.draftAvatarUrl) postData.avatarUrl = this.data.draftAvatarUrl
      const res = await API.modifyUserInfoV2(postData)
      if (!res || res.code != 0) {
        wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' })
        return
      }
      wx.showToast({ title: '已保存', icon: 'success' })
      this.setData({ profileEditing: false })
      this.userDetail()
    } finally {
      this.setData({ savingProfile: false })
    }
  },

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
