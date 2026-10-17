/**
 * 门店地图板块（可复用组件）
 * ---------------------------------------------------------------------------
 * 2026-10-09 新增：把「门店地图 + 用户定位授权 + 距离 + 一键导航到店」收敛成一个组件，
 * 结算页 / 订单详情 / 核销结果 / 我的 四个位置共用同一份实现。
 *
 * 两种形态：
 *   mini  = true   结算页门店卡右上角的缩略图：小尺寸、不可拖动、圆形导航按钮、无地址行
 *   mini  = false  完整地图板块：可拖动缩放、门店标记 + 气泡、地址行 + 「一键导航到店」按钮
 *
 * 依赖：
 *   utils/location.js    定位授权 / 距离 / 导航（wx.openLocation）
 *   images/map-pin-shop@2x.png   门店标记图标（map 的 markers.iconPath 为必填项）
 *
 * 权限降级：拿不到定位时，只隐藏「距离您 X」并在下方给一条可点击的提示，
 *          地图与「一键导航到店」照常可用（openLocation 不需要定位权限）。
 *
 * 距离文案优先级：
 *   页面传入的 distanceText（父页面算好的业务距离，如外送=收货地址→门店）
 *   > 组件自己定位算的「距离您 X」。
 *   外送场景必须传 distanceText，否则顾客看到的会是"当前位置到门店"的距离。
 * ---------------------------------------------------------------------------
 */
const LOC = require('../../utils/location')

Component({
  options: {
    addGlobalClass: true
  },

  properties: {
    // 门店信息 { name, address, latitude, longitude }
    shop: {
      type: Object,
      value: {}
    },
    // 地图高度（rpx）
    height: {
      type: String,
      value: '400rpx'
    },
    // 缩略图形态（结算页门店卡）
    mini: {
      type: Boolean,
      value: false
    },
    // 地图缩放级别
    scale: {
      type: Number,
      value: 16
    },
    // 是否显示距离气泡（文案见下面的 distanceText / locateText）
    showDistance: {
      type: Boolean,
      value: true
    },
    // 由页面指定的距离文案（如结算页外送时的「配送距离 1.2km」= 收货地址 → 门店）。
    // 传了就以它为准，并且**不再申请定位**：
    //   外送场景顾客关心的是"送到我这里多远"，显示当前位置到门店的距离会误导
    //   （人在外面下单时，这个数字与实际配送距离完全不是一回事）。
    // 留空 → 沿用老行为：定位成功后显示「距离您 X」。
    distanceText: {
      type: String,
      value: ''
    },
    // 是否显示「一键导航到店」按钮（mini 形态使用圆形按钮，不受此开关影响）
    showNavigate: {
      type: Boolean,
      value: true
    },
    // 完整形态下是否在下方显示门店地址
    showAddress: {
      type: Boolean,
      value: false
    },
    // 是否在挂载后自动申请定位
    autoLocate: {
      type: Boolean,
      value: true
    }
  },

  data: {
    latitude: 0,
    longitude: 0,
    markers: [],
    navigable: false,
    // 内部定位算出来的文案（「距离您 X」）；页面传入 distanceText 时不使用
    locateText: '',
    hint: '',
    hintDenied: false,
    // 2026-10-17：定位失败原因是"平台隐私授权未完成"（不是用户拒绝定位）
    hintPrivacy: false,
    // 是否运行在微信开发者工具里（工具内导航可能走不通，给一行说明，不阻断操作）
    devtools: false
  },

  observers: {
    shop(shop) {
      this.syncShop(shop)
    },
    distanceText(text) {
      // 2026-10-17：页面给了业务距离（如外送「配送距离 X」= 收货地址→门店，与运费同源）时，
      // 「距离您 X」与定位授权提示都不再需要 —— 清掉可能残留的定位失败提示，
      // 避免结算页地图下方一直挂着"需先同意隐私指引才能使用定位"（真机反馈）。
      if (text) {
        if (this.data.hint || this.data.hintPrivacy || this.data.locateText) {
          this.setData({ hint: '', hintDenied: false, hintPrivacy: false, locateText: '' })
        }
        return
      }
      // 页面把指定的距离文案清空时（如从「外送」切回「自提」），
      // 补做一次定位，恢复「距离您 X」。
      if (this.data.navigable && !this._autoLocated) {
        this._autoLocated = true
        this.locate()
      }
    }
  },

  lifetimes: {
    attached() {
      this.setData({ devtools: LOC.isDevtools() })
      // syncShop 内部会在坐标就绪时自动补一次定位，这里不重复调用
      this.syncShop(this.data.shop)
    }
  },

  methods: {
    /** 根据门店坐标准备地图中心与标记点 */
    syncShop(shop) {
      const s = LOC.shopOf(shop)
      const navigable = LOC.isShopReady(s)
      const latitude = navigable ? Number(s.latitude) : 0
      const longitude = navigable ? Number(s.longitude) : 0
      this.setData({
        navigable,
        latitude,
        longitude,
        markers: navigable
          ? [
              {
                id: 1,
                latitude,
                longitude,
                // iconPath 是 map 组件 markers 的必填项，项目内原本没有定位图标
                iconPath: '/images/map-pin-shop@2x.png',
                width: 24,
                height: 30,
                callout: {
                  content: s.name || '门店',
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
      // 门店信息可能是页面 onLoad/接口返回后才写入的（组件此时已 attached），
      // 因此坐标一旦就绪就补做一次定位；同一实例只自动定位一次，
      // 之后重试由用户点提示条触发。
      // 页面已指定距离文案（外送场景）时不需要定位，避免无谓的授权弹窗。
      if (navigable && this.data.autoLocate && !this.data.distanceText && !this._autoLocated) {
        this._autoLocated = true
        this.locate()
      }
    },

    /** 申请定位 → 计算与门店的距离 */
    async locate() {
      if (!this.data.navigable) return
      if (this._locating) return
      this._locating = true
      const res = await LOC.getCurrent()
      this._locating = false
      if (!res.ok) {
        this.setData({
          hint: res.errMsg || '定位失败，点击重试',
          hintDenied: !!res.denied,
          // 2026-10-17：隐私授权类失败 → 点提示时重新触发微信隐私授权（而不是去设置页）
          hintPrivacy: !!res.privacy,
          locateText: ''
        })
        return
      }
      const km = LOC.distanceToShop(res.latitude, res.longitude, this.data.shop)
      const text = LOC.formatDistance(km)
      this.setData({
        hint: '',
        hintDenied: false,
        hintPrivacy: false,
        locateText: text ? '距离您 ' + text : ''
      })
      this.triggerEvent('located', { latitude: res.latitude, longitude: res.longitude, km })
    },

    /** 点击提示条：被拒绝过就引导去设置页；隐私授权未完成 / 其它情况直接重试 */
    async onHintTap() {
      if (this.data.hintPrivacy) {
        // 重新走一次定位：LOC.getCurrent 内部会补触发微信平台级隐私授权并重试
        this.locate()
        return
      }
      if (this.data.hintDenied) {
        const opened = await LOC.openSettingGuide(true)
        if (!opened) return
      }
      this.locate()
    },

    /** 一键导航到店 */
    onNavigate() {
      LOC.openNavigation(this.data.shop)
    },

    /** 复制门店地址（导航按钮不可用时的兜底） */
    onCopyAddress() {
      LOC.copyShopAddress(this.data.shop)
    },

    /** 缩略图形态下点地图也能导航；完整形态保留地图自身的拖动体验 */
    onMapTap() {
      if (this.data.mini) {
        LOC.openNavigation(this.data.shop)
      }
    }
  }
})
