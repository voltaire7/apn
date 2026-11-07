import { Interpreter } from "../src/interp.ts";
import { runSource } from "../src/repl.ts";

for (const command of ['load "main"', 'load $ "main"', 'load "main"']) {
    Deno.test(`REPL load does not render infinite or invalid exports: ${command}`, () => {
        const i = new Interpreter();
        i.sourceDir = new URL('./fixtures/load-echo/', import.meta.url).pathname;
        const output: string[] = [];
        const log = console.log;
        console.log = (...args: unknown[]) => output.push(args.join(' '));
        try {
            if (runSource(command, i) !== '') throw new Error('load echoed its exports');
            if (output.join(',') !== 'loaded') throw new Error('file effects changed');
            output.length = 0;
            // Running a load opens nothing; use opens its record.
            if (i.env.get('v')) throw new Error('a load opened its names');
            runSource('module <- load "main"', i, true);
            if (runSource('module.v', i) !== '[x = 1, y = 2, z = 3]') throw new Error('module record lost');
            runSource('use module', i);
            if (runSource('v.x', i) !== '1') throw new Error('exports lost');
            if (runSource('take 5 infinite', i) !== '[0,1,2,3,4]') throw new Error('lazy export lost');
        } finally { console.log = log; }
    });
}
