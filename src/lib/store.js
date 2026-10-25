/**
 * src/lib/store.js — SQLite 存储层。
 *
 * 用 node:sqlite 的 DatabaseSync：宿主 Node 自带，零运行时依赖。DB 文件在
 * <dataDir>/data.db —— 目录本身已经是本 App 专属的，文件名不必再带 App id。
 *
 * 四张表：
 *   versions  一个 tag 一行，body 存 digest 原文，digest_sha256 是原文的哈希
 *   absent    已确认没有 digest 的 tag（负缓存），断口只探一次
 *   assets    某 tag 的附件清单（名字/大小/sha256），按需写入
 *   state     键值杂项（backfill_state / last_etag / last_check_at）
 *
 * 写入一律 UPSERT：同一个版本取回多次，库里只有一行。每个版本独立提交，
 * 不包成一个大事务——崩溃时已取到的都在，续跑只补缺的。
 *
 * 信任上游：不做"上游是否换过资产"的比对。只做本地完整性校验——重算 body 的
 * sha256 与 digest_sha256 比对，防磁盘损坏与误改。
 */
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DB_FILENAME = "data.db";

/** state 表里本模块自己认得的键。 */
export const STATE_BACKFILL = "backfill_state";
export const STATE_LAST_ETAG = "last_etag";
export const STATE_LAST_CHECK_AT = "last_check_at";

/**
 * 断口接续表：{ <没有 digest 的 tag>: <它沿 tags 页找到的上一版> }。
 *
 * 一个 tag 进 absent 表有两种截然不同的含义，必须在库里分开存：
 *   · 链到此为止（最老的版本，或 tags 页里也找不到它的上一版）；
 *   · 这个 tag 没有 digest，但链在它的下一版继续。
 * 只有前者能让 chainClosed 停。混为一谈的话断口以下的版本永远补不到——
 * 实测链上第 26 个就有一个断口，冷启动会停在 26 条而不是 50 条。
 *
 * 这张表跨重启存在，所以崩溃续跑也能穿过它，续跑结果与一次跑完一致。
 */
export const STATE_HOLE_CONTINUATIONS = "hole_continuations";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS versions (
  tag            TEXT PRIMARY KEY,
  previous_tag   TEXT,
  digest_sha256  TEXT NOT NULL,
  source_url     TEXT NOT NULL,
  fetched_at     INTEGER NOT NULL,
  body           TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS absent (
  tag        TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS assets (
  tag       TEXT NOT NULL,
  name      TEXT NOT NULL,
  size      INTEGER,
  sha256    TEXT,
  PRIMARY KEY (tag, name)
);
CREATE TABLE IF NOT EXISTS state (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`;

const sha256 = (text) => createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex");

/** body 解析不出来时不要把整页读崩：返回 null，调用方自己决定怎么显示。 */
function parseBody(body) {
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** digest 原文 → 列表页要的轻量摘要。整份 items 只在单版本详情里给。 */
function summarize(row) {
  const digest = parseBody(row.body);
  const out = {
    tag: row.tag,
    previousTag: row.previous_tag ?? null,
    fetchedAt: row.fetched_at,
    digestSha256: row.digest_sha256,
    sourceUrl: row.source_url,
    version: null,
    generatedAt: null,
    noUserFacingChanges: null,
    summary: null,
    counts: null,
    itemCount: 0,
  };
  if (!digest) return out;
  out.version = typeof digest.version === "string" ? digest.version : null;
  out.generatedAt = typeof digest.generatedAt === "string" ? digest.generatedAt : null;
  out.noUserFacingChanges = typeof digest.noUserFacingChanges === "boolean" ? digest.noUserFacingChanges : null;
  if (digest.summary && typeof digest.summary === "object") {
    out.summary = {
      zh: typeof digest.summary.zh === "string" ? digest.summary.zh : null,
      en: typeof digest.summary.en === "string" ? digest.summary.en : null,
    };
  }
  if (digest.counts && typeof digest.counts === "object") {
    out.counts = {
      feature: Number(digest.counts.feature) || 0,
      fix: Number(digest.counts.fix) || 0,
      improvement: Number(digest.counts.improvement) || 0,
      migration: Number(digest.counts.migration) || 0,
    };
  }
  out.itemCount = Array.isArray(digest.items) ? digest.items.length : 0;
  return out;
}

/**
 * 打开（必要时创建）库。
 *
 * busy_timeout 兜住短暂的写锁：回填在写的同时，页面的读请求不该立刻失败。
 */
export function openStore(dataDir) {
  if (typeof dataDir !== "string" || !dataDir) {
    throw new Error("openStore 需要一个 dataDir");
  }
  mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, DB_FILENAME);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000;");
  // WAL 让页面在回填写入的同时还能读到已提交的行。某些文件系统（网络盘、
  // 只读挂载）不支持切 WAL，那就退回默认日志模式——不是致命错误。
  try {
    db.exec("PRAGMA journal_mode = WAL;");
  } catch {
    // 退到默认模式：读写仍然正确，只是并发读会更早撞上写锁。
  }
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);

  const stmt = {
    upsertVersion: db.prepare(`
      INSERT INTO versions (tag, previous_tag, digest_sha256, source_url, fetched_at, body)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(tag) DO UPDATE SET
        previous_tag  = excluded.previous_tag,
        digest_sha256 = excluded.digest_sha256,
        source_url    = excluded.source_url,
        fetched_at    = excluded.fetched_at,
        body          = excluded.body
    `),
    getVersion: db.prepare("SELECT * FROM versions WHERE tag = ?"),
    getLink: db.prepare("SELECT tag, previous_tag FROM versions WHERE tag = ?"),
    hasVersion: db.prepare("SELECT 1 AS ok FROM versions WHERE tag = ?"),
    countVersions: db.prepare("SELECT COUNT(*) AS n FROM versions"),
    allLinks: db.prepare("SELECT tag, previous_tag, fetched_at FROM versions"),
    allBodies: db.prepare("SELECT tag, digest_sha256, body FROM versions"),

    markAbsent: db.prepare(`
      INSERT INTO absent (tag, checked_at) VALUES (?, ?)
      ON CONFLICT(tag) DO UPDATE SET checked_at = excluded.checked_at
    `),
    isAbsent: db.prepare("SELECT 1 AS ok FROM absent WHERE tag = ?"),
    listAbsent: db.prepare("SELECT tag, checked_at FROM absent ORDER BY checked_at DESC"),

    clearAssets: db.prepare("DELETE FROM assets WHERE tag = ?"),
    upsertAsset: db.prepare(`
      INSERT INTO assets (tag, name, size, sha256) VALUES (?, ?, ?, ?)
      ON CONFLICT(tag, name) DO UPDATE SET
        size   = excluded.size,
        sha256 = excluded.sha256
    `),
    listAssets: db.prepare("SELECT name, size, sha256 FROM assets WHERE tag = ? ORDER BY name"),

    getState: db.prepare("SELECT value FROM state WHERE key = ?"),
    setState: db.prepare(`
      INSERT INTO state (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `),
    deleteState: db.prepare("DELETE FROM state WHERE key = ?"),
    allState: db.prepare("SELECT key, value FROM state ORDER BY key"),
  };

  /** 一个版本名下的全部行一起提交：版本体与附件不能一半在、一半不在。 */
  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const out = work();
      db.exec("COMMIT");
      return out;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // 回滚失败只说明事务已经不在了，原始错误才是要报出去的那个。
      }
      throw error;
    }
  }

  return {
    dbPath,

    /**
     * 写入一个版本。body 是 digest 原文；digestSha256 由调用方按原文算出并传入。
     * 这里重算一遍再比对：本地多一道校验，写错或盘坏了当场报错，而不是静静留下一条坏行。
     */
    upsertVersion({ tag, previousTag = null, digestSha256, sourceUrl, fetchedAt, body, assets }) {
      if (typeof tag !== "string" || !tag) throw new Error("upsertVersion 需要 tag");
      if (typeof body !== "string") throw new Error("upsertVersion 需要 body");
      if (typeof sourceUrl !== "string" || !sourceUrl) throw new Error("upsertVersion 需要 sourceUrl");
      const actual = sha256(body);
      if (typeof digestSha256 === "string" && digestSha256 && actual !== digestSha256) {
        throw new Error(
          "digest 哈希不符：" + tag + " 记录为 " + digestSha256 + "，实算 " + actual,
        );
      }
      const stamp = Number.isFinite(fetchedAt) ? fetchedAt : Date.now();
      return transaction(() => {
        stmt.upsertVersion.run(tag, previousTag ?? null, digestSha256 || actual, sourceUrl, stamp, body);
        if (Array.isArray(assets)) {
          stmt.clearAssets.run(tag);
          for (const asset of assets) {
            if (!asset || typeof asset.name !== "string" || !asset.name) continue;
            stmt.upsertAsset.run(
              tag,
              asset.name,
              Number.isFinite(asset.size) ? asset.size : null,
              typeof asset.sha256 === "string" ? asset.sha256 : null,
            );
          }
        }
        return { tag, digestSha256: digestSha256 || actual };
      });
    },

    /** 单版本整份读数：digest 已解析，附件单独一张表。 */
    getVersion(tag) {
      const row = stmt.getVersion.get(tag);
      if (!row) return null;
      const digest = parseBody(row.body);
      return {
        tag: row.tag,
        previousTag: row.previous_tag ?? null,
        digestSha256: row.digest_sha256,
        sourceUrl: row.source_url,
        fetchedAt: row.fetched_at,
        body: row.body,
        digest,
        assets: stmt.listAssets.all(tag).map((a) => ({
          name: a.name,
          size: a.size ?? null,
          sha256: a.sha256 ?? null,
        })),
      };
    },

    /**
     * 只读链指针，不解析 body。
     *
     * chainClosed 会反复沿 previous_tag 走（每步都查一次闭合），走 getVersion
     * 就等于每步把整份 digest 解析一遍——50 条的链是 O(n²) 次 JSON.parse。
     * 这里只取两列。
     */
    getLink(tag) {
      const row = stmt.getLink.get(tag);
      if (!row) return null;
      return { tag: row.tag, previousTag: row.previous_tag ?? null };
    },

    hasVersion(tag) {
      return stmt.hasVersion.get(tag) !== undefined;
    },

    countVersions() {
      return Number(stmt.countVersions.get().n) || 0;
    },

    /**
     * 版本列表，最新的在前，limit/offset 分页。
     *
     * 顺序分两层：
     *
     *   1. **链内按链序**：沿 previous_tag 从链头往下走。同一条链里的先后是上游
     *      自己声明的（digest 里的 previousTag），比任何本地时间都可信。
     *   2. **链间按发布时间**：断口会把一整个系列切成多条链（回溯中途停过、或者
     *      库是分段回填的）。这时按「这条链头那个版本自己声明的 generatedAt」降序接上
     *      ——不能按入库先后排，因为入库先后只说明「哪一轮回溯先跑」，与发布时间
     *      没有关系：分段回填时先跑的那段可能是较旧的一段（实测库里三条链入库时间
     *      只差一秒，最新那条反而是中间入库的）。
     *
     * 缺 generatedAt 时回落到入库时间，再回落到 tag，保证排序始终是确定的。
     */
    listVersions({ limit = 20, offset = 0 } = {}) {
      const links = stmt.allLinks.all();
      const prevOf = new Map();
      const pointed = new Set();
      for (const row of links) {
        prevOf.set(row.tag, row.previous_tag ?? null);
        if (row.previous_tag) pointed.add(row.previous_tag);
      }
      // 链头的发布时间：读它那一条 digest 的 generatedAt（不在 links 查询里，按需查）。
      const headTimeOf = (row) => {
        let iso = null;
        try {
          const full = stmt.getVersion.get(row.tag);
          const digest = full ? parseBody(full.body) : null;
          iso = digest && typeof digest.generatedAt === "string" ? digest.generatedAt : null;
        } catch {
          iso = null;
        }
        const ms = iso ? Date.parse(iso) : NaN;
        return Number.isFinite(ms) ? ms : null;
      };
      // 头 = 没有任何行把它当上一版。多条链时按链头的发布时间降序（新链在前）。
      const heads = links
        .filter((row) => !pointed.has(row.tag))
        .map((row) => ({ tag: row.tag, publishedAt: headTimeOf(row), fetchedAt: row.fetched_at }))
        .sort((a, b) => {
          if (a.publishedAt !== null && b.publishedAt !== null && a.publishedAt !== b.publishedAt) {
            return b.publishedAt - a.publishedAt;
          }
          // 任一方没有发布时间：它排在有日期的后面（日期是更强的证据），彼此按入库先后。
          if (a.publishedAt === null && b.publishedAt !== null) return 1;
          if (a.publishedAt !== null && b.publishedAt === null) return -1;
          return a.fetchedAt - b.fetchedAt || (a.tag < b.tag ? -1 : 1);
        })
        .map((row) => row.tag);

      const ordered = [];
      const seen = new Set();
      for (const head of heads) {
        let cur = head;
        while (cur && prevOf.has(cur) && !seen.has(cur)) {
          seen.add(cur);
          ordered.push(cur);
          cur = prevOf.get(cur);
        }
      }
      // 成环或指向已不在库里的行留下的孤儿：接在尾部，按入库顺序。
      for (const row of links.slice().sort((a, b) => a.fetched_at - b.fetched_at)) {
        if (!seen.has(row.tag)) {
          seen.add(row.tag);
          ordered.push(row.tag);
        }
      }

      const safeLimit = Math.max(0, Math.floor(Number(limit) || 0));
      const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
      const slice = ordered.slice(safeOffset, safeOffset + safeLimit);
      const items = slice.map((tag) => summarize(stmt.getVersion.get(tag)));
      return { items, total: ordered.length, limit: safeLimit, offset: safeOffset };
    },

    /** 认下一个没有 digest 的 tag。断口只探一次。 */
    markAbsent(tag, checkedAt = Date.now()) {
      if (typeof tag !== "string" || !tag) return;
      stmt.markAbsent.run(tag, Number.isFinite(checkedAt) ? checkedAt : Date.now());
    },

    isAbsent(tag) {
      return stmt.isAbsent.get(tag) !== undefined;
    },

    listAbsent() {
      return stmt.listAbsent.all().map((row) => ({ tag: row.tag, checkedAt: row.checked_at }));
    },

    /** 覆盖某 tag 的附件清单。空数组表示这个 tag 没有附件。 */
    upsertAssets(tag, assets) {
      if (typeof tag !== "string" || !tag) throw new Error("upsertAssets 需要 tag");
      const list = Array.isArray(assets) ? assets : [];
      return transaction(() => {
        stmt.clearAssets.run(tag);
        let n = 0;
        for (const asset of list) {
          if (!asset || typeof asset.name !== "string" || !asset.name) continue;
          stmt.upsertAsset.run(
            tag,
            asset.name,
            Number.isFinite(asset.size) ? asset.size : null,
            typeof asset.sha256 === "string" ? asset.sha256 : null,
          );
          n += 1;
        }
        return { tag, count: n };
      });
    },

    listAssets(tag) {
      return stmt.listAssets.all(tag).map((a) => ({
        name: a.name,
        size: a.size ?? null,
        sha256: a.sha256 ?? null,
      }));
    },

    /** 状态一律存 TEXT：布尔记 "0"/"1"，数字记十进制串。 */
    getState(key, fallback = null) {
      const row = stmt.getState.get(key);
      return row === undefined ? fallback : row.value;
    },

    setState(key, value) {
      if (value === null || value === undefined) {
        stmt.deleteState.run(key);
        return null;
      }
      const text = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
      stmt.setState.run(key, text);
      return text;
    },

    getAllState() {
      const out = {};
      for (const row of stmt.allState.all()) out[row.key] = row.value;
      return out;
    },

    /** backfill_state：0 需要溯源，1 已完成。 */
    getBackfillState() {
      const row = stmt.getState.get(STATE_BACKFILL);
      return row !== undefined && row.value === "1" ? 1 : 0;
    },

    setBackfillState(value) {
      const text = value ? "1" : "0";
      stmt.setState.run(STATE_BACKFILL, text);
      return text;
    },

    /**
     * 断口接续表。key 是"没有 digest 的 tag"，value 是它的上一版（null 表示链到此为止）。
     *
     * 单独一张表而不是塞进 absent：absent 只说"这个 tag 没 digest"，这里说
     * "没 digest 之后链往哪去"。chainClosed 靠后者决定要不要继续走。
     */
    getHoleContinuations() {
      const raw = stmt.getState.get(STATE_HOLE_CONTINUATIONS);
      if (raw === undefined) return {};
      try {
        const parsed = JSON.parse(raw.value);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
      } catch {
        return {};
      }
    },

    /** 记一个断口的接续。上一版为 null 表示确认它是链的尽头。 */
    setHoleContinuation(tag, previousTag) {
      if (typeof tag !== "string" || !tag) return;
      const map = stmt.getState.get(STATE_HOLE_CONTINUATIONS);
      let current = {};
      if (map !== undefined) {
        try {
          const parsed = JSON.parse(map.value);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) current = parsed;
        } catch {
          current = {};
        }
      }
      current[tag] = typeof previousTag === "string" && previousTag ? previousTag : null;
      stmt.setState.run(STATE_HOLE_CONTINUATIONS, JSON.stringify(current));
      return current[tag];
    },

    /** 某个 tag 是否已被确认为"链的尽头"（与"没 digest 但有下一版"区分开）。 */
    isChainEnd(tag) {
      const map = stmt.getState.get(STATE_HOLE_CONTINUATIONS);
      if (map === undefined) return false;
      try {
        const parsed = JSON.parse(map.value);
        return (
          parsed !== null && typeof parsed === "object" && tag in parsed && parsed[tag] === null
        );
      } catch {
        return false;
      }
    },

    /** 离线复核：重算每条 body 的 sha256，与库里记的比对。 */
    verifyAll() {
      const rows = stmt.allBodies.all();
      const bad = [];
      for (const row of rows) {
        const actual = sha256(row.body);
        if (actual !== row.digest_sha256) {
          bad.push({ tag: row.tag, expected: row.digest_sha256, actual });
        }
      }
      return { ok: bad.length === 0, checked: rows.length, bad };
    },

    close() {
      try {
        db.close();
      } catch {
        // 已经关了就算了：关闭不是业务语义的一部分。
      }
    },
  };
}
