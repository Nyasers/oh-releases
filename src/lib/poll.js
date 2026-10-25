/**
 * src/lib/poll.js — 一次订阅检查。
 *
 * 只做一件事：问 atom「有没有新版本」。带上次的 ETag 去，304 就直接收工——
 * 零字节，不占任何配额。
 *
 * 判新不看版本号：App 读不到宿主当前版本，比大小没有意义。用的是 atom 里的
 * entry id / tag 在库里有没有。所以"比库里最新的那条更新"就等于"库里没有"。
 *
 * atom 只有十条，还混着 train-beta-* 这类内部通道（它们没有 digest）。所以先按
 * ^v\d+\.\d+\.\d+ 过滤，再看库里。
 */
import { createHash } from "node:crypto";
import {
  DIGEST_ASSET,
  isVersionTag,
  parseAtom,
  releaseUrl,
} from "./upstream.js";
import { STATE_LAST_CHECK_AT, STATE_LAST_ETAG } from "./store.js";

/**
 * 附件清单已经探过的 tag 集合（JSON 对象：tag → 探测时间）。
 *
 * 为什么需要它：附件清单可能真的是空的（tag 发了 Release 却没传附件），"表里
 * 没有行"因此分不清「没探过」和「探过但没有」。分开记，页面才不会每次打开都
 * 重新抓一遍 expanded_assets。
 *
 * 回填不抓附件（它只补 digest），所以历史版本第一次进详情页时才补这一份。
 */
export const STATE_ASSETS_KNOWN = "assets_known";

const sha256Hex = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** 读"探过附件的 tag"表。读不出来当空表，不让一处坏数据拖垮页面。 */
export function readAssetsKnown(store) {
  const raw = store.getState(STATE_ASSETS_KNOWN, null);
  if (typeof raw !== "string" || !raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** 记一个 tag 的附件清单已经取过。 */
export function markAssetsKnown(store, tag, at = Date.now()) {
  if (typeof tag !== "string" || !tag) return;
  const known = readAssetsKnown(store);
  if (known[tag] !== undefined) return;
  known[tag] = at;
  store.setState(STATE_ASSETS_KNOWN, JSON.stringify(known));
}

/**
 * 在 atom 的条目里挑出"库里还没有"的那些，保持 atom 的原有顺序（新 → 旧）。
 *
 * 只认版本 tag：train-beta-* 永远不会有 digest，把它们放进来会让每一次检查都
 * 报"有新版本"，然后取 digest 得 404。
 */
export function pickNewEntries(entries, hasVersion) {
  const out = [];
  for (const entry of entries || []) {
    if (!entry || typeof entry.tag !== "string" || !entry.tag) continue;
    if (!isVersionTag(entry.tag)) continue;
    if (hasVersion(entry.tag)) continue;
    out.push(entry);
  }
  return out;
}

/**
 * 取一个 tag 的 digest 并入库（含附件清单）。
 *
 * available 时连附件清单一并取：expanded_assets 不占 API 配额，而且页面要它才
 * 能让用户挑安装包。取不到也不影响 digest 入库——那只是一份清单。
 */
export async function ingestVersion({ store, client, tag, now = Date.now() }) {
  const response = await client.fetchDigestText(tag);
  if (response?.notModified) {
    return { ok: false, code: "UNEXPECTED_304", tag };
  }
  if (!response?.ok) {
    return {
      ok: false,
      code: response?.status === 404 ? "NO_DIGEST" : "DIGEST_HTTP_ERROR",
      status: response?.status ?? null,
      tag,
      error: response?.error ?? "HTTP " + response?.status,
    };
  }
  const body = response.text;
  let digest = null;
  try {
    digest = JSON.parse(body);
  } catch {
    digest = null;
  }
  if (!digest || typeof digest !== "object") {
    return { ok: false, code: "DIGEST_MALFORMED", tag };
  }
  if (typeof digest.tag === "string" && digest.tag !== tag) {
    return { ok: false, code: "TAG_MISMATCH", tag, claimedTag: digest.tag };
  }

  let assets = [];
  try {
    const expanded = await client.fetchExpandedAssets(tag);
    if (expanded?.ok && Array.isArray(expanded.assets)) {
      assets = expanded.assets.map((asset) => ({
        name: asset.name,
        size: Number.isFinite(asset.size) ? asset.size : null,
        sha256: typeof asset.sha256 === "string" ? asset.sha256 : null,
      }));
    }
  } catch {
    // 清单是页面用的附加信息：取不到就留空，digest 本身照样入库。
    assets = [];
  }

  const previousTag =
    typeof digest.previousTag === "string" && digest.previousTag ? digest.previousTag : null;

  store.upsertVersion({
    tag,
    previousTag,
    digestSha256: sha256Hex(body),
    sourceUrl: releaseUrl(tag),
    fetchedAt: now,
    body,
    assets,
  });
  // 这里已经取过一次清单（哪怕是空的），记下来免得详情页再抓一遍。
  markAssetsKnown(store, tag, now);

  return {
    ok: true,
    tag,
    previousTag,
    digest,
    assets,
    hasDigestAsset: assets.some((asset) => asset.name === DIGEST_ASSET),
  };
}

/**
 * 补齐某个版本的附件清单。
 *
 * 回填只取 digest、不取附件，所以历史版本第一次被打开时这里才去抓一次
 * expanded_assets（不占 API 配额）。force 为真时忽略"已探过"的记录重新抓。
 */
export async function ensureAssets({ store, client, tag, force = false, now = Date.now() }) {
  if (typeof tag !== "string" || !tag) {
    return { ok: false, code: "TAG_REQUIRED", message: "缺少 tag" };
  }
  const known = readAssetsKnown(store);
  const cached = store.listAssets(tag);
  if (!force && known[tag] !== undefined) {
    return { ok: true, tag, assets: cached, fromCache: true };
  }
  let expanded;
  try {
    expanded = await client.fetchExpandedAssets(tag);
  } catch (error) {
    return {
      ok: false,
      code: "ASSETS_FETCH_FAILED",
      tag,
      message: String(error && error.message ? error.message : error),
      assets: cached,
    };
  }
  if (!expanded?.ok) {
    // 不记"已探过"：能入库 digest 的 tag 一定发过 Release，这里拿到 404 属于异常，
    // 多半是暂时的。留在可重试状态，下次打开详情页再试一次。
    return {
      ok: false,
      code: "ASSETS_HTTP_ERROR",
      tag,
      status: expanded?.status ?? null,
      message: expanded?.error ?? "HTTP " + expanded?.status,
      assets: cached,
    };
  }
  const assets = Array.isArray(expanded.assets)
    ? expanded.assets.map((asset) => ({
        name: asset.name,
        size: Number.isFinite(asset.size) ? asset.size : null,
        sha256: typeof asset.sha256 === "string" ? asset.sha256 : null,
      }))
    : [];
  store.upsertAssets(tag, assets);
  markAssetsKnown(store, tag, now);
  return { ok: true, tag, assets, fromCache: false, hasDigestAsset: expanded.hasDigest === true };
}

/**
 * 跑一次检查。
 *
 * 返回里 ok 表示"这次检查本身成功了"，与"有没有新版本"分开：newVersions 为空
 * 是正常结果，ok:false 才需要页面上报错。
 */
export async function pollOnce({ store, client, now = Date.now() }) {
  const lastEtag = store.getState(STATE_LAST_ETAG, null);
  const response = await client.fetchAtom(typeof lastEtag === "string" ? lastEtag : null);

  if (response?.notModified) {
    store.setState(STATE_LAST_CHECK_AT, now);
    return { ok: true, notModified: true, newVersions: [], checkedAt: now };
  }
  if (!response?.ok) {
    return {
      ok: false,
      notModified: false,
      code: "ATOM_HTTP_ERROR",
      status: response?.status ?? null,
      error: response?.error ?? "HTTP " + response?.status,
      newVersions: [],
    };
  }

  const parsed = parseAtom(response.text ?? "");
  const fresh = pickNewEntries(parsed.entries, (tag) => store.hasVersion(tag));
  const newVersions = [];

  for (const entry of fresh) {
    const ingested = await ingestVersion({ store, client, tag: entry.tag, now });
    if (ingested.ok) {
      newVersions.push({
        tag: ingested.tag,
        previousTag: ingested.previousTag,
        version: typeof ingested.digest.version === "string" ? ingested.digest.version : null,
        summary:
          ingested.digest.summary && typeof ingested.digest.summary === "object"
            ? {
                zh: typeof ingested.digest.summary.zh === "string" ? ingested.digest.summary.zh : null,
                en: typeof ingested.digest.summary.en === "string" ? ingested.digest.summary.en : null,
              }
            : null,
        assets: ingested.assets,
      });
      continue;
    }
    // 404 说明这个 tag 没有 Release：记进负缓存，下次不再探它。
    if (ingested.code === "NO_DIGEST") {
      store.markAbsent(entry.tag, now);
      continue;
    }
    // 其它失败（网络、坏 JSON）不吞：这次检查算失败，ETag 不推进，下次重取。
    return {
      ok: false,
      notModified: false,
      code: ingested.code,
      status: ingested.status ?? null,
      error: ingested.error ?? ingested.code,
      tag: entry.tag,
      newVersions,
    };
  }

  // 只有整轮都成功才推进 ETag：中途失败还前移的话，那些没取到的新版本以后再也不会被看见。
  const nextEtag = typeof response.etag === "string" && response.etag ? response.etag : lastEtag;
  if (nextEtag) store.setState(STATE_LAST_ETAG, nextEtag);
  store.setState(STATE_LAST_CHECK_AT, now);

  return {
    ok: true,
    notModified: false,
    newVersions,
    etag: nextEtag ?? null,
    checkedAt: now,
    feedUpdated: parsed.feedUpdated ?? null,
  };
}

/** 宿主对一条通知的 UTF-8 字节上限（title 256 / body 4096，逐字校验）。 */
const NOTIFICATION_TITLE_MAX = 256;
const NOTIFICATION_BODY_MAX = 4096;

/**
 * 按字节截断，别把多字节字符切成半个。
 *
 * 宿主按 UTF-8 字节数校验，超了整条通知被拒（APP_NOTIFICATION_INVALID），用户
 * 什么也收不到。所以这里主动截，宁可少几个字也要发得出去。
 */
function truncateBytes(text, maxBytes) {
  const value = String(text ?? "");
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  // 省略号本身也占字节：先给它留出位置再截正文，否则最终长度又超回去。
  const ELLIPSIS = "…";
  const budget = maxBytes - Buffer.byteLength(ELLIPSIS, "utf8");
  let out = "";
  let used = 0;
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8");
    if (used + size > budget) break;
    out += ch;
    used += size;
  }
  // 截断处补省略号，读者知道这不是全文。
  return out + ELLIPSIS;
}

/** 通知正文：优先中文摘要，没有就退回版本号。 */
export function notificationFor(version) {
  const title = version.version
    ? "HanaAgent " + version.version + " 已发布"
    : version.tag + " 已发布";
  const zh = version.summary?.zh;
  const body = typeof zh === "string" && zh.trim() ? zh.trim() : "新版本 " + version.tag + " 已经可以下载。";
  return {
    title: truncateBytes(title, NOTIFICATION_TITLE_MAX),
    body: truncateBytes(body, NOTIFICATION_BODY_MAX),
  };
}
