/**
 * 附件名的显示规则：去版本号、分组。
 *
 * 下载页与设置页都要按同一套规则展示附件，所以放在这里共用：产物名统一是
 * `<产物>-<版本>-<平台>.<扩展名>`，版本号已经显示在版本头上，留着既占宽度，
 * 又把真正能区分的部分（平台与架构）挤出可见区。
 */

/**
 * 去掉文件名里重复的版本段。
 *
 * 按已知 tag 精确匹配，不猜哪边算多数：tag 是页面已知的，比统计更可靠。
 * 不带版本号的文件（latest.yml、SHA256SUMS.txt）原样返回。
 */
export function stripVersion(name, tag) {
  if (!name || !tag) return name;
  const bare = String(tag).replace(/^v/i, "");
  if (!bare) return name;

  const at = name.indexOf(bare);
  // 没命中、或版本号就在开头时不动：没有产物名可去，也可能不是这套命名。
  if (at <= 0) return name;

  let end = at + bare.length;
  // 把紧跟的分隔符一并吃掉，避免结果以 `-` 开头。
  if (name[end] === "-" || name[end] === "_" || name[end] === ".") end += 1;
  const rest = name.slice(end);
  return rest || name;
}

/**
 * 附件分两类：双击能装的，和解压后能用的。
 *
 * 这个区分对用户是实质的：前者双击就装，后者要先解压。混在一张表里，用户
 * 没法判断点哪个。其余后缀（blockmap / yml / txt / json）是自动更新和校验用
 * 的配套件，不属于这两类。
 */
const INSTALLER_SUFFIXES = new Set(["exe", "msi", "dmg", "pkg", "deb", "rpm", "appimage"]);
const ARCHIVE_SUFFIXES = new Set(["zip", "tgz", "tar", "7z", "gz", "xz"]);

/** 后缀 → "installer" | "archive" | "extra"。 */
export function assetGroupOf(suffix) {
  const key = String(suffix ?? "").toLowerCase();
  if (INSTALLER_SUFFIXES.has(key)) return "installer";
  if (ARCHIVE_SUFFIXES.has(key)) return "archive";
  return "extra";
}
