/**
 * Magpie / OpenCode provider plugin: Tencent CloudBase AI
 *
 * 上游是一个部署在云开发里的云函数（aiProxy），它用 @cloudbase/node-sdk 走
 * 「云开发 SDK 通道」调用成长计划赠送额度的模型（hy3 / hy4 / deepseek-v4.1-flash …）。
 *
 * 为什么需要插件：CloudBase 的 AI 网关只对「小程序 SDK / 云开发 SDK」开放成长计划额度，
 * 直接拿 API Key 打 /v1/ai/* 会返回 403 AI_CHANNEL_NOT_ALLOWED。云函数内部走 SDK 通道
 * 才合法，而云函数的公网入口只能通过 HTTP API（/v1/functions/<name>），它返回的是
 * 一次性 JSON，不支持真流式 —— 所以由本插件在 fetch 里做协议适配。
 *
 * 配置项（登录时填写，存在 plugin-auth.json 的 metadata 里）：
 *   envId  云开发环境 ID，例如 cloudbase-xxxxxxxx
 *   key    CloudBase 服务端 API Key
 */

const PROVIDER_ID = 'cloudbase'
const FUNCTION_NAME = process.env.CLOUDBASE_AI_FUNCTION || 'aiProxy'

// 成长计划（小程序成长计划）抵扣范围内的模型
const MODELS = {
  hy3: 'Hunyuan 3',
  hy4: 'Hunyuan 4',
  'hy4-preview': 'Hunyuan 4 Preview',
  'deepseek-v4.1-flash': 'DeepSeek V4.1 Flash',
  'deepseek-v4.1-flash-1017': 'DeepSeek V4.1 Flash 1017'
}

function resolveEnvId(auth) {
  const envId =
    (auth && auth.metadata && auth.metadata.envId) ||
    (auth && auth.envId) ||
    ''
  return String(envId).trim()
}

function buildBaseURL(envId) {
  return `https://${envId}.api.tcloudbasegateway.com/v1/functions/${FUNCTION_NAME}/v1`
}

function toSSE(data, model) {
  const id = data.id || 'chatcmpl-cloudbase'
  const created = data.created || Math.floor(Date.now() / 1000)
  const content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || ''
  const usage = data.usage || undefined
  const chunk = (delta, finish, extra) =>
    'data: ' +
    JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(extra || {})
    }) +
    '\n\n'

  const sse =
    chunk({ role: 'assistant', content: '' }, null) +
    chunk({ content }, null) +
    chunk({}, 'stop', usage ? { usage } : undefined) +
    'data: [DONE]\n\n'

  return new Response(sse, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache'
    }
  })
}

/**
 * 上游只支持一次性 JSON：强制 stream:false，再按客户端原本的意图合成 SSE。
 */
async function adaptFetch(input, init) {
  const url = typeof input === 'string' ? input : input && input.url
  let payload = null
  if (init && typeof init.body === 'string') {
    try {
      payload = JSON.parse(init.body)
    } catch {
      payload = null
    }
  }

  const wantsStream = !!(payload && payload.stream)
  const model = (payload && payload.model) || 'hy3'

  let outgoing = init
  if (payload) {
    payload.stream = false
    outgoing = { ...init, body: JSON.stringify(payload) }
  }

  const res = await fetch(url, outgoing)
  if (!res.ok) return res

  const text = await res.text()
  let data = null
  try {
    data = JSON.parse(text)
  } catch {
    return new Response(text, {
      status: 502,
      headers: { 'content-type': 'application/json' }
    })
  }

  // 云函数在内部异常时返回 200 + { error: {...} }，转成非 2xx 让网关做故障切换
  if (data && data.error) {
    return new Response(JSON.stringify({ error: data.error }), {
      status: 502,
      headers: { 'content-type': 'application/json' }
    })
  }

  if (!wantsStream) {
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return toSSE(data, model)
}

export default async function cloudbasePlugin(_input, _options) {
  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER_ID] ??= {
        name: 'CloudBase AI',
        npm: '@ai-sdk/openai-compatible',
        models: Object.fromEntries(
          Object.entries(MODELS).map(([id, name]) => [id, { name }])
        )
      }
    },

    auth: {
      provider: PROVIDER_ID,

      methods: [
        {
          type: 'api',
          label: 'CloudBase API Key',
          placeholder: 'eyJhbGci…（控制台：环境配置 → API Key 配置）',
          prompts: [
            {
              type: 'text',
              key: 'envId',
              message: '云开发环境 ID',
              placeholder: 'cloudbase-xxxxxxxxxxxx'
            }
          ]
        }
      ],

      loader: async (getAuth) => {
        const auth = await getAuth()
        const envId = resolveEnvId(auth)
        if (!envId) {
          throw new Error('缺少云开发环境 ID（envId），请重新登录并填写')
        }
        return {
          baseURL: buildBaseURL(envId),
          apiKey: (auth && auth.key) || '',
          fetch: adaptFetch
        }
      }
    }
  }
}

export const _internal = {
  buildBaseURL,
  resolveEnvId,
  toSSE,
  adaptFetch,
  MODELS,
  PROVIDER_ID
}
