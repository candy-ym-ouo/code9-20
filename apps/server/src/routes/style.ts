import { Router } from 'express';
import { styleRecommendQuerySchema, styleVoteSchema } from '@flil/shared';
import { ah, ok } from '../http/respond.js';
import { authenticate, currentUser } from '../http/middleware.js';
import { ctxOf } from '../http/context.js';
import {
  listStyleFeedback,
  recordStyleFeedback,
  resetStyleFeedback,
  styleRecommendations,
} from '../services/styleRecommend.js';

/**
 * 风格相似推荐（色板 + 标签 + 光位 + 机位，结果逐项可解释）。
 * 反馈是每用户独立的：赞/踩只影响本人看到的排序，重置即删除反馈行。
 */
export const styleRouter = Router();
styleRouter.use(authenticate());

styleRouter.get(
  '/inspirations/:id/similar',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const user = currentUser(req);
    const query = styleRecommendQuerySchema.parse(req.query);
    const result = styleRecommendations(ctx.libraryId, user.id, ctx, req.params.id, {
      size: query.size,
      minScore: query.minScore,
    });
    ok(res, result);
  }),
);

styleRouter.post(
  '/inspirations/:id/similar/feedback',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const user = currentUser(req);
    const input = styleVoteSchema.parse(req.body);
    const result = recordStyleFeedback({
      libraryId: ctx.libraryId,
      userId: user.id,
      sourceId: req.params.id,
      targetId: input.targetId,
      vote: input.vote,
    });
    ok(res, result, 201);
  }),
);

styleRouter.get(
  '/inspirations/:id/similar/feedback',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const user = currentUser(req);
    ok(res, { items: listStyleFeedback(ctx.libraryId, user.id, req.params.id) });
  }),
);

/** 只重置这张源卡的反馈（排序立刻回到纯风格分） */
styleRouter.post(
  '/inspirations/:id/similar/reset',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const user = currentUser(req);
    ok(res, { scope: 'source', ...resetStyleFeedback(ctx.libraryId, user.id, req.params.id) });
  }),
);

/** 重置当前用户在本库的全部风格反馈 */
styleRouter.post(
  '/style-feedback/reset',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const user = currentUser(req);
    ok(res, { scope: 'library', ...resetStyleFeedback(ctx.libraryId, user.id) });
  }),
);

styleRouter.get(
  '/style-feedback',
  ah(async (req, res) => {
    const ctx = ctxOf(req);
    const user = currentUser(req);
    ok(res, { items: listStyleFeedback(ctx.libraryId, user.id) });
  }),
);
