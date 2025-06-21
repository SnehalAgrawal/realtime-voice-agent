function convertToTranscript(messages) {
  return messages
    .filter((msg) => msg.role !== "system" && msg.content !== "START")
    .map((msg) => {
      const speaker = msg.role === "assistant" ? "Bot" : "User";
      if (msg.timestamp) {
        return `${msg.timestamp} ${speaker}: ${msg.content.trim()}`;
      }
      return `${speaker}: ${msg.content.trim()}`;
    })
    .join("\n");
}

function estimatePlaybackDuration(text) {
  const words = text.split(/\s+/).length;
  return words * 100; // ~100ms per word
}

module.exports = { convertToTranscript, estimatePlaybackDuration };
