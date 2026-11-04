import { createNavigationContainerRef } from "@react-navigation/native";
import type { RootStackParamList } from "./types";

/** For code outside screens — a notification tap opening an order. */
export const navigationRef = createNavigationContainerRef<RootStackParamList>();
