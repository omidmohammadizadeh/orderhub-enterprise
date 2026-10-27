import type { NavigatorScreenParams } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { Shop } from "@/api/types";

export type TabParamList = {
  Home: undefined;
  Orders: undefined;
  Account: undefined;
};

export type RootStackParamList = {
  Tabs: NavigatorScreenParams<TabParamList> | undefined;
  Welcome: undefined;
  EmailAuth: { mode: "signin" | "signup" };
  Phone: { then?: "Checkout" } | undefined;
  Search: undefined;
  Shop: { shop: Shop };
  Item: { shop: Shop; itemId: string };
  Checkout: undefined;
  Address: undefined;
  Tracking: { orderId: string };
  Call: { orderId: string; name: string };
  Messages: { orderId: string; name: string };
};

export type RootScreen<K extends keyof RootStackParamList> = NativeStackScreenProps<RootStackParamList, K>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace ReactNavigation {
    interface RootParamList extends RootStackParamList {}
  }
}
