"use strict";
/**
 * Canonical branding constants for the Order Hub product family.
 *
 * Customer-facing names always use these constants — never hardcode
 * product names in UI or email templates.
 *
 * Technical namespaces (@orderhub/*) are intentionally kept separate
 * and do NOT change with marketing rebrands.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PRODUCTS = exports.BRAND = void 0;
exports.BRAND = {
    /** Top-level company / platform name */
    company: "Order Hub Solutions",
    /** Short name used in tight UI spaces (nav, browser tabs, toasts) */
    short: "Order Hub",
    /** Used in email From: headers */
    emailFrom: "Order Hub Solutions <noreply@orderhub.io>",
    /** Support URL */
    supportUrl: "https://help.orderhub.io",
    /** Marketing site */
    marketingUrl: "https://orderhub.io",
};
/**
 * Individual product names within the Order Hub family.
 * Each product can be deployed independently or as part of the suite.
 */
exports.PRODUCTS = {
    /** Core multi-tenant dashboard — orders, menu, integrations, analytics */
    solutions: {
        name: "Order Hub Solutions",
        short: "Solutions",
        slug: "solutions",
    },
    /** Platform administration — tenants, billing, system health */
    admin: {
        name: "Order Hub Admin",
        short: "Admin",
        slug: "admin",
    },
    /** Driver dispatch and delivery tracking */
    dispatch: {
        name: "Order Hub Dispatch",
        short: "Dispatch",
        slug: "dispatch",
    },
    /** Kitchen display system */
    kds: {
        name: "Order Hub KDS",
        short: "KDS",
        slug: "kds",
    },
    /** Point-of-sale terminal */
    pos: {
        name: "Order Hub POS",
        short: "POS",
        slug: "pos",
    },
    /** Driver mobile app */
    driver: {
        name: "Order Hub Driver",
        short: "Driver",
        slug: "driver",
    },
};
//# sourceMappingURL=branding.js.map