import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { ChatMessage } from "@/services/auth";

// Reusable polling chat. `mine` decides which side a bubble sits on.
export function ChatScreen({
  title,
  subtitle,
  mine,
  load,
  send,
  onBack,
}: {
  title: string;
  subtitle?: string;
  mine: ChatMessage["senderType"];
  load: () => Promise<ChatMessage[]>;
  send: (body: string) => Promise<void>;
  onBack: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  const refresh = useCallback(async () => {
    try {
      const m = await load();
      setMessages(m);
    } catch {
      // transient
    } finally {
      setLoading(false);
    }
  }, [load]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  async function onSend() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setText("");
    try {
      await send(body);
      await refresh();
      listRef.current?.scrollToEnd({ animated: true });
    } catch {
      setText(body); // restore on failure
    } finally {
      setSending(false);
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 0}
    >
      <View style={styles.topbar}>
        <Pressable onPress={onBack} hitSlop={10}>
          <Text style={styles.back}>‹ Back</Text>
        </Pressable>
        <View style={{ alignItems: "center" }}>
          <Text style={styles.title}>{title}</Text>
          {!!subtitle && <Text style={styles.subtitle}>{subtitle}</Text>}
        </View>
        <View style={{ width: 50 }} />
      </View>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color="#0F172A" />
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.empty}>No messages yet. Say hello 👋</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 12, gap: 8 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          renderItem={({ item }) => {
            const isMine = item.senderType === mine;
            return (
              <View style={[styles.bubbleRow, isMine ? styles.rowMine : styles.rowTheirs]}>
                <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  {!isMine && !!item.senderName && <Text style={styles.sender}>{item.senderName}</Text>}
                  <Text style={[styles.body, isMine && { color: "#fff" }]}>{item.body}</Text>
                  <Text style={[styles.time, isMine && { color: "rgba(255,255,255,0.7)" }]}>
                    {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>
              </View>
            );
          }}
        />
      )}

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Type a message…"
          placeholderTextColor="#94a3b8"
          multiline
        />
        <Pressable style={[styles.sendBtn, (!text.trim() || sending) && { opacity: 0.4 }]} onPress={onSend}>
          <Text style={styles.sendText}>{sending ? "…" : "Send"}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f1f5f9" },
  topbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 12,
    paddingVertical: 12,
    backgroundColor: "#0F172A",
  },
  back: { color: "#fff", fontSize: 16, width: 50 },
  title: { color: "#fff", fontSize: 16, fontWeight: "800" },
  subtitle: { color: "#94a3b8", fontSize: 12, marginTop: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  empty: { color: "#64748b" },
  bubbleRow: { flexDirection: "row" },
  rowMine: { justifyContent: "flex-end" },
  rowTheirs: { justifyContent: "flex-start" },
  bubble: { maxWidth: "80%", borderRadius: 16, paddingHorizontal: 12, paddingVertical: 8 },
  bubbleMine: { backgroundColor: "#2563eb", borderBottomRightRadius: 4 },
  bubbleTheirs: { backgroundColor: "#fff", borderBottomLeftRadius: 4 },
  sender: { fontSize: 11, fontWeight: "700", color: "#64748b", marginBottom: 2 },
  body: { fontSize: 15, color: "#0F172A" },
  time: { fontSize: 10, color: "#94a3b8", marginTop: 3, alignSelf: "flex-end" },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    padding: 10,
    borderTopWidth: 1,
    borderTopColor: "#e2e8f0",
    backgroundColor: "#fff",
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 42,
    borderRadius: 21,
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    fontSize: 15,
    color: "#0F172A",
  },
  sendBtn: {
    backgroundColor: "#2563eb",
    borderRadius: 21,
    paddingHorizontal: 18,
    height: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  sendText: { color: "#fff", fontWeight: "800", fontSize: 15 },
});
