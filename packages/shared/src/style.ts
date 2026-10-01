import { angleDiff } from './geometry.js';
import { paletteSimilarity, type PaletteColor } from './palette.js';

/**
 * 风格相似打分（纯函数，无 IO / 无随机 / 无时钟）。
 * 四个可解释维度：色板 palette、标签 tags、光位 light、机位 camera。
 * 服务层负责从库里抽出 StyleSignature，本模块只负责"给两张卡算相似度"，
 * 因此同样的输入永远得到同样的输出（重复查询顺序一致）。
 */

export type StyleDimensionKey = 'palette' | 'tags' | 'light' | 'camera';

export const STYLE_DIMENSION_LABEL: Record<StyleDimensionKey, string> = {
  palette: '色板',
  tags: '标签',
  light: '光位',
  camera: '机位',
};

/** 默认权重：色板与标签是风格主体，光位次之，机位朝向作为补充 */
export const DEFAULT_STYLE_WEIGHTS: Record<StyleDimensionKey, number> = {
  palette: 0.3,
  tags: 0.3,
  light: 0.25,
  camera: 0.15,
};

/** 显式反馈的打分位移：踩比赞更强（避免一次赞盖过风格本身） */
export const FEEDBACK_UP_BOOST = 0.12;
export const FEEDBACK_DOWN_PENALTY = 0.4;

export interface StyleSignature {
  palette: PaletteColor[];
  tagIds: string[];
  /** 相对机位的光位角：0°=顺光，90°=光从右来，180°=逆光；未知为 null */
  lightBearing: number | null;
  /** 太阳仰角（度）；未知为 null */
  sunElevation: number | null;
  /** 机位朝向（罗盘方位角，度）；未知为 null */
  cameraBearing: number | null;
}

export type VoteKind = 'up' | 'down';

export interface StyleDimensionResult {
  key: StyleDimensionKey;
  label: string;
  /** 该维度原始得分 0..1 */
  score: number;
  /** 归一化后实际参与加权的权重（缺失维度会被重分配） */
  weight: number;
  /** 该维度是否双方都有数据可比较 */
  available: boolean;
  /** 给人看的一句话理由，含实际值 vs 目标值 */
  reason: string;
}

export interface StyleSimilarityInput {
  source: StyleSignature;
  target: StyleSignature;
  weights?: Partial<Record<StyleDimensionKey, number>>;
  /** 标签 id → 名称，用于理由里写"共同标签：逆光/连廊"而不是裸 id */
  tagNames?: (id: string) => string | undefined;
}

export interface StyleSimilarityResult {
  /** 未含反馈的加权基础分 0..1 */
  score: number;
  /** 参与打分的维度个数（双方都有数据才算） */
  availableDimensionCount: number;
  dimensions: StyleDimensionResult[];
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** 角差转 0..1 相似度：90° 以上视为完全不相关（顺光 vs 逆光） */
function angleScore(diffDeg: number, cutoffDeg = 90): number {
  return Math.max(0, 1 - Math.min(diffDeg, cutoffDeg) / cutoffDeg);
}

function paletteDimension(source: StyleSignature, target: StyleSignature): StyleDimensionResult {
  const available = source.palette.length > 0 && target.palette.length > 0;
  const score = available ? paletteSimilarity(source.palette, target.palette) : 0;
  const reason = !available
    ? '至少一方缺少主色板，未参与比较'
    : `主色序列匹配度 ${(score * 100).toFixed(0)}%（取双方前 6 主色加权对比）`;
  return { key: 'palette', label: STYLE_DIMENSION_LABEL.palette, score, weight: 0, available, reason };
}

function tagsDimension(
  source: StyleSignature,
  target: StyleSignature,
  tagNames?: (id: string) => string | undefined,
): StyleDimensionResult {
  const available = source.tagIds.length > 0 && target.tagIds.length > 0;
  let score = 0;
  let reason = '至少一方没有标签，未参与比较';
  if (available) {
    const a = new Set(source.tagIds);
    const common = target.tagIds.filter((t) => a.has(t));
    const union = new Set([...source.tagIds, ...target.tagIds]).size;
    score = union > 0 ? common.length / union : 0;
    const names = common.map((id) => tagNames?.(id) ?? id).slice(0, 5);
    reason =
      common.length > 0
        ? `共同标签 ${common.length} 个（Jaccard ${(score * 100).toFixed(0)}%）：${names.join('、')}`
        : '标签集合无交集';
  }
  return { key: 'tags', label: STYLE_DIMENSION_LABEL.tags, score, weight: 0, available, reason };
}

function lightDimension(source: StyleSignature, target: StyleSignature): StyleDimensionResult {
  const bearingKnown = source.lightBearing !== null && target.lightBearing !== null;
  const elevKnown = source.sunElevation !== null && target.sunElevation !== null;
  const available = bearingKnown || elevKnown;

  let score = 0;
  let reason = '双方光位均未知（未设条件/无实拍太阳位置），未参与比较';
  if (available) {
    const parts: string[] = [];
    let weighted = 0;
    let wSum = 0;
    if (bearingKnown) {
      const diff = angleDiff(source.lightBearing as number, target.lightBearing as number);
      const s = angleScore(diff);
      weighted += s * 0.7;
      wSum += 0.7;
      parts.push(`光位角差 ${round1(diff)}°（源 ${round1(source.lightBearing as number)}° vs 目标 ${round1(target.lightBearing as number)}°，0°=顺光/180°=逆光）`);
    }
    if (elevKnown) {
      const diff = Math.abs((source.sunElevation as number) - (target.sunElevation as number));
      // 仰角差 45° 以上视为完全不相关（地平线 vs 正午）
      const s = angleScore(diff, 45);
      weighted += s * 0.3;
      wSum += 0.3;
      parts.push(`太阳仰角差 ${round1(diff)}°（源 ${round1(source.sunElevation as number)}° vs 目标 ${round1(target.sunElevation as number)}°）`);
    }
    score = wSum > 0 ? weighted / wSum : 0;
    reason = parts.join('；');
  }
  return { key: 'light', label: STYLE_DIMENSION_LABEL.light, score, weight: 0, available, reason };
}

function cameraDimension(source: StyleSignature, target: StyleSignature): StyleDimensionResult {
  const available = source.cameraBearing !== null && target.cameraBearing !== null;
  let score = 0;
  let reason = '至少一方未绑定机位，机位朝向未参与比较';
  if (available) {
    const diff = angleDiff(source.cameraBearing as number, target.cameraBearing as number);
    score = angleScore(diff);
    reason = `机位朝向差 ${round1(diff)}°（源 ${round1(source.cameraBearing as number)}° vs 目标 ${round1(target.cameraBearing as number)}°）`;
  }
  return { key: 'camera', label: STYLE_DIMENSION_LABEL.camera, score, weight: 0, available, reason };
}

/**
 * 四维加权相似。缺失维度（任一方无数据）不参与，其权重按比例重分配给在席维度；
 * 若在席维度不足 2 个，返回 null —— 单维相似不足以支撑"风格相似"推荐。
 */
export function styleSimilarity(input: StyleSimilarityInput): StyleSimilarityResult | null {
  const weights: Record<StyleDimensionKey, number> = {
    ...DEFAULT_STYLE_WEIGHTS,
    ...(input.weights ?? {}),
  };
  const dimensions: StyleDimensionResult[] = [
    paletteDimension(input.source, input.target),
    tagsDimension(input.source, input.target, input.tagNames),
    lightDimension(input.source, input.target),
    cameraDimension(input.source, input.target),
  ];

  const available = dimensions.filter((d) => d.available);
  if (available.length < 2) return null;

  const weightSum = available.reduce((acc, d) => acc + Math.max(0, weights[d.key]), 0);
  let score = 0;
  for (const d of dimensions) {
    if (d.available) {
      d.weight = weightSum > 0 ? Math.max(0, weights[d.key]) / weightSum : 1 / available.length;
      score += d.score * d.weight;
    }
  }
  return {
    score: Math.max(0, Math.min(1, score)),
    availableDimensionCount: available.length,
    dimensions,
  };
}

export interface RankableStyle {
  targetId: string;
  score: number;
  vote?: VoteKind | null;
}

/**
 * 应用显式反馈：赞 +0.12，踩 −0.40，夹到 [0,1]。
 * 反馈只改变排序位移，不改变各维度原始分 —— 所以"重置"只需删掉反馈。
 */
export function applyFeedback(score: number, vote: VoteKind | null | undefined): number {
  if (vote === 'up') return Math.max(0, Math.min(1, score + FEEDBACK_UP_BOOST));
  if (vote === 'down') return Math.max(0, Math.min(1, score - FEEDBACK_DOWN_PENALTY));
  return score;
}

/**
 * 确定性排序：反馈后分数 ↓ → 基础分 ↓ → 目标 id 字典序 ↑。
 * 没有任何时间/随机成分，同一批卡无论查询多少次、调用顺序如何，结果顺序都一致。
 */
export function rankStyleCandidates<T extends RankableStyle>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const af = applyFeedback(a.score, a.vote);
    const bf = applyFeedback(b.score, b.vote);
    if (bf !== af) return bf - af;
    if (b.score !== a.score) return b.score - a.score;
    return a.targetId < b.targetId ? -1 : a.targetId > b.targetId ? 1 : 0;
  });
}
