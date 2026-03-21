type WxLoginInfo = {
  appid: string
  redirect_uri: string
  wxLoginStyleBase64: string
}

const WX_LOGIN_STYLE = `
.status_icon { display: none; }
.impowerBox .status { text-align: center; padding: 0; }
.impowerBox .loginPanel.normalPanel .title { display: none; }
.impowerBox .loginPanel.normalPanel .qrcode {
  margin-top: 40px;
  width: 120px;
  height: 120px;
  border: 0;
}
.impowerBox .status .status_txt,
.impowerBox .status.status_browser p:nth-child(2) {
  color: #000000;
  font-size: 16px;
  line-height: 21px;
}
.impowerBox .status p {
  margin-top: 5px;
  color: #8f8f8f;
  font-size: 12px;
  line-height: 16px;
}
.web_qrcode_switch_wrp {
  margin-top: 32px;
  height: 16px;
  line-height: 16px;
  font-weight: 400;
  font-size: 12px;
}
.web_qrcode_switch {
  color: #000f7a;
  font-size: 12px;
}
`.trim()

const PROD_WX_LOGIN_INFO: WxLoginInfo = {
  appid: 'wx9d11056dd75b7240',
  redirect_uri: 'https://security.guanjia.qq.com/login',
  wxLoginStyleBase64: window.btoa(unescape(encodeURIComponent(WX_LOGIN_STYLE))),
}

const BETA_WX_LOGIN_INFO: WxLoginInfo = {
  appid: 'wx3dd49afb7e2cf957',
  redirect_uri: 'https://security-test.guanjia.qq.com/login',
  wxLoginStyleBase64: window.btoa(unescape(encodeURIComponent(WX_LOGIN_STYLE))),
}

export function useWxLoginInfo() {
  function getWxLoginInfo(): WxLoginInfo {
    return import.meta.env.PROD ? PROD_WX_LOGIN_INFO : BETA_WX_LOGIN_INFO
  }

  return {
    getWxLoginInfo,
  }
}
