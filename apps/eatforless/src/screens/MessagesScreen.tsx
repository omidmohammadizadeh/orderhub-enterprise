// Messages with the driver on one order. Text goes through Eat For Less, so
// neither side needs the other's number. Polls every 4s while open; the
// driver gets a push for each message.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, StyleSheet, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { getOrderMessages, sendOrderMessage } from "@/api/efl";
import type { OrderMessage } from "@/api/types";
import { RoundButton } from "@/components/Bits";
import { Icon } from "@/components/Icon";
import { PressScale } from "@/components/PressScale";
import { T } from "@/components/T";
import type { RootScreen } from "@/navigation/types";
import { C, F } from "@/theme";

const QUICK = ["I'm coming down", "Please leave it at the door", "Ring the bell, please"];

function time(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function MessagesScreen({ navigation, route }: RootScreen<"Messages">) {
  const { orderId, name } = route.params;
  const insets = useSafeAreaInsets();
  const qc = useQueryClient();
  const list = useRef<FlatList<OrderMessage>>(null);
  const [text, setText] = useState("");

  const key = ["messages", orderId];
  const messages = useQuery({ queryKey: key, queryFn: () => getOrderMessages(orderId), refetchInterval: 4_000 });
  const send = useMutation({
    mutationFn: (body: string) => sendOrderMessage(orderId, body),
    onSuccess: (sent) => {
      qc.setQueryData<OrderMessage[]>(key, (old) => [...(old ?? []), sent]);
      setText("");
    },
    onError: (err) => Alert.alert("Message not sent", (err as Error).message),
  });

  const rows = messages.data ?? [];
  useEffect(() => {
    if (rows.length) requestAnimationFrame(() => list.current?.scrollToEnd({ animated: true }));
  }, [rows.length]);

  const submit = (body: string) => {
    const clean = body.trim();
    if (clean && !send.isPending) send.mutate(clean);
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.root}>
      <View style={[styles.header, { paddingTop: insets.top + 8 }]}>
        <RoundButton icon="back" label="Back" light onPress={() => navigation.goBack()} />
        <View style={{ flex: 1 }}>
          <T v="title">{name}</T>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Icon name="lock" size={12} color={C.grey600} />
            <T v="small">Private · your number stays hidden</T>
          </View>
        </View>
      </View>

      {messages.isLoading ? (
        <ActivityIndicator style={{ marginTop: 40 }} color={C.ink} />
      ) : (
        <FlatList
          ref={list}
          data={rows}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 16, gap: 8, flexGrow: 1 }}
          ListEmptyComponent={
            <View style={styles.empty}>
              <T v="item">Message {name}</T>
              <T v="sub" style={{ textAlign: "center" }}>
                Gate codes, where to leave it, or that you're on your way down.
              </T>
            </View>
          }
          renderItem={({ item }) => {
            const mine = item.senderType === "CUSTOMER";
            return (
              <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
                <T style={[styles.body, mine && { color: C.white }]}>{item.body}</T>
                <T style={[styles.time, mine && { color: "#9C9C9C" }]}>{time(item.createdAt)}</T>
              </View>
            );
          }}
        />
      )}

      {rows.length === 0 && !messages.isLoading ? (
        <View style={styles.quick}>
          {QUICK.map((q) => (
            <PressScale key={q} onPress={() => submit(q)} style={styles.chip} haptic>
              <T v="label" style={{ fontSize: 13 }}>{q}</T>
            </PressScale>
          ))}
        </View>
      ) : null}

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <TextInput
          value={text}
          onChangeText={setText}
          placeholder={`Message ${name}`}
          placeholderTextColor={C.grey500}
          style={styles.input}
          maxLength={500}
          multiline
          accessibilityLabel={`Message ${name}`}
        />
        <PressScale
          onPress={() => submit(text)}
          disabled={!text.trim() || send.isPending}
          style={[styles.send, (!text.trim() || send.isPending) && { opacity: 0.35 }]}
          accessibilityRole="button"
          accessibilityLabel="Send"
          haptic
        >
          {send.isPending ? <ActivityIndicator color={C.ink} /> : <Icon name="arrowRight" size={20} color={C.ink} />}
        </PressScale>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.white },
  header: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: C.line },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: 32 },
  bubble: { maxWidth: "80%", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 10, gap: 2 },
  mine: { alignSelf: "flex-end", backgroundColor: C.ink, borderBottomRightRadius: 6 },
  theirs: { alignSelf: "flex-start", backgroundColor: C.grey100, borderBottomLeftRadius: 6 },
  body: { fontFamily: F.regular, fontSize: 15, lineHeight: 21, color: C.ink },
  time: { fontFamily: F.medium, fontSize: 11, color: C.grey500, alignSelf: "flex-end" },
  quick: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingBottom: 8 },
  chip: { borderWidth: 1, borderColor: C.grey300, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8 },
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 10, paddingHorizontal: 16, paddingTop: 10, borderTopWidth: 1, borderTopColor: C.line },
  input: {
    flex: 1,
    minHeight: 44,
    maxHeight: 120,
    backgroundColor: C.grey100,
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 12,
    fontFamily: F.regular,
    fontSize: 15,
    color: C.ink,
  },
  send: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.lime, alignItems: "center", justifyContent: "center" },
});
