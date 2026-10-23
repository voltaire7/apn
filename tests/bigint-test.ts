import { Interpreter } from "../src/interp.ts";
import { parse } from "../main.ts";
import { setLooseSpacing } from "../src/parser.ts";

function example(name: string, source: string, expected: string) {
    Deno.test(name, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}

function failure(name: string, source: string, expected: string) {
    Deno.test(name, () => {
        try {
            const interp = new Interpreter();
            interp.renderString(interp.run(parse(source)));
        } catch (error) {
            if (error instanceof Error && error.message.includes(expected)) return;
            throw error;
        }
        throw new Error(`Expected an error containing ${expected}`);
    });
}

example("integer literals above 2^53 preserve every digit", "9007199254740993", "9007199254740993");
example("large addition is exact", "9007199254740993 + 2", "9007199254740995");
example("large subtraction is exact", "9007199254740993 - 9007199254740992", "1");
example("large multiplication is exact", "12345678901234567890 * 12345678901234567890", "152415787532388367501905199875019052100");
example("signed division retains exact fractions", "[-7 / 3, 7 / -3, -7 / -3]", "[-7/3,-7/3,7/3]");
example("large division is exact", "100000000000000000000000000001 / 3", "100000000000000000000000000001/3");
example("signed remainder follows the dividend", "[-7 % 3, 7 % -3, -7 % -3]", "[-1,1,-1]");
example("large comparisons do not subtract into a float", "[9007199254740993 > 9007199254740992, 9007199254740993 == 9007199254740992]", "[true,false]");
example("negative integer literals are exact", "-9007199254740993", "-9007199254740993");
example("from String retains large integer digits", 'from String "9007199254740993"', "9007199254740993");
example("integer string formatting has no BigInt suffix", 'format "% / %" [9007199254740993,-9007199254740993]', '"9007199254740993 / -9007199254740993"');
example("to String uses exact decimal text", "to String 9007199254740993", '"9007199254740993"');
example("quoted literals retain exact digits", "quote 9007199254740993", '"9007199254740993"');
example("toAST retains large numeric leaves", "toAST (9007199254740993 + 1)", '["+",9007199254740993,1]');
example("large finite ranges advance exactly", "[9007199254740993..9007199254740995]", "[9007199254740993,9007199254740994,9007199254740995]");
example("large stepped ranges advance exactly", "[9007199254740993,9007199254740995..9007199254740997]", "[9007199254740993,9007199254740995,9007199254740997]");
example("descending ranges retain exact endpoints", "[9007199254740995..9007199254740993]", "[9007199254740995,9007199254740994,9007199254740993]");
example("infinite ranges above 2^53 still advance", "take 3 [9007199254740993..]", "[9007199254740993,9007199254740994,9007199254740995]");
example("range arithmetic is exact", "[9007199254740993..9007199254740993+2]", "[9007199254740993,9007199254740994,9007199254740995]");
example("range integer division agrees with runtime division", "[0..5/2]", "[0,1,2]");
example("range patterns compare exact integer bounds", "match 9007199254740993 [[9007199254740993..9007199254740995] -> true, _ -> false]", "true");
example("literal patterns match exact large integers", "pick 9007199254740993 = 1\npick n = 0\npick 9007199254740992", "0");
example("large record keys round-trip exactly", "r = [9007199254740993: 7]\n[r.9007199254740993, r \"9007199254740993\"]", "[7,7]");
example("large take counts end at a finite list", "take 9007199254740993 [1,2]", "[1,2]");
example("large drop counts end at a finite list", "drop 9007199254740993 [1,2]", "[]");
example("negative list and record indexes still work", '[[1,2] -1, [a: 1, b: 2] -1]', '[2,["b",2]]');
example("negative integer iteration still counts down", "-3 * x -> x", "[0,-1,-2]");
example("floats keep fractional arithmetic", "[7.0 / 2.0, 0.5 + 0.25]", "[3.5,0.75]");
failure("huge positive indexes fail without rounding", "[1,2] 9007199254740993", "index 9007199254740993 out of range");
failure("huge negative indexes fail without rounding", "[1,2] -9007199254740993", "index -9007199254740993 out of range");
failure("huge record indexes fail without rounding", "[a: 1] 9007199254740993", "index 9007199254740993 out of range");
failure("integer division by zero has an APN error", "1 / 0", "division by zero");
failure("integer remainder by zero has an APN error", "1 % 0", "remainder by zero");
failure("huge exit codes are rejected before host conversion", "exit 9007199254740993", "signed 32-bit integer");
failure("lossy mixed arithmetic requires explicit conversion", "9007199254740993 + 1.0", "lossy implicit numeric conversion");

// No literal this long fits in a 99-character line; loose source may hold one.
Deno.test("literals beyond floating-point range stay finite", () => {
    setLooseSpacing(true);
    try {
        const interp = new Interpreter();
        if (interp.renderString(interp.run(parse("100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001"))) !== "100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001") throw new Error("rounded");
    } finally { setLooseSpacing(false); }
});

Deno.test("Fibonacci streams exact values beyond the former Infinity threshold", () => {
    const interp = new Interpreter();
    const fibs = interp.run(parse("fibs = 0 :: 1 :: zipWith (+) fibs (tail fibs)\nfibs"));
    let last = "";
    let count = 0;
    for (const value of interp.elements(interp.takeList(1501n, fibs))) {
        last = interp.renderString(value);
        if (!/^[0-9]+$/.test(last)) throw new Error(`Non-integer rendering: ${last}`);
        count++;
    }
    const expected = "13551125668563101951636936867148408377786010712418497242133543153221487310873528750612259354035717265300373778814347320257699257082356550045349914102924249595997483982228699287527241931811325095099642447621242200209254439920196960465321438498305345893378932585393381539093549479296194800838145996187122583354898000";
    if (count !== 1501 || last !== expected) throw new Error(`Incorrect F1500: ${last}`);
});
