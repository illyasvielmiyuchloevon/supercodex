type Kernel = {
  symbols: {
    GetStdHandle(handle: number): unknown;
    GetConsoleMode(handle: unknown, buffer: unknown): number;
    SetConsoleMode(handle: unknown, mode: number): number;
    FlushConsoleInputBuffer(handle: unknown): number;
  };
};

const STD_INPUT_HANDLE = -10;
const ENABLE_PROCESSED_INPUT = 0x0001;

let kernel: Kernel | null | undefined;
let unhook: (() => void) | undefined;

async function loadKernel(): Promise<Kernel | null> {
  if (process.platform !== "win32" || !process.stdin.isTTY) return null;
  if (kernel !== undefined) return kernel;
  try {
    const ffi = await import("bun:ffi");
    kernel = ffi.dlopen("kernel32.dll", {
      GetStdHandle: { args: ["i32"], returns: "ptr" },
      GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
      SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
      FlushConsoleInputBuffer: { args: ["ptr"], returns: "i32" },
    }) as Kernel;
    return kernel;
  } catch {
    kernel = null;
    return null;
  }
}

export async function win32DisableProcessedInput(): Promise<void> {
  const k32 = await loadKernel();
  if (!k32) return;
  const ffi = await import("bun:ffi");
  const handle = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);
  const buf = new Uint32Array(1);
  if (k32.symbols.GetConsoleMode(handle, ffi.ptr(buf)) === 0) return;
  const mode = buf[0] ?? 0;
  if ((mode & ENABLE_PROCESSED_INPUT) === 0) return;
  k32.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT);
}

export async function win32FlushInputBuffer(): Promise<void> {
  const k32 = await loadKernel();
  if (!k32) return;
  const handle = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);
  k32.symbols.FlushConsoleInputBuffer(handle);
}

export async function win32InstallCtrlCGuard(): Promise<(() => void) | undefined> {
  const k32 = await loadKernel();
  if (!k32 || unhook) return unhook;
  const ffi = await import("bun:ffi");
  const stdin = process.stdin as unknown as { setRawMode?: (mode: boolean) => unknown };
  const original = stdin.setRawMode;
  const handle = k32.symbols.GetStdHandle(STD_INPUT_HANDLE);
  const buf = new Uint32Array(1);
  if (k32.symbols.GetConsoleMode(handle, ffi.ptr(buf)) === 0) return undefined;
  const initial = buf[0] ?? 0;

  const enforce = () => {
    if (k32.symbols.GetConsoleMode(handle, ffi.ptr(buf)) === 0) return;
    const mode = buf[0] ?? 0;
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return;
    k32.symbols.SetConsoleMode(handle, mode & ~ENABLE_PROCESSED_INPUT);
  };
  const later = () => {
    enforce();
    setImmediate(enforce);
  };

  let wrapped: ((mode: boolean) => unknown) | undefined;
  if (typeof original === "function") {
    wrapped = (mode: boolean) => {
      const result = original.call(stdin, mode);
      later();
      return result;
    };
    stdin.setRawMode = wrapped;
  }

  later();
  const interval = setInterval(enforce, 100);
  interval.unref();

  let done = false;
  unhook = () => {
    if (done) return;
    done = true;
    clearInterval(interval);
    if (wrapped && stdin.setRawMode === wrapped) {
      stdin.setRawMode = original;
    }
    k32.symbols.SetConsoleMode(handle, initial);
    unhook = undefined;
  };
  return unhook;
}
