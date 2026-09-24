import { Interpreter } from "../src/interp.ts";
import { runSource } from "../src/repl.ts";

for (const command of ['load "main"', '"main" $ load', '(load "main")']) {
    Deno.test(`REPL load does not render infinite or invalid exports: ${command}`, () => {
        const i = new Interpreter();
        i.sourceDir = new URL('./fixtures/load-echo/', import.meta.url).pathname;
        const output: string[] = [];
        const log = console.log;
        console.log = (...args: unknown[]) => output.push(args.join(' '));
        try {
            if (runSource(command, i) !== '') throw new Error('load echoed its exports');
            if (output.join(',') !== 'loaded') throw new Error('file effects changed');
            if (command.startsWith('(')) {
                if (i.env.get('v')) throw new Error('block exports leaked');
            } else {
                if (runSource('v.x', i) !== '1') throw new Error('exports lost');
                if (runSource('take 5 infinite', i) !== '[0, 1, 2, 3, 4]') throw new Error('lazy export lost');
            }
            runSource('module <- load "main"', i, true);
            if (runSource('module.v', i) !== '[x: 1, y: 2, z: 3]') throw new Error('module record lost');
        } finally { console.log = log; }
    });
}
