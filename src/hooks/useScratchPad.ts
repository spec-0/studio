import { useCallback, useState } from "react";
import { EMPTY_PAD, saveScratch, type ScratchPad } from "../lib/scratch";

/** The one scratch pad. Only its contents persist, the way a text buffer does. */
export function useScratchPad() {
  const [pad, setPad] = useState<ScratchPad>(EMPTY_PAD);

  const updatePad = useCallback((next: ScratchPad) => {
    setPad(next);
    void saveScratch(next);
  }, []);

  return { pad, setPad, updatePad };
}
