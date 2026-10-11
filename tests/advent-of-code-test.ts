import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";

function interpreter(): Interpreter {
    const i = new Interpreter();
    i.sourceDir = new URL("../examples/advent-of-code/", import.meta.url).pathname;
    i.run(parse('load "sonar-sweep"; load "lanternfish"; load "hill-climbing"'));
    return i;
}
function result(i: Interpreter, source: string): string { return i.renderString(i.run(parse(source))); }
for (const [file, solver, expected] of [
    ['sonar', 'solveSonar', '7'], ['fish', 'solveFish', '5934'], ['hill', 'solveHill', 'Some 31'],
]) Deno.test(`AoC published sample: ${file}`, () => {
    const i = interpreter();
    i.env.setLocal("input", { kind: "string", v: Deno.readTextFileSync(new URL(`../examples/advent-of-code/samples/${file}.input`, import.meta.url)) });
    const actual = result(i, `${solver} input`);
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});
for (const [source, expected] of [
    ['solveSonar ""', '0'], ['solveSonar "7"', '0'],
    ['solveSonar "1\\r\\n2\\r\\n3\\r\\n"', '2'],
    ['solveSonar (joinWith "\\n" (map (to String) [1..2000]))', '1999'],
    ['fishPopulation 0 "3,4,3,1,2"', '5'],
    ['fishPopulation 18 "3,4,3,1,2"', '26'],
    ['fishPopulation 256 "3,4,3,1,2"', '26984457539'],
    ['solveHill "SE"', 'None'],
    ['solveHill "SabcdefghijklmnopqrstuvwxyzE"', 'Some 27'],
    ['lookup 1000 (bfsDistances (n -> n < 1000 ? [n+1] : []) [0])', '1000'],
    ['pairs (bfsDistances (n -> [n,n]) [0,0])', '[[0,0]]'],
    ['pairs (bfsDistances (n -> [1-n]) [0,1])', '[[0,0],[1,0]]'],
    ['pairs (bfsDistances missing [])', '[]'],
    ['integers "-4 +2 0 100"', '[-4,2,0,100]'],
    ['length (splitOn "," (joinWith "" (replicate 2000 "a")))', '1'],
]) Deno.test(`AoC helper/stress: ${source}`, () => {
    const actual = result(interpreter(), source);
    if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
});
for (const source of ['parseInt "1.5"', 'parseInt "1/2"', 'solveFish "9"', 'solveHill "Sa\\nabcE"']) {
    Deno.test(`AoC rejects invalid input: ${source}`, () => {
        try { result(interpreter(), source); }
        catch { return; }
        throw new Error("Expected invalid input to fail");
    });
}
Deno.test("readInput uses program arguments and reads UTF-8 from cwd-relative or absolute paths", () => {
    const i = new Interpreter(); i.run(parse('import "io"'));
    const file = new URL("../examples/advent-of-code/samples/sonar.input", import.meta.url).pathname;
    i.programArgs = [file];
    const actual = i.demand(i.run(parse('readInput []')));
    if (actual.kind !== "string" || actual.v !== Deno.readTextFileSync(file)) throw new Error("readInput failed");
});
Deno.test("file read failures identify the operation", () => {
    const i = new Interpreter(); i.run(parse('import "io"'));
    try { result(i, 'readFile "/__apn_missing_input__/missing.input"'); }
    catch (error) { if (error instanceof Error && error.message.startsWith("readFile:")) return; throw error; }
    throw new Error("expected a read error");
});
