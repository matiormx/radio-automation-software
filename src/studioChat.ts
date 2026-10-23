import { useCallback, useEffect, useRef, useState } from "react";

/** Chat de NGRADIO desde el estudio: /api/studio/chat con el token de estudio. */
export interface ChatMsg {
  id: number;
  user_id: string;
  name: string;
  avatar_url: string | null;
  text: string;
  ts: number;
  edited_at?: number | null;
  deleted_at?: number | null;
}

export type ChatStatus = "off" | "connecting" | "open" | "error";

export interface ChatConfig {
  serverUrl: string;
  token: string;
  /** Nombre con el que escribe la emisora */
  name: string;
  enabled: boolean;
}

/** Mensajes visibles para los oyentes durante 1 hora (el estudio ve tambien los antiguos, marcados). */
export const CHAT_VISIBLE_MS = 60 * 60 * 1000;
export const STUDIO_ID = "studio";

export function studioChatUrl(serverUrl: string, name: string): string | null {
  const raw = serverUrl.trim();
  if (!raw) return null;
  try {
    const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/api/studio/chat";
    url.search = "";
    url.hash = "";
    if (name.trim()) url.searchParams.set("name", name.trim().slice(0, 40));
    return url.toString();
  } catch {
    return null;
  }
}

export function useStudioChat(cfg: ChatConfig) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [status, setStatus] = useState<ChatStatus>("off");
  const [error, setError] = useState("");
  const [online, setOnline] = useState(0);
  const [notice, setNotice] = useState("");
  const [paused, setPaused] = useState(false);
  const [slowMs, setSlowMs] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const noticeTimer = useRef(0);

  const flash = useCallback((text: string) => {
    setNotice(text);
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(""), 4500);
  }, []);

  useEffect(() => {
    const url = studioChatUrl(cfg.serverUrl, cfg.name);
    if (!cfg.enabled) {
      setStatus("off");
      return;
    }
    if (!url || cfg.token.trim().length < 24) {
      setStatus("error");
      setError("Configura la dirección de NGRADIO y el token de estudio en Ajustes → Llamadas.");
      return;
    }
    let stopped = false;
    let retry = 0;
    let timer = 0;
    const connect = () => {
      if (stopped) return;
      setStatus("connecting");
      let ws: WebSocket;
      try {
        ws = new WebSocket(url, ["studio.v1", `token.${cfg.token.trim()}`]);
      } catch (e) {
        setStatus("error");
        setError(String(e));
        return;
      }
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setError("");
        setStatus("open");
      };
      ws.onmessage = (ev) => {
        let d: any;
        try {
          d = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (d.t === "hist") {
          setMessages(d.messages ?? []);
          if (d.settings) {
            setPaused(!!d.settings.paused);
            setSlowMs(Number(d.settings.slow_ms) || 0);
          }
        } else if (d.t === "msg") setMessages((p) => [...p.filter((m) => m.id !== d.message.id), d.message].slice(-300));
        else if (d.t === "del") setMessages((p) => p.filter((m) => m.id !== d.id));
        else if (d.t === "mdel") setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, deleted_at: d.deleted_at } : m)));
        else if (d.t === "edit") setMessages((p) => p.map((m) => (m.id === d.id ? { ...m, text: d.text, edited_at: d.edited_at } : m)));
        else if (d.t === "online") setOnline(Number(d.n) || 0);
        else if (d.t === "settings") {
          setPaused(!!d.settings?.paused);
          setSlowMs(Number(d.settings?.slow_ms) || 0);
        } else if (d.t === "err" || d.t === "info") flash(String(d.message ?? ""));
      };
      ws.onclose = (ev) => {
        if (wsRef.current === ws) wsRef.current = null;
        if (stopped) return;
        setStatus(ev.code === 1006 && retry > 2 ? "error" : "connecting");
        if (ev.code === 1006 && retry > 2) setError("No se pudo conectar con el chat de NGRADIO (revisa la dirección y el token).");
        timer = window.setTimeout(connect, Math.min(15000, 1000 * 2 ** retry++));
      };
    };
    connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [cfg.enabled, cfg.serverUrl, cfg.token, cfg.name, flash]);

  const send = useCallback((payload: object) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  return {
    messages,
    status,
    error,
    online,
    notice,
    paused,
    slowMs,
    sendText: (text: string) => send({ t: "msg", text, lang: "es" }),
    remove: (id: number) => send({ t: "del", id }),
    retract: (id: number) => send({ t: "retract", id }),
    ban: (userId: string, minutes = 1440) => send({ t: "ban", user_id: userId, minutes }),
    setPausedRemote: (p: boolean) => send({ t: "settings", paused: p }),
  };
}
