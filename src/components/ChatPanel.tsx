import { useEffect, useRef, useState } from "react";
import { CHAT_VISIBLE_MS, STUDIO_ID, useStudioChat, type ChatConfig, type ChatMsg } from "../studioChat";

interface Props {
  config: ChatConfig;
  /** En la ventana principal (acoplado) o en su propia ventana */
  floating: boolean;
  onToggleFloating: () => void;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
}

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** Chat de NGRADIO: leer, escribir como la emisora y moderar. */
export function ChatPanel({ config, floating, onToggleFloating, collapsed, onToggleCollapsed }: Props) {
  const chat = useStudioChat(config);
  const [text, setText] = useState("");
  const [menu, setMenu] = useState<number | null>(null);
  const [confirmBan, setConfirmBan] = useState<ChatMsg | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  useEffect(() => {
    const el = listRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages, collapsed]);

  const send = () => {
    const t = text.trim();
    if (!t) return;
    if (chat.sendText(t)) {
      setText("");
      stick.current = true;
    }
  };

  const statusText =
    chat.status === "open"
      ? `${chat.online} conectados`
      : chat.status === "connecting"
        ? "Conectando…"
        : chat.status === "off"
          ? "Desactivado"
          : "Sin conexión";

  return (
    <section className={`panel chat-panel ${floating ? "chat-floating" : ""} ${collapsed ? "chat-collapsed" : ""}`} aria-label="Chat de NGRADIO">
      <div className="chat-head">
        <span className={`live-dot ${chat.status === "open" ? "live-on" : ""}`} aria-hidden="true" />
        <span className="chat-title">Chat</span>
        <span className="chat-status">{statusText}</span>
        {chat.paused && <span className="badge-auto">PAUSADO</span>}
        <span className="spacer" />
        {!floating && onToggleCollapsed && (
          <button type="button" className="ghost-btn" onClick={onToggleCollapsed} title={collapsed ? "Mostrar el chat" : "Minimizar el chat"} aria-expanded={!collapsed}>
            {collapsed ? "▴" : "▾"}
          </button>
        )}
        <button type="button" className="ghost-btn" onClick={onToggleFloating} title={floating ? "Acoplar en la ventana principal" : "Abrir en una ventana flotante"}>
          {floating ? "Acoplar" : "⧉"}
        </button>
      </div>

      {!collapsed && (
        <>
          {chat.status === "error" && chat.error && <p className="hint hint-error chat-error">{chat.error}</p>}
          <div
            ref={listRef}
            className="chat-list"
            onScroll={(e) => {
              const el = e.currentTarget;
              stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
            }}
          >
            {chat.messages.length === 0 && chat.status === "open" && <p className="hint chat-empty">Aún no hay mensajes en la última hora.</p>}
            {chat.messages.map((m) => {
              const mine = m.user_id === STUDIO_ID;
              const hidden = m.ts < now - CHAT_VISIBLE_MS;
              const deleted = !!m.deleted_at;
              return (
                <div key={m.id} className={`chat-msg ${mine ? "chat-mine" : ""} ${hidden || deleted ? "chat-dim" : ""}`}>
                  <div className="chat-meta">
                    <span className="chat-name">{m.name}</span>
                    <span className="chat-time">{time(m.ts)}</span>
                    {m.edited_at && !deleted && <span className="chat-flag">editado</span>}
                    {deleted && <span className="chat-flag">borrado por su autor</span>}
                    {hidden && <span className="chat-flag">oculto (más de 1 h)</span>}
                  </div>
                  <button
                    type="button"
                    className={`chat-bubble ${deleted ? "chat-struck" : ""}`}
                    onClick={() => setMenu(menu === m.id ? null : m.id)}
                    title="Opciones"
                  >
                    {m.text}
                  </button>
                  {menu === m.id && (
                    <div className="chat-actions">
                      {mine ? (
                        <button type="button" className="ghost-btn" onClick={() => { chat.retract(m.id); setMenu(null); }}>
                          Eliminar
                        </button>
                      ) : (
                        <>
                          <button type="button" className="ghost-btn" onClick={() => { chat.remove(m.id); setMenu(null); }}>
                            Borrar mensaje
                          </button>
                          <button type="button" className="ghost-btn" onClick={() => { setConfirmBan(m); setMenu(null); }}>
                            Silenciar…
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {confirmBan && (
            <div className="chat-confirm" role="alertdialog">
              <span>
                Silenciar a <strong>{confirmBan.name}</strong> y borrar sus mensajes:
              </span>
              {[
                [10, "10 min"],
                [60, "1 h"],
                [1440, "24 h"],
                [10080, "7 días"],
              ].map(([min, label]) => (
                <button key={min} type="button" className="btn btn-sm" onClick={() => { chat.ban(confirmBan.user_id, Number(min)); setConfirmBan(null); }}>
                  {label}
                </button>
              ))}
              <button type="button" className="ghost-btn" onClick={() => setConfirmBan(null)}>
                Cancelar
              </button>
            </div>
          )}
          {chat.notice && (
            <p className="hint chat-notice" role="status">
              {chat.notice}
            </p>
          )}
          <div className="chat-compose">
            <input
              value={text}
              maxLength={500}
              placeholder={chat.status === "open" ? `Escribir como ${config.name || "Estudio"}…` : "Sin conexión"}
              disabled={chat.status !== "open"}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              aria-label="Mensaje para el chat"
            />
            <button type="button" className="btn btn-sm" disabled={chat.status !== "open" || !text.trim()} onClick={send}>
              Enviar
            </button>
          </div>
        </>
      )}
    </section>
  );
}
