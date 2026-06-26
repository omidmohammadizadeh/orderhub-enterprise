// Order Hub Driver — native delivery app.
//
// Auth gate → Home (online/offline + jobs) → Job detail (navigate, call,
// slide-to-start/delivered, skip/cancel). Background GPS streams the driver's
// position to dispatch; push notifications deliver new-job alerts with
// Accept / Reject buttons even when the app is closed.

import { useEffect, useState } from "react";
import { SafeAreaView } from "react-native-safe-area-context";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, View } from "react-native";

import { useAuth, Job } from "@/services/auth";
import { configureGoogleSignIn } from "@/services/google";
import {
  attachJobResponseHandler,
  registerForPush,
  setupJobCategory,
} from "@/services/notifications";
import { LoginScreen } from "@/screens/LoginScreen";
import { HomeScreen } from "@/screens/HomeScreen";
import { JobScreen } from "@/screens/JobScreen";
import { ProfileScreen } from "@/screens/ProfileScreen";
import { OrdersScreen } from "@/screens/OrdersScreen";
import { CashUpScreen } from "@/screens/CashUpScreen";
import type { OrdersTab } from "@/components/Drawer";

export default function App() {
  const { tokens, hydrated, setTokens } = useAuth();
  const [job, setJob] = useState<Job | null>(null);
  const [profile, setProfile] = useState(false);
  const [ordersTab, setOrdersTab] = useState<OrdersTab | null>(null);
  const [cashup, setCashup] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    configureGoogleSignIn();
  }, []);

  // Once signed in: set up push (category + token) and the Accept/Reject
  // notification action handler.
  useEffect(() => {
    if (!tokens) return;
    setupJobCategory();
    registerForPush();
    const detach = attachJobResponseHandler(() => setRefreshKey((k) => k + 1));
    return detach;
  }, [tokens]);

  if (!hydrated) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "#0F172A" }}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={{ flex: 1, backgroundColor: "#0F172A" }} edges={["top"]}>
        <StatusBar style="light" />
        {!tokens ? (
          <LoginScreen onSignedIn={(t) => setTokens(t)} />
        ) : job ? (
          <JobScreen
            key={`${job.id}-${refreshKey}`}
            job={job}
            onBack={() => setJob(null)}
            onChanged={() => setRefreshKey((k) => k + 1)}
          />
        ) : profile ? (
          <ProfileScreen
            onBack={() => setProfile(false)}
            onSignOut={() => {
              setProfile(false);
              setTokens(null);
            }}
          />
        ) : cashup ? (
          <CashUpScreen onBack={() => setCashup(false)} />
        ) : ordersTab ? (
          <OrdersScreen
            initialTab={ordersTab}
            onBack={() => setOrdersTab(null)}
            onOpenJob={(j) => {
              setOrdersTab(null);
              setJob(j);
            }}
          />
        ) : (
          <HomeScreen
            key={refreshKey}
            onOpenJob={(j) => setJob(j)}
            onSignOut={() => setTokens(null)}
            onOpenProfile={() => setProfile(true)}
            onOpenOrders={(t) => setOrdersTab(t)}
            onOpenCashUp={() => setCashup(true)}
          />
        )}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}
