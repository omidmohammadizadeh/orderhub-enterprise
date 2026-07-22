import { AppRegistry } from "react-native";
import { registerRootComponent } from "expo";
import ReactNativeForegroundService from "@supersami/rn-foreground-service";
import App from "./App";
import { headlessNotificationTask } from "./src/detectors";

// Register the foreground-service task runner. The service (a persistent
// notification) keeps the app process alive so the SIM phone-state listener
// keeps catching calls when the app is closed / in the background.
ReactNativeForegroundService.register();

// react-native-android-notification-listener dispatches incoming notifications
// to a headless JS task registered under this exact name. It runs even when the
// app UI is closed, so VoIP-call notifications are caught in the background.
AppRegistry.registerHeadlessTask(
  "RNAndroidNotificationListenerHeadlessJs",
  () => headlessNotificationTask,
);

registerRootComponent(App);
