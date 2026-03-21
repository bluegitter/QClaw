const ENV_URLS = {
  test: {
    jprxGateway: 'https://jprx.sparta.html5.qq.com/',
    wxLoginRedirectUri: 'https://security-test.guanjia.qq.com/login',
    beaconUrl: 'https://pcmgrmonitor.3g.qq.com/test/datareport',
    qclawBaseUrl: 'https://jprx.sparta.html5.qq.com/aizone/v1',
    wechatWsUrl: 'wss://jprx.sparta.html5.qq.com/agentwss'
  },
  production: {
    jprxGateway: 'https://jprx.m.qq.com/',
    wxLoginRedirectUri: 'https://security.guanjia.qq.com/login',
    beaconUrl: 'https://pcmgrmonitor.3g.qq.com/datareport',
    qclawBaseUrl: 'https://mmgrcalltoken.3g.qq.com/aizone/v1',
    wechatWsUrl: 'wss://mmgrcalltoken.3g.qq.com/agentwss'
  }
}

function createSchemaResult(success, data, message) {
  return success
    ? { success: true, data }
    : {
        success: false,
        error: {
          message
        }
      }
}

export function getEnvUrls(env) {
  return ENV_URLS[env] ?? ENV_URLS.test
}

export const OpenClawConfigSchema = {
  safeParse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return createSchemaResult(false, value, 'Config must be an object')
    }
    return createSchemaResult(true, value, undefined)
  }
}

export { ENV_URLS }
