import { APNError } from "./errors.ts";

let interruptFlag: Int32Array | null = null;

export function checkInterrupt(): void {
    if (interruptFlag === null) return;
    checkInterruptInner();
}
let __spinCount = 0;
function checkInterruptInner(): void {
    if (++__spinCount % 100_000_000 === 0) {
        if (Atomics.load(interruptFlag!, 0) === 1) {
            Atomics.store(interruptFlag!, 0, 0);
            throw new APNError("runtime", "interrupted");
        }
    }
    if (
        Atomics.load(interruptFlag!, 0) === 1 ||
        Atomics.wait(interruptFlag!, 0, 0, 0) !== "timed-out" ||
        Atomics.load(interruptFlag!, 1) === 888
    ) {
        Atomics.store(interruptFlag!, 0, 0);
        Atomics.store(interruptFlag!, 1, 0);
        throw new APNError("runtime", "interrupted");
    }
}

export function setInterruptFlag(f: Int32Array | null): void {
    interruptFlag = f;
}

export function resetInterrupt(): void {
    if (interruptFlag !== null) {
        Atomics.store(interruptFlag, 0, 0);
        Atomics.store(interruptFlag, 1, 0);
    }
}

