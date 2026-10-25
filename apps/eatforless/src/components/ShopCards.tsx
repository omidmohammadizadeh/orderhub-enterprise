// Shop cards in the Home artboard's four shapes: the compact featured card,
// the "Order again" card, the wide deal card and the full-width list card.

import { memo } from "react";
import { StyleSheet, View } from "react-native";
import type { Shop } from "@/api/types";
import { foodKind } from "@/lib/menu";
import { money } from "@/lib/money";
import { useFavourites, useIsFavourite } from "@/state/favourites";
import { C, F } from "@/theme";
import { DealBadge } from "./Bits";
import { Icon } from "./Icon";
import { Photo } from "./Photo";
import { PressScale } from "./PressScale";
import { T } from "./T";

export function feeText(shop: Shop, short = false): string {
  if (!shop.delivery.available) return shop.collection.available ? "Collection only" : "Not delivering here";
  const fee = shop.delivery.fee ?? 0;
  if (fee === 0) return short ? "Free" : "Free delivery";
  return short ? money(fee) : `${money(fee)} delivery`;
}

/** The delivery window the API gives for this address (shop prep + driving),
 *  else how soon collection is ready, else nothing. */
export function etaText(shop: Shop): string {
  const eta = shop.delivery.available ? shop.delivery.etaMinutes : null;
  if (eta) return `${eta.min}–${eta.max} min`;
  if (shop.collection.available && shop.collection.readyInMinutes) return `Ready in ${shop.collection.readyInMinutes} min`;
  return "";
}

/** Lower bound of the delivery window, for sorting and the "Under 30 min" filter. */
export function etaMin(shop: Shop): number | null {
  return shop.delivery.available ? shop.delivery.etaMinutes?.min ?? null : null;
}

/** "a · b", skipping empty parts. */
export const joinDot = (...parts: Array<string | null | undefined | false>) => parts.filter(Boolean).join(" · ");

export const kindOf = (shop: Shop) => foodKind(...shop.cuisines, shop.name);

// Ratings come from the API (null until a shop has reviews); offers aren't in
// it yet (README → API gaps). Cards show each only when present.
const dealOf = (shop: Shop): string | null => shop.deal ?? null;
const ratingOf = (shop: Shop): string | null =>
  shop.rating ? `${shop.rating.value.toFixed(1)} ★` : null;

type CardProps = { shop: Shop; onPress: (shop: Shop) => void; sponsored?: boolean };

export const FeaturedCard = memo(function FeaturedCard({ shop, onPress }: CardProps) {
  const deal = dealOf(shop);
  return (
    <PressScale onPress={() => onPress(shop)} accessibilityLabel={shop.name} style={styles.featured}>
      <View>
        <Photo uri={shop.heroImageUrl} kind={kindOf(shop)} style={{ height: 112 }} />
        {deal ? <DealBadge text={deal} style={styles.badgeAt} /> : null}
        {!shop.isOpen ? <ClosedVeil /> : null}
      </View>
      <View style={styles.featuredBody}>
        <T v="item" style={{ fontSize: 15 }} numberOfLines={1}>{shop.name}</T>
        <T v="small" style={styles.meta}>{feeText(shop)}</T>
        <T v="small" style={styles.meta}>
          {ratingOf(shop) ? <T style={styles.rating}>{ratingOf(shop)} · </T> : null}
          {etaText(shop)}
        </T>
      </View>
    </PressScale>
  );
});

export const AgainCard = memo(function AgainCard({ shop, onPress }: CardProps) {
  return (
    <PressScale onPress={() => onPress(shop)} accessibilityLabel={`Order again from ${shop.name}`} style={styles.again}>
      <Photo uri={shop.heroImageUrl} kind={kindOf(shop)} style={{ height: 108 }} />
      <View style={styles.featuredBody}>
        <T v="item" style={{ fontSize: 15 }} numberOfLines={1}>{shop.name}</T>
        <T v="small" style={styles.meta}>{joinDot(feeText(shop), etaText(shop))}</T>
      </View>
    </PressScale>
  );
});

export const DealCard = memo(function DealCard({ shop, onPress }: CardProps) {
  const deal = dealOf(shop);
  return (
    <PressScale onPress={() => onPress(shop)} accessibilityLabel={shop.name} style={{ width: 270, gap: 8 }}>
      <View>
        <Photo uri={shop.heroImageUrl} kind={kindOf(shop)} radius={16} style={{ height: 150 }} />
        {deal ? <DealBadge text={deal} style={[styles.badgeAt, { top: 10, left: 10 }]} /> : null}
      </View>
      <View style={{ gap: 2 }}>
        <T v="item" style={{ fontSize: 15 }}>{shop.name}</T>
        <T v="small" style={styles.meta}>
          {joinDot(feeText(shop, true), etaText(shop))}
          {ratingOf(shop) ? <T style={styles.rating}> · {ratingOf(shop)}</T> : null}
        </T>
      </View>
    </PressScale>
  );
});

export const ListCard = memo(function ListCard({ shop, onPress, sponsored }: CardProps) {
  const deal = dealOf(shop);
  return (
    <PressScale onPress={() => onPress(shop)} accessibilityLabel={shop.name} style={{ gap: 10 }} scaleTo={0.98}>
      <View>
        <Photo uri={shop.heroImageUrl} kind={kindOf(shop)} radius={18} style={{ height: 176 }} />
        {deal ? <DealBadge text={deal} style={[styles.badgeAt, { top: 12, left: 12 }]} /> : null}
        {sponsored ? (
          <View style={styles.sponsored}>
            <T style={styles.sponsoredText}>Sponsored</T>
          </View>
        ) : null}
        {!shop.isOpen ? <ClosedVeil radius={18} /> : null}
      </View>
      <View style={styles.listRow}>
        <View style={{ flex: 1, gap: 3 }}>
          <T v="item">{shop.name}{shop.area ? ` · ${shop.area}` : ""}</T>
          <T v="sub">{joinDot(feeText(shop), etaText(shop))}</T>
          <T v="sub">
            {ratingOf(shop) ? <T style={[styles.rating, { fontSize: 13 }]}>{ratingOf(shop)} ({shop.rating!.count}+) · </T> : null}
            {shop.distanceMiles.toFixed(1)} mi{shop.cuisines.length ? ` · ${shop.cuisines.slice(0, 3).join(", ")}` : ""}
          </T>
        </View>
        <FavHeart id={shop.id} name={shop.name} />
      </View>
    </PressScale>
  );
});

function FavHeart({ id, name }: { id: string; name: string }) {
  const on = useIsFavourite(id);
  const toggle = useFavourites((s) => s.toggle);
  return (
    <PressScale onPress={() => toggle(id)} haptic scaleTo={0.85} accessibilityLabel={on ? `Remove ${name} from saved shops` : `Save ${name}`}>
      <Icon name="heart" size={22} fill={on ? C.ink : "none"} />
    </PressScale>
  );
}

function ClosedVeil({ radius = 0 }: { radius?: number }) {
  return (
    <View style={[StyleSheet.absoluteFill, styles.veil, { borderRadius: radius }]}>
      <T style={styles.veilText}>Closed for now</T>
    </View>
  );
}

const styles = StyleSheet.create({
  featured: { width: 196, borderWidth: 1, borderColor: C.border, borderRadius: 16, overflow: "hidden", backgroundColor: C.white },
  featuredBody: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, gap: 3 },
  again: { width: 220, borderWidth: 1, borderColor: C.border, borderRadius: 16, overflow: "hidden", backgroundColor: C.white },
  meta: { fontFamily: F.regular, fontSize: 12, color: C.grey600 },
  rating: { fontFamily: F.bold, fontSize: 12, color: C.ink },
  badgeAt: { position: "absolute", top: 8, left: 8 },
  sponsored: {
    position: "absolute",
    right: 10,
    bottom: 10,
    backgroundColor: "rgba(11,11,11,0.72)",
    paddingHorizontal: 8,
    paddingVertical: 5,
    borderRadius: 8,
  },
  sponsoredText: { fontFamily: F.bold, fontSize: 11, color: C.white },
  listRow: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  veil: { backgroundColor: "rgba(11,11,11,0.45)", alignItems: "center", justifyContent: "center" },
  veilText: { fontFamily: F.bold, fontSize: 14, color: C.white },
});
