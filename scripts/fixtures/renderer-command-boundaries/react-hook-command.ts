import { useEffect } from "react";
import { invokePlainCommand } from "@/lib/renderer-command";

export function useEscapedCommand(): void {
  useEffect(() => {
    void invokePlainCommand;
  }, []);
}
