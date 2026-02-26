import { createContext, useCallback, useContext, useState } from "react";

type ToastType = "success" | "error" | "info";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
}

const ToastContext = createContext<(message: string, type?: ToastType) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

let nextId = 0;

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: ToastType = "info") => {
    const id = ++nextId;
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  return (
    <ToastContext.Provider value={showToast}>
      {children}
      <div className="fixed bottom-5 right-5 z-500 flex flex-col-reverse gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`bg-bg-raised border border-border rounded-md px-4 py-2.5 text-[13px] shadow-lg flex items-center gap-2 max-w-[360px] animate-[slide-in_0.25s_ease-out] ${
              t.type === "success"
                ? "border-l-3 border-l-success"
                : t.type === "error"
                  ? "border-l-3 border-l-danger"
                  : "border-l-3 border-l-primary"
            }`}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
