import { asFloat, toExact, floating, type Real } from "../src/numbers.ts";
import { parse } from "../main.ts";
import { Interpreter } from "../src/interp.ts";
import { APNError } from "../src/errors.ts";

for (const [source, expected] of [
    ["(makeRectangular 1e308 1e308) / (makeRectangular 1e308 1e308)", "1.0+0.0i"],
    ["1 / 3 + 1 / 6", "1/2"], ["6 / 3", "2"], ["1 / (-3)", "-1/3"],
    ["(2 / 3) * (9 / 4)", "3/2"], ["-(2 / 3)", "-2/3"],
    ["1 + 2.0", "3.0"], ["(1 / 2) + 0.5", "1.0"],
    ["[1 == 1.0,1 / 2 == 0.5,1 / 10 == .1]", "[true,true,false]"],
    ["[9007199254740993 == 9007199254740992.0,9007199254740993 > 9007199254740992.0]", "[false,true]"],
    ["[quotient (-7) 3,remainder (-7) 3,modulo (-7) 3]", "[-2,-1,2]"],
    ["[quotient 7.0 3,remainder 7.0 3,modulo 7 (-3)]", "[2.0,1.0,-2]"],
    ["[floor (-3 / 2),ceiling (-3 / 2),truncate (-3 / 2),round (-3 / 2)]", "[-2,-1,-1,-2]"],
    ["[round 2.5,round 3.5,round (-2.5),round (-3.5)]", "[2.0,4.0,-2.0,-4.0]"],
    ["[numerator (6 / 4),denominator (6 / 4),denominator .5]", "[3,2,2.0]"],
    ["[gcd 32 (-36),lcm 32 (-36),gcd 32.0 36,lcm 0 0]", "[4,288,4.0,0]"],
    ["[min 2 3.0,max 2 3.0]", "[2.0,3.0]"],
    ["[sqrt 4,sqrt (9 / 16),sqrt (-1)]", "[2,3/4,0+1i]"],
    ["sqrt 2", "1.4142135623730951"],
    ["[expt 2 (-3),expt (2 / 3) 3,expt 4 (1 / 2)]", "[1/8,8/27,2]"],
    ["(makeRectangular 1 2) + (makeRectangular 3 4)", "4+6i"],
    ["(makeRectangular 1 2) * (makeRectangular 3 4)", "-5+10i"],
    ["(makeRectangular 1 2) / (makeRectangular 3 4)", "11/25+2/25i"],
    ["[realPart (makeRectangular 3 4),imagPart (makeRectangular 3 4),magnitude (makeRectangular 3 4)]", "[3,4,5]"],
    ["conjugate (makeRectangular 3 4)", "3-4i"],
    ["makeRectangular 1 0", "1"], ["makeRectangular 1 .5", "1.0+0.5i"],
    ["sqrt (makeRectangular 3 4)", "2+1i"],
    ["[isNumber 3,isComplex 3,isReal 3,isRational 3,isInteger 3.0,isExact 3.0]", "[true,true,true,true,true,false]"],
    ["[isNumber [],isReal (makeRectangular 1 2),isInteger (3 / 2),isExact (makeRectangular 1 2)]", "[false,false,false,true]"],
    ["[isOdd (-3),isEven 2.0,isPositive (1 / 3),isNegative (-1 / 3)]", "[true,true,true,true]"],
    ["[exact .5,inexact (1 / 2),exact .1]", "[1/2,0.5,3602879701896397/36028797018963968]"],
    ["inexact (expt 10 400 / expt 10 400)", "1.0"],
    ["inexact ((expt 10 400 + 1) / (expt 10 400 + 3))", "1.0"],
    ["[1.0 / 0.0,(-1.0) / 0.0,0.0 / 0.0]", "[+inf.0,-inf.0,+nan.0]"],
    ["[isInfinite (1.0 / 0.0),isNaN (0.0 / 0.0),isFinite (expt 10 400)]", "[true,true,true]"],
    ["[0.0 / 0.0 == 0.0 / 0.0,0.0 / 0.0 <= 1]", "[false,false]"],
    ["[0,1/2..2]", "[0,1/2,1,3/2,2]"],
    ["[2,3/2..0]", "[2,3/2,1,1/2,0]"],
    ["take 4 [1/3,2/3..]", "[1/3,2/3,1,4/3]"],
    ["[0,1/2..2] 3", "3/2"],
    ["[exp 0,log 1,sin 0,cos 0,tan 0,asin 0,acos 1,atan 0]", "[1,0,0,1,0,0,0,0]"],
    ["rationalize (exact .3) (1 / 10)", "1/3"],
    ["rationalize .3 (1 / 10)", "0.3333333333333333"],
    ["rationalize (-3 / 10) (1 / 10)", "-1/3"],
    ["f 1 = 7\nf x = 0\nf 1.0", "7"],
    ['from String "1/3"', "1/3"],
]) {
    Deno.test(`Scheme numeric behavior: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
for (const source of ["1 / 0", "exact (1.0 / 0.0)", "[10] 0.0", "(makeRectangular 1 2) < 3", "quotient (1 / 2) 3", "isOdd (1 / 2)"]) {
    Deno.test(`numeric domain error: ${source}`, () => {
        try { const interp = new Interpreter(); interp.renderString(interp.run(parse(source))); }
        catch (e) { if (e instanceof APNError) return; throw e; }
        throw new Error("Expected domain error");
    });
}

for (const [source, expected] of [
    ["[0xFF,0b11010100,0o235461]", "[255,212,80689]"],
    ["-0xFF", "-255"], ["0x20000000000001", "9007199254740993"],
    ["[0xA..0xC]", "[10,11,12]"],
    ["[1e3,.5e2,1.2e-3]", "[1000.0,50.0,0.0012]"],
    ['from String "11/25+2/25i"', "11/25+2/25i"],
    ['from String "0xFF"', "255"], ['from String "-0b10"', "-2"],
    ['from String (to String (makeRectangular 1 .5))', "1.0+0.5i"],
    ['from String (to String (1.0 / 0.0))', "+inf.0"],
    ["inexact (1 / expt 2 1074)", "5e-324"],
    ["inexact (1 / expt 2 1075)", "0.0"],
    ["isExact (0xFF + 0b1)", "true"],
]) {
    Deno.test(`APN numeric notation: ${source}`, () => {
        const interp = new Interpreter();
        const actual = interp.renderString(interp.run(parse(source)));
        if (actual !== expected) throw new Error(`Expected ${expected}, got ${actual}`);
    });
}
for (const source of ["0x", "0b102", "0o8", "0xFG", "1e+", ".1e"]) {
    Deno.test(`invalid numeric notation: ${source}`, () => {
        try { parse(source); } catch (e) { if (e instanceof APNError) return; throw e; }
        throw new Error("Expected syntax error");
    });
}

Deno.test("binary64 exact conversion round trips normal and subnormal numbers", () => {
    const bits = new DataView(new ArrayBuffer(8));
    for (let exponent = 0; exponent < 2047; exponent += 13) {
        bits.setUint32(0, (exponent << 20) | 0xabcde);
        bits.setUint32(4, 0xf1234567);
        const value = bits.getFloat64(0);
        for (const signed of [value, -value]) {
            const back = asFloat(toExact(floating(signed)) as Real);
            if (!Object.is(back, signed)) throw new Error(`Conversion lost ${signed}`);
        }
    }
});
Deno.test("large non-square exact values have finite square roots", () => {
    const interp = new Interpreter();
    const result = interp.run(parse("sqrt (expt 10 400 + 1)"));
    if (result.kind !== "float" || result.v !== 1e200) throw new Error("Square root overflowed unnecessarily");
});
Deno.test("large inexact complex square roots remain finite", () => {
    const interp = new Interpreter();
    const result = interp.run(parse("sqrt (makeRectangular 1e308 1e308)"));
    if (result.kind !== "complex" || !Number.isFinite(asFloat(result.re)) || !Number.isFinite(asFloat(result.im))) throw new Error("Complex root overflowed");
});
