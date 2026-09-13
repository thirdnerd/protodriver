export interface BrowserReleaseHooks {
  readonly release: () => void | Promise<void>;
  readonly window: Pick<Window, "addEventListener" | "removeEventListener">;
}

/** Starts release synchronously; unload cannot promise time for completion. */
export function installBrowserReleaseHooks(options: BrowserReleaseHooks): {
  dispose(): void;
} {
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    void options.release();
  };
  options.window.addEventListener("beforeunload", release);
  return {
    dispose: () => options.window.removeEventListener("beforeunload", release),
  };
}
