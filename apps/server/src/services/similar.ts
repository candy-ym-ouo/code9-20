import {
  SIMILAR_BASE_WEIGHTS,
  SIMILAR_DIMENSION_LABEL,
  angleSimilarity,
  applySimilarFeedback,
  bearingFromArrow,
  combineDimensionScores,
  compareSimilarRank,
  expectedAzimuth,
  paletteSimilarity,
  tagOverlapScore,
  angleDiff,
  type PaletteColor,
  type SimilarDimensionDto,
  type SimilarDimensionKey,
  type SimilarFeedbackSignal,
  type SimilarItemDto,
  type SimilarResultDto,
} from '@flil/shared';
import { getDb, newId, nowIso, parseJson } from '../db.js';
import { errors } from '../http/errors.js';
import { requireInspiration } from './inspirations.js';
import { toInspirationDto, type InspirationRow, type SerializeContext } from './serialization.js';
import { loadSpotGeom, loadTiming, type SpotGeom } from './windowEngine.js';

/**
 * 风格相似推荐（文档 15.4）：
 * 色板 + 标签 + 光位 + 机位 四维加权，每个维度都给出可复算的理由；
 * 用户反馈（点赞/点踩）在基础分上做加性调整，可整体重置；
 * 排序为确定性全序（分数 → 基础分 → id），重复查询顺序一致。
 */

interface StyleFeatures {
  tagIds: string[];
  tagNames: Map<string, string>;
  palette: PaletteColor[];
  light: { value: number; source: string } | null;
  cameraBearing: number | null;
}

function deg(v: number): string {
  return String(Math.round(v));
}

/** 光位方位角的三个来源（按优先级）：条件里的方位角区间 → 光位箭头标注 → 实拍照片反算 */
function lightAzimuthOf(inspirationId: string, spot: SpotGeom | null): { value: number; source: string } | null {
  const db = getDb();
  const timing = loadTiming(inspirationId);
  if (timing?.azimuth_range) {
    const range = parseJson<number[]>(timing.azimuth_range, []);
    if (Array.isArray(range) && range.length === 2 && range.every((v) => Number.isFinite(v))) {
      return { value: (((range[0] + range[1]) / 2) % 360 + 360) % 360, source: '条件方位角' };
    }
  }
  const arrow = db
    .prepare(
      `SELECT cn.geometry FROM composition_note cn
       JOIN asset a ON a.id = cn.asset_id
       WHERE a.inspiration_id = ? AND cn.kind = 'light_arrow'
       ORDER BY cn.created_at DESC LIMIT 1`,
    )
    .get(inspirationId) as { geometry: string } | undefined;
  if (arrow && spot) {
    const g = parseJson<Record<string, unknown>>(arrow.geometry, {});
    const from = g.from as { x: number; y: number } | undefined;
    const to = g.to as { x: number; y: number } | undefined;
    const bearing =
      typeof g.bearingDeg === 'number'
        ? g.bearingDeg
        : from && to
          ? bearingFromArrow(from, to)
          : null;
    if (bearing !== null) {
      return { value: expectedAzimuth(spot.camera_bearing, bearing), source: '光位箭头' };
    }
  }
  const asset = db
    .prepare(
      'SELECT sun_azimuth FROM asset WHERE inspiration_id = ? AND sun_azimuth IS NOT NULL ORDER BY created_at ASC LIMIT 1',
    )
    .get(inspirationId) as { sun_azimuth: number } | undefined;
  if (asset) return { value: asset.sun_azimuth, source: '实拍太阳方位' };
  return null;
}

function featuresOf(row: InspirationRow): StyleFeatures {
  const db = getDb();
  const tagRows = db
    .prepare(
      `SELECT t.id, t.name FROM inspiration_tag it JOIN tag t ON t.id = it.tag_id
       WHERE it.inspiration_id = ? ORDER BY t.domain, t.sort_order`,
    )
    .all(row.id) as { id: string; name: string }[];

  let palette: PaletteColor[] = [];
  const assetRow = db
    .prepare(
      `SELECT palette FROM asset WHERE inspiration_id = ? AND palette != '[]'
       ORDER BY created_at ASC LIMIT 1`,
    )
    .get(row.id) as { palette: string } | undefined;
  if (assetRow) palette = parseJson<PaletteColor[]>(assetRow.palette, []);

  const spot = row.spot_id ? loadSpotGeom(row.spot_id) : null;
  return {
    tagIds: tagRows.map((t) => t.id),
    tagNames: new Map(tagRows.map((t) => [t.id, t.name])),
    palette,
    light: lightAzimuthOf(row.id, spot),
    cameraBearing: spot ? spot.camera_bearing : null,
  };
}

function dominantHex(palette: PaletteColor[]): string | null {
  if (!palette.length) return null;
  return palette.reduce((m, c) => (c.ratio > m.ratio ? c : m), palette[0]).hex;
}

function buildDimensions(seed: StyleFeatures, candidate: StyleFeatures): SimilarDimensionDto[] {
  const dims: SimilarDimensionDto[] = [];
  const push = (key: SimilarDimensionKey, score: number | null, reason: string) =>
    dims.push({ key, label: SIMILAR_DIMENSION_LABEL[key], weight: 0, score, reason });

  // 色板
  if (seed.palette.length && candidate.palette.length) {
    const score = paletteSimilarity(seed.palette, candidate.palette);
    push(
      'palette',
      score,
      `主色 ${dominantHex(seed.palette)} ↔ ${dominantHex(candidate.palette)}，色板相似度 ${score.toFixed(2)}`,
    );
  } else {
    push('palette', null, '缺少图片色板，未参与计分');
  }

  // 标签
  if (seed.tagIds.length && candidate.tagIds.length) {
    const { score, matched } = tagOverlapScore(seed.tagIds, candidate.tagIds);
    const names = matched.map((id) => seed.tagNames.get(id) ?? candidate.tagNames.get(id) ?? id);
    push(
      'tag',
      score,
      matched.length
        ? `共同标签 ${matched.length} 个：${names.join('、')}（覆盖率 ${score.toFixed(2)}）`
        : '双方都有标签但无共同项',
    );
  } else {
    push('tag', null, '标签不足，未参与计分');
  }

  // 光位
  if (seed.light && candidate.light) {
    const score = angleSimilarity(seed.light.value, candidate.light.value);
    push(
      'light',
      score,
      `光位 ${deg(seed.light.value)}°（${seed.light.source}）↔ ${deg(candidate.light.value)}°（${candidate.light.source}），相差 ${deg(angleDiff(seed.light.value, candidate.light.value))}°`,
    );
  } else {
    push('light', null, '无光位数据，未参与计分');
  }

  // 机位
  if (seed.cameraBearing !== null && candidate.cameraBearing !== null) {
    const score = angleSimilarity(seed.cameraBearing, candidate.cameraBearing);
    push(
      'camera',
      score,
      `机位朝向 ${deg(seed.cameraBearing)}° ↔ ${deg(candidate.cameraBearing)}°，相差 ${deg(angleDiff(seed.cameraBearing, candidate.cameraBearing))}°`,
    );
  } else {
    push('camera', null, '未绑定机位，未参与计分');
  }

  return dims;
}

interface FeedbackRow {
  target_inspiration_id: string;
  signal: SimilarFeedbackSignal;
}

function feedbackMapFor(seedId: string): Map<string, SimilarFeedbackSignal> {
  const rows = getDb()
    .prepare('SELECT target_inspiration_id, signal FROM similar_feedback WHERE seed_inspiration_id = ?')
    .all(seedId) as FeedbackRow[];
  return new Map(rows.map((r) => [r.target_inspiration_id, r.signal]));
}

/**
 * 计算与种子卡风格相似的候选列表。
 * 没有任何可用维度的候选会被排除（无法比较，列出来只是噪音）。
 */
export function computeSimilar(
  libraryId: string,
  ctx: SerializeContext,
  seedId: string,
  limit = 12,
): SimilarResultDto {
  const db = getDb();
  const seedRow = requireInspiration(seedId, libraryId);
  const seedFeat = featuresOf(seedRow);
  const feedback = feedbackMapFor(seedId);

  const candidates = db
    .prepare(
      `SELECT * FROM inspiration
       WHERE library_id = ? AND deleted_at IS NULL AND id != ?
       ORDER BY created_at ASC, id ASC LIMIT 500`,
    )
    .all(libraryId, seedId) as InspirationRow[];

  const ranked: (SimilarItemDto & { row: InspirationRow })[] = [];
  for (const row of candidates) {
    const dimensions = buildDimensions(seedFeat, featuresOf(row));
    const combined = combineDimensionScores(
      dimensions.map((d) => ({ key: d.key, weight: SIMILAR_BASE_WEIGHTS[d.key], score: d.score })),
    );
    // 四个维度全缺数据 → 无法比较，不进入推荐列表
    if (dimensions.every((d) => d.score === null)) continue;
    for (const d of dimensions) d.weight = combined.effectiveWeights[d.key];

    const signal = feedback.get(row.id) ?? null;
    const { delta, score } = applySimilarFeedback(combined.score, signal);
    ranked.push({
      row,
      inspiration: toInspirationDto(row, ctx, { withWindowSummary: false }),
      score,
      baseScore: combined.score,
      feedbackSignal: signal,
      feedbackDelta: delta,
      dimensions,
    });
  }

  ranked.sort((a, b) =>
    compareSimilarRank(
      { id: a.row.id, score: a.score, baseScore: a.baseScore },
      { id: b.row.id, score: b.score, baseScore: b.baseScore },
    ),
  );
  const items = ranked.slice(0, Math.max(1, Math.min(50, limit)));
  return {
    seedId,
    weights: { ...SIMILAR_BASE_WEIGHTS },
    feedbackCount: feedback.size,
    items: items.map(({ row: _row, ...item }) => item),
  };
}

/** 提交/覆盖一条反馈（同一对种子-候选只保留最新信号，重复提交幂等） */
export function setSimilarFeedback(
  libraryId: string,
  seedId: string,
  targetId: string,
  signal: SimilarFeedbackSignal,
): { feedbackCount: number } {
  const seed = requireInspiration(seedId, libraryId);
  const target = requireInspiration(targetId, libraryId);
  if (seed.id === target.id) throw errors.badRequest('不能对种子卡本身反馈');
  const db = getDb();
  const ts = nowIso();
  db.prepare(
    `INSERT INTO similar_feedback (id, library_id, seed_inspiration_id, target_inspiration_id, signal, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT (seed_inspiration_id, target_inspiration_id)
     DO UPDATE SET signal = excluded.signal, updated_at = excluded.updated_at`,
  ).run(newId(), libraryId, seed.id, target.id, signal, ts, ts);
  return { feedbackCount: feedbackMapFor(seed.id).size };
}

/** 撤销单条反馈 */
export function clearSimilarFeedback(libraryId: string, seedId: string, targetId: string): { feedbackCount: number } {
  const seed = requireInspiration(seedId, libraryId);
  getDb()
    .prepare('DELETE FROM similar_feedback WHERE seed_inspiration_id = ? AND target_inspiration_id = ?')
    .run(seed.id, targetId);
  return { feedbackCount: feedbackMapFor(seed.id).size };
}

/** 重置：清空这张种子卡的全部反馈，排序回到纯基础分 */
export function resetSimilarFeedback(libraryId: string, seedId: string): { cleared: number } {
  const seed = requireInspiration(seedId, libraryId);
  const res = getDb().prepare('DELETE FROM similar_feedback WHERE seed_inspiration_id = ?').run(seed.id);
  return { cleared: res.changes };
}
