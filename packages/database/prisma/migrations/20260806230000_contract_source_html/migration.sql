-- The template wording before substitution, so an amendment can re-render the
-- body with new figures. Without it the rendered body has "£49.00" where the
-- placeholder was and there is nothing left to substitute into.
--
-- Nullable: contracts created before this column existed have no source, and
-- amending one leaves its body untouched rather than guessing.
ALTER TABLE "contracts" ADD COLUMN IF NOT EXISTS "sourceHtml" TEXT;
