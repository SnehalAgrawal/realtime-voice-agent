// Small helpers shared by the HTTP providers. No SDKs: every provider is a fetch call,
// so the request each one sends is visible in one short file.

/** POSTs JSON and throws with the response body if the status is not 2xx. */
export function postJson(url, body, { headers = {}, ...options } = {}) {
  return postBody(url, JSON.stringify(body), { headers: { "content-type": "application/json", ...headers }, ...options });
}

/** POSTs multipart form data (fetch sets the boundary). */
export function postForm(url, form, options = {}) {
  return postBody(url, form, options);
}

/** POSTs a body as is and throws with the provider's error message if the status is not 2xx. */
export async function postBody(url, body, { headers = {}, signal, timeoutMs } = {}) {
  const response = await fetch(url, { method: "POST", headers, body, signal: withTimeout(signal, timeoutMs) });
  await ensureOk(response, url);
  return response;
}

export async function ensureOk(response, url) {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`${response.status} ${response.statusText} from ${redact(url)}: ${errorDetail(body)}`);
}

/** The provider's own error message when the body is JSON ({ error: "..." } or { error: { message } }). */
function errorDetail(body) {
  try {
    const { error, message } = JSON.parse(body);
    const detail = error?.message ?? error ?? message;
    if (detail) return (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 500);
  } catch {
    // not JSON
  }
  return body.slice(0, 500);
}

/** Yields the lines of a streamed response body. */
export async function* lines(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      yield buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) yield buffer;
}

/** Yields the `data:` payloads of a server-sent events stream. */
export async function* serverSentEvents(body) {
  for await (const line of lines(body)) {
    if (line.startsWith("data:")) yield line.slice(5).trimStart();
  }
}

/** Combines a caller's abort signal with an optional timeout. */
export function withTimeout(signal, timeoutMs) {
  if (!timeoutMs) return signal;
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Drops query strings (which may carry API keys) from URLs in error messages. */
function redact(url) {
  return String(url).replace(/\?.*$/, "");
}

/** Joins a base URL and a path without doubling or losing slashes. */
export function joinUrl(base, path) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
