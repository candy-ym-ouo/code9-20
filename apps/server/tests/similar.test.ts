import { describe, expect, it } from 'vitest';
import {
  SIMILAR_BASE_WEIGHTS,
  SIMILAR_FEEDBACK_DELTA,
  angleSimilarity,
  applySimilarFeedback,
  combineDimensionScores,
  compareSimilarRank,
  tagOverlapScore,
  type SimilarRankItem,
} from '@flil/shared';

describe('风格相似 · 角度相似度', () => {
  it('同向为 1，正相反为 0，且按最短弧计算（350° 与 10° 只差 20°）', () => {
    expect(angleSimilarity(90, 90)).toBe(1);
    expect(angleSimilarity(0, 180)).toBe(0);
    expect(angleSimilarity(350, 10)).toBeCloseTo(1 - 20 / 180, 6);
    // 对称性
    expect(angleSimilarity(10, 350)).toBeCloseTo(angleSimilarity(350, 10), 12);
  });
});

describe('风格相似 · 标签重合度', () => {
  it('Jaccard：|交集| / |并集|，并返回命中项', () => {
    const { score, matched } = tagOverlapScore(['a', 'b'], ['b', 'c']);
    expect(score).toBeCloseTo(1 / 3, 6);
    expect(matched).toEqual(['b']);
  });

  it('完全一致为 1，无交集为 0，空集安全返回 0', () => {
    expect(tagOverlapScore(['a'], ['a']).score).toBe(1);
    expect(tagOverlapScore(['a'], ['b']).score).toBe(0);
    expect(tagOverlapScore([], ['a']).score).toBe(0);
    expect(tagOverlapScore([], []).score).toBe(0);
  });
});

describe('风格相似 · 维度合成', () => {
  it('缺失维度不参与计分，权重按可用维度重新归一化', () => {
    const { score, effectiveWeights } = combineDimensionScores([
      { key: 'palette', weight: SIMILAR_BASE_WEIGHTS.palette, score: 1 },
      { key: 'tag', weight: SIMILAR_BASE_WEIGHTS.tag, score: 0 },
      { key: 'light', weight: SIMILAR_BASE_WEIGHTS.light, score: null },
      { key: 'camera', weight: SIMILAR_BASE_WEIGHTS.camera, score: null },
    ]);
    const total = SIMILAR_BASE_WEIGHTS.palette + SIMILAR_BASE_WEIGHTS.tag;
    expect(effectiveWeights.palette).toBeCloseTo(SIMILAR_BASE_WEIGHTS.palette / total, 6);
    expect(effectiveWeights.tag).toBeCloseTo(SIMILAR_BASE_WEIGHTS.tag / total, 6);
    expect(effectiveWeights.light).toBe(0);
    expect(effectiveWeights.camera).toBe(0);
    expect(score).toBeCloseTo(SIMILAR_BASE_WEIGHTS.palette / total, 6);
  });

  it('全部维度缺失时基础分为 0（而不是 NaN）', () => {
    const { score } = combineDimensionScores([
      { key: 'palette', weight: 0.35, score: null },
      { key: 'tag', weight: 0.3, score: null },
      { key: 'light', weight: 0.2, score: null },
      { key: 'camera', weight: 0.15, score: null },
    ]);
    expect(score).toBe(0);
  });
});

describe('风格相似 · 反馈调整', () => {
  it('点赞加分、点踩减分，且点踩力度更大', () => {
    expect(applySimilarFeedback(0.5, 'up').score).toBeCloseTo(0.5 + SIMILAR_FEEDBACK_DELTA.up, 6);
    expect(applySimilarFeedback(0.5, 'down').score).toBeCloseTo(0.5 + SIMILAR_FEEDBACK_DELTA.down, 6);
    expect(Math.abs(SIMILAR_FEEDBACK_DELTA.down)).toBeGreaterThan(Math.abs(SIMILAR_FEEDBACK_DELTA.up));
  });

  it('结果钳制在 [0,1]，无反馈时原样返回', () => {
    expect(applySimilarFeedback(0.95, 'up').score).toBe(1);
    expect(applySimilarFeedback(0.1, 'down').score).toBe(0);
    const none = applySimilarFeedback(0.42, null);
    expect(none.delta).toBe(0);
    expect(none.score).toBe(0.42);
  });
});

describe('风格相似 · 确定性排序', () => {
  const items: SimilarRankItem[] = [
    { id: 'c3', score: 0.5, baseScore: 0.5 },
    { id: 'c1', score: 0.8, baseScore: 0.8 },
    { id: 'c2', score: 0.8, baseScore: 0.7 }, // 同分不同基础分
    { id: 'c0', score: 0.5, baseScore: 0.5 }, // 完全同分 → 比 id
  ];

  it('最终分降序 → 基础分降序 → id 升序，构成唯一全序', () => {
    const sorted = [...items].sort(compareSimilarRank).map((i) => i.id);
    expect(sorted).toEqual(['c1', 'c2', 'c0', 'c3']);
  });

  it('任意打乱输入，排序结果完全一致（重复查询顺序一致）', () => {
    const a = [...items].sort(compareSimilarRank).map((i) => i.id);
    const b = [...items].reverse().sort(compareSimilarRank).map((i) => i.id);
    const c = [items[2], items[0], items[3], items[1]].sort(compareSimilarRank).map((i) => i.id);
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });
});
