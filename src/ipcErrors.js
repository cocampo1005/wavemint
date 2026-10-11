// Errors thrown by main-process IPC handlers arrive wrapped as
// "Error invoking remote method '<channel>': Error: <message>". WaveMint's own
// actionable errors also start with a "[code]" tag (see createUserError in
// electron/main.cjs), e.g. "[auth]", "[rate-limit]" or "[dependency]".
export function parseIpcError(error, fallback = "Something went wrong") {
  let message = String(error?.message || error || "")
    .replace(/^Error invoking remote method '[^']+':\s*/, "")
    .replace(/^Error:\s*/, "");
  const match = /^\[([a-z-]+)\]\s*/.exec(message);

  if (match) {
    message = message.slice(match[0].length);
  }

  return { message: message || fallback, code: match ? match[1] : "" };
}
