/**
 * 上游采集层：atom 订阅、tag 翻页、附件清单、digest 抓取。
 *
 * 这里只负责「从网上拿到什么」，不碰数据库也不碰业务判断。
 * 所有网络调用都走宿主注入的 fetch（App 主进程受 Node 权限模型约束，
 * 裸 fetch 没有出站，必须经 ctx.network.fetch）。
 */

export const REPO_OWNER = "liliMozi";
export const REPO_NAME = "openhanako";
export const RELEASES_ATOM = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases.atom`;
const TAGS_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/tags`;
const EXPANDED_ASSETS = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/expanded_assets`;
const DOWNLOAD_BASE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download`;

const DIGEST_ASSET = "release-digest.v1.json";

/** 版本 tag 的形态：v<数字>.<数字>.<数字>...。用来滤掉 train-beta-* 这类内部通道。 */
const VERSION_TAG = /^v\d+\.\d+\.\d+/;

export function isVersionTag(tag) {
  return typeof tag === "string" && VERSION_TAG.test(tag);
}

// ---------------------------------------------------------------- XML

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text) {
  return String(text).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X"
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function pickTag(xml, name) {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? m[1] : null;
}

function pickAttr(xml, name, attr) {
  const m = new RegExp(`<${name}\\b[^>]*\\b${attr}="([^"]*)"`).exec(xml);
  return m ? decodeEntities(m[1]) : null;
}

/**
 * 解析 releases.atom。
 * 只取判新需要的字段：id 与更新的 tag 名。
 */
export function parseAtom(xml) {
  const feedUpdated = decodeEntities(pickTag(xml, "updated") ?? "").trim() || null;
  const entries = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const block = m[1];
    const id = decodeEntities(pickTag(block, "id") ?? "").trim();
    const title = decodeEntities(pickTag(block, "title") ?? "").trim();
    const updated = decodeEntities(pickTag(block, "updated") ?? "").trim();
    const href = pickAttr(block, "link", "href");
    // tag 名从 id 尾巴取：tag:github.com,2008:Repository/<id>/<tag>
    const tag = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : null;
    // 正文是 HTML 转义过的 release notes，判新用不上，保留长度供诊断
    const contentBlock = pickTag(block, "content");
    entries.push({
      id,
      tag,
      title,
      updated: updated || null,
      href,
      contentLength: contentBlock ? contentBlock.length : 0,
    });
  }
  return { feedUpdated, entries };
}

// ---------------------------------------------------------------- tags 翻页

/**
 * 从 tags HTML 里抓 tag 名与下一页游标。
 *
 * GitHub 的 tags 页把 tag 写成 /releases/tag/<tag> 或 /archive/refs/tags/<tag>。
 *
 * **游标只能从分页区的 Next 链接取**。页面里 `?after=` 还会出现在自指的地方：
 * `app-argument` 的 meta、以及两个 `originating_url`（JSON 与其 HTML 转义副本）
 * 里都嵌着当前页的 URL。取第一个匹配就拿到当前游标本身，于是每翻一页都
 * 原地打转，永远翻不到下一页。分页区的形状是：
 *
 *   <div class="pagination">
 *     <a href="...?after=<上一页>">Previous</a>
 *     <a href="...?after=<下一页>">Next</a>
 *   </div>
 *
 * 只有一页时没有分页区，after 为 null。
 */
export function parseTagsPage(html) {
  const found = [];
  const linkRe = /\/releases\/tag\/([^"'\s?#<>]+)/g;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    const tag = decodeURIComponent(m[1]);
    if (!found.includes(tag)) found.push(tag);
  }

  // 只在分页区里找 Next：区分“下一页”与“上一页/当前页”，也绕开头部那些自指 URL。
  let after = null;
  const pagination = /<div class="pagination"[^>]*>([\s\S]*?)<\/div>/.exec(html);
  if (pagination) {
    const nextRe = /<a\b[^>]*href="([^"]*\?after=[^"]*)"[^>]*>\s*Next\s*<\/a>/i;
    const nextMatch = nextRe.exec(pagination[1]);
    if (nextMatch) {
      const cursor = /\?after=([^"&\s<>]+)/.exec(nextMatch[1]);
      if (cursor) after = decodeURIComponent(cursor[1]);
    }
  }

  return { tags: found, after };
}

// ---------------------------------------------------------------- 附件清单

/**
 * 解析 expanded_assets 页。这个端点不占 API 配额，给出该 tag 的完整附件清单，
 * 含文件名、大小与 sha256。没有发 Release 的 tag 会得到零附件。
 */
export function parseExpandedAssets(html) {
  const assets = [];
  const rowRe = /<li\b[^>]*>([\s\S]*?)<\/li>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const block = m[1];
    const hrefMatch = /\/releases\/download\/[^"'\s<>]+\/([^"'\s<>?#]+)/.exec(block);
    if (!hrefMatch) continue;
    const name = decodeURIComponent(hrefMatch[1]);
    if (assets.some((a) => a.name === name)) continue;
    const shaMatch = /sha256:([0-9a-f]{64})/i.exec(block);
    const sizeMatch = /([\d.]+\s*(?:Bytes|KB|MB|GB))/i.exec(block);
    assets.push({
      name,
      sha256: shaMatch ? shaMatch[1].toLowerCase() : null,
      sizeText: sizeMatch ? sizeMatch[1].trim() : null,
      size: sizeMatch ? parseSizeToBytes(sizeMatch[1]) : null,
    });
  }
  return assets;
}

export function parseSizeToBytes(text) {
  const m = /([\d.]+)\s*(Bytes|KB|MB|GB)/i.exec(String(text));
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = m[2].toLowerCase();
  const factor = unit === "bytes" ? 1 : unit === "kb" ? 1024 : unit === "mb" ? 1024 ** 2 : 1024 ** 3;
  return Math.round(value * factor);
}

// ---------------------------------------------------------------- digest

export function digestUrl(tag) {
  return `${DOWNLOAD_BASE}/${tag}/${DIGEST_ASSET}`;
}

/** 这个版本在 GitHub 上的 Release 页面，供“数据来源”引用。 */
export function releaseUrl(tag) {
  return `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/tag/${encodeURIComponent(tag)}`;
}

export function assetUrl(tag, name) {
  return `${DOWNLOAD_BASE}/${tag}/${name}`;
}

/**
 * 附件的后缀：文件名最后一个点之后的部分，统一小写。取不到就返回空串。
 *
 * 自动下载按后缀匹配：后缀决定这个文件是什么、能不能装，版本号只是同一种东西的
 * 不同变体。所以勾“exe”就是“以后每个版本的 Windows 安装包”，不必跟着版本号走。
 */
export function assetSuffix(name) {
  const file = String(name ?? "").trim();
  const match = /\.([A-Za-z0-9]+)$/.exec(file);
  return match ? match[1].toLowerCase() : "";
}

/**
 * 安装包文件名的分类：平台、架构、格式。
 *
 * 只做描述，不做取舍：页面把分类提给用户看，由用户勾选到底下载哪几个。
 * 认不出来的归 other，照样列出——宁可选按错，也不要替用户藏掉一个真实附件。
 */
const PLATFORM_RULES = [
  { platform: "Windows", re: /(?:^|[-_.])(win|windows|win32|win64)(?:[-_.]|$)/i },
  { platform: "macOS", re: /(?:^|[-_.])(mac|macos|darwin|osx)(?:[-_.]|$)/i },
  { platform: "Linux", re: /(?:^|[-_.])(linux)(?:[-_.]|$)/i },
];

/** 先认文件后缀：它比名字里的平台字样更硬。 */
const FORMAT_RULES = [
  { format: "exe", platform: "Windows", re: /\.exe$/i },
  { format: "msi", platform: "Windows", re: /\.msi$/i },
  { format: "dmg", platform: "macOS", re: /\.dmg$/i },
  { format: "pkg", platform: "macOS", re: /\.pkg$/i },
  { format: "deb", platform: "Linux", re: /\.deb$/i },
  { format: "rpm", platform: "Linux", re: /\.rpm$/i },
  { format: "AppImage", platform: "Linux", re: /\.appimage$/i },
];

const ARCH_RULES = [
  { arch: "arm64", re: /(?:^|[-_.])(?:arm64|aarch64)(?:[-_.]|$)/i },
  { arch: "x64", re: /(?:^|[-_.])(?:x64|x86_64|amd64)(?:[-_.]|$)/i },
  { arch: "x86", re: /(?:^|[-_.])(?:x86|ia32|386|i686)(?:[-_.]|$)/i },
];

/**
 * 能下载来用的后缀。blockmap / yml / txt / json 不在里面：那些是自动更新与
 * 校验用的配套件，跟着主文件走，单拿下来没有意义。
 *
 * zip 算在这里，但它不是安装包：双击装不了，要先解压。分组交给展示层。
 */
const DOWNLOADABLE_SUFFIXES = new Set([
  "exe",
  "msi",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "appimage",
  "zip",
  "tgz",
  "tar",
  "7z",
]);

/**
 * 把一个附件描述成可供勾选的一行。
 *
 * blockmap / yml / SHA256SUMS 这些配套件会被标成 downloadable:false：它们跟着
 * 主安装包走，单独下一个没有意义，自动下载也不该去下。
 */
export function describeAsset(name, size = null) {
  const file = String(name ?? "");
  const suffix = assetSuffix(file);

  let format = null;
  let platform = null;
  for (const rule of FORMAT_RULES) {
    if (rule.re.test(file)) {
      format = rule.format;
      platform = rule.platform;
      break;
    }
  }
  // zip 不带平台信息，靠名字里的平台字样定（macOS 用 zip 分发很常见）。
  if (!format && suffix === "zip") format = "zip";
  if (!platform) {
    for (const rule of PLATFORM_RULES) {
      if (rule.re.test(file)) {
        platform = rule.platform;
        break;
      }
    }
  }

  let arch = null;
  for (const rule of ARCH_RULES) {
    if (rule.re.test(file)) {
      arch = rule.arch;
      break;
    }
  }

  return {
    name: file,
    suffix,
    size: Number.isFinite(size) ? size : null,
    platform,
    arch,
    format,
    downloadable: DOWNLOADABLE_SUFFIXES.has(suffix),
  };
}

// ---------------------------------------------------------------- 网络封装

/**
 * 丢掉一个用不到的响应体，释放宿主侧的流句柄。
 *
 * 宿主为每个未释放的响应体记一个句柄，同时在开的上限是 32 个。提前 return 而不
 * 消费 body 时，那个句柄会一直挂到超时才回收。取消比读完便宜。
 */
async function discardBody(res) {
  try {
    if (res.body && typeof res.body.cancel === "function") await res.body.cancel();
    else if (typeof res.text === "function") await res.text();
  } catch {
    // 已经关掉了就算了，这只是一次清理。
  }
}

function makeClient(fetchImpl) {
  async function getText(url, { etag, timeoutMs = 20000, maxBytes } = {}) {
    const headers = {
      "user-agent": "oh-releases/0.1 (+hana app)",
      accept: "*/*",
    };
    if (etag) headers["if-none-match"] = etag;
    const res = await fetchImpl(url, { method: "GET", headers, timeoutMs });
    if (res.status === 304) {
      // 304 也可能带一个空的响应体，同样要释放。
      await discardBody(res);
      return { notModified: true, etag: etag ?? null, status: 304 };
    }
    if (!res.ok) {
      // 非 2xx 也必须把响应体收完或取消。宿主对每个未释放的响应体持一个句柄，
      // 上限 32 个；不回填时要打很多 404（实测一轮 70 个），漏释放就会撞上
      // APP_HTTP_STREAM_LIMIT，看起来像网络错误。
      await discardBody(res);
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    const text = await res.text();
    if (maxBytes && text.length > maxBytes) {
      return { ok: false, status: res.status, error: `response too large: ${text.length}` };
    }
    return {
      ok: true,
      status: res.status,
      text,
      etag: res.headers.get("etag"),
    };
  }

  return {
    /**
     * 取 atom。
     *
     * 刻意不发条件请求（不传 if-none-match）：宿主在把响应交回 App 时会重建
     * Response，而它先看流句柄再看无 body 状态码，于是 304 走流式分支时
     * 撞上 new Response(stream, {status: 304})，直接抛
     * “Invalid response status code 304”。这个分支是先判流后判 304，
     * App 侧改不了。
     *
     * 代价只是每次都取回 atom 全文，实测 50 KB 左右，本身就不值得为它
     * 做条件请求。304 分支保留在 getText 里，宿主修好后传 etag 就能用上。
     */
    async fetchAtom(etag) {
      return getText(RELEASES_ATOM, { timeoutMs: 25000, maxBytes: 4 * 1024 * 1024 });
    },

    /** 取一页 tags。after 为游标，不传即首页。 */
    async fetchTagsPage(after) {
      const url = after ? `${TAGS_PAGE}?after=${encodeURIComponent(after)}` : TAGS_PAGE;
      const out = await getText(url, { timeoutMs: 25000, maxBytes: 8 * 1024 * 1024 });
      if (!out.ok) return out;
      return { ...out, ...parseTagsPage(out.text) };
    },

    /** 取某 tag 的附件清单。零附件表示这个 tag 没发 Release。 */
    async fetchExpandedAssets(tag) {
      const out = await getText(`${EXPANDED_ASSETS}/${encodeURIComponent(tag)}`, {
        timeoutMs: 25000,
        maxBytes: 8 * 1024 * 1024,
      });
      if (!out.ok) return out;
      const assets = parseExpandedAssets(out.text);
      return { ...out, assets, hasDigest: assets.some((a) => a.name === DIGEST_ASSET) };
    },

    /** 取某 tag 的 digest 原文（不解析，交给存储层算哈希）。 */
    async fetchDigestText(tag) {
      return getText(digestUrl(tag), { timeoutMs: 30000, maxBytes: 1024 * 1024 });
    },
  };
}

export { makeClient, DIGEST_ASSET };
