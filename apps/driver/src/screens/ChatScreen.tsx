import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { ChatMessage } from "@/services/auth";
import { Header, Icon } from "@/components/ui";
import { C, R } from "@/theme";

// Reusable polling chat. `mine` decides which side a bubble sits on.
// `standalone` = rendered inside a Modal, outside App's top safe-area edge.
export function ChatScreen({
  title,
  subtitle,
  mine,
  load,
  send,
  onBack,
  standalone,
}: {
  title: string;
  subtitle?: string;
  mine: ChatMessage["senderType"];
  load: () => Promise<ChatMessage[]>;
  send: (body: string) => Promise<void>;
  onBack: () => void;
  standalone?: boolean;
}) {
  const insets = useSafeAreaInsets();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  const [kbOpen, setKbOpen] = useState(false);
  const listRef = useRef<FlatList<ChatMessage> | null>(null);

  // `load` is usually an inline arrow, so it changes every render; keep the
  // poll on a ref or the interval is torn down and rebuilt on every keystroke.
  const loadRef = useRef(load);
  loadRef.current = load;

  const refresh = useCallback(async () => {
    try {
      setMessages(await loadRef.current());
    } catch {
      // transient
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 3000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    const a = Keyboard.addListener("keyboardDidShow", () => setKbOpen(true));
    const b = Keyboard.addListener("keyboardDidHide", () => setKbOpen(false));
    return () => {
      a.remove();
      b.remove();
    };
  }, []);

  async function onSend() {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setFailed(false);
    setText("");
    try {
      await send(body);
      await refresh();
      listRef.current?.scrollToEnd({ animated: true });
    } catch {
      setText(body); // restore on failure
      setFailed(true);
    } finally {
      setSending(false);
    }
  }

  const canSend = !!text.trim() && !sending;

  return (
    <KeyboardAvoidingView
      style={[styles.container, standalone && { paddingTop: insets.top }]}
      // Android edge-to-edge no longer resizes the window for the keyboard, so
      // both platforms pad the view themselves.
      behavior={Platform.OS === "ios" ? "padding" : "height"}
    >
      <Header title={title} subtitle={subtitle} onBack={onBack} />

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator color={C.textDim} />
        </View>
      ) : messages.length === 0 ? (
        <View style={styles.center}>
          <View style={styles.emptyIcon}>
            <Icon name="chatbubbles-outline" size={28} color={C.textDim} />
          </View>
          <Text style={styles.empty}>No messages yet</Text>
          <Text style={styles.emptySub}>Messages you send appear here instantly.</Text>
        </View>
      ) : (
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(m) => m.id}
          contentContainerStyle={{ padding: 14, gap: 8 }}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => {
            const isMine = item.senderType === mine;
            return (
              <View style={[styles.bubbleRow, isMine ? styles.rowMine : styles.rowTheirs]}>
                <View style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}>
                  {!isMine && !!item.senderName && <Text style={styles.sender}>{item.senderName}</Text>}
                  <Text style={[styles.body, isMine && { color: C.onAccent }]}>{item.body}</Text>
                  <Text style={[styles.time, isMine && { color: "rgba(4,20,11,0.6)" }]}>
                    {new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                  </Text>
                </View>
              </View>
            );
          }}
        />
      )}

      {failed && <Text style={styles.failed}>Couldn&apos;t send — check your signal and try again.</Text>}
      <View style={[styles.inputRow, { paddingBottom: kbOpen ? 10 : Math.max(insets.bottom, 10) }]}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message…"
          placeholderTextColor={C.textMute}
          multiline
        />
        <Pressable
          style={[styles.sendBtn, !canSend && { opacity: 0.35 }]}
          onPress={onSend}
          disabled={!canSend}
          accessibilityLabel="Send"
        >
          {sending ? <ActivityIndicator color={C.onAccent} size="small" /> : <Icon name="arrow-up" size={22} color={C.onAccent} />}
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  emptyIcon: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: C.surface,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 12,
  },
  empty: { color: C.text, fontWeight: "800", fontSize: 16 },
  emptySub: { color: C.textMute, marginTop: 4 },
  bubbleRow: { flexDirection: "row" },
  rowMine: { justifyContent: "flex-end" },
  rowTheirs: { justifyContent: "flex-start" },
  bubble: { maxWidth: "80%", borderRadius: 18, paddingHorizontal: 13, paddingVertical: 9 },
  bubbleMine: { backgroundColor: C.go, borderBottomRightRadius: 5 },
  bubbleTheirs: { backgroundColor: C.surface2, borderBottomLeftRadius: 5, borderWidth: 1, borderColor: C.border },
  sender: { fontSize: 11, fontWeight: "800", color: C.textDim, marginBottom: 2 },
  body: { fontSize: 15, color: C.text, lineHeight: 20 },
  time: { fontSize: 10, color: C.textMute, marginTop: 3, alignSelf: "flex-end" },
  failed: { color: C.danger, fontSize: 12, textAlign: "center", paddingVertical: 4 },
  inputRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    paddingHorizontal: 10,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: C.border,
    backgroundColor: C.bg,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    minHeight: 44,
    borderRadius: 22,
    backgroundColor: C.surface2,
    borderWidth: 1,
    borderColor: C.border,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    fontSize: 15,
    color: C.text,
  },
  sendBtn: {
    backgroundColor: C.go,
    borderRadius: 22,
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
});
