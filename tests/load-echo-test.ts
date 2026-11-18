import { Interpreter } from "../src/interp.ts";
import { runSource } from "../src/repl.ts";

// Running a load runs the file, again each time, and yields its value; the
// REPL echoes none of it (an infinite list, a failing field), and it opens
// nothing until use opens it.
for (const command of ['load "main"', 'load $ "main"']) {
    Deno.test(`REPL load does not render infinite or invalid exports: ${command}`, () => {
        const i = new Interpreter();
        i.sourceDir = new URL('./fixtures/load-echo/', import.meta.url).pathname;
        const output: string[] = [];
        const log = console.log;
        console.log = (...args: unknown[]) => output.push(args.join(' '));
        try {
            if (runSource(command, i) !== '') throw new Error('load echoed its value');
            if (output.join(',') !== 'loaded' || i.env.get('v')) throw new Error('a load did not run its file alone');
            runSource('module <- load "main"', i, true);
            if (output.join(',') !== 'loaded,loaded') throw new Error('a load ran its file once');
            if (runSource('module.v', i) !== '[x = 1, y = 2, z = 3]') throw new Error('field lost');
            runSource('[..] = module', i);
            if (runSource('v.x', i) !== '1') throw new Error('exports lost');
            if (runSource('take 5 infinite', i) !== '[0,1,2,3,4]') throw new Error('lazy export lost');
            if (output.length !== 2) throw new Error('[..] ran the file again');
        } finally { console.log = log; }
    });
}
