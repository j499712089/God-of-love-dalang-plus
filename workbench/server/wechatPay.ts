import { readFileSync, existsSync } from "node:fs";

// 微信支付 Native 扫码 + 回调验签/解密。
// 全部凭证走环境变量（WECHAT_*），私钥/证书只读文件，绝不硬编码、不入库、不入代码。
// SDK 用法照抄问命笺 zhimingtang 的 wechatPay.ts（wechatpay-node-v3@2.2.1）。

type Creds = {
  appid: string;
  mchid: string;
  apiV3Key: string;
  serialNo: string;
  privateKey: Buffer;
  publicKey: Buffer;
};

/** 读取微信支付凭证（AppID + 商户号 + APIv3 密钥 + 商户证书）。 */
export function loadWechatCreds(): { creds?: Creds; error?: string } {
  const appid = process.env.WECHAT_APPID;
  const mchid = process.env.WECHAT_MCH_ID;
  const apiV3Key = process.env.WECHAT_API_V3_KEY;
  const serialNo = process.env.WECHAT_MCH_SERIAL_NO;
  if (!appid || !mchid || !apiV3Key || !serialNo) {
    return { error: "微信支付未配置" };
  }
  const keyPath = process.env.WECHAT_KEY_PATH || "certs/apiclient_key.pem";
  const certPath = process.env.WECHAT_CERT_PATH || "certs/apiclient_cert.pem";
  let privateKey: Buffer;
  let publicKey: Buffer;
  try {
    privateKey = readFileSync(keyPath);
    publicKey = readFileSync(certPath);
  } catch {
    return { error: "微信支付证书缺失" };
  }
  return { creds: { appid, mchid, apiV3Key, serialNo, privateKey, publicKey } };
}

/** 动态加载 CJS SDK，兼容 default / 命名导出两种形态。 */
async function newPay(creds: Creds): Promise<any> {
  const mod = (await import("wechatpay-node-v3")) as any;
  const WxPay = mod.default || mod;
  return new WxPay({
    appid: creds.appid,
    mchid: creds.mchid,
    privateKey: creds.privateKey,
    publicKey: creds.publicKey,
    serial_no: creds.serialNo,
  });
}

/**
 * 微信支付 Native 下单，返回可被微信 App 扫描的 code_url。
 */
export async function createNativeOrder(opts: {
  outTradeNo: string;
  description: string;
  amountFen: number;
}): Promise<{ codeUrl?: string; error?: string }> {
  const { creds, error } = loadWechatCreds();
  if (error) return { error };
  if (!Number.isFinite(opts.amountFen) || opts.amountFen <= 0) {
    return { error: "金额无效" };
  }
  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL || "https://dalang.wenmingjianyuce.cn";
  const pay = await newPay(creds!);
  try {
    const result: any = await pay.transactions_native({
      appid: creds!.appid,
      mchid: creds!.mchid,
      description: opts.description,
      out_trade_no: opts.outTradeNo,
      notify_url: baseUrl + "/api/pay/wechat/notify",
      amount: { total: opts.amountFen, currency: "CNY" },
    });
    const codeUrl = result?.data?.code_url || result?.code_url;
    if (codeUrl) return { codeUrl };
    return { error: "微信下单失败：" + JSON.stringify(result) };
  } catch (e: any) {
    return { error: "微信通信失败：" + (e?.message || String(e)) };
  }
}

/**
 * 回调验签 + 解密 resource，返回解密后的交易对象。
 * rawBody 必须是微信推送的原始 body 文本（顺序敏感，验签前勿 JSON.parse）。
 */
export async function verifyAndDecrypt(
  rawBody: string,
  headers: {
    timestamp: string;
    nonce: string;
    serial: string;
    signature: string;
  },
): Promise<{ ok: true; decrypted: any } | { ok: false; error: string }> {
  const { creds, error } = loadWechatCreds();
  if (error) return { ok: false, error };
  const mod = (await import("wechatpay-node-v3")) as any;
  const WxPay = mod.default || mod;
  const pay = new WxPay({
    appid: creds!.appid,
    mchid: creds!.mchid,
    privateKey: creds!.privateKey,
    publicKey: creds!.publicKey,
    serial_no: creds!.serialNo,
  });

  // 新版微信支付公钥模式（serial 以 PUB_KEY_ID_ 开头）：
  // 把本地下载的 .pem 公钥注入 SDK 静态缓存，verifySign 直接本地验，不走联网 fetchCertificates。
  if (headers.serial && headers.serial.startsWith("PUB_KEY_ID_")) {
    const pubKeyPath =
      process.env.WECHAT_PUBKEY_PATH || "certs/wxpay_public_key.pem";
    if (!existsSync(pubKeyPath)) {
      return { ok: false, error: "微信支付公钥文件缺失" };
    }
    const pubKeyPem = readFileSync(pubKeyPath, "utf8");
    WxPay.certificates = WxPay.certificates || {};
    WxPay.certificates[headers.serial.trim()] = pubKeyPem;
  }

  let verified = false;
  try {
    verified = await pay.verifySign({
      timestamp: headers.timestamp,
      nonce: headers.nonce,
      body: rawBody,
      serial: headers.serial.trim(),
      signature: headers.signature,
      apiSecret: creds!.apiV3Key,
    });
  } catch (e: any) {
    return { ok: false, error: "验签异常：" + (e?.message || String(e)) };
  }
  if (!verified) return { ok: false, error: "验签失败" };

  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, error: "回调 body 非法 JSON" };
  }
  const resource = body?.resource;
  if (!resource?.ciphertext) return { ok: false, error: "缺少 resource.ciphertext" };

  let decrypted: any;
  try {
    decrypted = pay.decipher_gcm(
      resource.ciphertext,
      resource.associated_data || "",
      resource.nonce,
      creds!.apiV3Key,
    );
  } catch (e: any) {
    return { ok: false, error: "解密失败：" + (e?.message || String(e)) };
  }
  return { ok: true, decrypted };
}
