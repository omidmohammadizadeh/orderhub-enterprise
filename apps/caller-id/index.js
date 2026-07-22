import { AppRegistry } from "react-native";
import { registerRootComponent } from "expo";
import App from "./App";
import { headlessNotificationTask } from "./src/detectors";

// react-native-android-notification-listener dispatches incoming notifications
// to a headless JS task registered under this exact name. It runs even when the
// app UI is closed, so VoIP-call notifications are caught in the background.
AppRegistry.registerHeadlessTask(
  "RNAndroidNotificationListenerHeadlessJs",
  () => headlessNotificationTask,
);

registerRootComponent(App);
