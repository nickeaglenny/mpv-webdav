'use strict';
// 「只记最近一次」的播放进度逻辑（纯函数，方便单测）。
//
// 设计取舍（见 README）：
//   - 只保留一条记录：一个 data/last-played.json，体积恒定，不随观看数量增长；
//   - 键 = 专辑 + 路径，并用 size/mtime 做「被动校验」：文件变了就当没记录；
//   - 双阈值：太靠前视为没看（清掉），太靠尾视为看完（清掉）；
//   - 不与 mpv 自己的 watch-later 混用（我们的实例显式关闭它）。

const DEFAULT_RULES = {
  minSeconds: 30,        // 至少看了这么久才算「看了」
  minPercent: 5,         // 或者至少看了 5%
  endGuardSeconds: 60,   // 距离结尾不足这么久，视为「看完」
};

function rules(settings = {}) {
  return {
    minSeconds: Number.isFinite(settings.resumeMinSeconds) ? settings.resumeMinSeconds : DEFAULT_RULES.minSeconds,
    minPercent: Number.isFinite(settings.resumeMinPercent) ? settings.resumeMinPercent : DEFAULT_RULES.minPercent,
    endGuardSeconds: Number.isFinite(settings.resumeEndGuardSeconds) ? settings.resumeEndGuardSeconds : DEFAULT_RULES.endGuardSeconds,
  };
}

// 返回 'remember' | 'clear' | 'skip'
//   remember: 值得记下来（下次从这里继续）
//   clear:    明确不该留（太靠前 / 已看完）→ 清掉旧记录
//   skip:     信息不足，什么都不做
function decide(pos, dur, settings) {
  const r = rules(settings);
  if (!Number.isFinite(pos) || !Number.isFinite(dur) || pos <= 0 || dur <= 0) return 'skip';
  const minByPercent = dur * (r.minPercent / 100);
  const min = Math.max(r.minSeconds, minByPercent);
  if (pos < min) return 'clear';
  if (dur - pos < r.endGuardSeconds) return 'clear';
  return 'remember';
}

function buildRecord({ albumId, path, name, pos, dur, size, mtime }, now = Date.now()) {
  return {
    albumId,
    path,
    name: name || String(path || '').split('/').filter(Boolean).pop() || '',
    pos: Math.round(pos * 10) / 10,
    dur: Math.round((dur || 0) * 10) / 10,
    size: Number.isFinite(size) ? size : null,
    mtime: mtime || null,
    updatedAt: now,
  };
}

// 记录是否还适用于这次播放请求。
// size / mtime 由前端从目录列表带过来（可选）；不一致说明文件被替换过。
function matches(record, { albumId, path, size, mtime }) {
  if (!record || !record.albumId || !record.path) return false;
  if (record.albumId !== albumId) return false;
  if (record.path !== path) return false;
  if (Number.isFinite(size) && record.size != null && size !== record.size) return false;
  // mtime 只作参考：不同 WebDAV 服务对时间格式/时区的表示可能不一致，
  // 若把它当硬条件，就会出现"明明有记录却不续播"的怪现象。
  return true;
}

// 记录与本次请求的关系，用于日志/诊断
function mismatchReason(record, { albumId, path, size }) {
  if (!record) return 'no-record';
  if (record.albumId !== albumId) return 'other-album';
  if (record.path !== path) return 'other-file';
  if (Number.isFinite(size) && record.size != null && size !== record.size) return 'size-changed';
  return null;
}

function describe(record) {
  if (!record) return '';
  const s = Math.max(0, Math.floor(record.pos || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const time = h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
  return `${record.name || record.path} · ${time}`;
}

module.exports = { DEFAULT_RULES, rules, decide, buildRecord, matches, mismatchReason, describe };
