import { createBottomTabNavigator } from "@react-navigation/bottom-tabs";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { FloatingBar } from "@/components/FloatingBar";
import { useSession } from "@/auth/session";
import { AccountScreen } from "@/screens/AccountScreen";
import { AddressScreen } from "@/screens/AddressScreen";
import { CallScreen } from "@/screens/CallScreen";
import { MessagesScreen } from "@/screens/MessagesScreen";
import { CheckoutScreen } from "@/screens/CheckoutScreen";
import { EmailAuthScreen } from "@/screens/EmailAuthScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { ItemSheet } from "@/screens/ItemSheet";
import { OrdersScreen } from "@/screens/OrdersScreen";
import { PhoneScreen } from "@/screens/PhoneScreen";
import { SearchScreen } from "@/screens/SearchScreen";
import { ShopScreen } from "@/screens/ShopScreen";
import { TrackingScreen } from "@/screens/TrackingScreen";
import { WelcomeScreen } from "@/screens/WelcomeScreen";
import { C } from "@/theme";
import type { RootStackParamList, TabParamList } from "./types";

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tabs = createBottomTabNavigator<TabParamList>();

function TabsNavigator() {
  return (
    <Tabs.Navigator
      tabBar={(props) => <FloatingBar {...props} />}
      screenOptions={{ headerShown: false, animation: "fade", sceneStyle: { backgroundColor: C.white } }}
    >
      <Tabs.Screen name="Home" component={HomeScreen} />
      <Tabs.Screen name="Orders" component={OrdersScreen} />
      <Tabs.Screen name="Account" component={AccountScreen} />
    </Tabs.Navigator>
  );
}

export function RootNavigator() {
  const onboarded = useSession((s) => s.onboarded);
  return (
    <Stack.Navigator
      initialRouteName={onboarded ? "Tabs" : "Welcome"}
      screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.white } }}
    >
      <Stack.Screen name="Tabs" component={TabsNavigator} options={{ animation: "fade" }} />
      <Stack.Screen name="Welcome" component={WelcomeScreen} options={{ animation: "fade", gestureEnabled: false }} />
      <Stack.Screen name="EmailAuth" component={EmailAuthScreen} />
      <Stack.Screen name="Phone" component={PhoneScreen} options={{ presentation: "fullScreenModal", animation: "slide_from_bottom" }} />
      <Stack.Screen name="Search" component={SearchScreen} options={{ animation: "fade" }} />
      <Stack.Screen name="Shop" component={ShopScreen} />
      <Stack.Screen
        name="Item"
        component={ItemSheet}
        // The sheet draws its own scrim and spring, so the route itself is
        // a transparent overlay with no system animation.
        options={{ presentation: "transparentModal", animation: "none", contentStyle: { backgroundColor: "transparent" } }}
      />
      <Stack.Screen name="Checkout" component={CheckoutScreen} />
      <Stack.Screen name="Address" component={AddressScreen} options={{ presentation: "modal" }} />
      <Stack.Screen name="Tracking" component={TrackingScreen} options={{ animation: "slide_from_bottom", gestureEnabled: false }} />
      <Stack.Screen name="Call" component={CallScreen} options={{ presentation: "fullScreenModal", animation: "fade" }} />
      <Stack.Screen name="Messages" component={MessagesScreen} options={{ animation: "slide_from_right" }} />
    </Stack.Navigator>
  );
}
