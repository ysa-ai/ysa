import { useState } from "react";
import { trpc } from "./trpc";

interface TerminalPickerProps {
  onConfirm: (terminalId: string, remember: boolean) => void;
  onCancel: () => void;
}

export function TerminalPicker({ onConfirm, onCancel }: TerminalPickerProps) {
  const { data: terminals = [], isLoading } = trpc.system.detectTerminals.useQuery();
  const [selected, setSelected] = useState<string | null>(null);
  const [remember, setRemember] = useState(true);

  const handleConfirm = () => {
    if (!selected) return;
    onConfirm(selected, remember);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="bg-bg-raised border border-border rounded-xl shadow-xl w-full max-w-sm mx-4">
        <div className="px-5 py-4 border-b border-border">
          <h2 className="text-[14px] font-semibold text-text-primary">Choose your terminal</h2>
          <p className="text-[12px] text-text-muted mt-0.5">The sandbox shell will open in your selected terminal.</p>
        </div>

        <div className="px-5 py-3 space-y-1.5">
          {isLoading ? (
            <p className="text-[12px] text-text-faint py-4 text-center">Detecting installed terminals...</p>
          ) : terminals.length === 0 ? (
            <p className="text-[12px] text-text-faint py-4 text-center">No supported terminals detected.</p>
          ) : (
            terminals.map((t) => (
              <button
                key={t.id}
                onClick={() => setSelected(t.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-lg border text-left transition-all cursor-pointer ${
                  selected === t.id
                    ? "bg-primary/10 border-primary/40 text-primary"
                    : "bg-bg-inset border-border text-text-primary hover:border-border-bright"
                }`}
              >
                <span className="text-[13px] font-medium">{t.name}</span>
              </button>
            ))
          )}
        </div>

        <div className="px-5 py-3 border-t border-border">
          <label className="flex items-center gap-2.5 cursor-pointer select-none mb-4">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="w-3.5 h-3.5 rounded accent-primary cursor-pointer"
            />
            <span className="text-[12px] text-text-muted">Remember this choice</span>
          </label>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="flex-1 py-2 rounded-lg text-[12px] font-medium border border-border text-text-muted hover:border-border-bright transition-all cursor-pointer"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={!selected}
              className={`flex-1 py-2 rounded-lg text-[12px] font-medium bg-primary text-white transition-all ${
                !selected ? "opacity-40 cursor-not-allowed" : "hover:brightness-110 cursor-pointer"
              }`}
            >
              Open shell
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
