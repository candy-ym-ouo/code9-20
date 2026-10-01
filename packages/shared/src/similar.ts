import { angleDiff } from './geometry.js';

/**
 * 风格相似推荐（文档 15.4）：色板 / 标签 / 光位 / 机位 四个维度加权合成。
 * 全部是纯函数：同样的输入永远得到同样的分数与排序（重复查询顺序一致）。
 */

export const SIMILAR_DIMENSION_KEYS = ['palette', 'tag', 'light', 'camera'] as const;
export type SimilarDimensionKey = (typeof SIMILAR_DIMENSION_KEYS)[number];

export const SIMILAR_DIMENSION_LABEL: Record<SimilarDimensionKey, string> = {
  palette: '色板',
  tag: '标签',
  light: '光位',
  camera: '机位',
};

/** 各维度基础权重；候选缺数据时按可用维度重新归一化 */
export const SIMILAR_BASE_WEIGHTS: Record<SimilarDimensionKey, number> = {
  palette: 0.35,
  tag: 0.3,
  light: 0.2,
  camera: 0.15,
};

export type SimilarFeedbackSignal = 'up' | 'down';

/** 反馈对排序分的调整量：点踩比点赞影响更大（把不相关的压下去） */
export const SIMILAR_FEEDBACK_DELTA: Record<SimilarFeedbackSignal, number> = {
  up: 0.12,
  down: -0.25,
};

/** 两个方位角的相似度（1 = 同向，0 = 正相反） */
export function angleSimilarity(aDeg: number, bDeg: number): number {
  return 1 - angleDiff(aDeg, bDeg) / 180;
}

/** 标签重合度（Jaccard）：|交集| / |并集|，并返回命中的标签 id 供解释 */
export function tagOverlapScore(
  seedTagIds: string[],
  candidateTagIds: string[],
): { score: number; matched: string[] } {
  const a = new Set(seedTagIds);
  const b = new Set(candidateTagIds);
  if (a.size === 0 || b.size === 0) return { score: 0, matched: [] };
  const matched = [...a].filter((id) => b.has(id));
  const union = new Set([...a, ...b]).size;
  return { score: union > 0 ? matched.length / union : 0, matched };
}

export interface DimensionScoreInput {
  key: SimilarDimensionKey;
  /** 基础权重（见 SIMILAR_BASE_WEIGHTS） */
  weight: number;
  /** null = 该维度数据缺失，不参与计分 */
  score: number | null;
}

export interface CombinedScore {
  /** 按可用维度归一化后的加权平均分（0..1）；无可用维度时为 0 */
  score: number;
  /** 每个维度在这张候选上实际使用的权重（不可用维度为 0，可用维度之和为 1） */
  effectiveWeights: Record<SimilarDimensionKey, number>;
}

/**
 * 合成基础分：只在"有数据的维度"上归一化。
 * 这样缺光位的卡不会被误判成"光位不像"，而是让其余维度分摊权重。
 */
export function combineDimensionScores(dims: DimensionScoreInput[]): CombinedScore {
  const effectiveWeights = Object.fromEntries(SIMILAR_DIMENSION_KEYS.map((k) => [k, 0])) as Record<
    SimilarDimensionKey,
    number
  >;
  const available = dims.filter((d) => d.score !== null && d.weight > 0);
  const totalWeight = available.reduce((sum, d) => sum + d.weight, 0);
  if (totalWeight <= 0) return { score: 0, effectiveWeights };
  let score = 0;
  for (const d of available) {
    const w = d.weight / totalWeight;
    effectiveWeights[d.key] = w;
    score += w * (d.score as number);
  }
  return { score, effectiveWeights };
}

/** 反馈叠加：基础分 + 调整量，钳制在 [0,1]；无反馈时 delta 为 0 */
export function applySimilarFeedback(
  baseScore: number,
  signal: SimilarFeedbackSignal | null,
): { delta: number; score: number } {
  const delta = signal ? SIMILAR_FEEDBACK_DELTA[signal] : 0;
  return { delta, score: Math.min(1, Math.max(0, baseScore + delta)) };
}

export interface SimilarRankItem {
  id: string;
  score: number;
  baseScore: number;
}

/**
 * 确定性排序：最终分降序 → 基础分降序 → id 升序。
 * 任何输入下都有唯一全序，重复查询结果顺序完全一致。
 */
export function compareSimilarRank(a: SimilarRankItem, b: SimilarRankItem): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.baseScore !== a.baseScore) return b.baseScore - a.baseScore;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
