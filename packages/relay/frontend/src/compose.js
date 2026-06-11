// A feed conversation is a one-way ingest stream (id prefixed `feed-` by the
// relay). The operator never replies *into* a feed, so an outgoing message must
// not be threaded under one.
export function isFeedConversation(conversationId) {
  return typeof conversationId === "string" && conversationId.startsWith("feed-");
}

// Resolve the conversation id an outgoing operator message threads into:
//   - a room message threads under its room id;
//   - otherwise it inherits the currently open conversation, EXCEPT a feed
//     thread, which must never absorb an outgoing message — start fresh
//     (undefined) so the relay assigns a new conversation.
export function resolveOutgoingConversationId({ isRoom, roomId, selectedConversationId }) {
  if (isRoom) return roomId;
  if (selectedConversationId && !isFeedConversation(selectedConversationId)) {
    return selectedConversationId;
  }
  return undefined;
}
