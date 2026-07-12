-- AI Studio now generates images too, reusing the same credit pipeline.
-- Tag each generation VIDEO (existing rows) or IMAGE. Plain text column,
-- default VIDEO so every existing row keeps its meaning.
ALTER TABLE "video_generations"
  ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'VIDEO';
