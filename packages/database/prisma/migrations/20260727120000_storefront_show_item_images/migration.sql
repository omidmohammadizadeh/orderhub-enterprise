-- Storefront: per-brand toggle to show/hide item photos on the public
-- online-ordering menu. Defaults to true so existing storefronts are unchanged.
ALTER TABLE "direct_ordering_configs"
  ADD COLUMN "showItemImages" BOOLEAN NOT NULL DEFAULT true;
