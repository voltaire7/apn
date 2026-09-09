// File I/O and initial APN bootstrapping only. No object-language eval callback.
// Run: deno run --allow-read examples/metacircular-self.ts
import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";

const i = new Interpreter();
i.env.setLocal("evaluatorSource", {
    kind: "string",
    v: Deno.readTextFileSync(new URL("../lib/meta/evaluator.apn", import.meta.url)),
});
i.run(parse(Deno.readTextFileSync(new URL("./metacircular-self.apn", import.meta.url))));
