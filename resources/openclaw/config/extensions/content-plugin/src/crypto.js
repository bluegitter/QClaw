
const crypto = require("crypto");

const AES_KEY_LENGTH = 32; // 256 bit
const IV_LENGTH = 12; // GCM 推荐 12 字节
const AUTH_TAG_LENGTH = 16; // GCM 标准 16 字节
const PROTOCOL_VERSION = "1";

// 内置 RSA 公钥（PEM 格式）
const BUILTIN_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAzTD3fz7NcBHPoy1szygL
urTW8Rkg0RTK1WMNye9ejRx+dK3Kd89Nrid1GC+wHtpt4Qe0BzGO7XMQQzAfsK4t
VonGq1OaeRsrPP9X69kFqRLLGFLjJRx3n6bFujxx04KXJCX5e2krZUZHpAYSx59L
RUFaMO0OdfWREu7vUFosgKppwOUaIqGkj8GS1mVWC+IC5ds1qzeP4qHPb0OW/1lv
hajeXHV9PSyI/v5NUb+AEOJOfd8yfUesvZHNhJnKECJnMdKvuQoT7hJXxcBSXo6N
6fpOIHidVW/nVgPQENTRFGqmgcFahySECuhEkgigTXw64ujGO6t3m6WAfA8WBBcL
kmW+m0rtQPxWlxiu7LB1wG2wG8hKBI5Aqt6hmM40DFdI4xLThi9J57DnXAcdDXPI
MLCZkolwgW/V6qI2A2gsSO6d6e9Q3EITzkpWGgcd216RzOkwMOzmNYy9WcTGym23
G76Tku4rOGi/jOzlYEjjw4kdUQb3tl8CWQQXkueIS0Xpc+uRNjConDYGSdPAi0tV
RkB0+H+H4zSUTphXv/oB2N+0rOStTPtHB4eOC7EuktgrRmH7MW3H/8zoZU/WGFXp
y+XlfWZpS13MmO36/u/7QZ/rcUUeSYrekO6swaS5EZCC+HcKYfyPAb/fX4AAtshB
o2UWNyjv43Sf2mGsnycB31cCAwEAAQ==
-----END PUBLIC KEY-----`;

/**
 * 获取内置公钥
 * @returns {string} PEM 格式的 RSA 公钥
 */
function getPublicKey() {
  return BUILTIN_PUBLIC_KEY;
}

/**
 * 安全地将 payload 序列化为 JSON 字符串
 * @param {*} payload
 * @returns {string}
 */
function safeStringify(payload) {
  if (payload === undefined || payload === null) {
    return "null";
  }
  try {
    return JSON.stringify(payload);
  } catch {
    // 循环引用等情况，降级为 toString
    return String(payload);
  }
}

/**
 * 加密业务数据（客户端使用公钥加密）
 *
 * @param {Object} payload - 业务载荷 { user_id: string, log: string }
 * @param {string|Buffer} publicKeyPem - RSA 公钥 (PEM 格式)
 * @returns {string} JSON 格式的加密信封；加密失败返回空字符串
 */
function encrypt(payload, publicKeyPem) {
  try {
    if (!publicKeyPem) {
      return "";
    }

    // 1. 序列化明文
    const plaintext = Buffer.from(safeStringify(payload), "utf-8");

    // 2. 生成随机 AES 密钥和 IV
    const aesKey = crypto.randomBytes(AES_KEY_LENGTH);
    const iv = crypto.randomBytes(IV_LENGTH);

    // 3. AES-256-GCM 加密
    const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv, {
      authTagLength: AUTH_TAG_LENGTH,
    });
    const ciphertext = Buffer.concat([
      cipher.update(plaintext),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // 4. RSA-OAEP(SHA-256) 加密 AES 密钥
    const encryptedKey = crypto.publicEncrypt(
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: "sha256",
      },
      aesKey
    );

    // 5. 组装信封
    const envelope = {
      encrypted_key: encryptedKey.toString("base64"),
      iv: iv.toString("base64"),
      ciphertext: ciphertext.toString("base64"),
      tag: tag.toString("base64"),
      version: PROTOCOL_VERSION,
    };

    return JSON.stringify(envelope);
  } catch {
    // 加密失败不影响主流程，返回空字符串
    return "";
  }
}

/**
 * 加密业务数据（便捷版，自动读取内置公钥）
 *
 * 加密失败时返回空字符串，不会抛出异常，保证不影响主流程。
 * 测试环境（BUILD_ENV !== "production"）下跳过加密，直接返回明文 JSON。
 *
 * @param {Object} payload - 业务载荷，如 { user_id: string, log: string }
 * @returns {string} JSON 格式的加密信封（正式环境）或明文 JSON（测试环境）；加密失败返回空字符串
 *
 * @example
 * const { encryptPayload } = require("./crypto");
 * const envelope = encryptPayload({ user_id: "u123", log: "sensitive data" });
 */
function encryptPayload(payload) {
  try {
    // 测试环境跳过加密，直接返回明文 JSON，方便调试排查
    if (!process.env.BUILD_ENV || process.env.BUILD_ENV === "production") {
      return encrypt(payload, getPublicKey());
    }
    return safeStringify(payload);
  } catch {
    return "";
  }
}

/**
 * 解密加密信封（服务端使用私钥解密）
 *
 * @param {string} envelopeJson - JSON 格式的加密信封
 * @param {string|Buffer} privateKeyPem - RSA 私钥 (PEM 格式)
 * @returns {Object} 解密后的业务载荷
 */
function decrypt(envelopeJson, privateKeyPem) {
  // 1. 解析信封
  const envelope = JSON.parse(envelopeJson);

  if (envelope.version !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported protocol version: ${envelope.version}`);
  }

  const encryptedKey = Buffer.from(envelope.encrypted_key, "base64");
  const iv = Buffer.from(envelope.iv, "base64");
  const ciphertext = Buffer.from(envelope.ciphertext, "base64");
  const tag = Buffer.from(envelope.tag, "base64");

  // 2. RSA-OAEP(SHA-256) 解密 AES 密钥
  const aesKey = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    encryptedKey
  );

  // 3. AES-256-GCM 解密
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, iv, {
    authTagLength: AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);

  // 4. 反序列化
  return JSON.parse(plaintext.toString("utf-8"));
}

module.exports = { encrypt, decrypt, encryptPayload };