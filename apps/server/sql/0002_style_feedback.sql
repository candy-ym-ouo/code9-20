-- 风格相似推荐 · 显式反馈（文档：反馈影响排序且可重置）
-- 反馈只改变排序位移（赞 +0.12 / 踩 -0.40），不改四维原始分；
-- 因此"重置"就是简单的 DELETE，立刻回到纯风格排序。
CREATE TABLE IF NOT EXISTS style_feedback (
  id             TEXT PRIMARY KEY,
  library_id     TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  source_id      TEXT NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
  target_id      TEXT NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
  vote           TEXT NOT NULL CHECK (vote IN ('up','down')),
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (library_id, user_id, source_id, target_id)
);
-- 推荐主查询的反馈回填走 (source_id, user_id) 维度
CREATE INDEX IF NOT EXISTS idx_style_feedback_source ON style_feedback(library_id, user_id, source_id);
