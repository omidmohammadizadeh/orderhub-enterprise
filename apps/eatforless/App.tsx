// Eat For Less — the customer app.
//
// App owns the things every screen needs before it can draw: fonts, the
// signed-in session, the query cache, Stripe and the navigator. The animated
// splash plays over the top until those are ready.

import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, Inter_700Bold, Inter_800ExtraBold } from "@expo-google-fonts/inter";
import { InterTight_700Bold, InterTight_800ExtraBold } from "@expo-google-fonts/inter-tight";
import { DefaultTheme, NavigationContainer } from "@react-navigation/native";
import { StripeProvider } from "@stripe/stripe-react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useSession } from "@/auth/session";
import { APPLE_PAY_MERCHANT_ID, STRIPE_PUBLISHABLE_KEY } from "@/config";
import { RootNavigator } from "@/navigation/RootNavigator";
import { SplashOverlay } from "@/screens/SplashOverlay";
import { C } from "@/theme";

SplashScreen.preventAutoHideAsync().catch(() => {});

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

const navTheme = { ...DefaultTheme, colors: { ...DefaultTheme.colors, background: C.white, primary: C.ink } };

export default function App() {
  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    Inter_800ExtraBold,
    InterTight_700Bold,
    InterTight_800ExtraBold,
  });
  const hydrated = useSession((s) => s.hydrated);
  const hydrate = useSession((s) => s.hydrate);
  const [splashDone, setSplashDone] = useState(false);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // The native splash (plain ink) stays up only until the fonts are in; the
  // animated splash, drawn in those fonts, takes over from there.
  useEffect(() => {
    if (fontsLoaded) SplashScreen.hideAsync().catch(() => {});
  }, [fontsLoaded]);

  const onSplashDone = useCallback(() => setSplashDone(true), []);

  if (!fontsLoaded) return <View style={{ flex: 1, backgroundColor: C.ink }} />;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <StripeProvider publishableKey={STRIPE_PUBLISHABLE_KEY || "pk_test_unset"} merchantIdentifier={APPLE_PAY_MERCHANT_ID} urlScheme="eatforless">
          <QueryClientProvider client={queryClient}>
            <StatusBar style={splashDone ? "dark" : "light"} />
            {hydrated ? (
              <NavigationContainer theme={navTheme}>
                <RootNavigator />
              </NavigationContainer>
            ) : (
              <View style={{ flex: 1, backgroundColor: C.ink }} />
            )}
            {!splashDone ? <SplashOverlay ready={hydrated} onDone={onSplashDone} /> : null}
          </QueryClientProvider>
        </StripeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
