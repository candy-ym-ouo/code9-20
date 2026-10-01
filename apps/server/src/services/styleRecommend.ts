import {
  applyFeedback,
  rankStyleCandidates,
  styleSimilarity,
  DEFAULT_STYLE_WEIGHTS,
  type StyleDimensionKey,
  type StyleRecommendationDto,
  type StyleRecommendationResult,
  type StyleSignature,
  type VoteKind,
} from '@flil/shared';
import type { PaletteColor } from '@flil/shared';
import { getDb, newId, nowIso, parseJson } from '../db.js';
import { errors } from '../http/errors.js';
import {
  toInspirationDto,
  type InspirationRow,
  type SerializeContext,
} from './serialization.js';
import { requireInspiration } from './inspirations.js';
import type { AssetRow } from './assets.js';
import { loadSpotGeom, loadTiming, timingRowToDto } from './windowEngine.js';

/**
 * 风格相似推荐（结合色板 / 标签 / 光位 / 机位，结果逐项可解释）。
 * 设计约束：
 *  - 打分是纯函数（@flil/shared/style.ts），服务层只做特征抽取；
 *  - 反馈只做排序位移（赞 +0.12 / 踩 -0.40），删除反馈即"重置"；
 *  - 排序末位用 inspiration id 兜底，无随机/无时钟，重复查询顺序一致。
 */

interface FeedbackRow {
  target_id: string;
  vote: VoteKind;
  updated_at: string;
}

/** 合并一张卡所有图片的主色：每张图等权（图内 ratio 已归一化），同 hex 聚合后取前 6 */
function mergePalette(rows: { palette: string }[]): PaletteColor[] {
  const buckets = new Map<string, { weight: number }>();
  let counted = 0;
  for (const row of rows) {
    const colors = parseJson<PaletteColor[]>(row.palette, []);
    if (!colors.length) continue;
    counted += 1;
    for (const c of colors) {
      const key = c.hex.toLowerCase();
      const prev = buckets.get(key);
      if (prev) prev.weight += c.ratio;
      else buckets.set(key, { weight: c.ratio });
    }
  }
  if (!counted) return [];
  const merged = [...buckets.entries()]
    .map(([hex, v]) => ({ hex, ratio: v.weight / counted }))
    .sort((a, b) => b.ratio - a.ratio || (a.hex < b.hex ? -1 : 1))
    .slice(0, 6);
  const sum = merged.reduce((acc, c) => acc + c.ratio, 0) || 1;
  return merged.map((c) => ({ hex: c.hex, ratio: Number((c.ratio / sum).toFixed(4)) }));
}

/**
 * 从库里抽取一张卡的风格指纹。
 * 光位优先用"拍摄条件"（人反复校准过的意图），没有条件时退回首张参考图反算出的太阳位置。
 */
export function buildSignature(inspirationId: string): StyleSignature {
  const db = getDb();

  const paletteRows = db
    .prepare('SELECT palette FROM asset WHERE inspiration_id = ? ORDER BY created_at ASC, id ASC')
    .all(inspirationId) as Pick<AssetRow, 'palette'>[];

  const tagRows = db
    .prepare('SELECT tag_id FROM inspiration_tag WHERE inspiration_id = ? ORDER BY tag_id')
    .all(inspirationId) as { tag_id: string }[];

  const inspiration = db
    .prepare('SELECT spot_id FROM inspiration WHERE id = ?')
    .get(inspirationId) as { spot_id: string | null } | undefined;
  const spot = inspiration?.spot_id ? loadSpotGeom(inspiration.spot_id) : null;
  const cameraBearing = spot ? spot.camera_bearing : null;

  let lightBearing: number | null = null;
  let sunElevation: number | null = null;

  const timingRow = loadTiming(inspirationId);
  if (timingRow && spot) {
    const timing = timingRowToDto(timingRow);
    if (timing.azimuthRange && timing.azimuthRange.length === 2) {
      // timing.azimuthRange 是"期望太阳方位角"（罗盘绝对角），换算成相对机位的光位角
      const sunAzCenter = (timing.azimuthRange[0] + timing.azimuthRange[1]) / 2;
      lightBearing = ((sunAzCenter - spot.camera_bearing) % 360 + 360) % 360;
    }
    const [lo, hi] = timing.elevationRange;
    // 默认的 [-90,90] 表示"仰角无约束"，不应当成一个真实的 0° 仰角
    if (lo > -90 || hi < 90) sunElevation = (lo + hi) / 2;
  }

  if (lightBearing === null || sunElevation === null) {
    const asset = db
      .prepare(
        `SELECT sun_azimuth, sun_elevation FROM asset
         WHERE inspiration_id = ? AND sun_azimuth IS NOT NULL AND sun_elevation IS NOT NULL
         ORDER BY created_at ASC, id ASC LIMIT 1`,
      )
      .get(inspirationId) as { sun_azimuth: number; sun_elevation: number } | undefined;
    if (asset) {
      if (lightBearing === null && cameraBearing !== null) {
        lightBearing = (asset.sun_azimuth - cameraBearing + 360) % 360;
      }
      if (sunElevation === null) sunElevation = asset.sun_elevation;
    }
  }

  return {
    palette: mergePalette(paletteRows),
    tagIds: tagRows.map((t) => t.tag_id),
    lightBearing,
    sunElevation,
    cameraBearing,
  };
}

function loadFeedbackMap(libraryId: string, userId: string, sourceId: string): Map<string, FeedbackRow> {
  const rows = getDb()
    .prepare(
      `SELECT target_id, vote, updated_at FROM style_feedback
       WHERE library_id = ? AND user_id = ? AND source_id = ?`,
    )
    .all(libraryId, userId, sourceId) as FeedbackRow[];
  return new Map(rows.map((r) => [r.target_id, r]));
}

function summarize(dimensions: { key: StyleDimensionKey; label: string; score: number; weight: number; available: boolean }[]): string {
  const top = dimensions
    .filter((d) => d.available)
    .sort((a, b) => b.weight * b.score - a.weight * a.weight || a.key.localeCompare(b.key))
    .slice(0, 2)
    .map((d) => d.label);
  return top.length ? `主要相似点：${top.join('、')}` : '四维数据均不足';
}

export interface RecommendOptions {
  size?: number;
  minScore?: number;
}

export function styleRecommendations(
  libraryId: string,
  userId: string,
  ctx: SerializeContext,
  sourceId: string,
  opts: RecommendOptions = {},
): StyleRecommendationResult {
  const size = opts.size ?? 12;
  const minScore = opts.minScore ?? 0.15;
  const sourceRow = requireInspiration(sourceId, libraryId);

  const db = getDb();
  const source = buildSignature(sourceId);

  const candidates = db
    .prepare(
      `SELECT * FROM inspiration
       WHERE library_id = ? AND deleted_at IS NULL AND id <> ? AND status <> 'dropped'
       ORDER BY id ASC
       LIMIT 500`,
    )
    .all(libraryId, sourceId) as InspirationRow[];

  const tagNameRows = db
    .prepare('SELECT id, name FROM tag WHERE library_id = ?')
    .all(libraryId) as { id: string; name: string }[];
  const tagNames = new Map(tagNameRows.map((t) => [t.id, t.name]));

  const feedback = loadFeedbackMap(libraryId, userId, sourceId);

  let skipped = 0;
  const scored: { row: InspirationRow; score: number; dimensions: StyleRecommendationDto['dimensions']; available: number }[] = [];
  for (const row of candidates) {
    const result = styleSimilarity({
      source,
      target: buildSignature(row.id),
      tagNames: (id) => tagNames.get(id),
    });
    if (!result) {
      skipped += 1;
      continue;
    }
    if (result.score < minScore) {
      skipped += 1;
      continue;
    }
    scored.push({
      row,
      score: result.score,
      dimensions: result.dimensions,
      available: result.availableDimensionCount,
    });
  }

  const ranked = rankStyleCandidates(
    scored.map((s) => ({ targetId: s.row.id, score: s.score, vote: feedback.get(s.row.id)?.vote ?? null })),
  );
  const byId = new Map(scored.map((s) => [s.row.id, s]));

  let feedbackApplied = 0;
  const items: StyleRecommendationDto[] = [];
  for (const rank of ranked.slice(0, size)) {
    const s = byId.get(rank.targetId)!;
    const fb = feedback.get(s.row.id);
    if (fb) feedbackApplied += 1;
    const adjustedScore = applyFeedback(s.score, fb?.vote ?? null);
    const suffix = fb?.vote === 'up' ? '；你点过赞，已提前' : fb?.vote === 'down' ? '；你点过踩，已压后' : '';
    items.push({
      inspiration: toInspirationDto(s.row, ctx, { withWindowSummary: false }),
      score: Number(s.score.toFixed(4)),
      adjustedScore: Number(adjustedScore.toFixed(4)),
      availableDimensionCount: s.available,
      dimensions: s.dimensions.map((d) => ({ ...d, score: Number(d.score.toFixed(4)), weight: Number(d.weight.toFixed(4)) })),
      feedback: { vote: fb?.vote ?? null, updatedAt: fb?.updated_at ?? null },
      summary: `${summarize(s.dimensions)}（综合 ${(s.score * 100).toFixed(0)}%）${suffix}`,
    });
  }

  return {
    sourceId: sourceRow.id,
    items,
    total: ranked.length,
    scanned: candidates.length,
    skipped,
    feedbackApplied,
    weights: { ...DEFAULT_STYLE_WEIGHTS },
  };
}

// ------------------------------------------------------------- feedback

function assertSameLibrary(inspirationId: string, libraryId: string): void {
  requireInspiration(inspirationId, libraryId);
}

/** 记录/修改一条赞踩；vote='none' 表示撤销（删除反馈行） */
export function recordStyleFeedback(params: {
  libraryId: string;
  userId: string;
  sourceId: string;
  targetId: string;
  vote: 'up' | 'down' | 'none';
}): { vote: VoteKind | null; updatedAt: string | null } {
  const { libraryId, userId, sourceId, targetId, vote } = params;
  if (sourceId === targetId) throw errors.badRequest('不能对源卡本身反馈');
  assertSameLibrary(sourceId, libraryId);
  assertSameLibrary(targetId, libraryId);

  const db = getDb();
  const existing = db
    .prepare('SELECT id FROM style_feedback WHERE library_id = ? AND user_id = ? AND source_id = ? AND target_id = ?')
    .get(libraryId, userId, sourceId, targetId) as { id: string } | undefined;

  if (vote === 'none') {
    if (existing) db.prepare('DELETE FROM style_feedback WHERE id = ?').run(existing.id);
    return { vote: null, updatedAt: null };
  }

  const ts = nowIso();
  if (existing) {
    db.prepare('UPDATE style_feedback SET vote = ?, updated_at = ? WHERE id = ?').run(vote, ts, existing.id);
  } else {
    db.prepare(
      `INSERT INTO style_feedback (id, library_id, user_id, source_id, target_id, vote, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?)`,
    ).run(newId(), libraryId, userId, sourceId, targetId, vote, ts, ts);
  }
  return { vote, updatedAt: ts };
}

/** 重置反馈：传 sourceId 只清这张卡的，不传则清空该用户在本库的全部反馈 */
export function resetStyleFeedback(libraryId: string, userId: string, sourceId?: string): { deleted: number } {
  const where = ['library_id = ?', 'user_id = ?'];
  const args: (string | number)[] = [libraryId, userId];
  if (sourceId) {
    where.push('source_id = ?');
    args.push(sourceId);
  }
  const info = getDb().prepare(`DELETE FROM style_feedback WHERE ${where.join(' AND ')}`).run(...args);
  return { deleted: info.changes };
}

export function listStyleFeedback(libraryId: string, userId: string, sourceId?: string) {
  const where = ['library_id = ?', 'user_id = ?'];
  const args: (string | number)[] = [libraryId, userId];
  if (sourceId) {
    where.push('source_id = ?');
    args.push(sourceId);
  }
  return getDb()
    .prepare(
      `SELECT source_id AS sourceId, target_id AS targetId, vote, updated_at AS updatedAt
       FROM style_feedback WHERE ${where.join(' AND ')} ORDER BY source_id, target_id`,
    )
    .all(...args);
}
