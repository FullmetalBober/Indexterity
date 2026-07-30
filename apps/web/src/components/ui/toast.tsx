import { createContext, type ReactNode, useCallback, useContext, useRef, useState } from "react";

// Tiny toast system — no dependency. push("Approved") / push("failed", "error");
// toasts stack bottom-right and dismiss themselves after 4s (click to dismiss).

export type ToastKind = "success" | "error";

interface Toast {
  readonly id: number;
  readonly kind: ToastKind;
  readonly text: string;
}

type PushToast = (text: string, kind?: ToastKind) => void;

const ToastContext = createContext<PushToast | null>(null);

export function useToast(): PushToast {
  const push = useContext(ToastContext);
  if (push === null) throw new Error("useToast outside <ToastProvider>");
  return push;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const nextId = useRef(1);

  const push = useCallback<PushToast>((text, kind = "success") => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((current) => [...current, { id, kind, text }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed right-4 bottom-4 z-50 flex flex-col gap-2">
        {toasts.map((toast) => (
          <button
            key={toast.id}
            type="button"
            onClick={() => setToasts((current) => current.filter((t) => t.id !== toast.id))}
            className={`pointer-events-auto rounded-md border px-4 py-2 text-left text-sm shadow-md ${
              toast.kind === "error"
                ? "border-red-200 bg-red-50 text-red-800"
                : "border-border bg-background text-foreground"
            }`}
          >
            {toast.text}
          </button>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
