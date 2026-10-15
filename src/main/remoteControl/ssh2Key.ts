import { createRequire } from "node:module";

const require2 = createRequire(import.meta.url);
const ssh2 = require2("ssh2") as typeof import("ssh2");

export type Ssh2TunnelKeyPair = {
  /** OpenSSH 格式私钥（BEGIN OPENSSH PRIVATE KEY），只在本机生成与使用。 */
  privateKey: string;
  /** 公钥行（算法名 base64 注释），用于服务器 authorized_keys。 */
  publicKey: string;
};

/**
 * 生成 SSH2 隧道专用密钥对（ed25519，OpenSSH 格式）。
 * 私钥绝不离开本机；部署时只上传公钥完成授权。
 */
export const generateSsh2TunnelKeyPair = (): Ssh2TunnelKeyPair => {
  const pair = ssh2.utils.generateKeyPairSync("ed25519", {
    comment: "snow-remote-tunnel",
  });
  return { privateKey: pair.private, publicKey: pair.public };
};

/**
 * 从已存 OpenSSH 私钥推导公钥行：部署失败回滚时用它把服务器
 * authorized_keys 恢复为旧设备的公钥；无法解析时返回 null。
 */
export const publicKeyFromPrivateKey = (privateKey: string): string | null => {
  try {
    const parsed = ssh2.utils.parseKey(privateKey);
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    if (!key || key instanceof Error) return null;
    return `${key.type} ${key.getPublicSSH().toString("base64")}`;
  } catch {
    return null;
  }
};
