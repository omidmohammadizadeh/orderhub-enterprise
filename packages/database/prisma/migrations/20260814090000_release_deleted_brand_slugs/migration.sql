-- Release storefront links held by already-deleted brands.
--
-- onlineOrderingSlug is globally unique across every row, deleted or not, so a
-- soft-deleted brand kept its public link forever. Recreating the same brand —
-- the commonest reason to delete one — then failed on the unique index, or at
-- best produced a "-2" suffixed URL.
--
-- Deleting a brand now clears the slug; this frees the ones deleted before
-- that change. Only rows already soft-deleted are touched, so no live
-- storefront is affected.
UPDATE "brands"
SET "onlineOrderingSlug" = NULL,
    "directOrderingEnabled" = false
WHERE "deletedAt" IS NOT NULL
  AND "onlineOrderingSlug" IS NOT NULL;
