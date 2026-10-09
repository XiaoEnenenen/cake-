// ⚠️ 本文件的 apifm-wxapi 为 legacy 备用通道依赖。
//    保留直接 require 的原因：api-map.js → auth.js 已存在依赖关系，
//    若此处改 require api-map 会形成循环依赖，反而更脆弱。
//    云开发模式下下面所有 WXAPI.* 调用都被 isCloudMode() 分支跳过，不会执行。
//    详见 utils/services/legacy-apifm.js 顶部说明。
const WXAPI = require('apifm-wxapi')
const API = require('./api-map')
import Dialog from '@vant/weapp/dialog/dialog'

/**
 * 当前是否运行在云开发模式
 * 云开发模式下用户身份由 OPENID 自动确定，不存在 token 概念，
 * 因此登录/鉴权逻辑与原 api工厂 完全不同。
 */
function isCloudMode() {
  return API.__dataSource() === 'cloud'
}

async function checkSession(){
  return new Promise((resolve, reject) => {
    wx.checkSession({
      success() {
        return resolve(true)
      },
      fail() {
        return resolve(false)
      }
    })
  })
}

// 2026-09-26 阶段二：已删除三级分销函数 bindSeller()（含 storage.referrer 读取与
// WXAPI.bindSeller 调用）。本店不做分销，功能整体移除。

// 检测登录状态，返回 true / false
async function checkHasLogined() {
  // ===== 云开发模式 =====
  // 云函数自动携带 OPENID，用户身份天然存在，无需 token 与 checkSession。
  // 这里只需确认云函数可通（能读到自己的用户资料）。
  if (isCloudMode()) {
    const res = await API.userDetail('')
    if (res && res.code === 0) {
      return true
    }
    // 云函数不通时不阻断流程，交给调用方决定
    return false
  }

  // ===== 原 api工厂 模式 =====
  const token = wx.getStorageSync('token')
  if (!token) {
    return false
  }
  const loggined = await checkSession()
  if (!loggined) {
    wx.removeStorageSync('token')
    return false
  }
  // https://www.yuque.com/apifm/nu0f75/mp9f59
  const checkTokenRes = await WXAPI.checkToken(token)
  if (checkTokenRes.code != 0) {
    wx.removeStorageSync('token')
    return false
  }
  return true
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
  // ===== 云开发模式 =====
  // 云开发不需要登录换 token：OPENID 由云函数自动提供。
  // 这里只调一次 getUser 确认云函数可通，并在 user 集合中建立用户记录。
  if (isCloudMode()) {
    try {
      const res = await API.userDetail('')
      if (res && res.code === 0) {
        // 缓存 openid 便于本地判断"已登录"
        wx.setStorageSync('uid', res.data.base.id)
        if (page) {
          page.onShow()
        }
      } else {
        wx.showModal({
          title: '云函数调用失败',
          content: (res && res.msg) || '请确认已部署 cloudfunctions/api 并开通云开发',
          showCancel: false
        })
      }
    } catch (e) {
      console.error('[auth] 云开发登录异常', e)
    }
    return
  }

  // ===== 原 api工厂 模式 =====
  const _this = this
  wx.login({
    success: function (res) {
      const componentAppid = wx.getStorageSync('componentAppid')
      if (componentAppid) {
        WXAPI.wxappServiceLogin({
          componentAppid,
          appid: wx.getStorageSync('appid'),
          code: res.code
        }).then(function (res) {        
          if (res.code == 10000) {
            // 去注册
            return;
          }
          if (res.code != 0) {
            // 登录错误
            wx.showModal({
              title: '无法登录',
              content: res.msg,
              showCancel: false
            })
            return;
          }
          wx.setStorageSync('token', res.data.token)
          wx.setStorageSync('uid', res.data.uid)
          if ( page ) {
            page.onShow()
          }
        })
      } else {
        // https://www.yuque.com/apifm/nu0f75/qt5o3d
        WXAPI.login_wx(res.code).then(function (res) {        
          if (res.code == 10000) {
            // 去注册
            return;
          }
          if (res.code != 0) {
            // 登录错误
            wx.showModal({
              title: '无法登录',
              content: res.msg,
              showCancel: false
            })
            return;
          }
          wx.setStorageSync('token', res.data.token)
          wx.setStorageSync('uid', res.data.uid)
          if ( page ) {
            page.onShow()
          }
        })
      }
    }
  })
}

async function authorize() {
  // ===== 云开发模式 =====
  // 原实现是 code 换 token 的注册流程；云开发下没有这一步。
  // 保留同样的返回结构（{ code: 0, data: {...} }），使调用方无需改动。
  if (isCloudMode()) {
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

  // ===== 原 api工厂 模式 =====
  // const code = await wxaCode()
  // const resLogin = await WXAPI.login_wx(code)
  // if (resLogin.code == 0) {
  //   wx.setStorageSync('token', resLogin.data.token)
  //   wx.setStorageSync('uid', resLogin.data.uid)
  //   return resLogin
  // }
  return new Promise((resolve, reject) => {
    wx.login({
      success: function (res) {
        const code = res.code
        // 2026-09-26 阶段二：已移除推荐人（referrer）读取与传参，分销功能整体删除。
        // 下面开始调用注册接口
        const componentAppid = wx.getStorageSync('componentAppid')
        if (componentAppid) {
          WXAPI.wxappServiceAuthorize({
            code: code
          }).then(function (res) {
            if (res.code == 0) {
              wx.setStorageSync('token', res.data.token)
              wx.setStorageSync('uid', res.data.uid)
              resolve(res)
            } else {
              wx.showToast({
                title: res.msg,
                icon: 'none'
              })
              reject(res.msg)
            }
          })
        } else {
          // https://www.yuque.com/apifm/nu0f75/tyisgg
          WXAPI.authorize({
            code: code
          }).then(function (res) {
            if (res.code == 0) {
              wx.setStorageSync('token', res.data.token)
              wx.setStorageSync('uid', res.data.uid)
              resolve(res)
            } else {
              wx.showToast({
                title: res.msg,
                icon: 'none'
              })
              reject(res.msg)
            }
          })
        }
      },
      fail: err => {
        reject(err)
      }
    })
  })
}

function loginOut(){
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
              console.error(e)
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
                  console.error(e)
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
        console.error(e)
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
  authorize: authorize
}