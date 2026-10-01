-- 风格相似推荐反馈（文档 15.4）：点赞/点踩影响排序，可整体重置
CREATE TABLE IF NOT EXISTS similar_feedback (
  id                    TEXT PRIMARY KEY,
  library_id            TEXT NOT NULL REFERENCES library(id) ON DELETE CASCADE,
  seed_inspiration_id   TEXT NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
  target_inspiration_id TEXT NOT NULL REFERENCES inspiration(id) ON DELETE CASCADE,
  signal                TEXT NOT NULL CHECK (signal IN ('up','down')),
  created_at            TEXT NOT NULL,
  updated_at            TEXT NOT NULL,
  -- 同一对（种子, 候选）只保留最新一次反馈，重复提交幂等
  UNIQUE (seed_inspiration_id, target_inspiration_id)
);
CREATE INDEX IF NOT EXISTS idx_similar_feedback_seed ON similar_feedback(seed_inspiration_id);
