// The runtime of an executable compile made: rebuild its snapshot in a fresh
// interpreter and run its entry, an action, with the executable's arguments.
import { Interpreter } from "./interp.ts";
import { formatError } from "./repl.ts";
import { restoreSnapshot, type Snapshot } from "./snapshot.ts";

// (snapshot is the JSON compile wrote, read as it was written.)
export function runSnapshot(snapshot: unknown): void {
    const interp = new Interpreter();
    interp.programArgs = Deno.args;
    try { interp.runIO(restoreSnapshot(interp, snapshot as Snapshot)); }
    catch (error) {
        console.error(formatError(error, Deno.stderr.isTerminal()));
        Deno.exit(1);
    }
}
