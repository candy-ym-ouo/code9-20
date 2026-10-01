import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STYLE_WEIGHTS,
  FEEDBACK_DOWN_PENALTY,
  FEEDBACK_UP_BOOST,
  applyFeedback,
  rankStyleCandidates,
  styleSimilarity,
  type StyleSignature,
} from '@flil/shared';

function sig(patch: Partial<StyleSignature> = {}): StyleSignature {
  return {
    palette: [],
    tagIds: [],
    lightBearing: null,
    sunElevation: null,
    cameraBearing: null,
    ...patch,
  };
}

describe('风格相似：单维打分', () => {
  it('色板一致得高分，主色不同得低分', () => {
    const a = sig({ palette: [{ hex: '#1a2a3a', ratio: 0.6 }, { hex: '#c9a86a', ratio: 0.4 }] });
    const same = sig({ palette: [{ hex: '#1a2a3a', ratio: 0.5 }, { hex: '#c9a86a', ratio: 0.5 }] });
    const other = sig({ palette: [{ hex: '#ff00ff', ratio: 1 }] });
    // 还需要第二个可比较维度才会出分：用标签补齐
    const r1 = styleSimilarity({
      source: sig({ ...a, tagIds: ['t1'] }),
      target: sig({ ...same, tagIds: ['t1'] }),
    });
    const r2 = styleSimilarity({
      source: sig({ ...a, tagIds: ['t1'] }),
      target: sig({ ...other, tagIds: ['t1'] }),
    });
    expect(r1!.score).toBeGreaterThan(r2!.score);
  });

  it('标签维度用 Jaccard：全交集 1，无交集 0', () => {
    const r = styleSimilarity({
      source: sig({ tagIds: ['a', 'b'], palette: [{ hex: '#101010', ratio: 1 }] }),
      target: sig({ tagIds: ['a', 'b'], palette: [{ hex: '#101010', ratio: 1 }] }),
    });
    const tagDim = r!.dimensions.find((d) => d.key === 'tags')!;
    expect(tagDim.score).toBe(1);

    const r0 = styleSimilarity({
      source: sig({ tagIds: ['a', 'b'], palette: [{ hex: '#101010', ratio: 1 }] }),
      target: sig({ tagIds: ['c', 'd'], palette: [{ hex: '#101010', ratio: 1 }] }),
    });
    expect(r0!.dimensions.find((d) => d.key === 'tags')!.score).toBe(0);
  });

  it('标签理由写共同标签名称（通过 tagNames 解析，不暴露裸 id）', () => {
    const r = styleSimilarity({
      source: sig({ tagIds: ['t1', 't2'], palette: [{ hex: '#202020', ratio: 1 }] }),
      target: sig({ tagIds: ['t1'], palette: [{ hex: '#202020', ratio: 1 }] }),
      tagNames: (id) => ({ t1: '逆光', t2: '连廊' })[id],
    });
    expect(r!.dimensions.find((d) => d.key === 'tags')!.reason).toContain('逆光');
  });

  it('光位角：顺光 vs 逆光得低分；相近光位得高分；理由带实际值 vs 目标值', () => {
    const source = sig({
      lightBearing: 0, // 顺光
      sunElevation: 5,
      tagIds: ['t'],
    });
    const backlight = sig({ lightBearing: 180, sunElevation: 5, tagIds: ['t'] });
    const close = sig({ lightBearing: 10, sunElevation: 8, tagIds: ['t'] });

    const rFar = styleSimilarity({ source, target: backlight })!;
    const rClose = styleSimilarity({ source, target: close })!;
    expect(rClose.score).toBeGreaterThan(rFar.score);
    const lightReason = rFar.dimensions.find((d) => d.key === 'light')!.reason;
    expect(lightReason).toContain('光位角差 180°');
    expect(lightReason).toMatch(/源 0°.*目标 180°/);
  });

  it('机位朝向差作为独立维度，理由含双方朝向角', () => {
    const r = styleSimilarity({
      source: sig({ cameraBearing: 265, tagIds: ['a'], palette: [{ hex: '#333333', ratio: 1 }] }),
      target: sig({ cameraBearing: 270, tagIds: ['a'], palette: [{ hex: '#333333', ratio: 1 }] }),
    });
    const cam = r!.dimensions.find((d) => d.key === 'camera')!;
    expect(cam.available).toBe(true);
    expect(cam.score).toBeGreaterThan(0.9);
    expect(cam.reason).toContain('机位朝向差 5°');
  });

  it('缺失维度不可用，权重按比例重分配给在席维度', () => {
    const r = styleSimilarity({
      source: sig({ tagIds: ['a'], palette: [{ hex: '#121212', ratio: 1 }] }),
      target: sig({ tagIds: ['a'], palette: [{ hex: '#121212', ratio: 1 }] }),
    })!;
    expect(r.availableDimensionCount).toBe(2);
    const expectedTag = DEFAULT_STYLE_WEIGHTS.tags / (DEFAULT_STYLE_WEIGHTS.tags + DEFAULT_STYLE_WEIGHTS.palette);
    const tag = r.dimensions.find((d) => d.key === 'tags')!;
    expect(tag.weight).toBeCloseTo(expectedTag, 5);
    // 缺失维度权重为 0 且理由说明"未参与比较"
    const light = r.dimensions.find((d) => d.key === 'light')!;
    expect(light.available).toBe(false);
    expect(light.weight).toBe(0);
    expect(light.reason).toContain('未参与比较');
  });

  it('可比较维度不足 2 个时返回 null（单维不足以支撑风格推荐）', () => {
    expect(
      styleSimilarity({
        source: sig({ tagIds: ['a'] }),
        target: sig({ tagIds: ['a'] }),
      }),
    ).toBeNull();
    expect(styleSimilarity({ source: sig(), target: sig() })).toBeNull();
  });
});

describe('风格相似：反馈与确定性排序', () => {
  it('赞加分、踩减分并夹到 [0,1]', () => {
    expect(applyFeedback(0.5, 'up')).toBeCloseTo(0.5 + FEEDBACK_UP_BOOST);
    expect(applyFeedback(0.5, 'down')).toBeCloseTo(0.5 - FEEDBACK_DOWN_PENALTY);
    expect(applyFeedback(0, 'up')).toBe(FEEDBACK_UP_BOOST);
    expect(applyFeedback(0.99, 'up')).toBe(1);
    expect(applyFeedback(0.1, 'down')).toBe(0);
    expect(applyFeedback(0.5, null)).toBe(0.5);
  });

  it('排序：反馈分 ↓ → 基础分 ↓ → id 字典序，完全确定', () => {
    const items = [
      { targetId: 'c', score: 0.4 },
      { targetId: 'a', score: 0.4 },
      { targetId: 'b', score: 0.55, vote: 'down' as const }, // 踩后 0.15，垫底
      { targetId: 'd', score: 0.42, vote: 'up' as const }, // 赞后 0.54，升到第二
    ];
    const ids = rankStyleCandidates(items).map((x) => x.targetId);
    // d 赞后 0.54 升到首位；a 与 c 基础分相同（0.40）→ id 小的在前；b 踩后 0.15 垫底
    expect(ids).toEqual(['d', 'a', 'c', 'b']);
  });

  it('重复排序输入乱序不影响结果顺序（重复查询顺序一致）', () => {
    const items = [
      { targetId: 'z9', score: 0.4 },
      { targetId: 'z1', score: 0.4 },
      { targetId: 'z5', score: 0.4 },
    ];
    const first = rankStyleCandidates(items).map((x) => x.targetId);
    const second = rankStyleCandidates([...items].reverse()).map((x) => x.targetId);
    expect(second).toEqual(first);
    expect(first).toEqual(['z1', 'z5', 'z9']);
  });
});
