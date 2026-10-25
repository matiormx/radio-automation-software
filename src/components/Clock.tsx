import { useEffect, useState } from "react";

/** Reloj aislado: no hace re-renderizar toda la aplicacion cada segundo. */
export function Clock() {
  const [text, setText] = useState(() =>
    new Date().toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
  );
  useEffect(() => {
    const tick = () =>
      setText(
        new Date().toLocaleTimeString("es-ES", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }),
      );
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <span className="clock" role="timer">
      {text}
    </span>
  );
}
