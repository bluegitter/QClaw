import {
  o as openclawApiService,
  r as removeStorageItem,
  s as setStorageItem,
  aB as getStorageItem,
  aM as getRuntimeConfig,
} from "./platform.js";
import { Y as readonly, r as ref } from "./vendor-vue.js";

const isLoggedInRef = ref(false);
const loginUserRef = ref(null);
const showWxLoginModalRef = ref(false);

let pendingAction = null;

export function useAuth() {
  function initAuthState() {
    const userInfo = getStorageItem("userInfo");
    if (userInfo && userInfo.nickname) {
      loginUserRef.value = userInfo;
      isLoggedInRef.value = true;
    } else {
      loginUserRef.value = null;
      isLoggedInRef.value = false;
    }
  }

  async function checkLoginStatus() {
    try {
      const guid = await openclawApiService.getGuid();
      const response = await openclawApiService.getUserInfo({ guid });
      const code =
        response?.data?.resp?.common?.code ??
        response?.data?.common?.code;

      if (response && response.success && response.data && code === 0) {
        const payload =
          response.data?.resp?.data ??
          response.data?.data ??
          response.data;

        const normalizedUser = {
          nickname:
            payload.nickname && payload.nickname !== "undefined"
              ? payload.nickname
              : payload.nick_name || "",
          avatar:
            payload.avatar ||
            payload.head_img_url ||
            payload.head_img ||
            "",
          guid: payload.guid || guid,
          userId: payload.userId || payload.user_id,
          ...payload,
        };

        loginUserRef.value = normalizedUser;
        isLoggedInRef.value = true;
        setStorageItem("userInfo", normalizedUser);
        return true;
      }
    } catch (error) {
      console.warn("[useAuth] 验证登录态异常:", error);
    }

    return false;
  }

  function requireLogin(action) {
    if (isLoggedInRef.value) {
      return true;
    }

    pendingAction = action ?? null;
    showWxLoginModalRef.value = true;
    return false;
  }

  async function onLoginSuccess(user) {
    loginUserRef.value = user;
    isLoggedInRef.value = true;
    setStorageItem("userInfo", user);
    showWxLoginModalRef.value = false;
  }

  function closeLoginModal() {
    showWxLoginModalRef.value = false;
    pendingAction = null;
  }

  async function logout() {
    try {
      const guid = await openclawApiService.getGuid();
      await openclawApiService.wxLogout({ guid });
    } catch (error) {
      console.error("[useAuth] wxLogout 失败:", error);
    }

    removeStorageItem("userInfo");
    removeStorageItem("wx_login_code");
    removeStorageItem("jwt_token");
    removeStorageItem("openclaw_channel_token");
    loginUserRef.value = null;
    isLoggedInRef.value = false;
  }

  function consumePendingAction() {
    const action = pendingAction;
    pendingAction = null;
    return action;
  }

  return {
    isLoggedIn: readonly(isLoggedInRef),
    loginUser: loginUserRef,
    showWxLoginModal: showWxLoginModalRef,
    initAuthState,
    checkLoginStatus,
    requireLogin,
    onLoginSuccess,
    closeLoginModal,
    consumePendingAction,
    logout,
  };
}

const REPORT_APP_KEY = "PC_Qclaw";

export const REPORT_EVENT_CODES = {
  CLICK_NEW: "click_new",
  EXPO: "expo",
};

class BrowserReporter {
  constructor(options) {
    if (!options.baseUrl) {
      throw new Error("[ClientAction] baseUrl 为必填项，请从上层传入上报地址");
    }

    this.baseUrl = options.baseUrl;
    this.appkey = options.appkey ?? REPORT_APP_KEY;
    this.guid = options.guid ?? "";
    this.onReportSuccess = options.onReportSuccess ?? (() => {});
    this.onReportFail = options.onReportFail ?? (() => {});
  }

  buildPayload(eventCode, params, extra) {
    const normalizedParams = {};
    for (const key in params) {
      const value = params[key];
      normalizedParams[key] = value != null ? String(value) : "";
    }

    normalizedParams.tdbank_imp_date = String(Date.now());

    const payload = {
      app_key: this.appkey,
      version: "1.0.0",
      guid: this.guid,
      event_code: eventCode,
      params: normalizedParams,
    };

    if (extra) {
      for (const key in extra) {
        payload[key] = extra[key];
      }
    }

    return payload;
  }

  reportDirect(eventCode, params, extra) {
    const payload = this.buildPayload(eventCode, params, extra);
    fetch(this.baseUrl, {
      headers: { "Content-Type": "application/json" },
      method: "POST",
      body: JSON.stringify(payload),
      mode: "cors",
    })
      .then((response) => response.json())
      .then((response) => {
        if (response.retCode === 0) {
          this.onReportSuccess();
        } else {
          this.onReportFail(response.retCode);
        }
      })
      .catch(() => this.onReportFail());
  }
}

class ServerReporter {
  constructor(options) {
    if (!options.baseUrl) {
      throw new Error("[ClientAction] baseUrl 为必填项，请从上层传入上报地址");
    }

    this.baseUrl = options.baseUrl;
    this.appkey = options.appkey ?? REPORT_APP_KEY;
    this.guid = options.guid ?? "";
    this.onReportSuccess = options.onReportSuccess ?? (() => {});
    this.onReportFail = options.onReportFail ?? (() => {});
  }

  buildPayload(eventCode, params, extra) {
    const normalizedParams = {};
    for (const key in params) {
      const value = params[key];
      normalizedParams[key] = value != null ? String(value) : "";
    }

    normalizedParams.tdbank_imp_date = String(Date.now());

    const payload = {
      app_key: this.appkey,
      version: "1.0.0",
      guid: this.guid,
      event_code: eventCode,
      params: normalizedParams,
    };

    if (extra) {
      for (const key in extra) {
        payload[key] = extra[key];
      }
    }

    return JSON.stringify(payload);
  }

  reportDirect(eventCode, params, extra) {
    const payload = this.buildPayload(eventCode, params, extra);
    fetch(this.baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
    })
      .then((response) => response.json())
      .then((response) => {
        if (response.retCode === 0) {
          this.onReportSuccess();
        } else {
          this.onReportFail(response.retCode);
        }
      })
      .catch(() => this.onReportFail());
  }
}

function isBrowserRuntime() {
  return typeof globalThis !== "undefined" && "window" in globalThis && "navigator" in globalThis;
}

function createReporter(options = {}) {
  return isBrowserRuntime() ? new BrowserReporter(options) : new ServerReporter(options);
}

let reporterInstance = null;
let reporterOptions = {};
let reporterBootstrapped = false;
let sharedReportParams = null;

function setReporterOptions(options) {
  reporterOptions = options;
  reporterInstance = null;
}

function getReporter() {
  if (!reporterInstance) {
    reporterInstance = createReporter(reporterOptions);
  }
  return reporterInstance;
}

function reportDirect(eventCode, params = {}, extra) {
  if (!eventCode) {
    console.warn("[Report] eventCode 不能为空");
    return;
  }

  try {
    let normalizedParams;
    if (params instanceof Map) {
      normalizedParams = {};
      for (const [key, value] of params) {
        normalizedParams[key] = value;
      }
    } else {
      normalizedParams = { ...params };
    }

    getReporter().reportDirect(eventCode, normalizedParams, extra);
  } catch (error) {
    console.error(`[Report] 上报失败: ${eventCode}`, error);
  }
}

async function bootstrapReporter(params) {
  if (reporterBootstrapped) {
    return;
  }

  let guid = "";

  if (params instanceof Map) {
    guid = params.get("uid") || "";
  } else if (params) {
    guid = params.uid || "";
  }

  if (!guid) {
    try {
      const machineId = await window.electronAPI.app.getMachineId();
      if (machineId) {
        guid = machineId;
      }
    } catch {}
  }

  if (!guid) {
    const userInfo = getStorageItem("userInfo");
    guid = userInfo?.guid || "";
  }

  const baseUrl = getRuntimeConfig().beaconUrl;
  setReporterOptions({
    appkey: REPORT_APP_KEY,
    guid,
    baseUrl,
  });

  reporterBootstrapped = true;
  await loadSharedReportParams();
}

function getPlatformReportValue() {
  const platform = window.electronAPI?.platform;
  const arch = window.electronAPI?.arch;

  if (platform === "win32") {
    return "Qclaw_Win";
  }
  if (platform === "darwin") {
    return arch === "arm64" ? "Qclaw_MAC_ARM" : "Qclaw_MAC_INTEL";
  }
  return `Qclaw_${platform}_${arch}`;
}

async function loadSharedReportParams() {
  if (sharedReportParams) {
    return;
  }

  const params = {
    event_params: getPlatformReportValue(),
  };

  try {
    const version = await window.electronAPI?.app.getVersion();
    if (version) {
      params.app_version = version;
    }
  } catch {}

  try {
    const channel = await window.electronAPI?.app.getChannel();
    if (channel) {
      params.channel = channel;
    }
  } catch {}

  sharedReportParams = params;
}

export async function reportEvent(eventCode, params = {}) {
  if (!eventCode) {
    console.warn("[Report] eventCode 不能为空");
    return;
  }

  try {
    await bootstrapReporter(params);

    const { isLoggedIn } = useAuth();
    const injectedParams = {
      action_status: isLoggedIn.value ? 1 : 0,
      ...(sharedReportParams || {}),
    };

    if (params instanceof Map) {
      for (const [key, value] of Object.entries(injectedParams)) {
        if (!params.has(key)) {
          params.set(key, value);
        }
      }
    } else {
      for (const [key, value] of Object.entries(injectedParams)) {
        if (!(key in params)) {
          params[key] = value;
        }
      }
    }

    reportDirect(eventCode, params);
  } catch (error) {
    console.error(`[Report] 埋点上报失败: ${eventCode}`, error);
  }
}
