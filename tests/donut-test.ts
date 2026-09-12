import { Interpreter } from "../src/interp.ts";
import { parse } from "../src/parser.ts";

Deno.test("APN donut agrees with the supplied C projection and z-buffer", () => {
    const i = new Interpreter();
    i.sourceDir = new URL('../examples/graphics/', import.meta.url).pathname;
    i.run(parse('load "donut"; [samples] = [makeDonutSamples .28 .08]'));
    const width = 40, height = 20, A = .9, B = .4;
    const chars = Array(width * height).fill(' '), depths = Array(width * height).fill(0);
    const ca = Math.cos(A), sa = Math.sin(A), cb = Math.cos(B), sb = Math.sin(B);
    const palette = '.,-~:;=!*#$@', k1 = width * 5 / 16;
    for (let ti = 0; ti < Math.ceil(2 * Math.PI / .28); ti++) {
        const ct = Math.cos(ti * .28), st = Math.sin(ti * .28);
        for (let fi = 0; fi < Math.ceil(2 * Math.PI / .08); fi++) {
            const cp = Math.cos(fi * .08), sp = Math.sin(fi * .08);
            const x = (2 + ct) * (cb * cp + sa * sb * sp) - st * ca * sb;
            const y = (2 + ct) * (sb * cp - sa * cb * sp) + st * ca * cb;
            const iz = 1 / (5 + ca * (2 + ct) * sp + st * sa);
            const sx = Math.trunc(width / 2 + k1 * iz * x), sy = Math.trunc(height / 2 - k1 * iz * y);
            const light = cp * ct * sb - ca * ct * sp - sa * st + cb * (ca * st - ct * sa * sp);
            if (light <= 0 || sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
            const at = sy * width + sx;
            if (iz <= depths[at]) continue;
            depths[at] = iz;
            const shade = Math.trunc(light * 8);
            if (shade >= 0 && shade < 12) chars[at] = palette[shade];
        }
    }
    const expected = Array.from({length: height}, (_, row) => chars.slice(row * width, (row + 1) * width).join('') + '\n').join('');
    const actual = i.renderString(i.run(parse('renderDonut samples .9 .4 40 20')), true);
    if (actual !== expected) throw new Error('APN frame differs from reference');
    const rotated = i.renderString(i.run(parse('renderDonut samples 1.4 .8 40 20')), true);
    if (rotated === actual || rotated.length !== 820) throw new Error('rotation or dimensions failed');
});
Deno.test("terminal escape and sleep primitive", () => {
    const i = new Interpreter();
    i.run(parse('import "std/system"; sleep 0'));
    if (i.renderString(i.run(parse('"\\e"')), true) !== '\x1b') throw new Error('escape not decoded');
    for (const input of ['-1', '1.5', '2147483648']) {
        let failed = false;
        try { i.run(parse(`sleep (${input})`)); } catch (error) { failed = String(error).includes('nonnegative integer'); }
        if (!failed) throw new Error(`sleep accepted ${input}`);
    }
});
