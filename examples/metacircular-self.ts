// Runs examples/metacircular-self.apn with the evaluator's path, so it works
// from any directory. No object-language eval callback.
// Run: deno run --allow-read examples/metacircular-self.ts
import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";

const i = new Interpreter();
i.programArgs = [new URL("../lib/meta/evaluator.apn", import.meta.url).pathname];
i.run(parse(Deno.readTextFileSync(new URL("./metacircular-self.apn", import.meta.url))));
