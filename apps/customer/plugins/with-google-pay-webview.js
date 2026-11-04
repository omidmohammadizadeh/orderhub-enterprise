// Google Pay inside an Android WebView (Mollie / Stripe hosted checkout in
// PaymentSheet). Google's recipe needs three things; react-native-webview's
// `paymentRequestEnabled` prop does the WebSettings part (androidx.webkit
// 1.14.0 ships with it), and this plugin adds the other: the PAY intents in
// <queries>, without which Android 11+ hides Google Play services' payment
// handler from the WebView and the button falls back to a sign-in page.
// https://developers.google.com/pay/api/android/guides/recipes/using-android-webview
const { withAndroidManifest } = require("expo/config-plugins");

const ACTIONS = [
  "org.chromium.intent.action.PAY",
  "org.chromium.intent.action.IS_READY_TO_PAY",
  "org.chromium.intent.action.UPDATE_PAYMENT_DETAILS",
];

module.exports = function withGooglePayWebView(config) {
  return withAndroidManifest(config, (cfg) => {
    const manifest = cfg.modResults.manifest;
    manifest.queries = manifest.queries ?? [{}];
    const q = manifest.queries[0];
    q.intent = q.intent ?? [];
    for (const name of ACTIONS) {
      const present = q.intent.some((i) => (i.action ?? []).some((a) => a.$?.["android:name"] === name));
      if (!present) q.intent.push({ action: [{ $: { "android:name": name } }] });
    }
    return cfg;
  });
};
