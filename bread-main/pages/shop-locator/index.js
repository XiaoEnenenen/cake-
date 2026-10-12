/**
 * 门店坐标拾取（店主专用，不对顾客开放）
 * ---------------------------------------------------------------------------
 * 为什么需要这一页：
 *   shop-config.js 里的门店经纬度一直是**估算占位值**，会让「一键导航到店」画出
 *   几十公里的假路线（实测：顾客在昆明市区，门店被算到 45 公里外）。
 *   把这一页拿到的精确坐标填回 shop-config.js 的 shop.latitude / shop.longitude 即可。
 *
 * 三种取点方式：
 *   1. 直接拖动地图，让中间的红图钉对准店门口，点「读取图钉坐标」——最直观；
 *   2. 「用微信地图选点」调 wx.chooseLocation，可以搜店名 / 小区名，还会带回地址文字；
 *   3. 「用我的当前位置」——站在店门口时最快（需要定位授权）。
 *
 * 入口：只在开发版 / 体验版显示（见 pages/my/index.js 的 goShopLocator），
 *      正式版顾客看不到；也可以用开发者工具的「自定义编译模式」直接启动本页。
 * ---------------------------------------------------------------------------
 */
const LOC = require('../../utils/location')
const SHOP_CONFIG = require('../../shop-config')
// 阶段 5.7：日志统一收敛到 utils/log.js
const LOG = require('../../utils/log')

/** 紧凑坐标文案：24.9195, 102.484（便于人眼核对） */
function compact(latitude, longitude) {
  const fix = (n) => Math.round(Number(n) * 1e6) / 1e6
  return fix(latitude) + ', ' + fix(longitude)
}

Page({
  data: {
    // 当前 shop-config.js 里的配置（用于对比）
    shop: {},
    cfgText: '',
    // 地图中心（初始 = 当前配置坐标）
    mapLat: 0,
    mapLng: 0,
    scale: 16,
    // 配置坐标的标记点（带气泡，便于看出偏了多少）
    markers: [],
    // 图钉读到的坐标
    pickedLat: null,
    pickedLng: null,
    pickedText: '',
    deltaText: '',
    // 用「微信地图选点」选到的地址文字
    chosenAddress: ''
  },

  onLoad() {
    const shop = SHOP_CONFIG.shop || {}
    const navigable = LOC.isShopReady(shop)
    const latitude = navigable ? Number(shop.latitude) : 0
    const longitude = navigable ? Number(shop.longitude) : 0
    this.setData({
      shop,
      cfgText: navigable ? compact(latitude, longitude) : '未配置',
      mapLat: latitude || 39.9087,
      mapLng: longitude || 116.3975,
      markers: navigable
        ? [
            {
              id: 1,
              latitude,
              longitude,
              iconPath: '/images/map-pin-shop@2x.png',
              width: 24,
              height: 30,
              callout: {
                content: '当前配置坐标',
                color: '#1f1f1f',
                fontSize: 12,
                borderRadius: 6,
                padding: 6,
                bgColor: '#ffffff',
                display: 'ALWAYS'
              }
            }
          ]
        : []
    })
  },

  // ===== 1) 读取图钉（地图中心）坐标 =====
  readCenter() {
    const ctx = wx.createMapContext('pickerMap', this)
    ctx.getCenterLocation({
      success: (res) => this.applyPicked(res.latitude, res.longitude),
      fail: (err) => {
        LOG.error('[shop-locator] getCenterLocation 失败', err)
        wx.showToast({ title: '读取失败，请稍后重试', icon: 'none' })
      }
    })
  },

  // ===== 2) 用微信地图选点（可搜索，带回地址） =====
  chooseByWechat() {
    wx.chooseLocation({
      success: (res) => {
        this.setData({
          mapLat: res.latitude,
          mapLng: res.longitude,
          chosenAddress: [res.name, res.address].filter(Boolean).join(' · ')
        })
        this.applyPicked(res.latitude, res.longitude)
      },
      fail: (err) => {
        const msg = String((err && err.errMsg) || '')
        if (msg.indexOf('cancel') >= 0) return
        LOG.warn('[shop-locator] chooseLocation 失败', err)
        wx.showModal({
          title: '无法打开地图选点',
          content:
            '请改用「拖动地图 + 读取图钉坐标」，或先在小程序后台申请定位相关权限。\n' +
            '（错误信息：' + (msg || '未知') + '）',
          showCancel: false
        })
      }
    })
  },

  // ===== 3) 用我的当前位置 =====
  async useCurrentLocation() {
    const res = await LOC.getCurrent()
    if (!res.ok) {
      const opened = await LOC.openSettingGuide(!!res.denied)
      if (!opened) {
        wx.showToast({ title: res.errMsg || '定位失败', icon: 'none' })
      }
      return
    }
    const ctx = wx.createMapContext('pickerMap', this)
    ctx.moveToLocation({ latitude: res.latitude, longitude: res.longitude })
    this.setData({ mapLat: res.latitude, mapLng: res.longitude })
    // 地图移动是异步的，稍等一下再读中心点
    setTimeout(() => this.readCenter(), 500)
  },

  // ===== 记录并展示读到的坐标 =====
  applyPicked(latitude, longitude) {
    const shop = this.data.shop || {}
    const km = LOC.distanceToShop(latitude, longitude, shop)
    const delta = LOC.formatDistance(km)
    this.setData({
      pickedLat: latitude,
      pickedLng: longitude,
      pickedText: LOC.formatCoordinate(latitude, longitude),
      deltaText: delta ? '与当前配置相差 ' + delta : ''
    })
  },

  // ===== 复位到配置坐标 =====
  resetToConfig() {
    const shop = this.data.shop || {}
    if (!LOC.isShopReady(shop)) return
    this.setData({ mapLat: Number(shop.latitude), mapLng: Number(shop.longitude) })
  },

  // ===== 复制坐标（直接粘进 shop-config.js / 发给开发者）=====
  copyResult() {
    if (this.data.pickedLat === null) {
      wx.showToast({ title: '请先读取图钉坐标', icon: 'none' })
      return
    }
    wx.setClipboardData({
      data: this.data.pickedText,
      success: () => wx.showToast({ title: '坐标已复制', icon: 'none' })
    })
  }
})
