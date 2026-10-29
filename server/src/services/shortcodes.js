/**
 * 短码体系（2026-10-29 · T2.4 前置件）
 *
 * 为什么需要：小程序码 scene 只有 32 个可见字符，而 uid（21 字符）与 shareToken（22 字符）
 * 加上 `t=`、`&c=probe` 必然被截断 —— 截断后的 uid 永远匹配不到用户（E.67 实测）。
 * 所以给每个用户分配一个 8 字符 base32 短码（大写字母+2-7，去掉易混的 0/1/8/9），
 * scene 写成 `t=<code>&c=<ch>`，还有余量。
 *
 * 约束：
 *   · 唯一索引在 code 上，生成时最多重试 5 次；
 *   · 反查用 code → uid，供落地页把短码换成用户；
 *   · 不做"过期"，邀请码长期有效；撤销靠 disabled 字段（暂不需要）。
 */
import crypto from 'node:crypto';
import { getDB } from '../config/db.js';

const COL = 'shortcodes';
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 个，去掉易混字符
const LEN = 8;

let indexed = false;
async function ensureIndex() {
  if (indexed) return;
  try {
    await getDB().collection(COL).createIndex({ code: 1 }, { unique: true });
    await getDB().collection(COL).createIndex({ uid: 1 });
  } catch {
    /* 索引已存在或并发创建，忽略 */
  }
  indexed = true;
}

export function randomCode() {
  const bytes = crypto.randomBytes(LEN);
  let out = '';
  for (let i = 0; i < LEN; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

/** 给 uid 取（或分配）短码；同一用户永远同一个码 */
export async function ensureShortCode(uid) {
  const key = String(uid || '').trim();
  if (!key) throw new Error('缺少 uid');
  await ensureIndex();
  const db = getDB();
  const found = await db.collection(COL).findOne({ uid: key });
  if (found?.code) return found.code;
  for (let i = 0; i < 5; i += 1) {
    const code = randomCode();
    try {
      await db.collection(COL).insertOne({ code, uid: key, createdAt: new Date() });
      return code;
    } catch (err) {
      if (String(err?.code) !== '11000') throw err; // 只有唯一键冲突才重试
    }
  }
  throw new Error('短码分配失败（重试次数用尽）');
}

/** 反查：短码 → uid；不存在返回 null */
export async function resolveShortCode(code) {
  const key = String(code || '').trim().toUpperCase();
  if (!/^[A-Z2-9]{8}$/.test(key)) return null;
  const doc = await getDB().collection(COL).findOne({ code: key });
  return doc?.uid || null;
}
