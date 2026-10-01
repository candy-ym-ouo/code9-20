import { Router } from 'express';
import { similarFeedbackSchema } from '@flil/shared';
import { ah, ok } from '../http/respond.js';
import { authenticate } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import {
  clearSimilarFeedback,
  computeSimilar,
  resetSimilarFeedback,
  setSimilarFeedback,
} from '../services/similar.js';

/**
 * 风格相似推荐（文档 15.4）：
 * 四维（色板/标签/光位/机位）可解释打分；反馈影响排序且可重置；重复查询顺序一致。
 */
export const similarRouter = Router();
similarRouter.use(authenticate());

/** 与某张灵感卡风格相似的推荐列表（含逐维度理由与反馈调整量） */
similarRouter.get(
  '/inspirations/:id/similar',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const limit = Math.max(1, Math.min(50, Number(req.query.limit ?? 12) || 12));
    ok(res, computeSimilar(ctx.libraryId, ctx, req.params.id, limit));
  }),
);

/** 反馈：点赞更靠前 / 点踩压下去（同一对只保留最新信号） */
similarRouter.post(
  '/inspirations/:id/similar/feedback',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const input = similarFeedbackSchema.parse(req.body);
    ok(res, setSimilarFeedback(ctx.libraryId, req.params.id, input.targetId, input.signal));
  }),
);

/** 撤销对某张候选的反馈 */
similarRouter.delete(
  '/inspirations/:id/similar/feedback/:targetId',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, clearSimilarFeedback(ctx.libraryId, req.params.id, req.params.targetId));
  }),
);

/** 重置：清空这张种子卡的全部反馈，排序回到纯基础分 */
similarRouter.post(
  '/inspirations/:id/similar/feedback/reset',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    ok(res, resetSimilarFeedback(ctx.libraryId, req.params.id));
  }),
);
