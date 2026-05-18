/**
 * Canonical branding constants for the Order Hub product family.
 *
 * Customer-facing names always use these constants — never hardcode
 * product names in UI or email templates.
 *
 * Technical namespaces (@orderhub/*) are intentionally kept separate
 * and do NOT change with marketing rebrands.
 */
export declare const BRAND: {
    /** Top-level company / platform name */
    readonly company: "Order Hub Solutions";
    /** Short name used in tight UI spaces (nav, browser tabs, toasts) */
    readonly short: "Order Hub";
    /** Used in email From: headers */
    readonly emailFrom: "Order Hub Solutions <noreply@orderhub.io>";
    /** Support URL */
    readonly supportUrl: "https://help.orderhub.io";
    /** Marketing site */
    readonly marketingUrl: "https://orderhub.io";
};
/**
 * Individual product names within the Order Hub family.
 * Each product can be deployed independently or as part of the suite.
 */
export declare const PRODUCTS: {
    /** Core multi-tenant dashboard — orders, menu, integrations, analytics */
    readonly solutions: {
        readonly name: "Order Hub Solutions";
        readonly short: "Solutions";
        readonly slug: "solutions";
    };
    /** Platform administration — tenants, billing, system health */
    readonly admin: {
        readonly name: "Order Hub Admin";
        readonly short: "Admin";
        readonly slug: "admin";
    };
    /** Driver dispatch and delivery tracking */
    readonly dispatch: {
        readonly name: "Order Hub Dispatch";
        readonly short: "Dispatch";
        readonly slug: "dispatch";
    };
    /** Kitchen display system */
    readonly kds: {
        readonly name: "Order Hub KDS";
        readonly short: "KDS";
        readonly slug: "kds";
    };
    /** Point-of-sale terminal */
    readonly pos: {
        readonly name: "Order Hub POS";
        readonly short: "POS";
        readonly slug: "pos";
    };
    /** Driver mobile app */
    readonly driver: {
        readonly name: "Order Hub Driver";
        readonly short: "Driver";
        readonly slug: "driver";
    };
};
export type ProductSlug = keyof typeof PRODUCTS;
//# sourceMappingURL=branding.d.ts.map