import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const packageName = "@lunchbox-labs/opencode-prompt-composer";
export function serverEntry(spec: string, root: string): boolean {
  if (
    spec === packageName ||
    (spec.startsWith(`${packageName}@`) &&
      /^[\w.*+~^<>=| -]+$/.test(spec.slice(packageName.length + 1)))
  ) {
    return true;
  }
  try {
    const path = spec.startsWith("file:")
      ? fileURLToPath(spec)
      : resolve(root, spec);
    return [
      fileURLToPath(new URL("./server.ts", import.meta.url)),
      fileURLToPath(new URL("./server.js", import.meta.url)),
      fileURLToPath(new URL("../", import.meta.url)).replace(/[\\/]$/, ""),
    ].includes(path);
  } catch {
    return false;
  }
}
