/**
  # 用户身份认证中间件

  提供对称加密算法，把用户名密码加密保存到 sqlite 数据库，请求时用私钥解密代替用户名密码进行请求
  目的是为了给缓存和用户密码进行加密，程序只有在用户请求期间可以解密用户密码和用户数据。

  ## 依赖接口

  ctx.params          from params.js
  ctx.post            from axios.js
  ctx.get             from axios.js
  ctx.cookieJar       from axios.js

  ## 暴露接口

  ctx.user.isLogin    boolean             仅已登录用户带 token 请求时有效，否则为 false
  ctx.user.encrypt    (string => string)? 使用用户 token 加密字符串，返回加密后的十六进制字符串
  ctx.user.decrypt    (string => string)? 使用用户 token 解密十六进制字符串，返回解密后的字符串
  ctx.user.token      string?             伪 token，每个用户唯一的识别码。若同一个人多处登录，该识别码不相同
  ctx.user.identity   string?             每个人唯一的识别码，若同一个人多处登录，识别码也相同。用于精确区分用户
  ctx.user.cardnum    string?             用户一卡通号码
  ctx.user.password   string?             用户密码
  ctx.user.name       string?             用户姓名
  ctx.user.schoolnum  string?             用户学号（教师为空）
  ctx.user.platform   string?             用户登录时使用的平台识别符
  ctx.useAuthCookie   (() => Promise)?    在接下来的请求中自动使用用户统一身份认证 Cookie

  注：

  以上接口除 isLogin 外，其他属性一旦被获取，将对用户进行鉴权，不允许游客使用；因此，若要定义用户和游客
  均可使用的功能，需要先通过 isLogin 区分用户和游客，然后对用户按需获取其他属性，不能对游客获取用户属性，
  否则将抛出 401。
 */
const db = require('../database/auth')
const tough = require('tough-cookie')
const crypto = require('crypto')
const { config } = require('../app')

// 对称加密算法，要求 value 是 String 或 Buffer，否则会报错
const encrypt = (key, value) => {
  try {
    let cipher = crypto.createCipher(config.auth.cipher, key)
    let result = cipher.update(value, 'utf8', 'hex')
    result += cipher.final('hex')
    return result
  } catch (e) {
    return ''
  }
}

// 对称解密算法，要求 value 是 String 或 Buffer，否则会报错
const decrypt = (key, value) => {
  try {
    let decipher = crypto.createDecipher(config.auth.cipher, key)
    let result = decipher.update(value, 'hex', 'utf8')
    result += decipher.final('utf8')
    return result
  } catch (e) {
    return ''
  }
}

// 哈希算法，用于对 token 和密码进行摘要
const hash = value => {
  return new Buffer(crypto.createHash('md5').update(value).digest()).toString('base64')
}

// 在这里选择认证接口提供者
const authProvider = require('./auth-provider/myold')
const graduateAuthProvider = require('./auth-provider/graduate')

// 认证接口带错误处理的封装
// 此方法用于：
// - 用户首次登录；
// - 用户重复登录时，提供的密码哈希与数据库保存的值不一致；
// - 需要获取统一身份认证 Cookie (useAuthCookie()) 调用时。
const auth = async (ctx, cardnum, password, gpassword) => {
  try {
    if (/^22\d*(\d{6})$/.test(cardnum)) {
      await graduateAuthProvider(ctx, RegExp.$1, gpassword)
    }
    return await authProvider(ctx, cardnum, password)
  } catch (e) {
    if (e === 401) {
      if (ctx.user && ctx.user.isLogin) {
        let { token } = ctx.user
        await db.auth.remove({ tokenHash: token })
      }
    }
    throw e
  }
}

// 加密和解密过程
module.exports = async (ctx, next) => {

  // 对于 auth 路由的请求，直接截获，不交给 kf-router
  if (ctx.path === '/auth') {

    // POST /auth 登录认证
    if (ctx.method.toUpperCase() !== 'POST') {
      throw 405
    }

    // 获取一卡通号、密码、研究生密码、前端定义版本
    let { cardnum, password, gpassword, platform } = ctx.params

    // 这里不用解构赋值的默认值，因为不仅需要给 undefined 设置默认值，也需要对空字符串进行容错
    gpassword = gpassword || password

    if (!platform) {
      throw '缺少参数 platform: 必须指定平台名'
    }

    // 查找同一用户同一平台的已认证记录
    let existing = await db.auth.find({ cardnum, platform }, 1)

    // 若找到已认证记录，比对密码
    if (existing) {
      let { passwordHash, gpasswordEncrypted, tokenEncrypted } = existing

      // 新认证数据库中，密码和 token 双向加密，用密码反向解密可以得到 token
      // 解密成功即可返回
      let token = decrypt(password, tokenEncrypted)
      if (token) {
        // 若两个密码有任何一个不同，可能是密码已变化，走认证
        if (passwordHash !== hash(password)
          || /^22/.test(cardnum) && gpassword !== decrypt(token, gpasswordEncrypted)) {

          await auth(ctx, cardnum, password, gpassword)

          // 未抛出异常说明新密码正确，更新数据库中密码
          // 密码变化后，密文 token、两个密文密码、密码哈希均发生变化，都要修改
          let passwordEncrypted = encrypt(token, password)
          gpasswordEncrypted = /^22/.test(cardnum) ? encrypt(token, gpassword) : ''
          tokenEncrypted = encrypt(password, token)
          passwordHash = hash(password)

          await db.update({ cardnum, platform }, {
            passwordEncrypted,
            gpasswordEncrypted,
            tokenEncrypted,
            passwordHash
          })
        }

        // 若密码相同，直接通过认证，不再进行统一身份认证
        // 虽然这样可能会出现密码修改后误放行旧密码的问题，但需要 Cookie 的接口调用统一身份认证时就会 401
        ctx.body = token
        return
      }
    }

    // 无已认证记录，则登录统一身份认证，有三个作用：
    // 1. 验证密码正确性
    // 2. 获得统一身份认证 Cookie 以便后续请求使用
    // 3. 获得姓名和学号
    let { name, schoolnum } = await auth(ctx, cardnum, password, gpassword)

    // 生成 32 字节 token 转为十六进制，及其哈希值
    let token = new Buffer(crypto.randomBytes(20)).toString('hex')
    let tokenHash = hash(token)
    let passwordHash = hash(password)

    // 将 token 和密码互相加密
    let tokenEncrypted = encrypt(password, token)
    let passwordEncrypted = encrypt(token, password)
    let gpasswordEncrypted = /^22/.test(cardnum) ? encrypt(token, gpassword) : ''

    // 将新用户信息插入数据库
    let now = new Date().getTime()

    // 插入用户数据
    await db.auth.insert({
      cardnum,
      tokenHash,
      tokenEncrypted,
      passwordEncrypted,
      passwordHash,
      gpasswordEncrypted,
      name, schoolnum, platform,
      registered: now,
      lastInvoked: now
    })

    // 返回 token
    ctx.body = token
    return
  } else if (ctx.request.headers.token) {
    // 对于其他请求，根据 token 的哈希值取出表项
    let token = ctx.request.headers.token
    let tokenHash = hash(token)
    let record = await db.auth.find({ tokenHash }, 1)

    if (record) { // 若 token 失效，穿透到未登录的情况去
      let now = new Date().getTime()

      // 更新用户最近调用时间
      await db.auth.update({ tokenHash }, { lastInvoked: now })

      // 解密用户密码
      let {
        cardnum, name, schoolnum, platform,
        passwordEncrypted, gpasswordEncrypted
      } = record

      let password = decrypt(token, passwordEncrypted)
      let gpassword = ''
      if (/^22/.test(cardnum)) {
        gpassword = decrypt(token, gpasswordEncrypted)
      }

      let identity = hash(cardnum + name)

      // 将统一身份认证和研究生身份认证 Cookie 获取器暴露给模块
      ctx.useAuthCookie = auth.bind(undefined, ctx, cardnum, password, gpassword)

      // 将身份识别码、解密后的一卡通号、密码和 Cookie、加解密接口暴露给下层中间件
      ctx.user = {
        isLogin: true,
        encrypt: encrypt.bind(undefined, token),
        decrypt: decrypt.bind(undefined, token),
        token: tokenHash,
        identity, cardnum, password, gpassword, name, schoolnum, platform
      }

      // 调用下游中间件
      await next()
      return
    }
  }

  // 对于没有 token 或 token 失效的请求，若下游中间件要求取 user，说明功能需要登录，抛出 401
  let reject = () => { throw 401 }
  ctx.user = {
    isLogin: false,
    get encrypt() { reject() },
    get decrypt() { reject() },
    get identity() { reject() },
    get cardnum() { reject() },
    get password() { reject() },
    get gpassword() { reject() },
    get name() { reject() },
    get schoolnum() { reject() },
    get platform() { reject() }
  }

  ctx.useAuthCookie = reject

  // 调用下游中间件
  await next()
}
