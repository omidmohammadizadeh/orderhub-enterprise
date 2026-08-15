-- Nested modifier groups.
--
-- Until now the catalog was strictly product → group → modifier. Deliveroo
-- nests one level deeper: an option ("Make It a Meal +£3.99") owns its own
-- modifier groups ("Choose Side", "Choose Drink"), and an option inside those
-- ("Fries") can own another ("Dip"). Those groups and their options were
-- already being imported — as orphans attached to no product. This table adds
-- the edges that were missing.
--
-- Purely additive: no existing row changes, and a flat menu simply has no
-- rows here.
CREATE TABLE "modifier_option_nested_groups" (
    "optionId"  TEXT NOT NULL,
    "groupId"   TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "modifier_option_nested_groups_pkey" PRIMARY KEY ("optionId","groupId")
);

CREATE INDEX "modifier_option_nested_groups_optionId_idx" ON "modifier_option_nested_groups"("optionId");
CREATE INDEX "modifier_option_nested_groups_groupId_idx" ON "modifier_option_nested_groups"("groupId");

-- Cascade both ways: deleting an option drops the groups it opened, and
-- deleting a group drops the links pointing at it. Neither leaves a picker
-- rendering a group that no longer exists.
ALTER TABLE "modifier_option_nested_groups"
    ADD CONSTRAINT "modifier_option_nested_groups_optionId_fkey"
    FOREIGN KEY ("optionId") REFERENCES "modifier_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "modifier_option_nested_groups"
    ADD CONSTRAINT "modifier_option_nested_groups_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "modifier_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
