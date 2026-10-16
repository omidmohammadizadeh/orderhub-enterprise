// How the native shell learns that the embedded storefront placed or opened
// an order, without the storefront knowing it is inside an app.
//
// URLs alone don't cover it: a cash order confirms in place without the URL
// changing at all. So the injected script also watches the storefront's own
// POST …/checkout response, which carries the new order id on every payment
// path, and reports client-side navigations (pushState) that a WebView
// doesn't always surface as navigation events.

export type BridgeMessage =
  | { type: "url"; url: string }
  | { type: "checkout"; orderId: string; checkoutUrl: string | null; pendingPayment: boolean; url: string };

export const INJECTED_JS = `(function () {
  if (window.__orderhubApp) return;
  window.__orderhubApp = true;
  function send(m) {
    if (window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify(m));
  }
  function reportUrl() { addCss(); send({ type: "url", url: location.href }); }
  ["pushState", "replaceState"].forEach(function (k) {
    var orig = history[k];
    history[k] = function () { var r = orig.apply(this, arguments); reportUrl(); return r; };
  });
  window.addEventListener("popstate", reportUrl);

  // The app's own tab bar replaces the storefront's phone tab bar (and the
  // spacer that reserves room for it); two stacked tab bars is the first
  // thing App Review would flag as "a website in a wrapper".
  // Re-added after hydration too, in case React drops a node it didn't render.
  function addCss() {
    if (document.getElementById("orderhub-app-css")) return;
    var css = document.createElement("style");
    css.id = "orderhub-app-css";
    css.textContent =
      'nav[aria-label="Storefront"]{display:none!important}' +
      'div[aria-hidden="true"]:has(+ nav[aria-label="Storefront"]){display:none!important}';
    (document.head || document.documentElement).appendChild(css);
  }
  addCss();
  document.addEventListener("DOMContentLoaded", addCss);
  window.addEventListener("load", addCss);

  function isCheckout(u) { return /\\/v1\\/[^?#]*\\/checkout(\\?|#|$)/.test(String(u || "")); }
  function onBody(text) {
    try {
      var o = JSON.parse(text);
      var order = o && o.order && o.order.id ? o.order : o;
      if (order && order.id) send({
        type: "checkout",
        orderId: String(order.id),
        checkoutUrl: order.checkoutUrl || null,
        pendingPayment: !!order.clientSecret,
        url: location.href
      });
    } catch (e) {}
  }

  var X = XMLHttpRequest.prototype, xOpen = X.open, xSend = X.send;
  X.open = function (method, url) {
    this.__ohCheckout = String(method).toUpperCase() === "POST" && isCheckout(url);
    return xOpen.apply(this, arguments);
  };
  X.send = function () {
    if (this.__ohCheckout) this.addEventListener("load", function () {
      if (this.status >= 200 && this.status < 300) onBody(this.responseText);
    });
    return xSend.apply(this, arguments);
  };
  if (window.fetch) {
    var f = window.fetch;
    window.fetch = function (input, init) {
      var u = typeof input === "string" ? input : (input && input.url) || "";
      var m = (init && init.method) || (input && input.method) || "GET";
      var p = f.apply(this, arguments);
      if (String(m).toUpperCase() === "POST" && isCheckout(u)) {
        p.then(function (r) { if (r.ok) r.clone().text().then(onBody); }).catch(function () {});
      }
      return p;
    };
  }
  reportUrl();
})();
true;`;

export type OrderLink = { slug: string; orderId: string };

function query(url: string, key: string): string | null {
  const m = url.match(new RegExp(`[?&]${key}=([^&#]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** An order the URL points at, on any of the storefront's three shapes:
 *  /order/<slug>/status/<id>, /order/<slug>/confirmation?orderId=<id>
 *  (back from Stripe) and /order/<slug>?confirmedOrderId=<id>. */
export function orderFromUrl(url: string): OrderLink | null {
  const path = url.replace(/^https?:\/\/[^/]+/, "");
  const status = path.match(/^\/order\/([^/?#]+)\/status\/([^/?#]+)/);
  if (status) return { slug: status[1], orderId: status[2] };
  const confirmation = path.match(/^\/order\/([^/?#]+)\/confirmation/);
  if (confirmation) {
    const id = query(path, "orderId");
    return id ? { slug: confirmation[1], orderId: id } : null;
  }
  const home = path.match(/^\/order\/([^/?#]+)\/?(?:[?#]|$)/);
  if (home) {
    const id = query(path, "confirmedOrderId");
    return id ? { slug: home[1], orderId: id } : null;
  }
  return null;
}

export function slugFromUrl(url: string): string | null {
  return url.replace(/^https?:\/\/[^/]+/, "").match(/^\/order\/([^/?#]+)/)?.[1] ?? null;
}
