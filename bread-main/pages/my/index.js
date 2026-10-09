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
const app = getApp()

// 订单入口：只做项目里真实存在的状态
//   0 待付款 / 1 待取货（后端原叫「制作中」）/ 3 已完成 / all 全部
// 注意：后端还存在 status=2 与 4，但含义未定义，此处不使用。
const ORDER_ENTRIES = [
  { key: '0', label: '待付款' },
  { key: '1', label: '待取货' },
  { key: '3', label: '已完成' },
  { key: 'all', label: '全部订单' }
]

Page({
  data: {
    // 用户信息
    userInfo: null,
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
    // 是否具备可用坐标（坐标仍是占位值时也能导航，但会有偏差）
    hasLocation: false,
    // 默认收货地址（展示在「收货地址」入口右侧）
    defaultAddressText: '',
    // 商家核销权限
    canHX: false
  },

  onLoad() {
    this.loadShopConfig()
  },

  onShow() {
    this.loadShopConfig()
    this.loadDefaultAddress()
    AUTH.checkHasLogined().then((isLogined) => {
      if (isLogined) {
        this.userDetail()
      } else {
        AUTH.authorize().then(() => {
          this.userDetail()
        })
      }
    })
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
      },
      hasLocation: !!(s.latitude && s.longitude)
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
      const order_hx_uids = wx.getStorageSync('order_hx_uids')
      this.setData({
        userInfo: res.data.base,
        // 商家核销权限：保留原有判定逻辑，扫码核销依赖它
        canHX: !!(order_hx_uids && order_hx_uids.indexOf(res.data.base.id) != -1)
      })
    }
  },

  // ===== 登录 / 更新头像昵称 =====
  updateUserInfo() {
    wx.getUserProfile({
      lang: 'zh_CN',
      desc: '用于完善用户资料',
      success: (res) => {
        this._updateUserInfo(res.userInfo)
      },
      fail: (err) => {
        console.log(err)
        wx.showToast({
          title: err.errMsg,
          icon: 'none'
        })
      }
    })
  },

  async _updateUserInfo(userInfo) {
    const postData = {
      token: wx.getStorageSync('token'),
      nick: userInfo.nickName,
      avatarUrl: userInfo.avatarUrl,
      city: userInfo.city,
      province: userInfo.province,
      gender: userInfo.gender
    }
    const res = await API.modifyUserInfoV2(postData)
    if (res.code != 0) {
      wx.showToast({ title: res.msg, icon: 'none' })
      return
    }
    wx.showToast({ title: '登录成功' })
    this.userDetail()
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
          console.error(err)
        }
      }
    })
  },

  // ===== 一键导航到门店 =====
  // 使用 wx.openLocation（微信原生能力）：
  //   - 唤起微信内置地图并显示门店位置，用户可在其中选择「用其他地图打开」
  //   - 只传门店坐标，不获取用户位置，因此无需 scope.userLocation 权限
  openShopLocation() {
    const s = this.data.shop
    if (!s.latitude || !s.longitude) {
      wx.showToast({ title: '门店坐标未配置', icon: 'none' })
      return
    }
    wx.openLocation({
      latitude: Number(s.latitude),
      longitude: Number(s.longitude),
      name: s.name || '门店',
      address: s.address || '',
      scale: 18,
      fail: (err) => {
        console.error('[my] openLocation 失败', err)
        wx.showToast({ title: '打开地图失败', icon: 'none' })
      }
    })
  },

  // ===== 关于我们 =====
  goAbout() {
    wx.navigateTo({
      url: '/pages/about-us/index'
    })
  },

  // ===== 商家核销（保留：店主核销订单用）=====
  scanOrderCode() {
    wx.scanCode({
      onlyFromCamera: true,
      success(res) {
        wx.navigateTo({
          url: '/pages/order-view/scan-result?hxNumber=' + res.result
        })
      },
      fail(err) {
        console.error(err)
        wx.showToast({
          title: err.errMsg,
          icon: 'none'
        })
      }
    })
  },

  tabbarChange(e) {
    app.tabbarChange(e)
  }
})
