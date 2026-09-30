import { useSyncExternalStore } from "react";
import { consoleState, subscribeConsole, type ConsoleState } from "../lib/appConsole";

/** The app console's entries and whether it's open. See `src/lib/appConsole.ts`. */
export function useAppConsole(): ConsoleState {
  return useSyncExternalStore(subscribeConsole, consoleState, consoleState);
}
