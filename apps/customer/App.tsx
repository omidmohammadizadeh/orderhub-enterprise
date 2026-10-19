import { Ionicons } from "@expo/vector-icons";
import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import * as Notifications from "expo-notifications";
import { StatusBar } from "expo-status-bar";
import { useEffect, useRef, useState } from "react";
import { AppState } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadAuth } from "./src/auth";
import { brand } from "./src/brand";
import { flushPendingNavigation, navigationRef, openPushTarget, type RootParams, type TabParams } from "./src/navigation";
import { registerOnLaunch } from "./src/push";
import { HomeScreen } from "./src/screens/HomeScreen";
import { MyOrdersScreen } from "./src/screens/MyOrdersScreen";
import { OrderScreen } from "./src/screens/OrderScreen";
import { OrderStatusScreen } from "./src/screens/OrderStatusScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { colors } from "./src/theme";

const Tab = createBottomTabNavigator<TabParams>();
const Stack = createNativeStackNavigator<RootParams>();

const theme = {
  ...DefaultTheme,
  colors: { ...DefaultTheme.colors, primary: colors.primary, background: colors.background, card: colors.card },
};

const TAB_ICONS: Record<keyof TabParams, keyof typeof Ionicons.glyphMap> = {
  Home: "home",
  Order: "restaurant",
  Orders: "receipt",
  Settings: "settings",
};

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        tabBarActiveTintColor: colors.primary,
        tabBarInactiveTintColor: colors.muted,
        tabBarIcon: ({ color, size, focused }) => (
          <Ionicons name={focused ? TAB_ICONS[route.name] : (`${TAB_ICONS[route.name]}-outline` as never)} size={size} color={color} />
        ),
      })}
    >
      <Tab.Screen name="Home" component={HomeScreen} options={{ headerShown: false }} />
      <Tab.Screen name="Order" component={OrderScreen} options={{ headerShown: false, title: "Menu" }} />
      <Tab.Screen name="Orders" component={MyOrdersScreen} options={{ title: "My orders" }} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

/** Tapping a notification — including the one that launched the app — opens
 *  its data.url: an order page in the native tracker, anything else in the
 *  storefront tab. */
function useNotificationTaps() {
  const last = Notifications.useLastNotificationResponse();
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!last || last.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const id = last.notification.request.identifier;
    if (seen.current === id) return;
    seen.current = id;
    openPushTarget(last.notification.request.content.data?.url);
    Notifications.clearLastNotificationResponseAsync().catch(() => {});
  }, [last]);
}

/** Opening the app is reading the news: whatever is still sitting in the
 *  notification shade (order updates the customer never tapped) is cleared,
 *  along with the icon badge, on launch and every time it comes back to the
 *  foreground. */
function useClearNotificationsOnOpen() {
  useEffect(() => {
    const clear = () => {
      Notifications.dismissAllNotificationsAsync().catch(() => {});
      Notifications.setBadgeCountAsync(0).catch(() => {});
    };
    clear();
    const sub = AppState.addEventListener("change", (state) => {
      if (state === "active") clear();
    });
    return () => sub.remove();
  }, []);
}

export default function App() {
  useNotificationTaps();
  useClearNotificationsOnOpen();

  useEffect(() => {
    registerOnLaunch();
  }, []);

  // The saved session first, so the storefront WebView starts signed in.
  const [authLoaded, setAuthLoaded] = useState(false);
  useEffect(() => {
    loadAuth().finally(() => setAuthLoaded(true));
  }, []);
  if (!authLoaded) return null;

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <NavigationContainer ref={navigationRef} theme={theme} onReady={flushPendingNavigation}>
        <Stack.Navigator screenOptions={{ headerTintColor: colors.primary, headerBackTitle: "Back" }}>
          <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false, title: brand.name }} />
          <Stack.Screen name="OrderStatus" component={OrderStatusScreen} options={{ title: "Your order" }} />
        </Stack.Navigator>
      </NavigationContainer>
    </SafeAreaProvider>
  );
}
