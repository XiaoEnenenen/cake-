/**
 * 鉴权 / 登录（云开发单一数据源）
 * ---------------------------------------------------------------------------
 * 2026-10-09 阶段三改造：
 *   云开发模式下用户身份由云函数自动注入的 OPENID 决定，**不存在 token 概念**，
 *   因此本文件只保留一条路径；原 api 工厂的 code 换 token 流程（checkToken /
 *   login_wx / wxappService* / authorize 注册）整体删除，不再 require apifm-wxapi。
 *
 *   同时修掉审计 A-P1-01：isCloudMode() 之前依赖 API.__dataSource() === 'cloud'
 *   这个**字符串**，一旦发生一次降级就永久变成 false，鉴权会跑去读从不存在的
 *   storage.token，用户看到「无法登录」。现在唯一判据是与 data-source.js 同源的
 *   DS.useCloud，不存在"降级后判据变化"的可能。
 * ---------------------------------------------------------------------------
 */
const DS = require('./data-source')
const API = require('./api-map')
// 阶段 5.7：日志统一收敛到 utils/log.js。
// 同时删除了一行从未被使用的 `import Dialog from '@vant/weapp/dialog/dialog'`
// （报告 §4.3 记录的死导入；本文件是 CommonJS 模块，混用 ESM import 也容易埋坑）。
const LOG = require('./log')

/**
 * 当前是否运行在云开发模式。
 * 单一数据源：唯一判据是 utils/data-source.js 的 useCloud（不再解析 __dataSource() 字符串）。
 *
 * 说明：阶段三之后本文件内部已不再需要对模式做分支（只剩云开发一条路径），
 * 该函数保留并导出，作为「模式判据」的单一出处，供页面/测试复用，
 * 避免再出现"每个调用点各自判断模式"的情况（审计 A-P1-01 的根因）。
 */
function isCloudMode() {
  return !!DS.useCloud
}

// 2026-09-26 阶段二：已删除三级分销函数 bindSeller()（含 storage.referrer 读取与
// 原 api 工厂的 bindSeller 调用）。本店不做分销，功能整体移除。

// 检测登录状态，返回 true / false
async function checkHasLogined() {
  // 云函数自动携带 OPENID，用户身份天然存在，无需 token 与 checkSession。
  // 这里只需确认云函数可通（能读到自己的用户资料）。
  const res = await API.userDetail('')
  if (res && res.code === 0) {
    return true
  }
  // 云函数不通时不阻断流程，交给调用方决定
  return false
}

async function wxaCode(){
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        return resolve(res.code)
      },
      fail() {
        wx.showToast({
          title: '获取code失败',
          icon: 'none'
        })
        return resolve('获取code失败')
      }
    })
  })
}

async function login(page){
  // 云开发不需要登录换 token：OPENID 由云函数自动提供。
  // 这里只调一次 getUser 确认云函数可通，并在 user 集合中建立用户记录。
  try {
    const res = await API.userDetail('')
    if (res && res.code === 0) {
      // 缓存 openid 便于本地判断"已登录"
      wx.setStorageSync('uid', res.data.base.id)
      if (page) {
        page.onShow()
      }
    } else {
      const msg = (res && res.msg) || '请确认已部署 cloudfunctions/api 并开通云开发'
      // 标题按失败类型区分：传输层/环境问题才叫「云函数调用失败」；
      // 云函数通了但业务报错（如「数据库错误」）不应被误标成环境问题。
      const isTransportFail = /云函数调用失败|不支持云开发|数据源未启用/.test(msg)
      wx.showModal({
        title: isTransportFail ? '云函数调用失败' : '获取用户信息失败',
        content: msg,
        showCancel: false
      })
    }
  } catch (e) {
    LOG.error('[auth] 云开发登录异常', e)
  }
}

async function authorize() {
  // 原实现是 code 换 token 的注册流程；云开发下没有这一步。
  // 保留同样的返回结构（{ code: 0, data: {...} }），使调用方无需改动。
  const res = await API.userDetail('')
  if (res && res.code === 0) {
    wx.setStorageSync('uid', res.data.base.id)
    return { code: 0, data: res.data }
  }
  wx.showToast({
    title: (res && res.msg) || '云函数调用失败',
    icon: 'none'
  })
  throw new Error((res && res.msg) || 'cloud login failed')
}

function loginOut(){
  // token 是 api 工厂时代的遗留键，云开发下不再写入；这里一并清掉，
  // 避免老版本升级上来的机器里残留旧 token 造成误解。
  wx.removeStorageSync('token')
  wx.removeStorageSync('uid')
}

async function checkAndAuthorize (scope) {
  return new Promise((resolve, reject) => {
    wx.getSetting({
      success(res) {
        if (!res.authSetting[scope]) {
          wx.authorize({
            scope: scope,
            success() {
              resolve() // 无返回参数
            },
            fail(e){
              LOG.error('[auth] authorize 失败', e)
              // if (e.errMsg.indexof('auth deny') != -1) {
              //   wx.showToast({
              //     title: e.errMsg,
              //     icon: 'none'
              //   })
              // }
              wx.showModal({
                title: '无权操作',
                content: '需要获得您的授权',
                showCancel: false,
                confirmText: '立即授权',
                confirmColor: '#e64340',
                success(res) {
                  wx.openSetting();
                },
                fail(e){
                  LOG.error('[auth] openSetting 失败', e)
                  reject(e)
                },
              })
            }
          })
        } else {
          resolve() // 无返回参数
        }
      },
      fail(e){
        LOG.error('[auth] getSetting 失败', e)
        reject(e)
      }
    })
  })  
}

module.exports = {
  checkHasLogined: checkHasLogined,
  wxaCode: wxaCode,
  login: login,
  loginOut: loginOut,
  checkAndAuthorize: checkAndAuthorize,
  authorize: authorize,
  isCloudMode: isCloudMode
}
