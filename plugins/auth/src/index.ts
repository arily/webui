import { Binding, Context, Logger, omit, Schema, Service, Time, User } from 'koishi'
import { Client } from '@koishijs/plugin-console'
import { createHash } from 'crypto'
import { resolve } from 'path'

declare module 'koishi' {
  interface Context {
    auth: AuthService
  }

  interface User {
    password: string
  }

  interface Tables {
    token: LoginToken
  }
}

declare module '@koishijs/plugin-console' {
  interface Client {
    auth?: Auth
  }

  namespace Console {
    interface Services {
      user: DataService<AuthData>
    }
  }

  interface Events {
    'login/platform'(this: Client, platform: string, pid: string): Promise<UserLogin>
    'login/password'(this: Client, name: string, password: string): void
    'login/token'(this: Client, id: number, token: string): void
    'user/delete-token'(this: Client, inc: number): void
    'user/unbind'(this: Client, platform: string, pid: string): void
    'user/update'(this: Client, data: UserUpdate): void
    'user/logout'(this: Client): void
  }
}

export interface LoginToken {
  inc: number
  id: number
  type: LoginType
  token: string
  expire: number
  createdAt: Date
  lastUsedAt: Date
  userAgent: string
  address: string
}

export type Auth =
  & Pick<LoginToken, 'token' | 'expire'>
  & Pick<User, 'id' | 'name' | 'authority'>

interface AuthData extends Auth {
  tokens: Omit<LoginToken, 'token' | 'id'>[]
  bindings: Omit<Binding, 'aid'>[]
}

type LoginType = 'platform' | 'password' | 'token'

const logger = new Logger('auth')

const letters = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

export function randomId(length = 40) {
  return Array(length).fill(0).map(() => letters[Math.floor(Math.random() * letters.length)]).join('')
}

export interface UserLogin extends Pick<User, 'id' | 'name'> {
  token: string
  expire: number
}

export type UserUpdate = Partial<Pick<User, 'name' | 'password'>>

function toHash(password: string) {
  return createHash('sha256').update(password).digest('hex')
}

class AuthService extends Service {
  static using = ['console', 'database'] as const

  constructor(ctx: Context, private config: AuthService.Config) {
    super(ctx, 'auth')

    ctx.model.extend('user', {
      password: 'string(255)',
    })

    ctx.model.extend('token', {
      inc: 'unsigned',
      id: 'unsigned',
      type: 'string(255)',
      token: 'string(255)',
      expire: 'unsigned(20)',
      createdAt: 'timestamp',
      lastUsedAt: 'timestamp',
      userAgent: 'string(255)',
      address: 'string(255)',
    }, {
      primary: 'inc',
      autoInc: true,
      unique: ['token'],
    })

    ctx.console.addEntry({
      dev: resolve(__dirname, '../client/index.ts'),
      prod: resolve(__dirname, '../dist'),
    })

    this.initLogin()
  }

  async start() {
    const { enabled, username, password } = this.config.admin
    if (!enabled) return
    logger.debug('creating admin account')
    await this.ctx.database.upsert('user', [{
      id: 0,
      name: username,
      authority: 5,
      password: toHash(password),
    }])
  }

  async setAuth(client: Client, auth = client.auth) {
    if (auth) {
      const bindings = await this.ctx.database.get('binding', { aid: auth.id })
      bindings.forEach(binding => delete binding.aid)
      const tokens = await this.ctx.database.get('token', { id: auth.id })
      tokens.reverse().forEach(login => (delete login.id, delete login.token))
      client.send({ type: 'data', body: { key: 'user', value: { ...auth, bindings, tokens } } })
    } else {
      client.send({ type: 'data', body: { key: 'user', value: null } })
    }
    client.auth = auth
    client.ctx.emit('console/connection', client)
    client.refresh()
  }

  async createToken(client: Client, type: LoginType, user: Pick<User, 'id' | 'name' | 'authority'>) {
    const { headers, socket } = client.request
    const createdAt = new Date()
    const lastUsedAt = new Date()
    const userAgent = headers['user-agent']?.toString()
    const address = headers['x-forwarded-for']?.toString() || socket.remoteAddress
    const expire = Date.now() + this.config.authTokenExpire
    const token = randomId()
    await this.ctx.database.create('token', { id: user.id, type, expire, token, createdAt, lastUsedAt, userAgent, address })
    await this.setAuth(client, { ...user, expire, token })
  }

  initLogin() {
    const self = this
    const { ctx, config } = this
    const states: Record<string, [string, number, Client]> = {}

    ctx.console.addListener('login/password', async function (name, password) {
      password = toHash(password)
      const [user] = await ctx.database.get('user', { name }, ['password', 'name', 'id', 'authority'])
      if (!user || user.password !== password) throw new Error('用户名或密码错误。')
      await self.createToken(this, 'password', omit(user, ['password']))
    })

    ctx.console.addListener('login/token', async function (aid, token) {
      const [data] = await ctx.database.get('token', { id: aid, token }, ['expire'])
      if (!data || data.expire <= Date.now()) throw new Error('令牌已失效。')
      const [user] = await ctx.database.get('user', { id: aid }, ['id', 'name', 'authority'])
      if (!user) throw new Error('用户不存在。')
      await ctx.database.set('token', { token }, { lastUsedAt: new Date() })
      await self.setAuth(this, { ...user, ...data, token })
    })

    ctx.console.addListener('login/platform', async function (platform, userId) {
      const user = await ctx.database.getUser(platform, userId, ['id', 'name'])
      if (!user) throw new Error('找不到此账户。')
      if (this.auth?.id === user.id) throw new Error('你已经绑定了此账户。')

      const key = `${platform}:${userId}`
      const token = Math.random().toString().slice(2, 8)
      const expire = Date.now() + config.loginTokenExpire
      states[key] = [token, expire, this]

      const listener = () => {
        delete states[key]
        dispose()
        this.socket.removeEventListener('close', dispose)
      }
      const dispose = ctx.setTimeout(() => {
        if (states[key]?.[1] >= Date.now()) listener()
      }, config.loginTokenExpire)
      this.socket.addEventListener('close', listener)

      return { id: user.id, name: user.name, token, expire }
    })

    ctx.middleware(async (session, next) => {
      const state = states[session.uid]
      if (!state || state[0] !== session.content.trim()) {
        return next()
      }

      const { platform, userId: pid } = session
      if (state[2].auth) {
        await ctx.database.set('binding', { platform, pid }, { aid: state[2].auth.id })
        return self.setAuth(state[2], state[2].auth)
      } else {
        const user = await session.observeUser(['id', 'name', 'authority'])
        return self.createToken(state[2], 'platform', user)
      }
    }, true)

    ctx.on('console/intercept', async (client, listener) => {
      if (!listener.authority) return false
      if (!client.auth) return true
      if (client.auth.expire <= Date.now()) return true
      if (client.auth.authority < listener.authority) return true
      await ctx.database.set('token', { token: client.auth.token }, { lastUsedAt: new Date() })
    })

    ctx.console.addListener('user/delete-token', async function (inc) {
      if (!this.auth) throw new Error('请先登录。')
      const [data] = await ctx.database.get('token', { id: this.auth.id, inc })
      if (!data) throw new Error('令牌不存在。')
      await ctx.database.remove('token', { inc })
      await self.setAuth(this)
    })

    ctx.console.addListener('user/logout', async function () {
      if (this.auth) {
        await ctx.database.remove('token', { token: this.auth.token })
      }
      await self.setAuth(this, null)
    })

    ctx.console.addListener('user/update', async function (data) {
      if (!this.auth) throw new Error('请先登录。')
      if (data.password) data.password = toHash(data.password)
      await ctx.database.set('user', { id: this.auth.id }, data)
      Object.assign(this.auth, data)
      await self.setAuth(this)
    })

    ctx.console.addListener('user/unbind', async function (platform, pid) {
      if (!this.auth) throw new Error('请先登录。')
      const bindings = await ctx.database.get('binding', { aid: this.auth.id })
      const binding = bindings.find(item => item.platform === platform && item.pid === pid)
      if (binding.aid !== binding.bid) {
        await ctx.database.set('binding', { platform, pid }, { aid: binding.bid })
      } else if (bindings.filter(item => item.aid === item.bid).length === 1) {
        throw new Error('无法解除绑定。')
      } else {
        await ctx.database.remove('binding', { platform, pid })
      }
      await self.setAuth(this)
    })
  }
}

namespace AuthService {
  export const filter = false

  export interface Admin {
    enabled?: boolean
    username?: string
    password?: string
  }

  export const Admin: Schema<Admin> = Schema.intersect([
    Schema.object({
      enabled: Schema.boolean().default(true).description('启用管理员账号。'),
    }),
    Schema.union([
      Schema.object({
        enabled: Schema.const(true),
        username: Schema.string().default('admin').description('管理员用户名。'),
        password: Schema.string().role('secret').required().description('管理员密码。'),
      }),
      Schema.object({}),
    ]),
  ])

  export interface Config {
    admin?: Admin
    authTokenExpire?: number
    loginTokenExpire?: number
  }

  export const Config: Schema<Config> = Schema.intersect([
    Schema.object({
      admin: Admin,
    }).description('管理员设置'),
    Schema.object({
      authTokenExpire: Schema.natural().role('ms').default(Time.week).min(Time.hour).description('用户令牌有效期。'),
      loginTokenExpire: Schema.natural().role('ms').default(Time.minute * 10).min(Time.minute).description('登录令牌有效期。'),
    }).description('高级设置'),
  ])
}

export default AuthService
