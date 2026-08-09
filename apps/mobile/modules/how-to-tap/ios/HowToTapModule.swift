// Wraps Apple's ProximityReaderDiscovery "How to Tap" merchant-education
// overlay. Apple's App Review requirement for Tap to Pay on iPhone (and
// Stripe's own integration guide) says this exact overlay MUST be shown
// before submitting the app for review — it isn't something the Stripe
// Terminal SDK provides itself, since ProximityReaderDiscovery is a raw
// Apple system framework the SDK merely links, not wraps.
//
// iOS 18.0+ only (the API doesn't exist before that). Below iOS 18, `show`
// resolves with `shown: false` so the caller can present its own fallback —
// see PosWebView.tsx / terminal.ts for the JS side.

import ExpoModulesCore
import ProximityReader
import UIKit

public class HowToTapModule: Module {
  public func definition() -> ModuleDefinition {
    Name("HowToTap")

    AsyncFunction("isAvailable") { () -> Bool in
      if #available(iOS 18.0, *) {
        return true
      }
      return false
    }

    AsyncFunction("show") { () -> Bool in
      guard #available(iOS 18.0, *) else {
        return false
      }
      guard let rootVC = await MainActor.run(body: { UIApplication.shared.ohTopMostViewController() }) else {
        throw HowToTapError.noViewController
      }
      let discovery = ProximityReaderDiscovery()
      let content = try await discovery.content(for: .payment(.howToTap))
      try await discovery.presentContent(content, from: rootVC)
      return true
    }
  }
}

enum HowToTapError: Error, LocalizedError {
  case noViewController

  var errorDescription: String? {
    "Could not find a screen to present How to Tap from."
  }
}

private extension UIApplication {
  func ohTopMostViewController() -> UIViewController? {
    guard
      let root = connectedScenes
        .compactMap({ $0 as? UIWindowScene })
        .flatMap({ $0.windows })
        .first(where: { $0.isKeyWindow })?.rootViewController
    else {
      return nil
    }
    var top = root
    while let presented = top.presentedViewController {
      top = presented
    }
    return top
  }
}
