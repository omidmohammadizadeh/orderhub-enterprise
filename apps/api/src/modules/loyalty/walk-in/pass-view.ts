// Everything a wallet pass (Apple or Google) shows, worked out once by
// WalkInLoyaltyService so the two passes and the card page cannot disagree.

export interface PassView {
  memberId: string;
  cardId: string;
  code: string;
  publicToken: string;
  firstName: string | null;

  /** Shop name at the top of the pass. */
  title: string;
  /** #RRGGBB */
  color: string;
  /** STAMP_ICONS key (coffee, pizza, scissors…). */
  stampIcon: string | null;
  /** The shop's logo, if it has one we can fetch. */
  logoUrl: string | null;

  /** Stamps on the CURRENT card. */
  stamps: number;
  stampsRequired: number;
  /** Earned and still claimable. */
  rewardsReady: number;
  rewardLabel: string;
  /** "Every order over £5 earns a stamp. Collect 6 for a free coffee." */
  earnRule: string;
  expiryNote: string | null;

  /** The customer's card page (web). */
  cardUrl: string;
  /** Public image URLs, for Google (Apple bundles the pictures). */
  stripUrl: string;
  iconUrl: string;

  updatedAt: Date;
}
